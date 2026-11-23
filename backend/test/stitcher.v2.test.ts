import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Capture v2 stitcher stages (spec §5.2 item 5): depth-file parsing,
 * translation-aware reprojection and gain compensation, on synthetic scenes
 * with known answers. Needs cv2 + numpy (skipIf otherwise) — point
 * STITCHER_TEST_PYTHON at a venv.
 */
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
const stitcherDir = fileURLToPath(new URL('../stitcher', import.meta.url));

const PREAMBLE = `
import sys, os, json, math
sys.path.insert(0, ${JSON.stringify(stitcherDir)})
import numpy as np, cv2
import reproject as R
from warp import pano_rays, project, sample, sample_field
R.log = R.progress = lambda *a, **k: None
`;

function run(snippet: string): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), 'stitch-v2-'));
  try {
    const driver = `${PREAMBLE}\nTMP = ${JSON.stringify(dir)}\n${snippet}\n`;
    const out = execFileSync(PY, ['-c', driver], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop()!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A textured wall (the plane z = WALL_Z) seen by two cameras 30 cm apart, both
 * yawed toward the middle so their views overlap. Frames and depth maps are
 * ray-cast from first principles (not from the code under test), stored the
 * way the device uploads them: ARKit-native landscape, depth as 16-bit mm PNG
 * at a lower resolution with an invalid (0) stripe.
 */
const SCENE = `
WALL_Z = 2.0
UW, UH, F = 180, 240, 200.0          # upright frame, focal px
tex = cv2.GaussianBlur(np.random.default_rng(7).integers(0, 256, (800, 800)).astype(np.float32), (0, 0), 2)
tex = cv2.normalize(tex, None, 0, 255, cv2.NORM_MINMAX)

def cam_pose(index, x, yaw_deg):
    y = math.radians(yaw_deg)
    fwd = np.array([-math.sin(y), 0.0, math.cos(y)])
    right = np.cross(fwd, [0.0, 1.0, 0.0]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    r_proj = np.array([right, up, fwd])
    T = np.eye(4); T[:3, :3] = r_proj.T @ np.asarray(R.ARKIT_TO_PROJ); T[:3, 3] = [x, 0.0, 0.0]
    return {'index': index, 'timestamp': 0.0, 'exposureLocked': True,
            'transform': [float(T[r, c]) for c in range(4) for r in range(4)],
            # native landscape 240x180: fx, fy, cx, cy
            'intrinsics': [F, 0, 120, 0, F, 90, 0, 0, 1]}, r_proj

def render(p, r_proj, gain=1.0):
    o = np.array(p['transform'][12:15])
    v, u = np.mgrid[0:UH, 0:UW].astype(np.float64)
    rc = np.stack([(u - UW / 2) / F, (UH / 2 - v) / F, np.ones_like(u)])
    rw = np.tensordot(r_proj.T, rc, 1)
    t = (WALL_Z - o[2]) / rw[2]
    X, Y = o[0] + t * rw[0], o[1] + t * rw[1]
    img = cv2.remap(tex, (X * 150 + 400).astype(np.float32), (Y * 150 + 400).astype(np.float32),
                    cv2.INTER_LINEAR)
    img = np.clip(img * gain, 0, 255).astype(np.uint8)
    return cv2.merge([img, img, img]), t   # t is the z-depth (camera z of the ray is 1)

def write_capture(fd, dd, gains=(1.0, 1.0)):
    os.makedirs(fd, exist_ok=True); os.makedirs(dd, exist_ok=True)
    poses = []
    for i, (x, yaw) in enumerate([(-0.15, 12.0), (0.15, -12.0)]):
        p, rp = cam_pose(i, x, yaw)
        img, z = render(p, rp, gains[i])
        cv2.imwrite(os.path.join(fd, 'frame_%d.png' % i), cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE))
        dmm = cv2.rotate((z * 1000).astype(np.uint16), cv2.ROTATE_90_COUNTERCLOCKWISE)
        dmm = cv2.resize(dmm, (120, 90), interpolation=cv2.INTER_NEAREST)  # half-res, like LiDAR
        dmm[40:44, :] = 0                                                  # low-confidence stripe
        cv2.imwrite(os.path.join(dd, 'depth_%d.png' % i), dmm)
        poses.append(p)
    return poses

def layers(fd, poses, depth_dir, proxy, W=1024):
    by_i = {p['index']: p for p in poses}
    frames = R.load_frames(fd, list(by_i), by_i, None, 52.0, W)
    center = np.mean([f[1].o for f in frames.values()], axis=0)
    invd = R.scene_depth(frames, by_i, depth_dir, center, proxy)
    rows, cols = np.arange(W // 2), np.arange(W)
    dx, dy, dz = pano_rays(rows, cols, W, W // 2)
    invd = sample_field(invd, rows, cols, W, W // 2)
    out = []
    for img, cam, _ in frames.values():
        px, py, inb = project(cam, center, dx, dy, dz, invd)
        out.append((sample(img, px, py)[:, :, 0].astype(np.float32), inb))
    return out

def misalignment(lay):
    """Residual shift (px) between the two reprojected frames over their overlap."""
    (a, ma), (b, mb) = lay
    both = ma & mb
    ys, xs = np.nonzero(both)
    y0, y1, x0, x1 = ys.min() + 4, ys.max() - 4, xs.min() + 4, xs.max() - 4
    win = cv2.createHanningWindow((x1 - x0, y1 - y0), cv2.CV_32F)
    (sx, sy), _ = cv2.phaseCorrelate(a[y0:y1, x0:x1], b[y0:y1, x0:x1], win)
    return float(math.hypot(sx, sy)), int(both.sum())
`;

describe.skipIf(!available)('stitcher v2: depth files', () => {
  it('parses 16-bit mm PNGs (0 = invalid) and rejects everything else softly', () => {
    const r = run(`
import depth as D
d = np.array([[0, 1500], [2750, 65535]], np.uint16)
cv2.imwrite(os.path.join(TMP, 'ok.png'), d)
cv2.imwrite(os.path.join(TMP, 'eight.png'), d.astype(np.uint8))
cv2.imwrite(os.path.join(TMP, 'zero.png'), np.zeros((4, 4), np.uint16))
open(os.path.join(TMP, 'junk.png'), 'wb').write(b'not a png')
m, why = D.read_depth_png(os.path.join(TMP, 'ok.png'))
print(json.dumps({
  'values': m.tolist(), 'dtype': str(m.dtype), 'why': why,
  'eight': D.read_depth_png(os.path.join(TMP, 'eight.png'))[1],
  'zero': D.read_depth_png(os.path.join(TMP, 'zero.png'))[1],
  'junk': D.read_depth_png(os.path.join(TMP, 'junk.png'))[1],
  'missing': D.read_depth_png(os.path.join(TMP, 'nope.png'))[1],
}))
`);
    const v = r.values as number[][];
    expect(r.why).toBeNull();
    expect(r.dtype).toBe('float32');
    expect(v[0]![0]).toBe(0); // invalid stays 0
    expect(v[0]![1]).toBeCloseTo(1.5, 5);
    expect(v[1]![0]).toBeCloseTo(2.75, 5);
    expect(v[1]![1]).toBeCloseTo(65.535, 3);
    expect(r.eight).toContain('16-bit');
    expect(r.zero).toBe('no valid depth');
    expect(r.junk).toBe('undecodable');
    expect(r.missing).toBe('missing');
  });
});

describe.skipIf(!available)('stitcher v2: translation-aware reprojection', () => {
  it('cameras 30 cm apart on a 2 m wall: depth maps align, rotation-only ghosts', () => {
    const r = run(`${SCENE}
fd, dd = os.path.join(TMP, 'f'), os.path.join(TMP, 'd')
poses = write_capture(fd, dd)
rot, n = misalignment(layers(fd, poses, None, float('inf')))
dep, _ = misalignment(layers(fd, poses, dd, float('inf')))     # proxy unused where depth is
prox, _ = misalignment(layers(fd, poses, None, 2.0))           # sphere proxy ~ the wall
print(json.dumps({'rotation_only': rot, 'depth_maps': dep, 'proxy': prox, 'overlap_px': n}))
`);
    expect(r.overlap_px as number).toBeGreaterThan(3000);
    // 30 cm at 2 m is ~8.6 deg ~ 24 px at 1024 wide: rotation-only must ghost.
    expect(r.rotation_only as number).toBeGreaterThan(15);
    expect(r.depth_maps as number).toBeLessThan(2);
    expect(r.proxy as number).toBeLessThan(4);
  });

  it('the CLI accepts --depth-dir and still writes a pano when a depth file is bad', () => {
    const r = run(`${SCENE}
import subprocess
fd, dd = os.path.join(TMP, 'f'), os.path.join(TMP, 'd')
poses = write_capture(fd, dd)
json.dump(poses, open(os.path.join(TMP, 'p.json'), 'w'))
open(os.path.join(dd, 'depth_1.png'), 'wb').write(b'garbage')
out = os.path.join(TMP, 'pano.jpg')
p = subprocess.run([sys.executable, os.path.join(${JSON.stringify(stitcherDir)}, 'reproject.py'),
    '--frames-dir', fd, '--poses', os.path.join(TMP, 'p.json'), '--depth-dir', dd,
    '--out', out, '--width', '256'], capture_output=True, text=True)
print(json.dumps({'code': p.returncode, 'warned': 'depth ignored (undecodable)' in p.stdout,
                  'shape': list(cv2.imread(out).shape) if p.returncode == 0 else None}))
`);
    expect(r.code).toBe(0);
    expect(r.warned).toBe(true);
    expect(r.shape).toEqual([128, 256, 3]);
  });
});

describe.skipIf(!available)('stitcher v2: gain compensation', () => {
  it('recovers a known 0.7x exposure difference from the overlap alone', () => {
    const r = run(`${SCENE}
fd, dd = os.path.join(TMP, 'f'), os.path.join(TMP, 'd')
poses = write_capture(fd, dd, gains=(1.0, 0.7))
by_i = {p['index']: p for p in poses}
frames = R.load_frames(fd, list(by_i), by_i, None, 52.0, 1024)
center = np.mean([f[1].o for f in frames.values()], axis=0)
invd = R.scene_depth(frames, by_i, dd, center, 2.0)
g = R.frame_gains(frames, by_i, center, invd, 512)
print(json.dumps({'ratio': float(g[1].mean() / g[0].mean()),
                  'geo_mean': float(math.sqrt(g[0].mean() * g[1].mean()))}))
`);
    expect(r.ratio as number).toBeGreaterThan((1 / 0.7) * 0.97);
    expect(r.ratio as number).toBeLessThan((1 / 0.7) * 1.03);
    // The weak prior anchors the overall level: gains split around 1.
    expect(Math.abs((r.geo_mean as number) - 1)).toBeLessThan(0.05);
  });

  it('turns iso * exposureDuration into a gamma-encoded prior, all-or-nothing', () => {
    const r = run(`
import gains as G
full = G.exposure_prior([{'iso': 100, 'exposureDuration': 0.02}, {'iso': 200, 'exposureDuration': 0.02},
                         {'iso': 100, 'exposureDuration': 0.01}])
part = G.exposure_prior([{'iso': 100, 'exposureDuration': 0.02}, {}])
print(json.dumps({'full': np.exp(full).tolist(), 'part': part}))
`);
    const full = r.full as number[];
    // Median exposure is 0.002 * 1000; 2x exposure needs 2^(-1/2.2) in JPEG values.
    expect(full[0]).toBeCloseTo(1, 6);
    expect(full[1]).toBeCloseTo(Math.pow(2, -1 / 2.2), 6);
    expect(full[2]).toBeCloseTo(Math.pow(2, 1 / 2.2), 6);
    expect(r.part).toBeNull();
  });
});

describe.skipIf(!available)('stitcher v2: nadir mask', () => {
  it('drops the nadir cap from every frame and refills it from the rim', () => {
    const r = run(`
# A floor that is red toward lon<0 and blue toward lon>0 around the cap.
h, w = 256, 512
pano = np.zeros((h, w, 3), np.uint8)
pano[:, : w // 2] = (0, 0, 200)
pano[:, w // 2:] = (200, 0, 0)
cap_row = int((1 - 20 / 180) * h)
mask = np.zeros((h, w), np.uint8)
mask[cap_row:] = 255
pano[cap_row:] = 0          # what build() leaves in the cap
out = R.fill_nadir(pano.copy(), mask, 20.0)
cap = out[cap_row:].astype(int)
print(json.dumps({
  'mask_cleared': int(mask[cap_row:].max()),
  'black_px': int((cap.max(axis=2) < 20).sum()),
  'left_red': bool(cap[:, 10, 2].mean() > cap[:, 10, 0].mean()),
  'right_blue': bool(cap[:, w - 10, 0].mean() > cap[:, w - 10, 2].mean()),
  'above_untouched': bool(np.array_equal(out[:cap_row], pano[:cap_row])),
}))
`);
    expect(r.mask_cleared).toBe(0); // fill_holes must not redo it
    expect(r.black_px).toBe(0);
    expect(r.left_red).toBe(true);
    expect(r.right_blue).toBe(true);
    expect(r.above_untouched).toBe(true);
  });
});
