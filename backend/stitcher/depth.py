"""Pano-space inverse-depth field for translation-aware reprojection.

Depth per frame, in priority order (spec §5.2 item 5):
  1. depth_<i>.png — 16-bit grayscale, millimetres, 0 = invalid, same
     orientation and field of view as frame_<i> (spec §5.2 item 2);
  2. the pose's featureDepthMedian (metres, ARKit rawFeaturePoints);
  3. a fixed proxy distance.

Depth maps are FORWARD-projected into one pano-space field (z-buffer: the
nearest surface wins), so every camera then samples the SAME 3-D point for a
pano pixel; per-camera depth would disagree in the overlaps, which is the
ghosting we are removing. Holes fall back to the proxy. Everything is stored as
inverse depth (see warp.py) at a low fixed resolution: depth is smooth at the
scale that matters for parallax, and LiDAR maps are only 256x192 anyway.
"""

import os

import cv2
import numpy as np

from warp import center_weight, dirs_to_pano, pano_rays, project

FIELD_WIDTH = 1024  # pano-space depth resolution (height = width / 2)
HOLE_GROW_ITERS = 3  # splat gaps this many field px wide are closed from neighbours


def read_depth_png(path):
    """(depth metres float32 with 0 = invalid, None) or (None, reason).

    Never raises: a bad depth file must only cost that frame its depth, never
    the job (spec §5.2 item 4)."""
    if not os.path.exists(path):
        return None, "missing"
    d = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if d is None:
        return None, "undecodable"
    if d.dtype != np.uint16 or d.ndim != 2:
        return None, f"expected 16-bit grayscale, got {d.dtype} {d.shape}"
    if not (d > 0).any():
        return None, "no valid depth"
    return d.astype(np.float32) * np.float32(0.001), None


def depth_points(depth_up, cam):
    """World points (3 x n, float64) of an UPRIGHT depth map seen by `cam`
    (a Cam sized for the depth map). Inverse of warp.project's pinhole."""
    v, u = np.nonzero(depth_up > 0)
    z = depth_up[v, u].astype(np.float64)
    pc = np.stack([(u - cam.w / 2.0) / cam.fx * z, (cam.h / 2.0 - v) / cam.fy * z, z])
    return cam.r.T @ pc + np.asarray(cam.o, np.float64)[:, None]


def splat(points, center, fw, fh):
    """Nearest-surface inverse depth per field pixel; 0 where nothing landed."""
    q = points - np.asarray(center, np.float64)[:, None]
    x, y = dirs_to_pano(q, fw, fh)
    ix = np.round(x).astype(np.int64) % fw
    iy = np.clip(np.round(y).astype(np.int64), 0, fh - 1)
    field = np.zeros((fh, fw), np.float32)
    np.maximum.at(field, (iy, ix), (1.0 / np.maximum(np.linalg.norm(q, axis=0), 1e-3)))
    for _ in range(HOLE_GROW_ITERS):
        # max = nearest neighbouring surface: grows foreground over splat gaps
        # rather than letting the proxy punch through an object.
        grown = cv2.dilate(field, np.ones((3, 3), np.uint8))
        field = np.where(field > 0, field, grown)
    return field


def proxy_field(cams, depths_m, center, fw, fh, default_m):
    """Inverse depth from one scalar depth per frame (featureDepthMedian or the
    fixed proxy), blended over the pano with each frame's centre weight so
    overlapping frames agree on one surface. Scalar when every frame agrees."""
    if len(set(depths_m)) <= 1:
        return np.float32(1.0 / (depths_m[0] if depths_m else default_m))
    dx, dy, dz = pano_rays(np.arange(fh), np.arange(fw), fw, fh)
    num = np.zeros((fh, fw), np.float32)
    den = np.zeros((fh, fw), np.float32)
    for cam, d in zip(cams, depths_m):
        px, py, inb = project(cam, center, dx, dy, dz, np.float32(1.0 / d))
        wgt = center_weight(cam, px, py) * inb
        num += wgt / d
        den += wgt
    field = np.where(den > 0, num / np.maximum(den, 1e-12), 1.0 / default_m).astype(np.float32)
    return cv2.GaussianBlur(field, (0, 0), fw / 128.0)  # no steps at footprint edges


def inverse_depth_field(points, proxy, center, fw=FIELD_WIDTH):
    """Final field: depth-map splats where they landed, the proxy elsewhere."""
    if not points:
        return proxy
    fh = fw // 2
    field = splat(np.concatenate(points, axis=1), center, fw, fh)
    fallback = np.broadcast_to(np.asarray(proxy, np.float32), field.shape)
    field = np.where(field > 0, field, fallback).astype(np.float32)
    return cv2.medianBlur(field, 5)  # drop single-pixel z-fighting speckle
