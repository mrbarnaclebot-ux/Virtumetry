import type { Config } from '../config.js';
import { createMockProvider } from './mock.js';
import type { ReconProvider } from './types.js';

export * from './types.js';

/**
 * Select the provider from config. PROVIDER_MODE=mock (default) spends nothing.
 * There is no live provider in this build; echo3.ts lands in Phase 6.
 */
export function createProvider(config: Config): ReconProvider {
  if (config.PROVIDER_MODE === 'mock') {
    return createMockProvider({
      scenario: config.MOCK_SCENARIO,
      processingSeconds: config.MOCK_PROCESSING_SECONDS,
      webhookSecret: config.SPAITIAL_WEBHOOK_SECRET,
    });
  }
  throw new Error('no live provider in this build (Phase 6)');
}
