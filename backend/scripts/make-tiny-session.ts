// One-off fixture builder (D-09/D-10/D-14). Converts a TUM RGB-D Freiburg-3
// sequence (CC BY 4.0, undistorted pinhole) into session format schema 1 with
// raw ARKit-convention poses, plus the mock-output placeholder files.
//
//   npx tsx scripts/make-tiny-session.ts <extractedSeqDir> <fixturesDir>
//
// <extractedSeqDir> holds rgb.txt, groundtruth.txt and rgb/*.png (untrusted
// data: only parsed, never executed). Writes <fixturesDir>/tiny-session/ and
// <fixturesDir>/mock-outputs/. Needs ffmpeg on PATH.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arkitToOpenCV, rotationIssues } from '../src/bundle/convert.js';
import { FrameLineV1, SessionV1, type FrameLine } from '../src/bundle/manifest.js';

type M4 = number[][];

const FRAME_COUNT = 30;
const MIN_DT_S = 0.25;
const MAX_STEP_M = 0.5;
const MATCH_TOL_S = 0.02;
const K = { fx: 535.4, fy: 539.2, cx: 320.1, cy: 247.6 }; // TUM fr3 (already undistorted)
const W_PX = 640, H_PX = 480;
const TZ = '+02:00'; // Freiburg, CEST at capture time

const mul = (A: M4, B: M4): M4 => A.map((row) => B[0]!.map((_, c) => row.reduce((s, v, k) => s + v * B[k]![c]!, 0)));
const transpose = (A: M4): M4 => A[0]!.map((_, c) => A.map((row) => row[c]!));
const F: M4 = [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]];

function rigidInv(M: M4): M4 {
  const out: M4 = [];
  for (let r = 0; r < 3; r++) {
    const row = [M[0]![r]!, M[1]![r]!, M[2]![r]!];
    out.push([...row, -(row[0]! * M[0]![3]! + row[1]! * M[1]![3]! + row[2]! * M[2]![3]!)]);
  }
  out.push([0, 0, 0, 1]);
  return out;
}

/** TUM pose (t, q=xyzw) -> 4x4 world_from_camera (OpenCV camera axes). */
function poseMatrix(t: number[], q: number[]): M4 {
  const n = Math.hypot(...q);
  const [x, y, z, w] = q.map((v) => v / n) as [number, number, number, number];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), t[0]!],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), t[1]!],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), t[2]!],
    [0, 0, 0, 1],
  ];
}

/** Rotation (4x4) taking unit vector u onto +Y (Rodrigues). */
function rotateOntoY(u: number[]): M4 {
  const [ux, uy, uz] = u as [number, number, number];
  const v = [-uz, 0, ux]; // u × (0,1,0)
  const s = Math.hypot(...v), c = uy;
  if (s < 1e-12) return c > 0 ? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] : F; // already up / upside down (180° about X)
  const [kx, ky, kz] = v.map((a) => a / s) as [number, number, number];
  const C = 1 - c;
  return [
    [c + kx * kx * C, kx * ky * C - kz * s, kx * kz * C + ky * s, 0],
    [ky * kx * C + kz * s, c + ky * ky * C, ky * kz * C - kx * s, 0],
    [kz * kx * C - ky * s, kz * ky * C + kx * s, c + kz * kz * C, 0],
    [0, 0, 0, 1],
  ];
}

const colMajor = (M: M4) => Array.from({ length: 16 }, (_, k) => M[k % 4]![Math.floor(k / 4)]!);
const pad6 = (i: number) => String(i).padStart(6, '0');
const numbers = (line: string) => line.trim().split(/\s+/).map(Number);
const dataLines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);

