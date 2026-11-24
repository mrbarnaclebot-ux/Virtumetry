/**
 * Floor-plan affines (D-08, D-11). Pure, no runtime imports.
 * [x, z, 1] = world_xz_from_pixel · [px, py, 1] (row-major 3x3, continuous pixel coords:
 * top-left pixel centre = (0.5, 0.5)). Source: docs.spaitial.ai/api/exports.
 * The `projection` string differs between docs and fixtures; it is deliberately not validated.
 */
import type { FloorplanMeta } from './types';

type Image = NonNullable<FloorplanMeta['image']>;
type Meta = { image: Image };

export const applyAffine = (m: number[][], x: number, y: number): [number, number] => [
  m[0][0] * x + m[0][1] * y + m[0][2],
  m[1][0] * x + m[1][1] * y + m[1][2],
];

export const pixelFromWorld = (meta: Meta, x: number, z: number) => applyAffine(meta.image.pixel_from_world_xz, x, z);

export const worldFromPixel = (meta: Meta, px: number, py: number) => applyAffine(meta.image.world_xz_from_pixel, px, py);

/** Tap offset on the displayed image (CSS px) → image pixels. No +0.5: the affines use continuous coords. */
export const tapToPixel = (offsetX: number, offsetY: number, clientW: number, clientH: number, meta: Meta): [number, number] => [
  (offsetX * meta.image.width_px) / clientW,
  (offsetY * meta.image.height_px) / clientH,
];

/** Camera forward (xz) → angle in image space (radians, atan2(y, x), y down). */
export function headingAngle(meta: Meta, fwdX: number, fwdZ: number) {
  const [[a, b], [c, d]] = meta.image.pixel_from_world_xz;
  return Math.atan2(c * fwdX + d * fwdZ, a * fwdX + b * fwdZ);
}

const isAffine = (m: unknown) =>
  Array.isArray(m) &&
  m.length >= 2 &&
  m.slice(0, 2).every((r) => Array.isArray(r) && r.length >= 3 && r.slice(0, 3).every(Number.isFinite));

/** T-05-24: only show the Plan button when both affines and a positive image size are present. */
export function hasFloorplan(meta: FloorplanMeta | null | undefined): meta is FloorplanMeta & Meta {
  const img = meta?.image;
  return (
    !!img &&
    img.width_px > 0 &&
    img.height_px > 0 &&
    isAffine(img.world_xz_from_pixel) &&
    isAffine(img.pixel_from_world_xz)
  );
}
