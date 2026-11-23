"""Graph-cut seam selection at analysis scale (spec §5.2 item 5).

Averaging every overlapping frame (the pre-v2 feather) turns any residual
misregistration into doubled edges. Instead each pano pixel is given to ONE
frame, with the boundaries routed by cv2.detail's GraphCutSeamFinder
(COST_COLOR_GRAD) through places where the frames agree; blend.py then hides
the cuts with a multi-band blend.

cv2.detail has no notion of the equirect's horizontal wrap, so a frame that
straddles lon = +-180 is handed to it as two pieces (one per contiguous column
run). The two sides of the wrap line are then cut independently; at worst that
is one more straight seam, which the wrap-aware multi-band blend smooths.
"""

import cv2
import numpy as np

from gains import apply_gain

ERODE_PX = 1  # keep seams off the frames' outermost (replicate-padded) pixels


def column_runs(cols):
    """Contiguous runs of a sorted index array."""
    return np.split(cols, np.nonzero(np.diff(cols) > 1)[0] + 1)


def find_seams(images, gains, masks, weights):
    """Per-frame uint8 (0/1) ownership masks over the analysis canvas.

    images  uint8 BGR canvases, compensated by `gains` piece by piece (a
            float32 copy of every whole canvas would cost ~6 MB per frame)
    masks   bool coverage canvases
    weights float32 centre weights, used only to give a frame any covered
            pixel the seam finder left unowned (it only arbitrates overlaps).
    """
    # The finder takes UMats; with OpenCL on they land in a device buffer pool
    # that is never handed back (hundreds of MB of RSS on a CPU-only worker).
    cv2.ocl.setUseOpenCL(False)
    kernel = np.ones((2 * ERODE_PX + 1, 2 * ERODE_PX + 1), np.uint8)
    pieces, corners, pmasks, owner = [], [], [], []
    for k, (img, m) in enumerate(zip(images, masks)):
        m8 = cv2.erode(m.astype(np.uint8) * 255, kernel)
        cols = np.nonzero(m8.any(axis=0))[0]
        if cols.size == 0:
            continue
        for run in column_runs(cols):
            x0, x1 = int(run[0]), int(run[-1]) + 1
            rows = np.nonzero(m8[:, x0:x1].any(axis=1))[0]
            y0, y1 = int(rows[0]), int(rows[-1]) + 1
            pieces.append(apply_gain(img[y0:y1, x0:x1], gains[k]))
            corners.append((x0, y0))
            pmasks.append(cv2.UMat(np.ascontiguousarray(m8[y0:y1, x0:x1])))
            owner.append(k)

    found = cv2.detail_GraphCutSeamFinder("COST_COLOR_GRAD").find(pieces, corners, pmasks)

    h, w = masks[0].shape
    seams = [np.zeros((h, w), np.uint8) for _ in images]
    for k, (x0, y0), pm in zip(owner, corners, found):
        pm = pm.get() if isinstance(pm, cv2.UMat) else pm
        ph, pw = pm.shape
        seams[k][y0:y0 + ph, x0:x0 + pw] |= (pm > 0).astype(np.uint8)

    # Covered but unowned (eroded rims, finder leftovers): best-centred frame.
    owned = np.any(seams, axis=0)
    wts = np.where(masks, weights, -1.0)  # n x h x w; analysis scale, small
    best = np.argmax(wts, axis=0)
    hole = ~owned & np.any(masks, axis=0)
    for k in range(len(seams)):
        seams[k][hole & (best == k)] = 1
    return seams
