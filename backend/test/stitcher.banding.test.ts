import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Band invariance for reproject.py's build() (spec §10 R8): filling the
// equirect in row bands (to bound peak RSS) must not change the pano. The
// reference is a single whole-sphere band of the SAME code. (Until the capture
// v2 pipeline this compared against a vendored copy of the pre-banding code;
// the prefilter and blend stages intentionally changed the pixels, so that
// reference retired.)
//
// Needs cv2 + numpy (skipIf otherwise) — point STITCHER_TEST_PYTHON at a venv.
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

/**
 * Build a small synthetic capture: `count` textured landscape frames at yaw
 * i*(360/count) plus one pitched-up frame, with ARKit-shaped poses. Textured
 * (not flat) so bilinear sampling and feather blending actually vary per pixel —
 * a solid-colour fixture would pass even a badly broken band split.
 */
const FIXTURE_PY = (framesDir: string, posesPath: string) => `
import cv2, numpy as np, json, os, math
fd = ${JSON.stringify(framesDir)}
os.makedirs(fd, exist_ok=True)
W, H, N = 320, 240, 6
rng = np.random.default_rng(1234)
def rot_y(a):
    ca, sa = math.cos(a), math.sin(a)
    return np.array([[ca,0,sa],[0,1,0],[-sa,0,ca]])
def rot_x(a):
    ca, sa = math.cos(a), math.sin(a)
    return np.array([[1,0,0],[0,ca,-sa],[0,sa,ca]])
ARK = np.array([[0,1,0],[-1,0,0],[0,0,-1]], float)
poses = []
for i in range(N):
    # Deterministic high-frequency texture + a smooth gradient.
    img = rng.integers(0, 256, size=(H, W, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    img[:, :, 0] = ((xx * 255) // W).astype(np.uint8)
    img[:, :, 1] = ((yy * 255) // H).astype(np.uint8)
    cv2.imwrite(os.path.join(fd, f'frame_{i}.jpg'), img)
    pitch = math.radians(40.0) if i == N - 1 else 0.0
    R_ak = rot_y(math.radians(i * (360.0 / (N - 1)))) @ rot_x(pitch) @ ARK
    T = np.eye(4); T[:3, :3] = R_ak
    poses.append({'index': i, 'timestamp': i * 0.1,
                  'transform': [float(T[r, c]) for c in range(4) for r in range(4)],
                  'intrinsics': [260, 0, 160, 0, 260, 120, 0, 0, 1],
                  'exposureLocked': True})
json.dump(poses, open(${JSON.stringify(posesPath)}, 'w'))
`;

/** Run build() whole-sphere and banded, print a JSON verdict. */
const COMPARE_PY = (
  framesDir: string,
  posesPath: string,
  width: number,
  bandRows: number,
  withFill: boolean,
) => `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
import numpy as np
import reproject as new

poses = json.load(open(${JSON.stringify(posesPath)}))
poses = sorted(poses, key=lambda p: int(p['index']))
fd = ${JSON.stringify(framesDir)}

# Silence progress/log chatter so stdout carries only the verdict.
new.log = new.progress = lambda *a, **k: None

o_pano, o_cov, o_mask = new.build(${width}, fd, poses, 1, -1, 52.0,
                                  band_height=${width} // 2)
n_pano, n_cov, n_mask = new.build(${width}, fd, poses, 1, -1, 52.0,
                                  band_height=${bandRows})
diff = np.abs(n_pano.astype(np.int16) - o_pano.astype(np.int16))
verdict = {
    'shape': list(n_pano.shape),
    'bands': int(np.ceil((${width} // 2) / ${bandRows})),
    'pano_max_abs_diff': int(diff.max()),
    'pano_mean_abs_diff': float(diff.mean()),
    'pano_bit_identical': bool(np.array_equal(n_pano, o_pano)),
    'mask_identical': bool(np.array_equal(n_mask, o_mask)),
    'cov_identical': bool(n_cov == o_cov),
    # Sanity: the fixture must actually produce varied, non-trivial output.
    'distinct_colors': int(len(np.unique(o_pano.reshape(-1, 3), axis=0))),
    'coverage_pct': float(o_cov),
}
if ${withFill ? 'True' : 'False'}:
    o_filled = new.fill_holes(o_pano.copy(), o_mask)
    n_filled = new.fill_holes(n_pano.copy(), n_mask)
    fdiff = np.abs(n_filled.astype(np.int16) - o_filled.astype(np.int16))
    verdict['filled_max_abs_diff'] = int(fdiff.max())
    verdict['filled_bit_identical'] = bool(np.array_equal(n_filled, o_filled))
print(json.dumps(verdict))
`;

