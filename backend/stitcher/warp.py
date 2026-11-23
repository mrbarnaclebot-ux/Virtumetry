"""Pano <-> camera reprojection with translation (spec §5.2 item 5).

The pano is centred on the centroid of the camera positions, not on any one
camera. A pano pixel is a ray from that centre; the surface it sees sits at
distance D along the ray (from a depth map, a feature depth or a fixed proxy).
Each camera then samples that 3-D point with its FULL pose. Rotation-only
reprojection is the D = infinity case, which is why everything here is written
in INVERSE depth (invd = 1/D): 0 means "infinitely far" and needs no special
case, and the pose-less fallback (all camera origins 0) reduces to exactly the
old rotation-only mapping.

Ray-grid convention (R17, see reproject.py): longitude grows with image-x and
leans toward -X, i.e. dx = -cos(lat) sin(lon). Do not flip it.
"""

from __future__ import annotations  # Cam's annotations: tests stub numpy out

import math
from typing import NamedTuple

import cv2
import numpy as np


class Cam(NamedTuple):
    """One frame's camera, for the (prefiltered, upright) image it samples."""

    r: np.ndarray  # 3x3 world -> projection camera; rows = (right, up, forward)
    o: np.ndarray  # camera centre in world metres (ARKit transform column 3)
    fx: float
    fy: float
    w: int
    h: int


def pano_rays(rows, cols, w, h):
    """float32 world unit rays (dx, dy, dz), each len(rows) x len(cols), for
    pano pixels of a w x h equirect. `cols` may run past w: they wrap."""
    lon = (((np.asarray(cols) % w) + 0.5) / w * 2.0 - 1.0) * math.pi
    lat = (0.5 - (np.asarray(rows) + 0.5) / h) * math.pi
    clat = np.cos(lat)[:, None]
    dx = (-clat * np.sin(lon)[None, :]).astype(np.float32)
    dz = (clat * np.cos(lon)[None, :]).astype(np.float32)
    dy = np.broadcast_to(np.sin(lat).astype(np.float32)[:, None], dx.shape)
    return dx, dy, dz


def dirs_to_pano(q, w, h):
    """Continuous pano pixel coords (x, y) of world vectors q (3 x n) seen from
    the pano centre — the inverse of pano_rays."""
    d = np.maximum(np.linalg.norm(q, axis=0), 1e-9)
    lat = np.arcsin(np.clip(q[1] / d, -1.0, 1.0))
    lon = np.arctan2(-q[0], q[2])
    x = (lon / math.pi + 1.0) / 2.0 * w - 0.5
    y = (0.5 - lat / math.pi) * h - 0.5
    return x, y


def project(cam, center, dx, dy, dz, invd):
    """Pixel coords (px, py) in cam's image of the point at distance 1/invd
    from `center` along each ray, plus the in-image mask.

    cam-frame point = R (center + D d - o); dividing by D (projection is scale
    free) gives R d + R (center - o) * invd, so invd = 0 is pure rotation.
    Out-of-image / behind-camera coords are pushed to -1 so a BORDER_REPLICATE
    remap extrapolates there instead of reading garbage.
    """
    # float32 coefficients: a float64 scalar would promote every band-sized
    # array to float64 under NumPy 2's typing rules (2x memory, slower).
    r = np.asarray(cam.r, np.float32)
    v = (cam.r @ (np.asarray(center, np.float64) - cam.o)).astype(np.float32)
    zc = r[2, 0] * dx + r[2, 1] * dy + r[2, 2] * dz + v[2] * invd
    ok = zc > 1e-6
    zs = np.where(ok, zc, np.float32(1.0))
    xc = r[0, 0] * dx + r[0, 1] * dy + r[0, 2] * dz + v[0] * invd
    px = (np.float32(cam.fx) * xc / zs + np.float32(cam.w / 2.0)).astype(np.float32)
    del xc
    yc = r[1, 0] * dx + r[1, 1] * dy + r[1, 2] * dz + v[1] * invd
    py = (np.float32(cam.h / 2.0) - np.float32(cam.fy) * yc / zs).astype(np.float32)
    del yc, zs
    inb = ok & (px >= 0) & (px < cam.w - 1) & (py >= 0) & (py < cam.h - 1)
    px[~ok] = -1.0
    py[~ok] = -1.0
    return px, py, inb


def sample(img, px, py):
    """Bilinear sample img at 2-D float32 maps (any size cv2.remap accepts)."""
    return cv2.remap(img, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def center_weight(cam, px, py):
    """Separable tent falloff toward the frame edges, in [0, 1]."""
    nx = np.abs(px - cam.w / 2.0) / (cam.w / 2.0)
    ny = np.abs(py - cam.h / 2.0) / (cam.h / 2.0)
    return np.clip(1 - nx, 0, 1) * np.clip(1 - ny, 0, 1)


def sample_field(field, rows, cols, w, h):
    """Bilinear sample a low-res pano-space field (e.g. inverse depth) at the
    pano pixels rows x cols of a w x h equirect. A scalar field is returned
    as-is (the common no-depth case costs nothing)."""
    if np.isscalar(field):
        return np.float32(field)
    fh, fw = field.shape
    mx = (((np.asarray(cols) % w) + 0.5) * (fw / w) - 0.5).astype(np.float32)
    my = ((np.asarray(rows) + 0.5) * (fh / h) - 0.5).astype(np.float32)
    mx, my = np.meshgrid(mx, my)
    return cv2.remap(field, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def shrink(img, cam, pano_width, oversample):
    """INTER_AREA-shrink a frame to `oversample` x the pano's angular density
    (pixels per radian at the frame centre vs pano_width / 2pi), returning the
    image and its rescaled Cam. Never upsamples.

    Bilinear remap from a much denser frame point-samples it and aliases fine
    texture into moire/sparkle; area-averaging first is the anti-alias filter.
    """
    s = oversample * (pano_width / (2.0 * math.pi)) / max(cam.fx, cam.fy)
    if s >= 1.0:
        return img, cam
    size = (max(2, round(cam.w * s)), max(2, round(cam.h * s)))
    img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    sx, sy = size[0] / cam.w, size[1] / cam.h
    return img, cam._replace(fx=cam.fx * sx, fy=cam.fy * sy, w=size[0], h=size[1])


def render_layers(frames, center, invd, w, oversample=1.0, min_dy=-1.0):
    """Whole-canvas reprojection of every (img, cam) at a SMALL pano width w:
    [(uint8 BGR, bool mask, float32 centre weight)]. The analysis view that
    gains and seams are computed on; frames are shrunk to w's density first so
    the analysis image is not aliased either. Rays with dy <= min_dy (the
    nadir cap, see reproject.NADIR_CAP_DEG) count as uncovered."""
    h = w // 2
    rows, cols = np.arange(h), np.arange(w)
    dx, dy, dz = pano_rays(rows, cols, w, h)
    invd = sample_field(invd, rows, cols, w, h)
    out = []
    for img, cam in frames:
        img, cam = shrink(img, cam, w, oversample)
        px, py, inb = project(cam, center, dx, dy, dz, invd)
        inb &= dy > min_dy
        out.append((sample(img, px, py), inb, center_weight(cam, px, py).astype(np.float32)))
    return out
