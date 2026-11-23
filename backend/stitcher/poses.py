"""Capture input layer: the pose-less nominal angle tables and poses.json
loading/validation. Pose problems are never fatal here: callers WARN and fall
back to the nominal angles."""

import json
import os
import re

from geom import intrinsics_fx_fy_cx_cy


def log(msg):
    print(msg, flush=True)


# --- nominal capture geometry (fallback, no poses) --------------------------
# Degrees. yaw = a RIGHTWARD turn about world up (see rmat), pitch about world
# +X (positive looks down), roll about the forward axis.
# horizon ring 0-7 at 45 deg apart, +45 pitch ring 8-11 at 90, -45 pitch 12-13
# at 0/180, 14 zenith (up), 15 nadir (down).
def nominal_pose(i, yaw_dir, pitch_sign):
    if i < 8:
        return (yaw_dir * i * 45.0, 0.0, 0.0)
    if 8 <= i <= 11:
        return (yaw_dir * (i - 8) * 90.0, pitch_sign * 45.0, 0.0)
    if i == 12:
        return (0.0, -pitch_sign * 45.0, 0.0)
    if i == 13:
        return (180.0, -pitch_sign * 45.0, 0.0)
    if i == 14:
        return (0.0, pitch_sign * 90.0, 0.0)  # zenith (up)
    if i == 15:
        return (0.0, -pitch_sign * 90.0, 0.0)  # nadir (down)
    # Beyond the nominal 16 targets we have no angle; treat as horizon spillover.
    return (yaw_dir * (i % 8) * 45.0, 0.0, 0.0)


def nominal_angles(frame_count, yaw_dir, pitch_sign):
    """Per-frame (yaw, pitch, roll) table for the pose-less fallback, selected
    by capture pattern:

      16 -> legacy layout (8 horizon @45 / 4 up @90 / 2 down / zenith / nadir)
      28 -> densified layout, same order as the iOS TargetLayout:
            12 horizon @30 / 8 up(+45) @45 / 6 down(-45) @60 / zenith / nadir
      other -> WARN and evenly distribute a horizon-only ring.

    pitch_sign follows the legacy convention (winning params use -1, i.e.
    "up" rings get pitch_sign * 45).
    """
    if frame_count == 16:
        return [nominal_pose(i, yaw_dir, pitch_sign) for i in range(16)]
    if frame_count == 28:
        angles = []
        for i in range(12):  # horizon ring, every 30 deg
            angles.append((yaw_dir * i * 30.0, 0.0, 0.0))
        for i in range(8):  # upper ring (+45), every 45 deg
            angles.append((yaw_dir * i * 45.0, pitch_sign * 45.0, 0.0))
        for i in range(6):  # lower ring (-45), every 60 deg
            angles.append((yaw_dir * i * 60.0, -pitch_sign * 45.0, 0.0))
        angles.append((0.0, pitch_sign * 90.0, 0.0))  # zenith
        angles.append((0.0, -pitch_sign * 90.0, 0.0))  # nadir
        return angles
    log(
        f"WARN unknown capture pattern ({frame_count} frames) — "
        "using an even horizon-only ring"
    )
    n = max(1, int(frame_count))
    return [(yaw_dir * i * (360.0 / n), 0.0, 0.0) for i in range(n)]


FRAME_NAME_RE = re.compile(r"^frame_\d+\.(jpg|jpeg|png)$", re.IGNORECASE)


def count_frames(frames_dir):
    """Number of frame_<i>.jpg/png files present, or None if unreadable."""
    try:
        return sum(1 for name in os.listdir(frames_dir) if FRAME_NAME_RE.match(name))
    except OSError:
        return None


def load_poses(path):
    """Load poses.json (the captures.poses_json array).

    Returns (poses, None) on success or (None, reason) when the file is
    missing/unreadable/malformed. Pose problems are NEVER fatal — the caller
    WARNs and falls back to the nominal-angle path (a legacy client once
    shipped zeroed intrinsics and hard-failing here burned every retry)."""
    if not path:
        return None, None
    if not os.path.exists(path):
        return None, f"poses file not found: {path}"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"failed to read poses: {exc}"
    if not isinstance(data, list) or len(data) == 0:
        return None, "poses.json must be a non-empty array"
    return data, None


def pose_validation_error(poses, frame_count=None):
    """Return a human-readable reason when the pose array is unusable, else
    None. Checks entry shape, transform (16 numbers), intrinsics (9 numbers
    with positive fx/fy/cx/cy) and — when known — pose count vs frame count.
    Mirrors everything build() would otherwise die on mid-run."""
    if frame_count is not None and frame_count > 0 and len(poses) != frame_count:
        return f"pose count {len(poses)} != frame count {frame_count}"
    for p in poses:
        if not isinstance(p, dict) or "transform" not in p or "index" not in p:
            return "each pose needs at least 'index' and 'transform'"
        try:
            i = int(p["index"])
        except (TypeError, ValueError):
            return f"non-integer pose index {p.get('index')!r}"
        t = p["transform"]
        if not isinstance(t, (list, tuple)) or len(t) != 16:
            return f"frame {i}: transform must have 16 elements"
        try:
            [float(x) for x in t]
        except (TypeError, ValueError):
            return f"frame {i}: non-numeric transform"
        k = p.get("intrinsics")
        if k is not None:
            if not isinstance(k, (list, tuple)) or len(k) != 9:
                return f"frame {i}: intrinsics must have 9 elements"
            try:
                # Convention-tolerant (row- or column-major) extraction; only
                # when BOTH principal-point candidates are non-positive is the
                # pose genuinely invalid.
                fx, fy, cx, cy = intrinsics_fx_fy_cx_cy(k)
            except (TypeError, ValueError):
                return f"frame {i}: non-numeric intrinsics"
            if fx <= 0 or fy <= 0 or cx <= 0 or cy <= 0:
                return f"frame {i}: non-positive intrinsics"
    return None
