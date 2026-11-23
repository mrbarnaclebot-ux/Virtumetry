import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure tests for reproject.py's pose-less nominal fallback angle table
// (pattern-aware by frame count). Unlike the smoke suite this needs NO cv2 —
// numpy/cv2 are stubbed via sys.modules before import, so it runs with any
// plain python3. Skipped only when python3 itself is missing.
const PY = process.env.STITCHER_TEST_PYTHON ?? 'python3';

function hasPython(): boolean {
  try {
    execFileSync(PY, ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const script = fileURLToPath(new URL('../stitcher/reproject.py', import.meta.url));

/** Run a python snippet with reproject imported as `m` (cv2/numpy stubbed). */
function runWithModule(snippet: string): string {
  const driver = `
import sys, types, json
np = types.ModuleType('numpy')
np.array = lambda x, dtype=None: x
np.float64 = 'float64'
sys.modules['numpy'] = np
sys.modules['cv2'] = types.ModuleType('cv2')
import importlib.util
spec = importlib.util.spec_from_file_location('reproject', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return execFileSync(PY, ['-c', driver], { encoding: 'utf8' });
}

describe.skipIf(!hasPython())('reproject.py nominal_angles (pattern-aware fallback)', () => {
  it('16 frames → the legacy layout (matches nominal_pose row for row)', () => {
    const out = runWithModule(`
legacy = [m.nominal_pose(i, 1, -1) for i in range(16)]
table = m.nominal_angles(16, 1, -1)
print(json.dumps(table == legacy))
print(json.dumps(len(table)))
`);
    const [same, count] = out.trim().split('\n');
    expect(JSON.parse(same!)).toBe(true);
    expect(JSON.parse(count!)).toBe(16);
  });

  it('28 frames → densified layout mirroring the iOS TargetLayout order', () => {
    const out = runWithModule(`
t = m.nominal_angles(28, 1, -1)
print(json.dumps(t))
`);
    const table: [number, number, number][] = JSON.parse(out.trim());
    expect(table).toHaveLength(28);
    // 12 horizon @30° spacing, pitch 0.
    for (let i = 0; i < 12; i++) expect(table[i]).toEqual([i * 30, 0, 0]);
    // 8 upper-ring @45° spacing, pitch = pitch_sign * 45 (winning params: -1).
    for (let i = 0; i < 8; i++) expect(table[12 + i]).toEqual([i * 45, -45, 0]);
    // 6 lower-ring @60° spacing, pitch = -pitch_sign * 45.
    for (let i = 0; i < 6; i++) expect(table[20 + i]).toEqual([i * 60, 45, 0]);
    // Zenith + nadir close the poles.
    expect(table[26]).toEqual([0, -90, 0]);
    expect(table[27]).toEqual([0, 90, 0]);
  });

  it('yaw_dir flips yaw sign across the whole table', () => {
    const out = runWithModule(`
t = m.nominal_angles(28, -1, -1)
print(json.dumps([t[1][0], t[13][0], t[21][0]]))
`);
    expect(JSON.parse(out.trim())).toEqual([-30, -45, -60]);
  });

  it('intrinsics reader tolerates COLUMN-major (iOS simd_float3x3) layout — exact prod sample', () => {
    const out = runWithModule(`
# Real sample from prod: simd_float3x3 flattened column-major by the client.
prod = [1500,0,0, 0,1500,0, 720,540,1]
row = [1500,0,720, 0,1500,540, 0,0,1]
zeroed = [0]*9
print(json.dumps(m.intrinsics_fx_fy_cx_cy(prod)))
print(json.dumps(m.intrinsics_fx_fy_cx_cy(row)))
print(json.dumps(m.pose_validation_error([
    {'index': 0, 'transform': [0,-0.99999994,0,0, 0.9393727,0,-0.34289777,0, 0.34289777,0,0.9393727,0, 0,1.4,0,1], 'intrinsics': prod}
], 1) is None))
print(json.dumps(m.pose_validation_error([
    {'index': 0, 'transform': [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], 'intrinsics': zeroed}
], 1)))
`);
    const [prod, row, prodValid, zeroReason] = out.trim().split('\n');
    // Column-major prod sample extracts the true fx/fy/cx/cy.
    expect(JSON.parse(prod!)).toEqual([1500, 1500, 720, 540]);
    // Row-major stays byte-identical.
    expect(JSON.parse(row!)).toEqual([1500, 1500, 720, 540]);
    // The prod pose (column-major transform + intrinsics) now VALIDATES.
    expect(JSON.parse(prodValid!)).toBe(true);
    // Only both-candidates-non-positive counts as invalid (→ warn+fallback).
    expect(JSON.parse(zeroReason!)).toContain('non-positive intrinsics');
  });

  it('unknown count → WARN + even horizon-only ring', () => {
    const out = runWithModule(`
t = m.nominal_angles(10, 1, -1)
print(json.dumps(t))
`);
    const lines = out.trim().split('\n');
    // First line is the WARN (nominal_angles logs it), last is the table.
    expect(lines.some((l) => l.includes('WARN unknown capture pattern'))).toBe(true);
    const table: [number, number, number][] = JSON.parse(lines[lines.length - 1]!);
    expect(table).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect(table[i]).toEqual([i * 36, 0, 0]);
  });
});
