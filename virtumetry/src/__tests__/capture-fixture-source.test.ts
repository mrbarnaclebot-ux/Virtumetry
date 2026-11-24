/// <reference types="node" />
import { Directory, File, Paths } from 'expo-file-system';
import fs from 'fs';
import path from 'path';

import framesJson from '../../assets/fixtures/tiny-session/frames.json';
import { FixtureCaptureSource } from '@/capture/fixture-source';
import { getCaptureSource, isFixtureSource } from '@/capture/source';
import type { FrameLine, KeyframeEvent, PoseEvent, TrackingEvent } from '@/capture/types';

const NOW0 = 1_800_000_000_000;
const FRAMES = framesJson as FrameLine[];

// jest-expo turns .jpg requires into numbers and expo-asset has no localUri (Pitfall 7): inject fake files.
async function resolveFrame(k: number) {
  const f = new File(Paths.cache, `src-${k}.jpg`);
  await f.write(`jpg-${k}`);
  return f.uri;
}

function setup(scenario?: 'good' | 'too-few' | 'tracking-gap' | 'pose-jump') {
  const src = new FixtureCaptureSource({ resolveFrame, now: () => NOW0 });
  if (scenario) src.setScenario(scenario);
  const keyframes: KeyframeEvent[] = [];
  const poses: PoseEvent[] = [];
  const tracking: TrackingEvent[] = [];
  src.addListener('keyframe', (e) => keyframes.push(e));
  src.addListener('pose', (e) => poses.push(e));
  src.addListener('tracking', (e) => tracking.push(e));
  return { src, keyframes, poses, tracking };
}

