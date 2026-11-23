#!/usr/bin/env python3
"""VirtSpace production panorama stitcher (Phase 0.5 winning algorithm).

Ports the gate-winning rotation-only reprojection spike into a production CLI.
Given a directory of ARKit-native landscape frames (and, optionally, the
per-frame ARKit poses), it rotates each frame upright, reprojects it onto an
equirectangular sphere using the camera orientation, feather-blends the
overlaps, inpaints the residual holes and writes a 4096x2048 (2:1) pano by default.

Two orientation modes:

  * poses provided  -> derive each frame's orientation from its ARKit 4x4
                       camera-to-world transform and its intrinsics-derived FOV
                       (translation is ignored; this is a pure rotation pano).
  * poses absent    -> fall back to the nominal 16-target guided-capture angles
                       with the winning parameters (pitch_sign=-1, hfov=52),
                       exactly as the spike did.

Coordinate conventions (derived in full in ARKIT_TO_PROJ and build()):
  Equirect world  : right-handed, +Y up (gravity), +Z at lon=0/lat=0.
                    Longitude increases with image-x and is measured as a
                    RIGHTWARD turn, so the ray at lon>0 leans toward -X: the
                    pano is viewed from INSIDE the sphere, and in a
                    right-handed +Y-up world a viewer facing +Z has -X on their
                    right (right x up = -forward). Getting that sign wrong
                    mirrors the entire pano — it shipped that way until
                    2026-09-17.
  ARKit camera    : right-handed, +X image-right, +Y image-up, optical axis
                    -Z (camera looks down -Z) in the landscape sensor frame.
  Projection cam  : the pinhole used by the reprojection equations: +X to the
                    image's right, +Y image-up, +Z forward, image +y downward.
                    (right, up, forward) is a LEFT-handed triple in this
                    right-handed world, so every R_proj below has det = -1.

Usage:
  reproject.py --frames-dir DIR --out pano.jpg [--poses poses.json]
               [--width 4096] [--preview-out pano_preview.jpg]
               [--depth-dir DIR] [--proxy-depth 2.5]

On success: prints progress lines to stdout and exits 0.
On failure: prints a message to stderr and exits one of the EXIT_* codes below.
The worker (src/worker.ts) classifies retryability from the CODE, never from the
message text:

  2 (EXIT_INPUT_ERROR)    the capture itself is unusable (undecodable/HEIC
                          frames, no usable frames, bad args). Retrying the same
                          payload can only fail again -> park the job dead.
  1 (EXIT_INTERNAL_ERROR) anything else (failed write, unexpected exception).
                          Possibly transient -> normal retry/backoff.
"""

import argparse
import math
import os
import sys

import cv2
import numpy as np

# The stage modules live beside this script; the worker runs it by path and the
# nominal test loads it via spec_from_file_location, neither of which puts this
# directory on sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from geom import (  # noqa: E402  (re-exported: tests use R.<name>)
    ARKIT_TO_PROJ,
    FLIP_RIGHT,
    derive_pose_rotation,
    focals_from_intrinsics,
    intrinsics_fx_fy_cx_cy,
    rmat,
)
from depth import (  # noqa: E402
    FIELD_WIDTH,
    depth_points,
    inverse_depth_field,
    proxy_field,
    read_depth_png,
)
from blend import MARGIN_STEPS, Band, band_rows, levels_for, roi_from_mask  # noqa: E402
from fill import fill_holes, fill_nadir  # noqa: E402
from gains import apply_gain, estimate_gains, exposure_prior  # noqa: E402
from poses import (  # noqa: E402  (re-exported: tests use R.<name>)
    count_frames,
    load_poses,
    nominal_angles,
    nominal_pose,
    pose_validation_error,
)
from seams import find_seams  # noqa: E402
from warp import (  # noqa: E402
    Cam,
    pano_rays,
    project,
    render_layers,
    sample,
    sample_field,
    shrink,
)


# Winning fallback parameters (spike Phase 0.5 gate).
DEFAULT_HFOV = 52.0
DEFAULT_YAW_DIR = 1
DEFAULT_PITCH_SIGN = -1