export function main(seqDir: string, fixturesDir: string): void {
  const gt = dataLines(readFileSync(join(seqDir, 'groundtruth.txt'), 'utf8')).map(numbers);
  const rgb = dataLines(readFileSync(join(seqDir, 'rgb.txt'), 'utf8')).map((l) => {
    const [ts, file] = l.trim().split(/\s+/);
    return { ts: Number(ts), file: file! };
  });
  if (!/^rgb\/[\d.]+\.png$/.test(rgb[0]?.file ?? '')) throw new Error('unexpected rgb.txt format');

  // World up: the TUM fr3 mocap frame is z-up (camera height tz stays ~1.9 m while it
  // travels metres in x/y). Image-down is NOT gravity here: the camera looks down at a
  // floor poster, so averaging R_tum column 1 would put "up" nearly horizontal.
  const up = [0, 0, 1];
  const poses = gt.map((g) => ({ ts: g[0]!, T: poseMatrix(g.slice(1, 4), g.slice(4, 8)) }));
  const W = rotateOntoY(up);
  const Wu = W.slice(0, 3).map((row) => row[0]! * up[0]! + row[1]! * up[1]! + row[2]! * up[2]!);
  if (Math.abs(Wu[1]! - 1) > 1e-9) throw new Error('W does not map up to +Y');

  // Match each RGB stamp to the nearest groundtruth row (both lists are time-sorted).
  const matched: { ts: number; file: string; T: M4 }[] = [];
  let j = 0;
  for (const r of rgb) {
    while (j + 1 < poses.length && Math.abs(poses[j + 1]!.ts - r.ts) <= Math.abs(poses[j]!.ts - r.ts)) j++;
    const p = poses[j];
    if (p && Math.abs(p.ts - r.ts) <= MATCH_TOL_S) matched.push({ ts: r.ts, file: r.file, T: p.T });
  }

  // Greedy ≥0.25 s spacing, then the 30-frame window with the longest path whose steps stay < 0.5 m.
  const picks: typeof matched = [];
  for (const m of matched) if (!picks.length || m.ts - picks[picks.length - 1]!.ts >= MIN_DT_S) picks.push(m);
  const centre = (m: { T: M4 }) => [m.T[0]![3]!, m.T[1]![3]!, m.T[2]![3]!];
  const step = (a: { T: M4 }, b: { T: M4 }) => Math.hypot(...centre(a).map((v, k) => v - centre(b)[k]!));
  let best = -1, bestLen = -1;
  for (let s = 0; s + FRAME_COUNT <= picks.length; s++) {
    let len = 0, ok = true;
    for (let k = s + 1; k < s + FRAME_COUNT; k++) {
      const d = step(picks[k - 1]!, picks[k]!);
      if (d >= MAX_STEP_M) ok = false;
      len += d;
    }
    if (ok && len > bestLen) { best = s; bestLen = len; }
  }
  if (best < 0) throw new Error(`no ${FRAME_COUNT}-frame window found (${picks.length} spaced frames)`);
  const chosen = picks.slice(best, best + FRAME_COUNT);

  const sessDir = join(fixturesDir, 'tiny-session');
  const outDir = join(fixturesDir, 'mock-outputs');
  rmSync(join(sessDir, 'frames'), { recursive: true, force: true });
  mkdirSync(join(sessDir, 'frames'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const t0 = chosen[0]!.ts;
  const lines: FrameLine[] = chosen.map((m, k) => {
    const i = k + 1;
    const Tark = mul(mul(W, m.T), F);
    const T_arkit = colMajor(Tark);
    const issues = rotationIssues(T_arkit);
    if (issues.length) throw new Error(`frame ${i}: ${issues.join(', ')}`);
    // Self-check of the convention transform: arkitToOpenCV(W·T·F) must equal inv(T)·Wᵀ.
    const want = mul(rigidInv(m.T), transpose(W));
    const got = arkitToOpenCV(T_arkit);
    want.forEach((row, r) => row.forEach((v, c) => {
      if (Math.abs(v - got[r]![c]!) > 1e-9) throw new Error(`frame ${i}: convention self-check failed at [${r}][${c}]`);
    }));
    ffmpeg(['-i', join(seqDir, m.file), '-q:v', '3', '-bitexact', join(sessDir, 'frames', `${pad6(i)}.jpg`)]);
    return FrameLineV1.parse({
      i, file: `frames/${pad6(i)}.jpg`, t: Number((m.ts - t0).toFixed(6)), wallMs: Math.round(m.ts * 1000),
      T_arkit, K, tracking: 'normal',
    });
  });

  const session = SessionV1.parse({
    sessionId: 'tum-fr3-nostructure-texture-far', schema: 1, device: 'TUM fr3 (converted)', appVersion: 'fixture',
    imageWidth: W_PX, imageHeight: H_PX, startedAtISO: new Date(lines[0]!.wallMs).toISOString(), tzOffset: TZ, gateConfig: {},
  });
  writeFileSync(join(sessDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
  writeFileSync(join(sessDir, 'frames.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // --- mock outputs (D-14 placeholders) ---
  writeFileSync(join(outDir, 'cameras.json'), `${JSON.stringify({
    schema_version: 'spaitial.capture_cameras.v1', capture_id: session.sessionId, splat: 'splat.ply',
    coordinate_system: 'opencv', width_px: W_PX, height_px: H_PX, source_frame_count: lines.length,
    frames: lines.map((l, k) => ({
      source_index: k, image: `images/Image_${pad6(l.i)}.jpg`, camera_from_splat: arkitToOpenCV(l.T_arkit),
      fx_px: K.fx, fy_px: K.fy, cx_px: K.cx, cy_px: K.cy,
    })),
  }, null, 2)}\n`);

  // Tiny 3DGS PLY: 8 gaussians at the first camera centres.
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const n = 8;
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const body = Buffer.alloc(n * props.length * 4);
  lines.slice(0, n).forEach((l, k) => {
    const v = [l.T_arkit[12]!, l.T_arkit[13]!, l.T_arkit[14]!, 0.5, 0.5, 0.5, 2, -3, -3, -3, 1, 0, 0, 0];
    v.forEach((x, p) => body.writeFloatLE(x, (k * props.length + p) * 4));
  });
  writeFileSync(join(outDir, 'splat.ply'), Buffer.concat([Buffer.from(header, 'latin1'), body]));

  // ASCII unit box collider: 8 vertices, 12 triangles.
  const verts = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => [b & 1, (b >> 1) & 1, (b >> 2) & 1].map((x) => x - 0.5).join(' '));
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]];
  writeFileSync(join(outDir, 'collider.ply'),
    `ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n${verts.join('\n')}\n${faces.map((f) => `3 ${f.join(' ')}`).join('\n')}\n`);

  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', '-bitexact', join(outDir, 'floorplan.png')]);
  const mpp = 0.05, origin = [-1.6, -1.6];
  writeFileSync(join(outDir, 'floorplan.json'), `${JSON.stringify({
    version: 1, coordinate_system: 'spaitial-world-v1', projection: 'orthographic_top_down',
    origin_xz: origin, image_x_axis_xz: [1, 0], image_y_axis_xz: [0, 1], extent_m: [3.2, 3.2], cut_height_y: 1.0,
    scene_bounds: { min: [-1.6, 0, -1.6], max: [1.6, 2.5, 1.6] },
    image: {
      width_px: 64, height_px: 64, meters_per_pixel: mpp,
      world_xz_from_pixel: [[mpp, 0, origin[0]], [0, mpp, origin[1]], [0, 0, 1]],
      pixel_from_world_xz: [[1 / mpp, 0, -origin[0]! / mpp], [0, 1 / mpp, -origin[1]! / mpp], [0, 0, 1]],
      download_url: 'floorplan.png',
    },
    raw_image: null, generated_at: '2026-11-23T00:00:00Z',
  }, null, 2)}\n`);

  const first = chosen[0]!.file, last = chosen[chosen.length - 1]!.file;
  console.log(`[fixture] ${lines.length} frames, ${first} .. ${last}, path ${bestLen.toFixed(3)} m, up=${up.map((v) => v.toFixed(3)).join(',')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [seqDir, fixturesDir] = process.argv.slice(2);
  if (!seqDir || !fixturesDir) {
    console.error('usage: tsx scripts/make-tiny-session.ts <extractedSeqDir> <fixturesDir>');
    process.exit(2);
  }
  main(seqDir, fixturesDir);
}
