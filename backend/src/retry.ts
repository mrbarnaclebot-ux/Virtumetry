import type { World } from './db/schema.js';

// Submit-stage codes D-08 marks retryable: the provider refused before billing.
const SUBMIT_RETRYABLE = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'BUDGET_EXCEEDED',
  'QUOTE_ABOVE_APPROVAL',
  'HTTP_402',
  'INSUFFICIENT_CREDITS',
]);

// Echo-3 validation families (D-08 + A-01): the capture itself is bad, so a
// retry would fail the same way.
const VALIDATION =
  /^(VALIDATION_FAILED|INVALID_INPUT|TOO_MANY_FRAMES|IMAGES?_|ZIP_|EXIF_|TRAJECTORY_|MATRIX_|ROTATION_|ORIENTATION_|SCANS_|CAMERA_FILE_|CAMERAS?_|CAPTURE_|PER_FRAME_INTRINSICS_|INTRINSICS_)|INTRINSICS/;

/**
 * Server-side source of truth for the Retry button (D-08). Unknown → false.
 * Processing failures cost 0 credits on Echo-3, so a non-validation provider
 * code is retryable (A-01); the ledger guard lives in the retry route (A-02).
 */
export function isRetryable(
  w: Pick<World, 'status' | 'deletedAt' | 'failureStage' | 'failureCode' | 'failureMessage'>,
): boolean {
  if (w.status !== 'failed' || w.deletedAt) return false;
  const code = w.failureCode ?? '';
  if (w.failureStage === 'submit') return SUBMIT_RETRYABLE.has(code);
  if (w.failureStage !== 'processing') return false;
  if (!code || code === 'FAILED') return false;
  const tokens = [code, ...(w.failureMessage ?? '').split(/[,\s]+/)].filter(Boolean);
  return !tokens.some((t) => VALIDATION.test(t));
}
