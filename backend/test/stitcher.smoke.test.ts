import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end smoke for stitcher/reproject.py. Runs ONLY when a Python with cv2
// + numpy is available (skipIf otherwise) — no network, no DB. Point it at a
// specific interpreter with STITCHER_TEST_PYTHON (e.g. a venv) if the default
// `python3` lacks the deps.
const PY = process.env.STITCHER_TEST_PYTHON ?? 'python3';

function pyHasDeps(): boolean {
  try {
    execFileSync(PY, ['-c', 'import cv2, numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = pyHasDeps();
const script = fileURLToPath(new URL('../stitcher/reproject.py', import.meta.url));

describe.skipIf(!available)('reproject.py smoke', () => {
  it('produces a 2:1 pano from tiny synthetic frames + poses (width 512)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-smoke-'));
    try {
      const framesDir = path.join(dir, 'frames');
      const posesPath = path.join(dir, 'poses.json');
      // Generate 3 solid-color landscape frames + synthetic ARKit poses via cv2.
      // Transforms are built as R_ak = R_nominal @ ARKIT_TO_PROJ so the stitcher's
      // pose math places them at yaw 0/120/240 around the horizon.
      const gen = `
import cv2, numpy as np, json, os, math
fd = ${JSON.stringify(framesDir)}
os.makedirs(fd, exist_ok=True)
colors = [(60,60,200),(60,200,60),(200,60,60)]
W, H = 640, 480
for i, c in enumerate(colors):
    img = np.zeros((H, W, 3), np.uint8); img[:] = c
    cv2.imwrite(os.path.join(fd, f'frame_{i}.jpg'), img)
def rot_y(a):
    ca, sa = math.cos(a), math.sin(a)
    return np.array([[ca,0,sa],[0,1,0],[-sa,0,ca]])
ARK = np.array([[0,1,0],[-1,0,0],[0,0,-1]], float)
poses = []
for i in range(3):
    R_ak = rot_y(math.radians(i*120)) @ ARK
    T = np.eye(4); T[:3,:3] = R_ak
    cm = [float(T[r,c]) for c in range(4) for r in range(4)]
    poses.append({'index': i, 'timestamp': i*0.1, 'transform': cm,
                  'intrinsics': [500,0,320,0,500,240,0,0,1], 'exposureLocked': True})
json.dump(poses, open(${JSON.stringify(posesPath)}, 'w'))
`;
      execFileSync(PY, ['-c', gen], { stdio: 'inherit' });

      const out = path.join(dir, 'pano.jpg');
      const stdout = execFileSync(
        PY,
        [script, '--frames-dir', framesDir, '--poses', posesPath, '--out', out, '--width', '512'],
        { encoding: 'utf8' },
      );

      // Machine-readable progress stream: PROGRESS lines are monotonic 0→100.
      const progress = stdout
        .split('\n')
        .map((l) => /^PROGRESS (\d+)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]));
      expect(progress.length).toBeGreaterThan(2);
      expect(progress[0]).toBe(0);
      expect(progress[progress.length - 1]).toBe(100);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]!);
      }

      expect(existsSync(out)).toBe(true);
      const shape = execFileSync(
        PY,
        ['-c', `import cv2;im=cv2.imread(${JSON.stringify(out)});print(im.shape[1], im.shape[0])`],
        { encoding: 'utf8' },
      ).trim();
      expect(shape).toBe('512 256'); // 2:1 equirect
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: a legacy client uploaded poses with zeroed intrinsics and the
  // stitcher hard-failed (`invalid pose (intrinsics fx/fy/cx/cy must be
  // positive)`), burning every retry. Invalid poses must WARN + fall back to
  // the nominal-angle path and still exit 0 with a pano.
  it('invalid poses (zeroed intrinsics) → WARN + nominal fallback, exit 0', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-badposes-'));
    try {
      const framesDir = path.join(dir, 'frames');
      const posesPath = path.join(dir, 'poses.json');
      const gen = `
import cv2, numpy as np, json, os
fd = ${JSON.stringify(framesDir)}
os.makedirs(fd, exist_ok=True)
for i, c in enumerate([(60,60,200),(60,200,60),(200,60,60)]):
    img = np.zeros((480, 640, 3), np.uint8); img[:] = c
    cv2.imwrite(os.path.join(fd, f'frame_{i}.jpg'), img)
poses = [{'index': i, 'timestamp': i*0.1,
          'transform': [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
          'intrinsics': [0,0,0,0,0,0,0,0,0],  # zeroed — the legacy-client bug
          'exposureLocked': True} for i in range(3)]
json.dump(poses, open(${JSON.stringify(posesPath)}, 'w'))
`;
      execFileSync(PY, ['-c', gen], { stdio: 'inherit' });

      const out = path.join(dir, 'pano.jpg');
      // Must NOT throw (exit 0) despite the unusable poses.
      const stdout = execFileSync(
        PY,
        [script, '--frames-dir', framesDir, '--poses', posesPath, '--out', out, '--width', '512'],
        { encoding: 'utf8' },
      );

      expect(stdout).toContain('WARN poses invalid');
      expect(stdout).toContain('non-positive intrinsics');
      expect(stdout).toContain('mode=nominal-fallback');
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
