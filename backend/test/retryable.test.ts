import { describe, expect, it } from 'vitest';
import { isRetryable } from '../src/retry.js';

type Row = [string, Parameters<typeof isRetryable>[0], boolean];
const failed = (failureStage: string | null, failureCode: string | null, failureMessage: string | null = null) => ({
  status: 'failed',
  deletedAt: null,
  failureStage,
  failureCode,
  failureMessage,
});

const validationCodes = [
  'ZIP_URL_NOT_FOUND',
  'IMAGES_MISSING',
  'TOO_MANY_FRAMES',
  'IMAGE_RESOLUTION_TOO_LOW',
  'EXIF_MISSING',
  'TRAJECTORY_X',
  'MATRIX_X',
  'ROTATION_X',
  'ORIENTATION_X',
  'SCANS_X',
  'CAMERA_FILE_INVALID_JSON',
  'PER_FRAME_INTRINSICS_X',
  'INTRINSICS_X',
  'CAPTURE_INGEST_TIMEOUT',
  'VALIDATION_FAILED',
];

const rows: Row[] = [
  ['ready world', { ...failed(null, null), status: 'ready' }, false],
  ['processing world', { ...failed(null, null), status: 'processing' }, false],
  ['deleted failed world', { ...failed('submit', 'RATE_LIMITED'), deletedAt: new Date() }, false],
  ...['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'BUDGET_EXCEEDED', 'QUOTE_ABOVE_APPROVAL', 'HTTP_402', 'INSUFFICIENT_CREDITS'].map(
    (c): Row => [`submit ${c}`, failed('submit', c), true],
  ),
  ...['SUBMIT_UNCERTAIN', 'IDEMPOTENCY_KEY_REUSED', 'PROVIDER_AUTH', 'INVALID_INPUT', 'BUNDLE_NOT_RANGEABLE', null].map(
    (c): Row => [`submit ${String(c)}`, failed('submit', c), false],
  ),
  ['processing WORLD_GENERATION_FAILED', failed('processing', 'WORLD_GENERATION_FAILED', 'WORLD_GENERATION_FAILED'), true],
  ['processing INTERNAL_ERROR', failed('processing', 'INTERNAL_ERROR'), true],
  ['processing bare FAILED', failed('processing', 'FAILED'), false],
  ['processing null code', failed('processing', null), false],
  ['processing empty code', failed('processing', ''), false],
  ...validationCodes.map((c): Row => [`processing ${c}`, failed('processing', c, c), false]),
  [
    'processing generic code but validation codes in message (A-01)',
    failed('processing', 'WORLD_GENERATION_FAILED', 'IMAGES_MISSING, EXIF_MISSING'),
    false,
  ],
  ...['validate', 'pack', 'upload', 'import'].map((s): Row => [`${s} stage`, failed(s, 'RATE_LIMITED'), false]),
  ['unknown stage', failed('mystery', 'RATE_LIMITED'), false],
  ['null stage', failed(null, 'RATE_LIMITED'), false],
];

describe('isRetryable truth table (V7)', () => {
  it.each(rows)('%s → %s', (_name, world, expected) => {
    expect(isRetryable(world)).toBe(expected);
  });
});
