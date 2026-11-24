/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  cameraToThree,
  F,
  fallbackPose,
  matToPose,
  mul4,
  needsFlip,
  rigidInverse,
  splatFrameFor,
  toMat4,
  type Mat4,
} from '@/viewer/coords';

const CAMERAS = JSON.parse(
  readFileSync(join(__dirname, '../../../backend/test/fixtures/mock-outputs/cameras.json'), 'utf8'),
) as { frames: { camera_from_splat: number[][] }[] };

const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const det3 = (m: Mat4) =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

/** Rotate v by unit quaternion [x,y,z,w]. */
function rotate([x, y, z, w]: number[], v: number[]) {
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

describe('coords (D-08)', () => {
  it('F is its own inverse', () => close(mul4(F, F), I));

  it('identity camera_from_splat: camera at origin, looking -Z, +Y up', () => {
    const T = cameraToThree(I);
    close(T, I);
    const pose = matToPose(T);
    close(pose.position, [0, 0, 0]);
    close(rotate(pose.quaternion, [0, 0, -1]), [0, 0, -1]);
    close(rotate(pose.quaternion, [0, 1, 0]), [0, 1, 0]);
  });

  it('round-trips a known T and keeps det +1', () => {
    const c = Math.cos(0.7), s = Math.sin(0.7);
    // yaw 0.7 rad about Y, at (1, 1.6, -2)
    const T: Mat4 = [c, 0, s, 1, 0, 1, 0, 1.6, -s, 0, c, -2, 0, 0, 0, 1];
    const cameraFromSplat = mul4(mul4(F, rigidInverse(T)), F);
    const back = cameraToThree(cameraFromSplat);
    close(back, T);
    expect(det3(back)).toBeCloseTo(1, 9);
    const pose = matToPose(back);
    close(pose.position, [1, 1.6, -2]);
    close(rotate(pose.quaternion, [0, 0, -1]), [-s, 0, -c]);
  });

  it('converts every mock cameras.json frame without NaN', () => {
    expect(CAMERAS.frames.length).toBeGreaterThan(0);
    for (const f of CAMERAS.frames) {
      const T = cameraToThree(toMat4(f.camera_from_splat));
      expect(T.every(Number.isFinite)).toBe(true);
      expect(det3(T)).toBeCloseTo(1, 6);
      const p = matToPose(T);
      expect([...p.position, ...p.quaternion].every(Number.isFinite)).toBe(true);
    }
  });

  it('fallbackPose: bounds centre at eye height, looking along the longer horizontal axis', () => {
    const wideX = fallbackPose({ min: [-3, 0.2, -1], max: [5, 2.5, 1] });
    close(wideX.position, [1, 1.8, 0]);
    const fx = rotate(wideX.quaternion, [0, 0, -1]);
    expect(Math.abs(fx[0])).toBeCloseTo(1, 9);
    expect(fx[1]).toBeCloseTo(0, 9);

    const deepZ = fallbackPose({ min: [-1, 0, -4], max: [1, 2, 4] });
    close(deepZ.position, [0, 1.6, 0]);
    const fz = rotate(deepZ.quaternion, [0, 0, -1]);
    expect(Math.abs(fz[2])).toBeCloseTo(1, 9);
  });

  it('needsFlip detects an (x,-y,-z) mirrored box', () => {
    const scene = { min: [-2, 0, -1], max: [2, 2.5, 3] };
    expect(needsFlip(scene, scene)).toBe(false);
    expect(needsFlip({ min: [-2, -2.5, -3], max: [2, 0, 1] }, scene)).toBe(true);
  });

  it('splatFrameFor: raw SPZ is RDF, everything else Y-up', () => {
    expect(splatFrameFor('spz')).toBe('rdf');
    expect(splatFrameFor('ply')).toBe('yup');
  });
});
