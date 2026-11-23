import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Handedness / orientation regression for stitcher/reproject.py.
 *
 * THE BUG (fixed 2026-09-17): the equirect ray grid used dx = +cos(lat)sin(lon),
 * i.e. image-x swinging toward +X. The pano is viewed from INSIDE the sphere and
 * the world is right-handed with +Y up, so a viewer facing +Z has -X on their
 * right (right x up = -forward). With the wrong sign the grid disagreed with
 * every physically realisable R_proj (all of which have det = -1), and the
 * output was mirrored twice over: each frame was SAMPLED mirrored (on-screen
 * text came out mirror-written) and the frames were LAID OUT in reverse yaw
 * order (turning right moved content left).
 *
 * Both halves of that need pinning, because the two plausible "fixes" are not
 * equivalent: flipping ARKIT_TO_PROJ to det = +1 un-mirrors each frame while
 * leaving the frames arranged backwards. Hence three independent assertions —
 * an asymmetric marker inside ONE frame, the ordering ACROSS frames, and the
 * camera-basis identity the conventions rest on.
 *
 * Everything here is synthetic: no device capture, no network, no DB. Needs
 * cv2 + numpy (skipIf otherwise) — point STITCHER_TEST_PYTHON at a venv.
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

/**
 * Shared fixture helpers, prepended to every snippet.
 *
 * `pose()` builds the ARKit transform from FIRST PRINCIPLES rather than reusing
 * the production `rmat()`: a fixture that re-derives its geometry from the code
 * under test cannot detect a convention error in that code — which is exactly
 * how the Phase 0.5 spike gate missed this (its synthetic poses were generated
 * as `R_ak = rot_y(theta) @ ARKIT_TO_PROJ`, algebraically cancelling the very
 * matrix under test, on solid-colour frames that look identical mirrored).
 */
const PREAMBLE = `
import sys, os, json, math
sys.path.insert(0, ${JSON.stringify(stitcherDir)})
import numpy as np, cv2
import reproject as R
R.log = R.progress = lambda *a, **k: None

# Upright frame geometry: portrait 180x240, from a 240x180 landscape sensor.
UW, UH = 180, 240
INTRINSICS = [200, 0, 120, 0, 200, 90, 0, 0, 1]  # fx,fy=200; cx=120, cy=90

def pose(index, yaw_deg, pitch_deg=0.0):
    """ARKit camera-to-world transform for a camera yawed yaw_deg to the
    viewer's RIGHT and pitched pitch_deg UP.

    Derived from the world geometry alone:
      forward = the world direction looked along. A RIGHTWARD turn from +Z goes
                toward -X, because the world is right-handed with +Y up, so
                X = Y x Z is the viewer's LEFT when facing +Z.
      right   = normalize(forward x up_ref)   -> (right, up, forward) is the
      up      = right x forward                  left-handed triple every real
                                                 camera basis forms in a
                                                 right-handed world.
    R_proj rows are (right, up, forward) in world coords and the production code
    computes R_proj = ARKIT_TO_PROJ @ R_ak.T, hence R_ak = R_proj.T @ ARKIT_TO_PROJ.
    """
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    fwd = np.array([-math.sin(y) * math.cos(p), math.sin(p), math.cos(y) * math.cos(p)])
    up_ref = np.array([0.0, 0.0, 1.0]) if abs(fwd[1]) > 0.999 else np.array([0.0, 1.0, 0.0])
    right = np.cross(fwd, up_ref); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    r_proj = np.array([right, up, fwd])
    r_ak = r_proj.T @ np.asarray(R.ARKIT_TO_PROJ)
    T = np.eye(4); T[:3, :3] = r_ak
    return {'index': index, 'timestamp': index * 0.1,
            'transform': [float(T[r, c]) for c in range(4) for r in range(4)],
            'intrinsics': INTRINSICS, 'exposureLocked': True}

def write_frame(fd, index, upright_img):
    """Store an UPRIGHT image as the ARKit-native LANDSCAPE frame the stitcher
    reads. reproject.upright() rotates every frame 90 deg CW, so the fixture
    rotates 90 deg CCW on the way in. PNG (not JPEG) so quadrant edges stay
    exact and the colour masks below can be strict."""
    land = cv2.rotate(upright_img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    assert cv2.imwrite(os.path.join(fd, 'frame_%d.png' % index), land)

def solid(bgr):
    img = np.zeros((UH, UW, 3), np.uint8); img[:] = bgr; return img

# Strict pure-colour masks: the feather blend only softens frame overlaps, so
# the core of each region stays saturated.
def masks(pano):
    b, g, r = (pano[:, :, i].astype(int) for i in range(3))
    return {
        'red':   (r > 195) & (g < 60) & (b < 60),
        'blue':  (b > 195) & (g < 60) & (r < 60),
        'green': (g > 195) & (r < 60) & (b < 60),
        'white': (r > 195) & (g > 195) & (b > 195),
    }

def centroid(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return {'count': 0}
    return {'count': int(len(xs)), 'cx': float(xs.mean()), 'cy': float(ys.mean()),
            'min_y': int(ys.min()), 'max_y': int(ys.max())}
`;

