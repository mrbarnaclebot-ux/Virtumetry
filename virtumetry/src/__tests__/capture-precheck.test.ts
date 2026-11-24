import { readFileSync } from 'fs';
import { join } from 'path';

import { DEFAULT_CAPTURE_CONFIG } from '@/capture/capture-config';
import { checkReason, precheck, serverReason } from '@/capture/precheck';
import { BLUR_PX_THRESHOLD, MIN_HORIZONTAL_FORWARD, YAW_SECTORS } from '@/capture/rules';
import type { KeyframeEvent } from '@/capture/types';

const BACKEND = join(__dirname, '../../../backend/src');
const fixture: KeyframeEvent[] = readFileSync(join(__dirname, '../../../backend/test/fixtures/tiny-session/frames.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const DEV = { minFrames: 20, maxFrames: 5000, maxBlurShare: 0.25, maxTrackingGapShare: 0, minCoverageSectors: 1 };
const edit = (over: (k: number) => Partial<KeyframeEvent>) => fixture.map((f, k) => ({ ...f, ...over(k) }));

describe('precheck (D-15)', () => {
  it('passes the good fixture', () => {
    expect(precheck(fixture, 1, DEV)).toEqual([]);
  });

  it('flags too few frames', () => {
    const issues = precheck(fixture.slice(0, 8), 1, DEV);
    expect(issues).toEqual([{ code: 'FRAME_COUNT_OUT_OF_RANGE', n: 8, min: 20, max: 5000 }]);
    expect(checkReason(issues[0]!)).toBe('Too few photos (8 of 20 needed). Scan again and keep walking.');
  });

  it('flags too many frames', () => {
    const issues = precheck(fixture, 1, { ...DEV, maxFrames: 25 });
    expect(checkReason(issues[0]!)).toBe('Too many photos (30, limit 25). Scan a smaller area.');
  });

  it('flags tracking gaps and blur', () => {
    const gap = precheck(edit((k) => (k >= 10 && k < 18 ? { tracking: 'limited' } : {})), 1, DEV);
    expect(gap.map((i) => i.code)).toEqual(['TRACKING_GAP']);
    expect(checkReason(gap[0]!)).toBe('The phone lost track of where it was. Scan again with more light.');

    const blur = precheck(edit((k) => (k < 9 ? { blurPx: 80 } : {})), 1, DEV);
    expect(blur.map((i) => i.code)).toEqual(['BLUR_SHARE']);
    expect(checkReason(blur[0]!)).toBe('Too many blurry photos. Scan again, moving slower with the lights on.');
  });

  it('flags low coverage', () => {
    const issues = precheck(fixture, 1, { ...DEV, minCoverageSectors: 4 });
    expect(issues).toEqual([{ code: 'COVERAGE_LOW', n: 1, min: 4 }]);
    expect(checkReason(issues[0]!)).toBe(
      'Not enough of the room was seen (1 of 4 directions). Look all the way around.',
    );
  });
});

describe('serverReason', () => {
  it('maps server codes to fixed copy', () => {
    expect(serverReason('CAMERA_JUMP')).toBe('The camera position jumped during the scan. Scan again, moving slowly.');
    expect(serverReason('FORWARD_MOTION_MISMATCH')).toBe(
      'The camera seemed to face away from where you walked. Scan again, walking forward.',
    );
    expect(serverReason('INTRINSICS_ASPECT')).toBe('The camera data looks wrong. Scan again.');
    expect(serverReason('INTRINSICS_PRINCIPAL_POINT')).toBe('The camera data looks wrong. Scan again.');
    expect(serverReason('TRACKING_GAP')).toBe('The phone lost track of where it was. Scan again with more light.');
  });

  it('falls back for unknown or missing codes', () => {
    expect(serverReason('SOMETHING_NEW')).toBe("This scan didn't pass checks. Scan again.");
    expect(serverReason(null)).toBe("This scan didn't pass checks. Scan again.");
  });
});

describe('rules pinned to the backend (D-16)', () => {
  const validate = readFileSync(join(BACKEND, 'bundle/validate.ts'), 'utf8');
  const config = readFileSync(join(BACKEND, 'capture-config.ts'), 'utf8');

  it('validate.ts constants match rules.ts', () => {
    expect(validate).toContain(`BLUR_PX_THRESHOLD = ${BLUR_PX_THRESHOLD}`);
    expect(validate).toContain(`YAW_SECTORS = ${YAW_SECTORS}`);
    expect(validate).toContain(`MIN_HORIZONTAL_FORWARD = ${MIN_HORIZONTAL_FORWARD}`);
  });

  it('capture-config.ts defaults match DEFAULT_CAPTURE_CONFIG', () => {
    const { readiness, precheck: rules, pricing } = DEFAULT_CAPTURE_CONFIG;
    for (const [key, value] of Object.entries({ ...readiness, ...rules, ...pricing })) {
      const m = config.match(new RegExp(`\\b${key}: ([\\d.]+)`));
      expect([key, m && Number(m[1])]).toEqual([key, value]);
    }
  });
});
