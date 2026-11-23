#!/usr/bin/env python3
"""Stitch quality metrics for a pano + the frames it was built from.

  overlap_err  mean |luma_i - luma_j| (0-255) over every pixel two reprojected
               frames share. Measures the reprojection MODEL (pose, depth,
               gains): perfect geometry and exposure give ~sensor noise. It does
               not read the pano, so seams and blending cannot hide anything.
  doubling     1 - mean over multi-frame, textured pano pixels of the best local
               gradient NCC between the pano and any single reprojected frame.
               A ghosted average matches no real photo (doubled edges), so it
               scores high; a clean seam-cut pano matches one frame everywhere.

Both reproject the frames with the stitcher's own code at --width, so pass the
same --proxy-depth / --depth-dir / --gains the pano was built with (inf = rotation-only,
the pre-v2 model). The nadir cap (lat < -70 deg) is excluded from `doubling`
because it is inpainted by design.

  bench.py --pano pano.jpg --frames-dir DIR --poses poses.json [--proxy-depth 2.5]
"""

import argparse
import json
import math
import time

import cv2
import numpy as np

import reproject as R
from gains import apply_gain
from warp import pano_rays, project, sample, sample_field

NCC_WIN = 15  # local window (px at --width) for the gradient NCC
NOISE_SIGMA = 1.5  # blur before gradients: dim-room sensor noise otherwise dominates
EDGE_PCT = 80  # score only the strongest 20% of pano edges, where doubling shows
NADIR_EXCLUDE_LAT = -70.0


def layers(args):
    """[(gray float32 canvas, valid bool canvas)] per frame at args.width."""
    poses = sorted(json.load(open(args.poses)), key=lambda p: int(p["index"]))
    by_i = {int(p["index"]): p for p in poses}
    w, h = args.width, args.width // 2
    frames = R.load_frames(args.frames_dir, list(by_i), by_i, None, R.DEFAULT_HFOV, w)
    center = np.mean([f[1].o for f in frames.values()], axis=0)
    invd_field = R.scene_depth(frames, by_i, args.depth_dir, center, args.proxy_depth)
    rows, cols = np.arange(h), np.arange(w)
    dx, dy, dz = pano_rays(rows, cols, w, h)
    invd = sample_field(invd_field, rows, cols, w, h)
    gains = (R.frame_gains(frames, by_i, center, invd_field, min(w, R.ANALYSIS_WIDTH))
             if args.gains else np.ones((len(frames), 3), np.float32))
    out = []
    for (img, cam, _), g in zip(frames.values(), gains):
        px, py, inb = project(cam, center, dx, dy, dz, invd)
        im = apply_gain(sample(img, px, py), g).astype(np.uint8)
        out.append((cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32), inb))
    return out


def overlap_err(lay):
    tot, cnt = 0.0, 0
    for a in range(len(lay)):
        for b in range(a + 1, len(lay)):
            both = lay[a][1] & lay[b][1]
            n = int(both.sum())
            if n:
                tot += float(np.abs(lay[a][0][both] - lay[b][0][both]).sum())
                cnt += n
    return tot / max(cnt, 1)


def grad(g):
    g = cv2.GaussianBlur(g, (0, 0), NOISE_SIGMA)
    return cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))


def local_ncc(a, b):
    box = lambda x: cv2.boxFilter(x, -1, (NCC_WIN, NCC_WIN))  # noqa: E731
    ma, mb = box(a), box(b)
    va = box(a * a) - ma * ma
    vb = box(b * b) - mb * mb
    return (box(a * b) - ma * mb) / np.sqrt(np.maximum(va * vb, 1e-6)), va


def doubling(pano_path, lay, w):
    pano = cv2.imread(pano_path, cv2.IMREAD_GRAYSCALE)
    pano = cv2.resize(pano, (w, w // 2), interpolation=cv2.INTER_AREA).astype(np.float32)
    gp = grad(pano)
    best = np.full(gp.shape, -1.0, np.float32)
    count = np.zeros(gp.shape, np.int32)
    var_p = None
    for g, m in lay:
        ncc, var_p = local_ncc(gp, grad(g))
        best = np.where(m, np.maximum(best, ncc), best)
        count += m
    lat = (0.5 - (np.arange(w // 2) + 0.5) / (w // 2)) * 180.0
    textured = var_p > np.percentile(var_p, EDGE_PCT)  # flat walls carry no edge signal
    sel = (count >= 2) & textured & (lat > NADIR_EXCLUDE_LAT)[:, None]
    return 1.0 - float(best[sel].mean())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pano", required=True)
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--poses", required=True)
    ap.add_argument("--depth-dir", default=None)
    ap.add_argument("--proxy-depth", type=float, default=R.DEFAULT_PROXY_DEPTH_M)
    ap.add_argument("--gains", action="store_true", help="apply the stitcher's gains first")
    ap.add_argument("--width", type=int, default=2048)
    args = ap.parse_args()
    R.log = R.progress = lambda *a, **k: None
    t = time.time()
    lay = layers(args)
    res = {"overlap_err": round(overlap_err(lay), 3),
           "doubling": round(doubling(args.pano, lay, args.width), 4),
           "proxy_depth": args.proxy_depth if math.isfinite(args.proxy_depth) else "inf",
           "bench_s": round(time.time() - t, 1)}
    print(json.dumps(res))


if __name__ == "__main__":
    main()