function run(snippet: string): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), 'stitch-orient-'));
  try {
    const driver = `${PREAMBLE}
fd = os.path.join(${JSON.stringify(dir)}, 'frames')
os.makedirs(fd, exist_ok=True)
${snippet}
`;
    const out = execFileSync(PY, ['-c', driver], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop()!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!available)('reproject.py orientation / handedness', () => {
  // (a) THE MIRROR TEST. One frame, four differently-coloured quadrants — an
  // asymmetric marker with no symmetry to hide behind. A horizontal mirror
  // swaps left/right, a vertical flip swaps top/bottom; both are caught.
  it('an asymmetric marker keeps its chirality: frame-left stays pano-left', () => {
    const r = run(`
img = np.zeros((UH, UW, 3), np.uint8)
img[:UH//2, :UW//2] = (0, 0, 255)        # top-left     RED
img[:UH//2, UW//2:] = (255, 0, 0)        # top-right    BLUE
img[UH//2:, :UW//2] = (0, 255, 0)        # bottom-left  GREEN
img[UH//2:, UW//2:] = (255, 255, 255)    # bottom-right WHITE
write_frame(fd, 0, img)
pano, cov, _ = R.build(512, fd, [pose(0, 0.0)], 1, -1, 52.0, band_height=37)
m = masks(pano)
ys, xs = np.nonzero(pano.any(axis=2))
print(json.dumps({k: centroid(v) for k, v in m.items()} |
                 {'covered_cx': float(xs.mean()), 'width': int(pano.shape[1])}))
`);
    const q = (k: string) => r[k] as { count: number; cx: number; cy: number };
    for (const k of ['red', 'blue', 'green', 'white']) {
      expect(q(k).count, `${k} quadrant present`).toBeGreaterThan(200);
    }
    // Horizontal chirality: the frame's LEFT half must land at SMALLER pano-x.
    // This is the assertion the shipped mirror bug failed.
    expect(q('red').cx).toBeLessThan(q('blue').cx);
    expect(q('green').cx).toBeLessThan(q('white').cx);
    // Vertical sanity: the frame's TOP half must land at SMALLER pano-y.
    expect(q('red').cy).toBeLessThan(q('green').cy);
    expect(q('blue').cy).toBeLessThan(q('white').cy);
    // A yaw-0 frame straddles lon = 0, i.e. the middle column of the equirect.
    expect(Math.abs((r.covered_cx as number) - (r.width as number) / 2)).toBeLessThan(4);
  });

  // (b) THE LAYOUT TEST. Un-mirroring each frame while leaving the frames
  // arranged backwards (what flipping ARKIT_TO_PROJ instead of the ray grid
  // would do) still fails here.
  it('a frame yawed to the viewer’s RIGHT lands at larger image-x', () => {
    const r = run(`
write_frame(fd, 0, solid((0, 0, 255)))      # RED   straight ahead
write_frame(fd, 1, solid((255, 0, 0)))      # BLUE  40 deg to the RIGHT
write_frame(fd, 2, solid((0, 255, 0)))      # GREEN 40 deg to the LEFT
poses = [pose(0, 0.0), pose(1, 40.0), pose(2, -40.0)]
pano, cov, _ = R.build(512, fd, poses, 1, -1, 52.0, band_height=37)
m = masks(pano)
print(json.dumps({k: centroid(v) for k, v in m.items()} | {'width': int(pano.shape[1])}))
`);
    const q = (k: string) => r[k] as { count: number; cx: number };
    for (const k of ['red', 'blue', 'green']) {
      expect(q(k).count, `${k} frame present`).toBeGreaterThan(200);
    }
    const w = r.width as number;
    expect(q('green').cx).toBeLessThan(q('red').cx);
    expect(q('red').cx).toBeLessThan(q('blue').cx);
    // Absolute placement, not just ordering: yaw theta sits at x = w/2 + theta/360*w.
    expect(q('red').cx).toBeCloseTo(w / 2, -0.5);
    expect(Math.abs(q('blue').cx - (w / 2 + (40 / 360) * w))).toBeLessThan(8);
    expect(Math.abs(q('green').cx - (w / 2 - (40 / 360) * w))).toBeLessThan(8);
  });

  // (c) Poles: cheap, and it pins that the vertical axis was NOT collateral
  // damage of the horizontal fix.
  it('zenith paints the top rows and nadir the bottom rows', () => {
    const r = run(`
write_frame(fd, 0, solid((0, 0, 255)))    # RED  straight up
write_frame(fd, 1, solid((255, 0, 0)))    # BLUE straight down
poses = [pose(0, 0.0, 90.0), pose(1, 0.0, -90.0)]
# nadir_cap_deg=0: the default cap (the user's body) is masked out for
# inpainting by design; this test is about where the nadir frame LANDS.
pano, cov, _ = R.build(512, fd, poses, 1, -1, 52.0, band_height=37, nadir_cap_deg=0)
m = masks(pano)
print(json.dumps({k: centroid(v) for k, v in m.items()} | {'height': int(pano.shape[0])}))
`);
    const zenith = r.red as { count: number; min_y: number; max_y: number };
    const nadir = r.blue as { count: number; min_y: number; max_y: number };
    const h = r.height as number;
    expect(zenith.count).toBeGreaterThan(200);
    expect(nadir.count).toBeGreaterThan(200);
    expect(zenith.min_y).toBe(0);
    expect(zenith.max_y).toBeLessThan(h * 0.25);
    expect(nadir.max_y).toBe(h - 1);
    expect(nadir.min_y).toBeGreaterThan(h * 0.75);
  });

  // (d) Text legibility, stated the way the bug was reported: a glyph must not
  // come out mirror-written. 'F' is chiral — its ink leans RIGHT at the top
  // (the arm) and sits at the stem on the left at the bottom. Mirrored, that
  // relationship inverts.
  it('a rendered glyph is not mirror-written', () => {
    const r = run(`
img = np.zeros((UH, UW, 3), np.uint8)
cv2.putText(img, 'F', (34, 196), cv2.FONT_HERSHEY_SIMPLEX, 5.0, (255, 255, 255), 14)
write_frame(fd, 0, img)
# Wider than the other cases: the glyph needs enough equirect pixels for the
# per-third centroids to be stable rather than quantisation noise.
pano, cov, _ = R.build(1024, fd, [pose(0, 0.0)], 1, -1, 52.0, band_height=37)
ink = pano.max(axis=2) > 128
ys, xs = np.nonzero(ink)
y0, y1 = int(ys.min()), int(ys.max())
band = (y1 - y0 + 1) / 3.0
top = xs[ys < y0 + band]
bot = xs[ys > y1 - band]
print(json.dumps({'ink': int(len(xs)), 'top_cx': float(top.mean()),
                  'bot_cx': float(bot.mean()), 'span': float(xs.max() - xs.min())}))
`);
    expect(r.ink as number).toBeGreaterThan(500);
    // The top arm reaches right of the stem the bottom third is made of.
    expect(r.top_cx as number).toBeGreaterThan((r.bot_cx as number) + (r.span as number) * 0.1);
  });

  // (e) The conventions the above rest on, asserted directly so a future edit
  // to ARKIT_TO_PROJ / FLIP_RIGHT fails HERE with a readable message instead of
  // silently mirroring the product again.
  it('every R_proj is a physical camera basis: right = forward x up, det = -1', () => {
    const r = run(`
worst_cross, worst_det = 0.0, 0.0
for yaw in (0.0, 37.0, -128.0, 180.0):
    for pitch in (0.0, 45.0, -45.0, 89.0):
        rp = np.asarray(R.derive_pose_rotation(pose(0, yaw, pitch)['transform']))
        worst_cross = max(worst_cross, float(np.abs(rp[0] - np.cross(rp[2], rp[1])).max()))
        worst_det = max(worst_det, abs(float(np.linalg.det(rp)) + 1.0))
# The pose-less nominal fallback must satisfy the SAME identity, or the two
# modes disagree and only one of them is mirrored.
nom_cross, nom_det = 0.0, 0.0
for yaw, pitch, roll in R.nominal_angles(28, 1, -1):
    rp = np.asarray(R.FLIP_RIGHT) @ np.asarray(R.rmat(yaw, pitch, roll)).T
    nom_cross = max(nom_cross, float(np.abs(rp[0] - np.cross(rp[2], rp[1])).max()))
    nom_det = max(nom_det, abs(float(np.linalg.det(rp)) + 1.0))
# Nominal yaw is a RIGHTWARD turn: +90 deg must look along -X, and the
# winning pitch_sign=-1 upper ring must actually look UP (+Y).
fwd90 = (np.asarray(R.FLIP_RIGHT) @ np.asarray(R.rmat(90.0, 0.0, 0.0)).T)[2]
fwd_up = (np.asarray(R.FLIP_RIGHT) @ np.asarray(R.rmat(0.0, -45.0, 0.0)).T)[2]
print(json.dumps({'worst_cross': worst_cross, 'worst_det': worst_det,
                  'nom_cross': nom_cross, 'nom_det': nom_det,
                  'fwd90': [float(v) for v in fwd90],
                  'fwd_up_y': float(fwd_up[1])}))
`);
    expect(r.worst_cross as number).toBeLessThan(1e-9);
    expect(r.worst_det as number).toBeLessThan(1e-9);
    expect(r.nom_cross as number).toBeLessThan(1e-9);
    expect(r.nom_det as number).toBeLessThan(1e-9);
    const [fx, fy, fz] = r.fwd90 as [number, number, number];
    expect(fx).toBeCloseTo(-1, 6); // yaw +90 → the viewer's right → -X
    expect(fy).toBeCloseTo(0, 6);
    expect(fz).toBeCloseTo(0, 6);
    expect(r.fwd_up_y as number).toBeGreaterThan(0.7); // pitch_sign -1 ring looks up
  });
});