describe.skipIf(!available)('reproject.py row banding (spec §10 R8)', () => {
  it('banded build is bit-identical to a whole-sphere build', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-band-'));
    try {
      const framesDir = path.join(dir, 'frames');
      const posesPath = path.join(dir, 'poses.json');
      execFileSync(PY, ['-c', FIXTURE_PY(framesDir, posesPath)], { stdio: 'inherit' });

      // width 256 → height 128, split into 7 bands of 20 rows (the last band is
      // a short 8-row remainder — the off-by-one the naive split gets wrong).
      const out = execFileSync(PY, ['-c', COMPARE_PY(framesDir, posesPath, 256, 20, true)], {
        encoding: 'utf8',
      });
      const r = JSON.parse(out.trim().split('\n').pop()!);

      expect(r.shape).toEqual([128, 256, 3]);
      expect(r.bands).toBe(7);
      // The fixture must be a real test, not a flat image.
      expect(r.distinct_colors).toBeGreaterThan(1000);
      expect(r.coverage_pct).toBeGreaterThan(15);

      expect(r.pano_max_abs_diff).toBe(0);
      expect(r.pano_bit_identical).toBe(true);
      expect(r.filled_max_abs_diff).toBe(0);
      expect(r.filled_bit_identical).toBe(true);
      expect(r.mask_identical).toBe(true);
      expect(r.cov_identical).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every band size — including 1 row and the whole sphere — agrees', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-band-sizes-'));
    try {
      const framesDir = path.join(dir, 'frames');
      const posesPath = path.join(dir, 'poses.json');
      execFileSync(PY, ['-c', FIXTURE_PY(framesDir, posesPath)], { stdio: 'inherit' });

      for (const bandRows of [1, 3, 32, 64]) {
        const out = execFileSync(
          PY,
          ['-c', COMPARE_PY(framesDir, posesPath, 128, bandRows, false)],
          { encoding: 'utf8' },
        );
        const r = JSON.parse(out.trim().split('\n').pop()!);
        expect(r.pano_bit_identical, `band_rows=${bandRows}`).toBe(true);
        expect(r.mask_identical, `band_rows=${bandRows}`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!available)('reproject.py exit codes + format sniffing', () => {
  const EXIT_INPUT_ERROR = 2;

  /** Run the CLI and return {status, stderr} without throwing. */
  function run(args: string[]): { status: number; stderr: string; stdout: string } {
    try {
      const stdout = execFileSync(PY, [script, ...args], { encoding: 'utf8' });
      return { status: 0, stderr: '', stdout };
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
      return {
        status: e.status ?? -1,
        stderr: String(e.stderr ?? ''),
        stdout: String(e.stdout ?? ''),
      };
    }
  }

  it('--width above the 8192 cap is an input error (exit 2)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-width-'));
    try {
      const r = run(['--frames-dir', dir, '--out', path.join(dir, 'p.jpg'), '--width', '16384']);
      expect(r.status).toBe(EXIT_INPUT_ERROR);
      expect(r.stderr).toContain('exceeds the maximum 8192');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing frames dir is an input error (exit 2)', () => {
    const r = run([
      '--frames-dir', path.join(tmpdir(), 'definitely-not-a-dir-9d3f'),
      '--out', path.join(tmpdir(), 'p.jpg'),
      '--width', '128',
    ]);
    expect(r.status).toBe(EXIT_INPUT_ERROR);
    expect(r.stderr).toContain('frames dir not found');
  });

  it('a real HEIC frame fails as an input error with an explicit message', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-heic-'));
    try {
      const framesDir = path.join(dir, 'frames');
      execFileSync(PY, ['-c', `import os; os.makedirs(${JSON.stringify(framesDir)})`]);
      // Minimal ISO-BMFF header with the `heic` brand — enough for the magic-byte
      // sniff, and genuinely undecodable by a non-HEIF OpenCV build.
      const heic = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from('ftypheic'),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from('mif1heic'),
        Buffer.alloc(64),
      ]);
      writeFileSync(path.join(framesDir, 'frame_0.jpg'), heic);
      writeFileSync(path.join(framesDir, 'frame_1.jpg'), heic);

      const r = run(['--frames-dir', framesDir, '--out', path.join(dir, 'p.jpg'), '--width', '128']);
      expect(r.status).toBe(EXIT_INPUT_ERROR);
      expect(r.stderr).toContain('genuine HEIF/HEIC image');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('garbage frame bytes fail as an input error naming the sniffed format', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stitch-garbage-'));
    try {
      const framesDir = path.join(dir, 'frames');
      execFileSync(PY, ['-c', `import os; os.makedirs(${JSON.stringify(framesDir)})`]);
      writeFileSync(path.join(framesDir, 'frame_0.jpg'), Buffer.from('not an image at all'));
      writeFileSync(path.join(framesDir, 'frame_1.jpg'), Buffer.from('not an image at all'));

      const r = run(['--frames-dir', framesDir, '--out', path.join(dir, 'p.jpg'), '--width', '128']);
      expect(r.status).toBe(EXIT_INPUT_ERROR);
      expect(r.stderr).toContain('sniffed format: unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
