"""Camera / panorama coordinate conventions shared by every stitcher stage.

Split out of reproject.py so the reprojection, depth and bench code agree on
ONE definition of the ARKit -> projection-camera basis (see reproject.py's
module docstring for the full convention derivation and the R17 mirror bug).
Module-level code uses only np.array: stitcher.nominal.test.ts imports
reproject.py with numpy and cv2 stubbed out.
"""

import math

import numpy as np

# Constant mapping from ARKit camera axes to the projection-camera axes, applied
# AFTER the frame is rotated 90 deg clockwise into portrait-upright. Derivation:
#   The optical axis is ARKit -Z, which must become projection-forward +Z.
#   Rotating the landscape image 90 deg CW makes native "up" (+Y_ak) the new
#   image-right, and native "right" (+X_ak) the new image-down; hence:
#       X_proj (right) = +Y_ak
#       Y_proj (up)    = -X_ak
#       Z_proj (fwd)   = -Z_ak
#   Rows of M are those projection axes expressed in ARKit-camera coordinates.
#   det(M) = -1 is EXPECTED and REQUIRED, not a bug: the rows of the resulting
#   R_proj are the camera's (right, up, forward) axes in WORLD coordinates, and
#   for a right-handed world those three are always a left-handed triple
#   (right x up = -forward). Every pose in a real device capture has
#   det(R_proj) = -1; it is the equirect ray grid's longitude sign, not this
#   matrix, that has to agree with it (see build()).
ARKIT_TO_PROJ = np.array(
    [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, -1.0]], dtype=np.float64
)

# The same rebasing for the pose-less nominal path. rmat() returns a PROPER
# rotation whose columns are the nominal orientation's rotated world axes
# (column 2 = camera forward, column 1 = camera up); the projection camera's
# RIGHT axis is the negative of column 0, because "right" in a right-handed
# +Y-up world is -X for a camera looking along +Z. Applying FLIP_RIGHT gives the
# nominal path the same det(R_proj) = -1 as the ARKit path, so both agree with
# the ray grid.
FLIP_RIGHT = np.array(
    [[-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64
)


def rmat(yaw, pitch, roll):
    """World rotation of a nominal yaw/pitch/roll orientation (degrees).

    Columns are the rotated world axes; column 2 is the camera FORWARD and
    column 1 the camera UP. `yaw` is a RIGHTWARD turn (clockwise seen from
    above, i.e. about -Y), matching how the guided capture asks the user to
    turn and how the equirect's longitude is measured — yaw +90 looks along -X.
    `pitch` is about world +X (positive looks DOWN), `roll` about the forward
    axis (always 0 in the nominal tables).

    This is NOT yet a projection-camera rotation: the projection camera's right
    axis is the negative of column 0, so callers use FLIP_RIGHT @ rmat(...).T.
    """
    y, p, r = map(math.radians, (yaw, pitch, roll))
    cy, sy = math.cos(y), math.sin(y)
    cp, sp = math.cos(p), math.sin(p)
    cr, sr = math.cos(r), math.sin(r)
    ry = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return ry @ rx @ rz


def derive_pose_rotation(transform):
    """R_proj (world->projection-camera) from an ARKit 4x4 transform.

    `transform` is 16 numbers in COLUMN-MAJOR order (ARKit's simd_float4x4),
    camera-to-world. Its upper-left 3x3 R_ak maps ARKit-camera -> world.
    R_ak.T maps world -> ARKit-camera; ARKIT_TO_PROJ then rebases into the
    upright projection camera. Translation (column 3) is intentionally ignored.
    """
    t = [float(x) for x in transform]
    if len(t) != 16:
        raise ValueError(f"transform must have 16 elements, got {len(t)}")
    # column-major: element(row, col) = t[col * 4 + row]
    r_ak = np.array(
        [
            [t[0], t[4], t[8]],
            [t[1], t[5], t[9]],
            [t[2], t[6], t[10]],
        ],
        dtype=np.float64,
    )
    return ARKIT_TO_PROJ @ r_ak.T


def intrinsics_fx_fy_cx_cy(intrinsics):
    """Convention-tolerant (fx, fy, cx, cy) from 9 intrinsics floats.

    The iOS client flattens ARKit's simd_float3x3 COLUMN-major —
    [fx,0,0, 0,fy,0, cx,cy,1] (cx at [6], cy at [7]) — while this script
    historically read ROW-major [fx,0,cx, 0,fy,cy, 0,0,1] (cx at [2], cy at
    [5]); that mismatch made real captures look like "zeroed" centers. fx/fy
    sit on the diagonal ([0]/[4]) in BOTH conventions; for the principal point
    prefer the row-major slot and fall back to the column-major one when the
    row-major slot is non-positive. Raises ValueError on wrong length or
    non-numeric values; positivity is the CALLER's check (a non-positive
    result after both fallbacks means genuinely unusable intrinsics).
    """
    k = [float(x) for x in intrinsics]
    if len(k) != 9:
        raise ValueError(f"intrinsics must have 9 elements, got {len(k)}")
    fx, fy = k[0], k[4]
    cx = k[2] if k[2] > 0 else k[6]
    cy = k[5] if k[5] > 0 else k[7]
    return fx, fy, cx, cy


def focals_from_intrinsics(intrinsics, wf, hf):
    """Per-axis focal lengths (pixels) for the UPRIGHT wf x hf image.

    `intrinsics` is 9 numbers (row- OR column-major — see
    intrinsics_fx_fy_cx_cy), expressed in the ARKit-native landscape sensor
    frame. We recover the native FOVs (resolution-independent) and re-derive
    focals for the actual upright image so a resolution mismatch between
    intrinsics and frame does not matter. After the 90 deg CW rotation the
    upright WIDTH spans the native VERTICAL FOV and the upright HEIGHT spans
    the native HORIZONTAL FOV.
    """
    fx, fy, cx, cy = intrinsics_fx_fy_cx_cy(intrinsics)
    if fx <= 0 or fy <= 0 or cx <= 0 or cy <= 0:
        raise ValueError("intrinsics fx/fy/cx/cy must be positive")
    ref_w, ref_h = 2.0 * cx, 2.0 * cy  # native landscape sensor extent
    hfov_native = 2.0 * math.atan(ref_w / (2.0 * fx))
    vfov_native = 2.0 * math.atan(ref_h / (2.0 * fy))
    focal_x = (wf / 2.0) / math.tan(vfov_native / 2.0)  # upright width  <- native vertical
    focal_y = (hf / 2.0) / math.tan(hfov_native / 2.0)  # upright height <- native horizontal
    return focal_x, focal_y