# Source px/deg kept per pano px/deg by warp.shrink(): a little over 1 so the
# bilinear remap still has sub-pixel detail to interpolate, well under the ~4x
# at which it starts to alias.
PREFILTER_OVERSAMPLE = 1.3

# Radius (deg) of the cap around the nadir dropped from EVERY frame and left to
# fill_holes: the down ring and nadir shots see the user's feet and legs there
# (R39). Phone at ~1.3 m, feet within ~0.3 m of the pivot -> ~13 deg; 20 leaves
# margin for a forward lean. Floor texture under the user is lost either way.
NADIR_CAP_DEG = 20.0

# Pano width the gain and seam analysis runs at: overlap statistics and seam
# placement need structure, not pixels, and the cost grows with width^2.
ANALYSIS_WIDTH = 1024

# Fixed proxy distance (m) from the pano centre when a frame has neither a
# depth map nor a featureDepthMedian. On the 2026-09-17 bedroom capture the
# bench.py overlap error is flat from 1.25 to 2.0 m (min 1.5, +0.5% at 2.0) and
# 13% worse rotation-only; 2.0 is the far end of that plateau so bigger rooms
# are not over-corrected. Wrong-by-x error scales with |1/d_true - 1/d_proxy|.
DEFAULT_PROXY_DEPTH_M = 2.0

# Hard ceiling on --width. 8192 was the original product width (spec §5); anything
# larger is a misconfiguration that would blow the worker's memory budget, so we
# refuse it up front instead of discovering it via an OOM-kill.
MAX_WIDTH = 8192

# Default output width (spec §10 R40): Marble recommends 2560 and returns
# 2560x1280, so 8192 only cost stitch time and memory; 4096 keeps a decent
# user-facing preview/save. --width can still ask for up to MAX_WIDTH.
DEFAULT_WIDTH = 4096

# --- Exit codes (see the module docstring; mirrored in src/worker.ts) ---------
EXIT_INTERNAL_ERROR = 1
EXIT_INPUT_ERROR = 2

# ISO-BMFF `ftyp` brands that mean "this really is a HEIF/HEIC (or AVIF) file".
HEIF_BRANDS = frozenset(
    (
        b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs",
        b"mif1", b"msf1", b"avif", b"avis",
    )
)


def log(msg):
    print(msg, flush=True)


def progress(pct):
    """Machine-readable progress line for the worker (stdout stream parsing).

    Format is exactly `PROGRESS <0-100>` on its own line; the Node worker
    (src/worker.ts) parses these incrementally and mirrors them into
    worlds.progress. Human log lines are unaffected.
    """
    print(f"PROGRESS {int(max(0, min(100, pct)))}", flush=True)


