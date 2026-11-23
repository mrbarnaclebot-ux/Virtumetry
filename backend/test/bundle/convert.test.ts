import { describe, it, expect } from 'vitest';
import { arkitToOpenCV, cameraCentre, rotationIssues } from '../../src/bundle/convert.js';
import { SessionV1, parseFramesJsonl } from '../../src/bundle/manifest.js';

/** Build a column-major ARKit transform from rotation columns (camera X/Y/Z in world) and position. */
function colMajor(x: number[], y: number[], z: number[], p: number[]): number[] {
  return [...x, 0, ...y, 0, ...z, 0, ...p, 1];
}

function expectMatClose(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(4);
  actual.forEach((row, r) => {
    expect(row).toHaveLength(4);
    row.forEach((v, c) => expect(v).toBeCloseTo(expected[r]![c]!, 9));
  });
}

const mul = (A: number[][], B: number[][]) =>
  A.map((row) => B[0]!.map((_, c) => row.reduce((s, v, k) => s + v * B[k]![c]!, 0)));

/** Generic 4x4 inverse via the rigid formula (R orthonormal). */
function rigidInv(M: number[][]): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const row = [M[0]![r]!, M[1]![r]!, M[2]![r]!];
    out.push([...row, -(row[0]! * M[0]![3]! + row[1]! * M[1]![3]! + row[2]! * M[2]![3]!)]);
  }
  out.push([0, 0, 0, 1]);
  return out;
}

const det3 = (M: number[][]) =>
  M[0]![0]! * (M[1]![1]! * M[2]![2]! - M[1]![2]! * M[2]![1]!) -
  M[0]![1]! * (M[1]![0]! * M[2]![2]! - M[1]![2]! * M[2]![0]!) +
  M[0]![2]! * (M[1]![0]! * M[2]![1]! - M[1]![1]! * M[2]![0]!);

describe('arkitToOpenCV', () => {
  it('D-03: identity rotation at (0,1.5,0) looking down -Z', () => {
    const T = colMajor([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1.5, 0]);
    expectMatClose(arkitToOpenCV(T), [
      [1, 0, 0, 0],
      [0, -1, 0, 1.5],
      [0, 0, -1, 0],
      [0, 0, 0, 1],
    ]);
  });

  it.each([0, 1, 2])('golden from SpAItial minimal-bundle, frame %i', (i) => {
    const T = colMajor([0, -1, 0], [1, 0, 0], [0, 0, 1], [0.1 * i, 1.4, 0]);
    expectMatClose(arkitToOpenCV(T), [
      [0, -1, 0, 1.4],
      [-1, 0, 0, 0.1 * i],
      [0, 0, -1, 0],
      [0, 0, 0, 1],
    ]);
  });

  it('returns nested [4][4] with bottom row [0,0,0,1] and det(R)=+1', () => {
    const c = Math.cos(0.7), s = Math.sin(0.7);
    const M = arkitToOpenCV(colMajor([c, 0, -s], [0, 1, 0], [s, 0, c], [1, 2, 3]));
    expect(Array.isArray(M[0])).toBe(true);
    expect(M[3]).toEqual([0, 0, 0, 1]);
    expect(Math.abs(det3(M) - 1)).toBeLessThan(1e-9);
  });

  it('round-trips: inv(D·M) reproduces the input pose', () => {
    const c = Math.cos(0.3), s = Math.sin(0.3);
    const T = colMajor([1, 0, 0], [0, c, s], [0, -s, c], [-0.4, 1.2, 2.5]);
    const D = [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]];
    const back = rigidInv(mul(D, arkitToOpenCV(T)));
    for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) expect(back[r]![col]!).toBeCloseTo(T[col * 4 + r]!, 9);
  });

  it('reprojects a point 2 m in front of the camera to the principal point', () => {
    const K = { fx: 535.4, fy: 539.2, cx: 320.1, cy: 247.6 };
    const c = Math.cos(0.5), s = Math.sin(0.5);
    // Camera yawed by 0.5 rad about +Y at (1, 1.5, -2). ARKit camera looks down its -Z.
    const T = colMajor([c, 0, -s], [0, 1, 0], [s, 0, c], [1, 1.5, -2]);
    const fwd = [-T[8]!, -T[9]!, -T[10]!];
    const P = [1 + 2 * fwd[0]!, 1.5 + 2 * fwd[1]!, -2 + 2 * fwd[2]!, 1];
    const M = arkitToOpenCV(T);
    const [x, y, z] = M.slice(0, 3).map((row) => row.reduce((acc, v, k) => acc + v * P[k]!, 0));
    expect(z!).toBeCloseTo(2, 9);
    expect(K.fx * (x! / z!) + K.cx).toBeCloseTo(K.cx, 9);
    expect(K.fy * (y! / z!) + K.cy).toBeCloseTo(K.cy, 9);
    // A point 0.1 m to the camera's right projects right of cx (OpenCV +X right).
    const Q = [P[0]! + 0.1 * T[0]!, P[1]! + 0.1 * T[1]!, P[2]! + 0.1 * T[2]!, 1];
    const [qx, , qz] = M.slice(0, 3).map((row) => row.reduce((acc, v, k) => acc + v * Q[k]!, 0));
    expect(K.fx * (qx! / qz!) + K.cx).toBeCloseTo(K.cx + K.fx * 0.05, 6);
  });

  it('throws on anything but 16 numbers', () => {
    expect(() => arkitToOpenCV([1, 2, 3])).toThrow();
    expect(() => arkitToOpenCV(new Array(17).fill(0))).toThrow();
  });
});

