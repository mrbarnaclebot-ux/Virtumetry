import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api';

// D-08: mirror of backend/src/capture-config.ts (defaults pinned by capture-precheck.test.ts).

export type ReadinessConfig = {
  minFramesGreen: number;
  minFramesAmber: number;
  minSectorsGreen: number;
  minSectorsAmber: number;
  maxBlurShareGreen: number;
  maxBlurShareAmber: number;
  maxTrackingGapShareGreen: number;
  maxTrackingGapShareAmber: number;
};

export type PrecheckRules = {
  minFrames: number;
  maxBlurShare: number;
  maxTrackingGapShare: number;
  minCoverageSectors: number;
};

export type Pricing = { baseCredits: number; perFrameCredits: number; usdPerCredit: number };

export type CaptureConfig = {
  readiness: ReadinessConfig;
  precheck: PrecheckRules;
  pricing: Pricing;
  limits: { minFrames: number; maxFrames: number };
};

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
  pricing: { baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 },
  limits: { minFrames: 50, maxFrames: 5000 },
};

export const getCaptureConfig = () => apiFetch<CaptureConfig>('/v1/capture/config');

/** Server thresholds, or the bundled defaults while loading / offline (no UI for fetch state). */
export function useCaptureConfig(): CaptureConfig {
  return useQuery({ queryKey: ['capture-config'], queryFn: getCaptureConfig }).data ?? DEFAULT_CAPTURE_CONFIG;
}
