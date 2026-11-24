// D-08: capture thresholds. Code defaults, tunable without a build through the
// optional CAPTURE_CONFIG_JSON env (strict partial, merged per section). The
// device readiness meter and the precheck rules shared by the app and the
// backend validator (D-16) all read from here.

import { z } from 'zod';
import type { Config } from './config.js';

const share = z.number().min(0).max(1);
const count = z.number().int().nonnegative();

export const ReadinessSchema = z
  .object({
    minFramesGreen: count,
    minFramesAmber: count,
    minSectorsGreen: count,
    minSectorsAmber: count,
    maxBlurShareGreen: share,
    maxBlurShareAmber: share,
    maxTrackingGapShareGreen: share,
    maxTrackingGapShareAmber: share,
  })
  .strict();

export const PrecheckSchema = z
  .object({
    minFrames: z.number().int().min(1),
    maxBlurShare: share,
    maxTrackingGapShare: share,
    minCoverageSectors: z.number().int().min(0).max(12),
  })
  .strict();

export type ReadinessConfig = z.infer<typeof ReadinessSchema>;
export type PrecheckRules = z.infer<typeof PrecheckSchema>;
export type CaptureConfig = { readiness: ReadinessConfig; precheck: PrecheckRules };

/** [ASSUMED] production defaults, tune after Phase 8 real scans (RESEARCH "Recommended config values"). */
export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  readiness: {
    minFramesGreen: 150,
    minFramesAmber: 80,
    minSectorsGreen: 9,
    minSectorsAmber: 6,
    maxBlurShareGreen: 0.1,
    maxBlurShareAmber: 0.2,
    maxTrackingGapShareGreen: 0.0,
    maxTrackingGapShareAmber: 0.05,
  },
  precheck: { minFrames: 50, maxBlurShare: 0.25, maxTrackingGapShare: 0.0, minCoverageSectors: 4 },
};

/** Display-only pricing for the quote screen (not env): credits = base + perFrame x frames. */
export const PRICING = { baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 } as const;

const Override = z
  .object({ readiness: ReadinessSchema.partial().strict(), precheck: PrecheckSchema.partial().strict() })
  .partial()
  .strict();

/** Throws `CAPTURE_CONFIG_JSON is invalid` (never echoes the value, T-04-03). */
export function captureConfig(cfg: Pick<Config, 'CAPTURE_CONFIG_JSON'>): CaptureConfig {
  if (!cfg.CAPTURE_CONFIG_JSON) return DEFAULT_CAPTURE_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(cfg.CAPTURE_CONFIG_JSON);
  } catch {
    throw new Error('CAPTURE_CONFIG_JSON is invalid');
  }
  const parsed = Override.safeParse(raw);
  if (!parsed.success) throw new Error('CAPTURE_CONFIG_JSON is invalid');
  return {
    readiness: { ...DEFAULT_CAPTURE_CONFIG.readiness, ...parsed.data.readiness },
    precheck: { ...DEFAULT_CAPTURE_CONFIG.precheck, ...parsed.data.precheck },
  };
}