describe('cameraCentre / rotationIssues', () => {
  it('reads the translation column', () => {
    expect(cameraCentre(colMajor([1, 0, 0], [0, 1, 0], [0, 0, 1], [4, 5, 6]))).toEqual([4, 5, 6]);
  });
  it('accepts a proper rotation and flags scaled, reflected and bad bottom rows', () => {
    expect(rotationIssues(colMajor([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]))).toEqual([]);
    expect(rotationIssues(colMajor([2, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0])).length).toBeGreaterThan(0);
    expect(rotationIssues(colMajor([-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0])).length).toBeGreaterThan(0);
    const badRow = colMajor([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
    badRow[3] = 0.5;
    expect(rotationIssues(badRow).length).toBeGreaterThan(0);
  });
});

describe('manifest schema 1', () => {
  const session = {
    sessionId: 's1', schema: 1, device: 'iPhone', appVersion: '1.0.0', imageWidth: 640, imageHeight: 480,
    startedAtISO: '2012-07-09T15:33:00.722Z', tzOffset: '+02:00', gateConfig: {},
  };
  it('accepts a valid session and rejects schema 2 and a "+0200" offset', () => {
    expect(SessionV1.safeParse(session).success).toBe(true);
    expect(SessionV1.safeParse({ ...session, schema: 2 }).success).toBe(false);
    expect(SessionV1.safeParse({ ...session, tzOffset: '+0200' }).success).toBe(false);
  });
  it('parseFramesJsonl parses lines and reports the 1-based line of a bad one', () => {
    const line = {
      i: 1, file: 'frames/000001.jpg', t: 0, wallMs: 1000, T_arkit: colMajor([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]),
      K: { fx: 500, fy: 500, cx: 320, cy: 240 }, tracking: 'normal',
    };
    const good = JSON.stringify(line);
    expect(parseFramesJsonl(`${good}\n${good}\n\n`)).toHaveLength(2);
    const bad = JSON.stringify({ ...line, T_arkit: [1, 2] });
    expect(() => parseFramesJsonl(`${good}\n${bad}\n`)).toThrow(/line 2: T_arkit/);
    expect(() => parseFramesJsonl(`${good}\nnot json\n`)).toThrow(/line 2/);
  });
});
