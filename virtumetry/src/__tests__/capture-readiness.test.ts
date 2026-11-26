import { DEFAULT_CAPTURE_CONFIG, type ReadinessConfig } from '@/capture/capture-config';
import { readiness } from '@/capture/readiness';
import type { KeyframeEvent, TrackingState } from '@/capture/types';

const DEV: ReadinessConfig = {
  ...DEFAULT_CAPTURE_CONFIG.readiness,
  minFramesGreen: 25,
  minFramesAmber: 15,
  minSectorsGreen: 1,
  minSectorsAmber: 1,
};

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function frames(n: number, over: (i: number) => Partial<KeyframeEvent> = () => ({})): KeyframeEvent[] {
  return Array.from({ length: n }, (_, k) => ({
    i: k + 1,
    file: `frames/${String(k + 1).padStart(6, '0')}.jpg`,
    t: k * 0.3,
    wallMs: 1000 + k * 300,
    T_arkit: I,
    K: { fx: 1400, fy: 1400, cx: 960, cy: 720 },
    tracking: 'normal' as TrackingState,
    ...over(k),
  }));
}

describe('readiness (D-07)', () => {
  it('is idle before the first frame', () => {
    expect(readiness([], 0, DEV)).toEqual({
      level: 'idle',
      signal: null,
      label: 'Ready to scan',
      reason: 'Tap Start, then walk slowly around the room',
    });
  });

  it('is green with enough frames under the dev config', () => {
    const r = readiness(frames(30), 1, DEV);
    expect(r).toMatchObject({ level: 'green', signal: null, label: 'Good to finish', reason: 'You can stop now' });
  });

  it('counts missing frames', () => {
    expect(readiness(frames(8), 1, DEV)).toMatchObject({
      level: 'red',
      signal: 'frames',
      label: 'Keep scanning',
      reason: 'Keep going: 17 more frames',
    });
    expect(readiness(frames(24), 1, DEV).reason).toBe('Keep going: 1 more frame');
    expect(readiness(frames(20), 1, DEV)).toMatchObject({ level: 'amber', label: 'Almost there' });
  });

  it('puts tracking ahead of frames', () => {
    const r = readiness(frames(30, (k) => (k < 8 ? { tracking: 'limited' } : {})), 1, DEV);
    expect(r).toMatchObject({
      level: 'red',
      signal: 'tracking',
      reason: 'Tracking dropped. Move slower and keep the lights on',
    });
  });

  it('puts blur ahead of frames when tracking is fine', () => {
    const r = readiness(frames(10, (k) => (k < 3 ? { blurPx: 80 } : {})), 1, DEV);
    expect(r).toMatchObject({ level: 'red', signal: 'blur', reason: 'Too many blurry photos. Slow down' });
  });

  it('puts frames ahead of coverage under production defaults', () => {
    const r = readiness(frames(30), 1, DEFAULT_CAPTURE_CONFIG.readiness);
    expect(r).toMatchObject({ level: 'red', signal: 'frames', reason: 'Keep going: 120 more frames' });
  });

  it('names coverage when only coverage is short', () => {
    const r = readiness(frames(200), 7, DEFAULT_CAPTURE_CONFIG.readiness);
    expect(r).toMatchObject({ level: 'amber', signal: 'coverage', reason: 'Look around the rest of the room' });
  });
});
