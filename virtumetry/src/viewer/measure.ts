/** Measure math (D-12, UI-SPEC B7). Pure, no imports. */
export type Vec3 = readonly [number, number, number];

export const TAP_MAX_PX = 8;
export const TAP_MAX_MS = 300;

export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const formatDistance = (m: number) => `≈ ${m.toFixed(2)} m (approx.)`;

export const announceDistance = (m: number) => `Distance about ${m.toFixed(2)} metres, approximate`;

/** A tap is a touch that moved < 8 px and lasted < 300 ms. */
export const isTap = (dx: number, dy: number, ms: number) => Math.hypot(dx, dy) < TAP_MAX_PX && ms < TAP_MAX_MS;
