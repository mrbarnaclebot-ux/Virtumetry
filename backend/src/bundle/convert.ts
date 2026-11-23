// ARKit -> Echo-3 (OpenCV) pose conversion (D-03). Pure, unit-tested on Windows.

/** D-06: rotation columns must be unit length and mutually orthogonal within this. */
export const ROT_TOL = 1e-4;
/** D-06: det(R) must be within this of +1 (no reflection, no scale). */
export const DET_TOL = 1e-4;
/** D-06: bottom row of the 4x4 must be [0,0,0,1] within this. */
export const BOTTOM_ROW_TOL = 1e-6;

/** ARKit world_from_camera (16 floats, column-major simd layout) -> OpenCV camera_from_world, row-major [4][4]. */
export function arkitToOpenCV(T: readonly number[]): number[][] {
  if (T.length !== 16) throw new Error('T_arkit must have 16 values');
  const R = (r: number, c: number) => T[c * 4 + r]!;          // column-major read
  const t = [T[12]!, T[13]!, T[14]!];
  const out: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const s = r === 0 ? 1 : -1;                                 // D = diag(1,-1,-1,1) on the LEFT
    const row = [R(0, r), R(1, r), R(2, r)];                    // row r of R^T
    const tr = -(row[0]! * t[0]! + row[1]! * t[1]! + row[2]! * t[2]!); // (-R^T t)_r
    out.push([s * row[0]!, s * row[1]!, s * row[2]!, s * tr]);
  }
  out.push([0, 0, 0, 1]);
  return out;
}

/** Camera centre in ARKit world coordinates (metres). */
export function cameraCentre(T: readonly number[]): [number, number, number] {
  return [T[12]!, T[13]!, T[14]!];
}

/** D-06 "valid 4x4" on the raw column-major ARKit transform. Empty = valid. Run before arkitToOpenCV (rigid inverse assumes orthonormal R). */
export function rotationIssues(T: readonly number[]): string[] {
  const out: string[] = [];
  const col = (c: number) => [T[c * 4]!, T[c * 4 + 1]!, T[c * 4 + 2]!];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const [x, y, z] = [col(0), col(1), col(2)];
  for (const [name, v] of [['x', x], ['y', y], ['z', z]] as const) {
    if (Math.abs(Math.sqrt(dot(v, v)) - 1) > ROT_TOL) out.push(`rotation column ${name} is not unit length`);
  }
  if (Math.abs(dot(x, y)) > ROT_TOL || Math.abs(dot(x, z)) > ROT_TOL || Math.abs(dot(y, z)) > ROT_TOL) {
    out.push('rotation columns are not orthogonal');
  }
  const cross = [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!];
  if (Math.abs(dot(cross, z) - 1) > DET_TOL) out.push('det(R) is not +1');
  const bottom = [T[3]!, T[7]!, T[11]!, T[15]!];
  if (bottom.some((v, k) => !Number.isFinite(v) || Math.abs(v - (k === 3 ? 1 : 0)) > BOTTOM_ROW_TOL)) {
    out.push('bottom row is not [0,0,0,1]');
  }
  return out;
}