const sessions = () => new Directory(Paths.document, 'sessions');
const sessionDir = (sid: string) => new Directory(Paths.document, 'sessions', sid);
const readLines = (sid: string) =>
  new File(sessionDir(sid), 'frames.jsonl')
    .textSync()
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as FrameLine);

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('fixture data', () => {
  it('frames.json equals the backend frames.jsonl line for line (drift check)', () => {
    const jsonl = fs.readFileSync(path.join(__dirname, '../../../backend/test/fixtures/tiny-session/frames.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(30);
    expect(FRAMES).toEqual(lines);
  });
});

describe('FixtureCaptureSource', () => {
  it('good: writes a schema-1 session dir and emits 30 keyframes at 2x speed', async () => {
    const { src, keyframes, poses } = setup('good');
    const { sessionId } = await src.start({ minFrames: 20 });
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const session = JSON.parse(new File(sessionDir(sessionId), 'session.json').textSync());
    expect(session).toMatchObject({ schema: 1, sessionId, imageWidth: 640, imageHeight: 480, appVersion: 'fixture' });
    expect(session.tzOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(session.gateConfig).toEqual({ minFrames: 20, fixtureScenario: 'good' });

    jest.advanceTimersByTime((7.78 / 2) * 1000 + 100);
    expect(keyframes.map((k) => k.i)).toEqual(FRAMES.map((f) => f.i));
    expect(poses).toHaveLength(30);
    expect(keyframes[0]).toMatchObject({ T_arkit: FRAMES[0].T_arkit, K: FRAMES[0].K, tracking: 'normal', t: 0 });

    for (let k = 1; k <= 30; k++) {
      expect(new File(sessionDir(sessionId), 'frames', `${String(k).padStart(6, '0')}.jpg`).exists).toBe(true);
    }
    const lines = readLines(sessionId);
    expect(lines).toHaveLength(30);
    lines.forEach((l, k) => {
      expect(l.wallMs).toBe(NOW0 + Math.round((FRAMES[k].t - FRAMES[0].t) * 1000));
      if (k > 0) expect(l.wallMs).toBeGreaterThan(lines[k - 1].wallMs);
    });

    await expect(src.stop()).resolves.toEqual({ sessionId, frameCount: 30, dir: sessionDir(sessionId).uri });
  });

  it('does not finish before the 2x run time', async () => {
    const { src, keyframes } = setup();
    await src.start({});
    jest.advanceTimersByTime(3000);
    expect(keyframes.length).toBeLessThan(30);
    jest.advanceTimersByTime(1000);
    expect(keyframes).toHaveLength(30);
  });

  it('too-few emits exactly 8 keyframes', async () => {
    const { src, keyframes } = setup('too-few');
    const { sessionId } = await src.start({});
    jest.advanceTimersByTime(10_000);
    expect(keyframes).toHaveLength(8);
    expect(readLines(sessionId)).toHaveLength(8);
  });

  it('tracking-gap marks frames 10..17 limited and emits tracking changes', async () => {
    const { src, keyframes, tracking } = setup('tracking-gap');
    const { sessionId } = await src.start({});
    jest.advanceTimersByTime(10_000);
    for (const k of keyframes) expect(k.tracking).toBe(k.i >= 10 && k.i <= 17 ? 'limited' : 'normal');
    expect(readLines(sessionId).filter((l) => l.tracking === 'limited').map((l) => l.i)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(tracking.map((e) => e.tracking)).toEqual(['normal', 'limited', 'normal']);
    expect(tracking[1].t).toBe(FRAMES[9].t);
  });

  it('pose-jump shifts x by 0.6 m from frame 15', async () => {
    const { src, keyframes } = setup('pose-jump');
    await src.start({});
    jest.advanceTimersByTime(10_000);
    keyframes.forEach((k, idx) => {
      const orig = FRAMES[idx].T_arkit;
      expect(k.T_arkit[12]).toBeCloseTo(orig[12] + (k.i >= 15 ? 0.6 : 0), 9);
      expect(k.T_arkit[13]).toBe(orig[13]);
    });
  });

  it('stop() halts the timer mid-run', async () => {
    const { src, keyframes } = setup();
    const { sessionId } = await src.start({});
    jest.advanceTimersByTime(1000);
    const res = await src.stop();
    const n = keyframes.length;
    expect(res.frameCount).toBe(n);
    expect(res.sessionId).toBe(sessionId);
    jest.advanceTimersByTime(10_000);
    expect(keyframes).toHaveLength(n);
  });

  it('cancel() deletes the session dir', async () => {
    const { src } = setup();
    const { sessionId } = await src.start({});
    jest.advanceTimersByTime(1000);
    await src.cancel();
    expect(sessionDir(sessionId).exists).toBe(false);
  });

  it('cancel() while start is still resolving assets abandons it: no dir, no frames (WR-05)', async () => {
    const { src, keyframes } = setup();
    const before = sessions().exists ? sessions().list().length : 0;
    const started = src.start({});
    await src.cancel();
    await expect(started).rejects.toThrow('capture cancelled');
    jest.advanceTimersByTime(10_000);
    expect(keyframes).toHaveLength(0);
    expect(sessions().exists ? sessions().list().length : 0).toBe(before);
  });

  it('cancel() during a second start never deletes the previous, saved session (iter-2 CR-01)', async () => {
    const { src } = setup();
    const a = await src.start({});
    jest.advanceTimersByTime(10_000);
    await src.stop();
    expect(sessionDir(a.sessionId).exists).toBe(true);
    const pending = src.start({});
    await src.cancel();
    await expect(pending).rejects.toThrow('capture cancelled');
    expect(sessionDir(a.sessionId).exists).toBe(true);
  });

  it('each start gets a fresh session id', async () => {
    const { src } = setup();
    const a = await src.start({});
    await src.stop();
    const b = await src.start({});
    expect(b.sessionId).not.toBe(a.sessionId);
  });
});

describe('getCaptureSource', () => {
  it('returns the fixture source when VmCapture is absent (jest / Expo Go)', () => {
    const src = getCaptureSource();
    expect(src.kind).toBe('fixture');
    expect(isFixtureSource(src)).toBe(true);
    expect(getCaptureSource()).toBe(src);
  });
});
