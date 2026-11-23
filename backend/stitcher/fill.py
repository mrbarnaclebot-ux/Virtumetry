"""Hole filling after the blend: the nadir cap (the user's body, masked out on
purpose) in a polar view, then any residual hole with Telea as before v2."""

import math

import cv2
import numpy as np

from blend import band_rows


RELAX_ITERS = 150  # ~0.3 s at 512x512; the rim step is gone by ~100


def push_pull_fill(img, hole, source):
    """Fill `hole` pixels of img with a smooth membrane from the `source`
    pixels: average them down a pyramid, then pull coarse values back up only
    where finer levels have no data."""
    wt = (source & ~hole).astype(np.float32)
    acc = [img.astype(np.float32) * wt[:, :, None]]
    wts = [wt]
    while min(wts[-1].shape) > 4:
        acc.append(cv2.pyrDown(acc[-1]))
        wts.append(cv2.pyrDown(wts[-1]))
    fill = acc[-1] / np.maximum(wts[-1], 1e-6)[:, :, None]
    for a, w in zip(acc[-2::-1], wts[-2::-1]):
        up = cv2.pyrUp(fill, dstsize=(w.shape[1], w.shape[0]))
        # acc is premultiplied by w (in [0, 1]): top up the missing share.
        fill = a + (1.0 - np.minimum(w, 1.0))[:, :, None] * up
    # Push-pull alone leaves a step at the rim (the coarse average is not the
    # rim value); a few Jacobi sweeps pin the membrane to its boundary.
    out = img.astype(np.float32)
    out[hole] = fill[hole]
    for _ in range(RELAX_ITERS):
        out[hole] = cv2.blur(out, (3, 3))[hole]  # neighbours outside are fixed
    return np.clip(out, 0, 255).astype(img.dtype)


def fill_nadir(pano, mask, cap_deg, size=512, ring_deg=10.0):
    """Inpaint the nadir cap in a top-down polar view, then map it back.

    Equirect Telea fills each column straight down to the pole, which reads as
    a radial starburst on the floor. In an azimuthal view centred on the nadir
    the cap is a plain disc surrounded by real floor, and a push-pull fill
    interpolates it smoothly from the whole rim (Telea still streaks inward).
    Clears the cap from `mask` so fill_holes leaves it alone.
    """
    if cap_deg <= 0:
        return pano
    h, w = pano.shape[:2]
    rad = cap_deg + ring_deg  # polar view radius (deg from nadir)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u, v = (xx - size / 2) / (size / 2), (yy - size / 2) / (size / 2)
    r = np.sqrt(u * u + v * v) * rad
    lon = np.arctan2(u, -v)
    mx = ((lon / math.pi + 1) / 2 * w - 0.5).astype(np.float32)
    my = ((0.5 - (r - 90.0) / 180.0) * h - 0.5).astype(np.float32)
    polar = cv2.remap(pano, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    hole = (r < cap_deg + 0.5) | (cv2.remap(mask, mx, my, cv2.INTER_NEAREST) > 0)
    hole &= r < rad
    # Source = a thin rim only: a wide ring drags in whatever bright object
    # sits nearby (the desk) and lifts the whole disc.
    polar = push_pull_fill(polar, hole, r < cap_deg + 2.0)

    r0 = int(math.floor((1.0 - cap_deg / 180.0) * h))  # first cap row
    lat = 90.0 - (np.arange(r0, h) + 0.5) / h * 180.0
    lon = ((np.arange(w) + 0.5) / w * 2 - 1) * math.pi
    rr = ((90.0 + lat) / rad * (size / 2))[:, None]
    px = (size / 2 + np.sin(lon)[None, :] * rr - 0.5).astype(np.float32)
    py = (size / 2 - np.cos(lon)[None, :] * rr - 0.5).astype(np.float32)
    pano[r0:] = cv2.remap(polar, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    mask[r0:] = 0
    return pano


def fill_holes(pano, mask):
    """Inpaint residual holes at reduced res (holes are large plain surfaces),
    then composite the filled pixels back into the full-res pano.

    Composites with `np.copyto(..., where=)` rather than `np.where(...)`: the
    latter allocates a THIRD full-res image (100 MB at 8192x4096) while both
    inputs are still live. The `where=` mask is materialised one row band at a
    time for the same reason. `pano` is updated in place and also returned."""
    h, w = pano.shape[:2]
    if not mask.any():
        # Full coverage — every pixel would composite back to itself. Skips a
        # 2048-wide Telea inpaint and a full-res upscale for nothing.
        return pano
    sw = 2048
    sh = sw * h // w
    ps = cv2.resize(pano, (sw, sh))
    ms = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_NEAREST)
    ms = cv2.dilate(ms, np.ones((5, 5), np.uint8), iterations=1)
    filled = cv2.inpaint(ps, ms, 7, cv2.INPAINT_TELEA)
    del ps, ms
    fu = cv2.resize(filled, (w, h))
    for r0 in range(0, h, band_rows(w, h)):
        r1 = min(h, r0 + band_rows(w, h))
        np.copyto(pano[r0:r1], fu[r0:r1], where=(mask[r0:r1] > 0)[:, :, None])
    return pano