def die(msg, code=EXIT_INTERNAL_ERROR):
    print(f"reproject: error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def die_input(msg):
    """Fail with EXIT_INPUT_ERROR — the payload is bad, a retry cannot help."""
    die(msg, EXIT_INPUT_ERROR)


def detect_image_format(path):
    """Container sniff from the leading magic bytes.

    Returns 'jpeg' | 'png' | 'heif' | 'iso-bmff' | 'unknown'. Used only to turn a
    decode failure into a precise, actionable message: the iOS client uploads
    JPEG bytes under `.heic` object keys with an `image/heic` content-type (a
    client contract we deliberately do NOT rename), so the file extension and the
    stored content-type say nothing about the real format.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(32)
    except OSError:
        return "unknown"
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    # ISO base media file format: [4-byte big-endian box size]['ftyp'][brand].
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "heif" if head[8:12] in HEIF_BRANDS else "iso-bmff"
    return "unknown"


def load_frame(frames_dir, i):
    """Read frame i, tolerating zero-padded / alternate extensions. Returns the
    ARKit-native (landscape) BGR image, or None if the frame does not exist."""
    candidates = (
        f"frame_{i}.jpg",
        f"frame_{i:02d}.jpg",
        f"frame_{i}.jpeg",
        f"frame_{i}.png",
        f"frame_{i:02d}.png",
    )
    for name in candidates:
        path = os.path.join(frames_dir, name)
        if os.path.exists(path):
            img = cv2.imread(path)
            if img is None:
                # Sniff the REAL container so the failure is actionable. OpenCV
                # builds with HEIF support decode it and never reach here.
                fmt = detect_image_format(path)
                if fmt == "heif":
                    die_input(
                        f"frame {path} is a genuine HEIF/HEIC image; this stitcher "
                        "decodes JPEG/PNG only. The capture client is expected to "
                        "upload JPEG bytes (the `.heic` object key and "
                        "`image/heic` content-type are a legacy client contract, "
                        "not the real format) — re-capture with a client that "
                        "encodes JPEG."
                    )
                die_input(f"failed to decode frame: {path} (sniffed format: {fmt})")
            return img
    return None


def upright(img):
    """Rotate an ARKit-native landscape frame 90 deg clockwise to portrait."""
    return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)


def frame_camera(i, img_shape, pose_by_index, angles, hfov_deg):
    """(Cam, label) for frame `i` sampled from an UPRIGHT image of
    `img_shape`. Focals are FOV-derived, so the same call serves the full-res
    frame, its prefiltered copy and its depth map."""
    hf, wf = img_shape[:2]
    if pose_by_index is not None:
        p = pose_by_index[i]
        try:
            r_proj = derive_pose_rotation(p["transform"])
            origin = np.array([float(x) for x in p["transform"][12:15]], np.float64)
            intr = p.get("intrinsics")
            if intr is not None:
                focal_x, focal_y = focals_from_intrinsics(intr, wf, hf)
            else:
                focal_x = focal_y = (wf / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
        except (KeyError, ValueError, TypeError) as exc:
            die_input(f"frame {i}: invalid pose ({exc})")
        # forward direction in world = row 2 of R_proj; its latitude tells
        # us whether this is a pole (zenith/nadir) frame.
        fwd_lat = math.degrees(math.asin(max(-1.0, min(1.0, float(r_proj[2, 1])))))
        cam = Cam(r_proj, origin, focal_x, focal_y, wf, hf)
        return cam, f"pose(lat={fwd_lat:.0f})"

    yaw, pitch, roll = angles[i]
    # world -> projection camera. FLIP_RIGHT turns rmat's proper rotation into
    # the (right, up, forward) basis the reprojection equations expect, giving
    # the same det = -1 the ARKit path derives from ARKIT_TO_PROJ. No poses =>
    # no translation: every camera sits at the origin (rotation-only).
    r_proj = FLIP_RIGHT @ rmat(yaw, pitch, roll).T
    focal = (wf / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
    cam = Cam(r_proj, np.zeros(3), focal, focal, wf, hf)
    return cam, f"pose(y={yaw:.0f},p={pitch:.0f})"


def load_frames(frames_dir, indices, pose_by_index, angles, hfov_deg, width):
    """{i: (prefiltered upright image, Cam, label)} for every frame
    present. Decoded ONCE: at the pano's density a 12 MP frame shrinks ~10x in
    area, so holding all of them is cheaper than re-decoding per band."""
    frames = {}
    for i in indices:
        raw = load_frame(frames_dir, i)
        if raw is None:
            log(f"frame {i}: missing, skipped")
            continue
        img = upright(raw)
        del raw
        cam, label = frame_camera(i, img.shape, pose_by_index, angles, hfov_deg)
        img, cam = shrink(img, cam, width, PREFILTER_OVERSAMPLE)
        frames[i] = (img, cam, label)
    return frames


def scene_depth(frames, pose_by_index, depth_dir, center, proxy_m):
    """Pano-space inverse depth (scalar or field), see depth.py for priority."""
    points, cams, depths = [], [], []
    for i, (_, cam, _) in frames.items():
        p = pose_by_index.get(i, {}) if pose_by_index else {}
        fdm = p.get("featureDepthMedian")
        ok_fdm = isinstance(fdm, (int, float)) and math.isfinite(fdm) and fdm > 0
        cams.append(cam)
        depths.append(float(fdm) if ok_fdm else proxy_m)
        if depth_dir and pose_by_index:
            dm, why = read_depth_png(os.path.join(depth_dir, f"depth_{i}.png"))
            if dm is None:
                if why != "missing":
                    log(f"WARN frame {i}: depth ignored ({why})")
                continue
            dm = upright(dm)
            dcam = frame_camera(i, dm.shape, pose_by_index, None, DEFAULT_HFOV)[0]
            points.append(depth_points(dm, dcam))
    if points:
        log(f"depth: {len(points)} depth maps")
    proxy = proxy_field(cams, depths, center, FIELD_WIDTH, FIELD_WIDTH // 2, proxy_m)
    return inverse_depth_field(points, proxy, center)


def frame_gains(frames, pose_by_index, center, invd, wa, lay=None):
    """(n_frames, 3) exposure gains, solved over overlaps at analysis scale."""
    if lay is None:
        lay = render_layers([f[:2] for f in frames.values()], center, invd, wa)
    prior = exposure_prior([pose_by_index[i] for i in frames]) if pose_by_index else None
    gains = estimate_gains([x[0] for x in lay], [x[1] for x in lay], prior)
    log("gains " + " ".join(f"{i}:{g.mean():.2f}" for i, g in zip(frames, gains))
        + (" (iso prior)" if prior is not None else ""))
    return gains


def build(width, frames_dir, poses, yaw_dir, pitch_sign, hfov_deg,
          band_height=None, depth_dir=None, proxy_m=None, nadir_cap_deg=NADIR_CAP_DEG):
    """Reproject, compensate, seam and blend all frames into an equirect pano.
    Returns (pano uint8, coverage %, hole mask uint8 255 = hole).

    Stages (spec §5.2 item 5): prefilter (load_frames) -> translation-aware
    reprojection about the camera centroid (warp/depth) -> gains and graph-cut
    seams on a small analysis pano (gains/seams) -> banded multi-band blend at
    full width (blend), with the nadir cap masked out for fill_holes.

    MEMORY (spec §10 R8). Full-res work happens in row BANDS of ~band_height
    rows (plus a pyramid margin), and each frame is only warped over the
    patch its seam mask can influence, so transient arrays are O(band);
    the uint8 pano, the coverage mask, the prefiltered frames and the
    analysis-scale masks are the only whole-sphere allocations.
    """
    w = width
    h = width // 2
    proxy_m = DEFAULT_PROXY_DEPTH_M if proxy_m is None else proxy_m

    if poses is not None:
        indices = [int(p["index"]) for p in poses]
        pose_by_index = {int(p["index"]): p for p in poses}
        angles = None
    else:
        # Pattern-aware fallback: pick the angle table from the number of
        # frames actually present (16 legacy / 28 densified / other WARN+ring).
        n_frames = count_frames(frames_dir) or 16
        angles = nominal_angles(n_frames, yaw_dir, pitch_sign)
        indices = list(range(len(angles)))
        pose_by_index = None

    frames = load_frames(frames_dir, indices, pose_by_index, angles, hfov_deg, w)
    if not frames:
        die_input(f"no usable frames found in {frames_dir}")
    progress(5)
    # Pano centre = centroid of the camera positions: the user orbits the phone
    # on their arm, so the centroid is ~2x closer to every camera than shot 0.
    center = np.mean([f[1].o for f in frames.values()], axis=0)
    invd = scene_depth(frames, pose_by_index, depth_dir, center, proxy_m)
    log(f"center {np.round(center, 3).tolist()} proxy {proxy_m} m")

    # dy is sin(latitude): rays below -(90 - cap) deg belong to the user's body.
    min_dy = -math.cos(math.radians(nadir_cap_deg)) if nadir_cap_deg > 0 else -1.0
    wa = min(w, ANALYSIS_WIDTH)
    lay = render_layers([f[:2] for f in frames.values()], center, invd, wa, min_dy=min_dy)
    gains = frame_gains(frames, pose_by_index, center, invd, wa, lay)
    seams = find_seams([x[0] for x in lay], gains, [x[1] for x in lay], [x[2] for x in lay])
    seams = [s.astype(np.float32) for s in seams]  # bilinear-upsampled per band
    del lay
    progress(15)

    levels = levels_for(w)
    step = 1 << levels
    rois = [roi_from_mask(s, w, h, step, 2 * step) for s in seams]
    if band_height is None:
        band_height = band_rows(w, h)
    core = -(-max(1, int(band_height)) // step) * step
    margin = MARGIN_STEPS * step
    h_pad = -(-h // step) * step

    pano = np.zeros((h, w, 3), np.uint8)
    cover = np.zeros((h, w), np.uint8)
    covered_px = dict.fromkeys(frames, 0)
    starts = range(0, h, core)
    for b, r0 in enumerate(starts):
        progress(15 + 55 * b / len(starts))
        R0, R1 = max(0, r0 - margin), min(h_pad, r0 + core + margin)
        band = Band(R0, R1 - R0, w, levels)
        for k, (i, (img, cam, _)) in enumerate(frames.items()):
            if rois[k] is None:
                continue
            y0, y1, c0, c1, crop = rois[k]
            y0, y1 = max(R0, y0), min(R1, y1)
            if y0 >= y1:
                continue
            rows = np.minimum(np.arange(y0, y1), h - 1)  # h_pad rows replicate the last
            cols = np.arange(c0, c1)
            dx, dy, dz = pano_rays(rows, cols, w, h)
            px, py, inb = project(cam, center, dx, dy, dz, sample_field(invd, rows, cols, w, h))
            inb &= dy > min_dy
            del dx, dy, dz
            wt = sample_field(seams[k], rows, cols, w, h) * inb
            if not wt.any():
                continue
            core_rows = (np.arange(y0, y1) >= r0) & (np.arange(y0, y1) < r0 + core)
            covered_px[i] += int((wt[core_rows] > 0).sum())
            band.add(apply_gain(sample(img, px, py), gains[k]), wt, y0, c0, crop)
            del px, py, inb, wt
        out, cov = band.collapse()
        a = r0 - R0
        n = min(core, h - r0)
        # Coarse pyramid levels bleed low frequencies into uncovered pixels;
        # holes must stay black and flagged so fill_holes owns them.
        out = np.clip(out[a:a + n], 0, 255).astype(np.uint8)
        out[~cov[a:a + n]] = 0
        pano[r0:r0 + n] = out
        cover[r0:r0 + n] = cov[a:a + n]
        del band, out, cov

    # Per-frame coverage totals, reported once (not once per band).
    processed = 0
    for i, (_, _, label) in frames.items():
        if covered_px[i] == 0:
            log(f"frame {i}: 0 px")
            continue
        processed += 1
        log(f"frame {i}: {label} owns {covered_px[i]} px")

    if processed == 0:
        die_input(f"no usable frames found in {frames_dir}")

    progress(70)  # reprojection + blend done.
    covpct = 100.0 * cover.mean()
    # Reuse the coverage buffer as the hole mask (covered 1 -> 0, hole 0 -> 255)
    # instead of allocating a bool temp + a uint8 temp + the scaled result: three
    # more full-size arrays (100 MB at 8192) for a value we already have.
    mask = cover
    np.subtract(1, mask, out=mask)
    mask *= 255
    return pano, covpct, mask


def main(argv=None):
    ap = argparse.ArgumentParser(description="VirtSpace equirect pano stitcher")
    ap.add_argument("--frames-dir", required=True, help="dir of ARKit-native landscape frame_N.jpg")
    ap.add_argument("--out", required=True, help="output pano.jpg path")
    ap.add_argument("--poses", default=None, help="optional poses.json (captures.poses_json array)")
    ap.add_argument(
        "--width", type=int, default=DEFAULT_WIDTH,
        help=f"pano width (height = width/2), even, max {MAX_WIDTH}",
    )
    ap.add_argument("--preview-out", default=None, help="optional 2000x1000 preview jpg path")
    ap.add_argument(
        "--band-rows", type=int, default=None,
        help="rows per reprojection band (default: sized from BAND_TARGET_PIXELS)",
    )
    ap.add_argument(
        "--depth-dir", default=None,
        help="optional dir of depth_<i>.png (16-bit mm, 0 = invalid); missing files are fine",
    )
    ap.add_argument(
        "--proxy-depth", type=float, default=DEFAULT_PROXY_DEPTH_M,
        help="fallback surface distance in metres (inf = rotation-only)",
    )
    ap.add_argument(
        "--nadir-cap-deg", type=float, default=NADIR_CAP_DEG,
        help="radius of the nadir cap masked out (user's body) and inpainted; 0 = keep",
    )
    # Nominal-fallback tuning (defaults are the Phase 0.5 winning parameters).
    ap.add_argument("--hfov", type=float, default=DEFAULT_HFOV)
    ap.add_argument("--yaw-dir", type=int, default=DEFAULT_YAW_DIR)
    ap.add_argument("--pitch-sign", type=int, default=DEFAULT_PITCH_SIGN)
    args = ap.parse_args(argv)

    if args.width < 2 or args.width % 2 != 0:
        die_input("--width must be a positive even integer")
    if args.width > MAX_WIDTH:
        # A caller asking for more than the product's pano width is a
        # misconfiguration; honouring it would OOM the worker (spec §10 R8).
        die_input(f"--width {args.width} exceeds the maximum {MAX_WIDTH}")
    if not 0 <= args.nadir_cap_deg < 90:
        die_input("--nadir-cap-deg must be in [0, 90)")
    if not args.proxy_depth > 0:
        die_input("--proxy-depth must be > 0 (inf for rotation-only)")
    if not os.path.isdir(args.frames_dir):
        die_input(f"frames dir not found: {args.frames_dir}")

    # Pose problems are never fatal: WARN and fall back to the nominal-angle
    # path rather than exit non-zero (a hard fail here burns every job retry
    # on a permanently-bad payload, e.g. a legacy client's zeroed intrinsics).
    poses, reason = load_poses(args.poses)
    if poses is not None and reason is None:
        reason = pose_validation_error(poses, count_frames(args.frames_dir))
        if reason is None:
            poses = sorted(poses, key=lambda p: int(p["index"]))
    if reason is not None:
        log(f"WARN poses invalid ({reason}) — falling back to nominal angles")
        poses = None

    mode = "poses" if poses is not None else "nominal-fallback"
    bh = args.band_rows or band_rows(args.width, args.width // 2)
    log(
        f"reproject: mode={mode} width={args.width} band_rows={bh} "
        f"frames_dir={args.frames_dir}"
    )
    progress(0)

    pano, cov, mask = build(
        args.width, args.frames_dir, poses,
        args.yaw_dir, args.pitch_sign, args.hfov,
        band_height=bh, depth_dir=args.depth_dir, proxy_m=args.proxy_depth,
        nadir_cap_deg=args.nadir_cap_deg,
    )
    log(f"coverage {cov:.1f}% before inpaint")
    progress(75)  # blend done; inpainting residual holes next.
    pano = fill_nadir(pano, mask, args.nadir_cap_deg)
    pano = fill_holes(pano, mask)
    progress(85)  # inpaint done; encoding + writing outputs next.

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    if not cv2.imwrite(args.out, pano, [cv2.IMWRITE_JPEG_QUALITY, 92]):
        die(f"failed to write pano: {args.out}")
    log(f"wrote pano {pano.shape[1]}x{pano.shape[0]} -> {args.out}")
    progress(95)

    if args.preview_out:
        preview = cv2.resize(pano, (2000, 1000), interpolation=cv2.INTER_AREA)
        pv_dir = os.path.dirname(os.path.abspath(args.preview_out))
        os.makedirs(pv_dir, exist_ok=True)
        if not cv2.imwrite(args.preview_out, preview, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            die(f"failed to write preview: {args.preview_out}")
        log(f"wrote preview 2000x1000 -> {args.preview_out}")

    progress(100)
    log("reproject: done")


if __name__ == "__main__":
    main()
