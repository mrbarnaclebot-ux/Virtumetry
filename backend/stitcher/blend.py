"""Banded, wrap-aware multi-band (Laplacian pyramid) blending.

Burt-Adelson: each frame's Laplacian pyramid is weighted by the Gaussian
pyramid of its seam mask, so low frequencies (exposure, vignetting) blend over
a wide zone while edges switch frames sharply at the seam — no doubled edges,
no visible step. Hand-rolled rather than cv2.detail.MultiBandBlender because
that one (a) knows nothing about the equirect's horizontal wrap, so the back
seam at lon = +-180 would never blend, and (b) needs the whole pano's pyramid
resident, which breaks the R8 memory bound at 8192.

Banding: the pano is processed in row bands with a margin of MARGIN_STEPS
pyramid cells on each side, so every output row sees (nearly) the same
neighbourhood it would in a whole-pano blend. Every row/column offset handed to
the pyramids is a multiple of 2**levels so all layers' levels line up.
"""

import cv2
import numpy as np

# Peak-RSS control (spec §10 R8). The full-res blend runs in horizontal row
# BANDS of ~1 Mpx (256 rows at 4096) plus a pyramid margin, so ray grids,
# warped patches and pyramid accumulators are O(band) not O(width^2). Measured
# on the 28-frame 2026-09-17 capture (macOS peak RSS, which also counts freed
# pages): ~0.98 GB at 4096, ~1.43 GB at 8192.
BAND_TARGET_PIXELS = 1024 * 1024


MAX_LEVELS = 5  # 32x at 4096: blend zone ~100 px (~8 deg), enough for exposure
MIN_COARSE_COLS = 128  # fewer levels on narrow panos: same blend zone in DEGREES
MARGIN_STEPS = 4  # band margin in coarsest-level cells; truncation error ~0


def band_rows(width, height, target_pixels=BAND_TARGET_PIXELS):
    """Rows per reprojection band for an equirect of `width` x `height`."""
    rows = max(1, int(target_pixels) // max(1, int(width)))
    return max(1, min(int(height), rows))


def levels_for(width):
    """Pyramid depth for a pano of `width`: <= MAX_LEVELS, divides the width
    (the wrap must line up at every level) and keeps >= MIN_COARSE_COLS
    coarse columns, so the transition is ~8 deg wide at every width."""
    lv = MAX_LEVELS
    while lv > 0 and (width % (1 << lv) or (width >> lv) < MIN_COARSE_COLS):
        lv -= 1
    return lv


def gaussian(img, levels):
    pyr = [img]
    for _ in range(levels):
        pyr.append(cv2.pyrDown(pyr[-1]))
    return pyr


def laplacian(img, levels):
    g = gaussian(img, levels)
    for k in range(levels):
        h, w = g[k].shape[:2]
        g[k] = g[k] - cv2.pyrUp(g[k + 1], dstsize=(w, h))
    return g


def pyr_up_wrap(img, size):
    """pyrUp whose horizontal border wraps around the sphere."""
    p = 2
    padded = np.concatenate([img[:, -p:], img, img[:, :p]], axis=1)
    up = cv2.pyrUp(padded, dstsize=(2 * padded.shape[1], size[1]))
    return up[:, 2 * p:2 * p + size[0]]


class Band:
    """Pyramid accumulators for one row band [r0, r0 + rows) of a w-wide pano."""

    def __init__(self, r0, rows, w, levels):
        self.r0, self.w, self.levels = r0, w, levels
        self.acc = [np.zeros((rows >> k, w >> k, 3), np.float32) for k in range(levels + 1)]
        self.wsum = [np.zeros((rows >> k, w >> k), np.float32) for k in range(levels + 1)]

    def add(self, img, weight, row0, col0, crop=0):
        """Accumulate one layer patch. img float32 HxWx3 and weight float32 HxW
        sit at absolute pano row `row0` and unwrapped column `col0` (both
        multiples of 2**levels). `crop` columns are trimmed from each side
        after the pyramid is built (wrap padding of a full-width layer)."""
        lap = laplacian(img, self.levels)
        gw = gaussian(weight, self.levels)
        for k in range(self.levels + 1):
            c = crop >> k
            lk = lap[k][:, c:lap[k].shape[1] - c] if c else lap[k]
            wk = gw[k][:, c:gw[k].shape[1] - c] if c else gw[k]
            rs = slice((row0 - self.r0) >> k, ((row0 - self.r0) >> k) + lk.shape[0])
            cols = (((col0 + crop) >> k) + np.arange(lk.shape[1])) % (self.w >> k)
            self.acc[k][rs, cols] += lk * wk[:, :, None]
            self.wsum[k][rs, cols] += wk

    def collapse(self):
        """(float32 band image, bool covered-at-full-res mask)."""
        out = None
        for k in range(self.levels, -1, -1):
            lev = self.acc[k] / np.maximum(self.wsum[k], 1e-8)[:, :, None]
            if out is not None:
                lev += pyr_up_wrap(out, (lev.shape[1], lev.shape[0]))
            out = lev
        return out, self.wsum[0] > 1e-6


def roi_from_mask(mask, w, h, step, pad):
    """Full-res patch (row0, row1, col0, col1, crop) covering an analysis-scale
    ownership mask, grown by `pad` px of blur support and aligned to `step`.

    Columns are an UNWRAPPED range (col0 may be negative, col1 may pass w): the
    shortest arc around the sphere that covers the mask, so a frame straddling
    lon = +-180 is one patch. A patch that would wrap onto itself becomes the
    full circle plus `crop` px of wrap padding on each side, trimmed after the
    pyramid is built. None when the mask is empty.
    """
    ha, wa = mask.shape
    rows = np.nonzero(mask.any(axis=1))[0]
    if rows.size == 0:
        return None
    sy, sx = h / ha, w / wa
    h_pad = -(-h // step) * step
    align_dn = lambda v: int(np.floor(v / step)) * step  # noqa: E731
    align_up = lambda v: int(np.ceil(v / step)) * step  # noqa: E731
    r0 = max(0, align_dn(rows[0] * sy - pad))
    r1 = min(h_pad, align_up((rows[-1] + 1) * sy + pad))

    cols = np.nonzero(mask.any(axis=0))[0]
    gaps = np.diff(np.concatenate([cols, [cols[0] + wa]]))  # gap AFTER each column
    g = int(np.argmax(gaps))
    start = cols[(g + 1) % cols.size]
    end = cols[g] + 1
    if end <= start:
        end += wa
    c0, c1 = align_dn(start * sx - pad), align_up(end * sx + pad)
    if c1 - c0 >= w:
        crop = align_up(pad)
        return r0, r1, -crop, w + crop, crop
    return r0, r1, c0, c1, 0
