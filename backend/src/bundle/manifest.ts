import { z } from 'zod';

// Session format schema 1 (D-01/D-02): the single source of truth for what the
// app writes and the backend reads. Raw ARKit values only; every conversion
// happens in the backend. Unknown schema versions are rejected.

export const SessionV1 = z.object({
  sessionId: z.string().min(1),
  schema: z.literal(1),
  device: z.string(),
  appVersion: z.string(),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  startedAtISO: z.string(),
  /** Capture-time UTC offset, `±HH:MM` (written to EXIF OffsetTimeOriginal). */
  tzOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/, 'tzOffset must be ±HH:MM'),
  gateConfig: z.record(z.string(), z.unknown()),
});

const finite = z.number().finite();

export const FrameLineV1 = z.object({
  i: z.number().int().min(1),
  file: z.string(),
  /** Seconds since session start (ARKit frame timestamp, rebased). */
  t: finite,
  /** Wall-clock capture time, Unix ms. */
  wallMs: z.number().int(),
  /** ARKit camera.transform (world_from_camera), 16 floats column-major. */
  T_arkit: z.array(finite).length(16),
  K: z.object({ fx: finite, fy: finite, cx: finite, cy: finite }),
  tracking: z.string(),
  blurPx: finite.optional(),
  expS: finite.optional(),
});

export type Session = z.infer<typeof SessionV1>;
export type FrameLine = z.infer<typeof FrameLineV1>;

/** Parse frames.jsonl. Throws one Error listing every bad line (1-based) as `line N: path: message`. */
export function parseFramesJsonl(text: string): FrameLine[] {
  const frames: FrameLine[] = [];
  const issues: string[] = [];
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      issues.push(`line ${n}: invalid JSON`);
      return;
    }
    const parsed = FrameLineV1.safeParse(json);
    if (parsed.success) frames.push(parsed.data);
    else for (const i of parsed.error.issues) issues.push(`line ${n}: ${i.path.join('.')}: ${i.message}`);
  });
  if (issues.length) throw new Error(`Invalid frames.jsonl: ${issues.join('; ')}`);
  return frames;
}
