// Mirrored from backend/src/bundle/validate.ts; pinned by capture-precheck.test.ts (D-16).

/** A frame whose predicted blur (blurPx) is above this many pixels counts as blurry. */
export const BLUR_PX_THRESHOLD = 64;
/** Yaw coverage is counted in this many equal sectors. */
export const YAW_SECTORS = 12;
export const SECTOR_DEG = 360 / YAW_SECTORS;
/** Below this horizontal forward length the camera looks near vertical and has no yaw. */
export const MIN_HORIZONTAL_FORWARD = 0.3;
