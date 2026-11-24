import type { PrecheckRules } from './capture-config';
import { BLUR_PX_THRESHOLD } from './rules';
import type { KeyframeEvent } from './types';

// D-15: device-side copy of the backend share/count rules (validate.ts). Advisory
// only: the server re-runs every rule at :complete (T-04-18).

export type PrecheckIssue = {
  code: 'FRAME_COUNT_OUT_OF_RANGE' | 'BLUR_SHARE' | 'TRACKING_GAP' | 'COVERAGE_LOW';
  n?: number;
  min?: number;
  max?: number;
};

export function precheck(frames: KeyframeEvent[], seenCount: number, rules: PrecheckRules & { maxFrames: number }): PrecheckIssue[] {
  const issues: PrecheckIssue[] = [];
  const n = frames.length;
  if (n < rules.minFrames || n > rules.maxFrames) {
    issues.push({ code: 'FRAME_COUNT_OUT_OF_RANGE', n, min: rules.minFrames, max: rules.maxFrames });
  }
  if (n) {
    const share = (pred: (f: KeyframeEvent) => boolean) => frames.filter(pred).length / n;
    if (share((f) => f.tracking !== 'normal') > rules.maxTrackingGapShare) issues.push({ code: 'TRACKING_GAP' });
    if (share((f) => (f.blurPx ?? 0) > BLUR_PX_THRESHOLD) > rules.maxBlurShare) issues.push({ code: 'BLUR_SHARE' });
    if (seenCount < rules.minCoverageSectors) issues.push({ code: 'COVERAGE_LOW', n: seenCount, min: rules.minCoverageSectors });
  }
  return issues;
}

const TRACKING = 'The phone lost track of where it was. Scan again with more light.';
const BLUR = 'Too many blurry photos. Scan again, moving slower with the lights on.';
const INTRINSICS = 'The camera data looks wrong. Scan again.';
const FALLBACK = "This scan didn't pass checks. Scan again.";

export function checkReason(issue: PrecheckIssue): string {
  switch (issue.code) {
    case 'FRAME_COUNT_OUT_OF_RANGE':
      return issue.n! < issue.min!
        ? `Too few photos (${issue.n} of ${issue.min} needed). Scan again and keep walking.`
        : `Too many photos (${issue.n}, limit ${issue.max}). Scan a smaller area.`;
    case 'TRACKING_GAP':
      return TRACKING;
    case 'BLUR_SHARE':
      return BLUR;
    case 'COVERAGE_LOW':
      return `Not enough of the room was seen (${issue.n} of ${issue.min} directions). Look all the way around.`;
  }
}

const SERVER: Record<string, string> = {
  TRACKING_GAP: TRACKING,
  BLUR_SHARE: BLUR,
  CAMERA_JUMP: 'The camera position jumped during the scan. Scan again, moving slowly.',
  FORWARD_MOTION_MISMATCH: 'The camera seemed to face away from where you walked. Scan again, walking forward.',
  INTRINSICS_PRINCIPAL_POINT: INTRINSICS,
  INTRINSICS_ASPECT: INTRINSICS,
  INTRINSICS_FOCAL_RANGE: INTRINSICS,
};

/** Server failure_code -> fixed copy; failure_message is never rendered (T-04-17). Count-based codes carry no numbers, so they use the fallback. */
export const serverReason = (code: string | null) => (code && SERVER[code]) || FALLBACK;
