/**
 * Coordinates in one place (D-03, D-08). Pure, no runtime imports.
 *
 * SpAItial (docs.spaitial.ai/api/llm-skills + /api/exports):
 * - F = diag(1,-1,-1,1), its own inverse. Raw SPZ splats are RDF (OpenCV): p_world = F · p_splat.
 *   Converted PLY/SOG are already Y-up.
 * - cameras.json `camera_from_splat` is an OpenCV camera (x right, y down, z forward).
 * - camera_from_world (OpenCV) C_w = camera_from_splat · F; three's camera matrixWorld (GL camera, -Z forward)
 *   T = inv(C_w) · F = F · inv(camera_from_splat) · F.
 * - Inverse (demo-room generator): camera_from_splat = F · inv(T) · F.
 */
import type { Bounds, Pose } from './types';

export type { Bounds, Pose };

/** 4x4 matrix, row-major, 16 numbers. */
export type Mat4 = number[];

export const EYE_HEIGHT = 1.6;

export const F: Mat4 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

export const toMat4 = (rows: number[][]): Mat4 => rows.flat();

export function mul4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  return out;
}

/** Inverse of a rigid transform [R t; 0 1] = [Rᵀ -Rᵀt; 0 1]. */
export function rigidInverse(m: Mat4): Mat4 {
  const [r00, r01, r02, tx, r10, r11, r12, ty, r20, r21, r22, tz] = m;
  return [
    r00, r10, r20, -(r00 * tx + r10 * ty + r20 * tz),
    r01, r11, r21, -(r01 * tx + r11 * ty + r21 * tz),
    r02, r12, r22, -(r02 * tx + r12 * ty + r22 * tz),
    0, 0, 0, 1,
  ];
}

/** OpenCV camera_from_splat (rows or flat) → three camera matrixWorld. */
export function cameraToThree(cameraFromSplat: Mat4 | number[][]): Mat4 {
  const C = Array.isArray(cameraFromSplat[0]) ? toMat4(cameraFromSplat as number[][]) : (cameraFromSplat as Mat4);
  return mul4(mul4(F, rigidInverse(C)), F);
}

/** Rigid matrix → three pose (position + [x,y,z,w] quaternion). */
export function matToPose(m: Mat4): Pose {
  const [m00, m01, m02, , m10, m11, m12, , m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return { position: [m[3], m[7], m[11]], quaternion: [x, y, z, w] };
}

/** No cameras: scene-bounds centre at eye height, looking along the longer horizontal axis (D-07). */
export function fallbackPose({ min, max }: Bounds): Pose {
  const position: Pose['position'] = [(min[0] + max[0]) / 2, min[1] + EYE_HEIGHT, (min[2] + max[2]) / 2];
  const h = Math.SQRT1_2;
  // -90° about Y turns three's -Z forward into +X.
  return max[0] - min[0] >= max[2] - min[2]
    ? { position, quaternion: [0, -h, 0, h] }
    : { position, quaternion: [0, 0, 0, 1] };
}

function overlap(a: Bounds, b: Bounds): number {
  let v = 1;
  for (let i = 0; i < 3; i++) v *= Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]));
  return v;
}

/** True when bbox matches sceneBounds better after (x,-y,-z) (RDF → Y-up) than as-is (Pitfall 9). */
export function needsFlip(bbox: Bounds, sceneBounds: Bounds): boolean {
  const flipped = {
    min: [bbox.min[0], -bbox.max[1], -bbox.max[2]],
    max: [bbox.max[0], -bbox.min[1], -bbox.min[2]],
  };
  return overlap(flipped, sceneBounds) > overlap(bbox, sceneBounds);
}

/** Raw SPZ is RDF; converted PLY/SOG/others are Y-up. */
export const splatFrameFor = (type: string): 'rdf' | 'yup' => (type === 'spz' ? 'rdf' : 'yup');
