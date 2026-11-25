import type { Config } from '../config.js';
import { createEcho3Provider } from './echo3.js';
import { createMockProvider, DEMO_ROOM_OUTPUTS_DIR } from './mock.js';
import type { ReconProvider } from './types.js';

export * from './types.js';

/**
 * Select the provider from config. PROVIDER_MODE=mock (default) spends nothing.
 * PROVIDER_MODE=live builds the paid Echo-3 client, reachable only past the
 * D-04 boot guard in config.ts (ALLOW_PAID_PROVIDER=1 + both secrets + https base).
 */
export function createProvider(config: Config): ReconProvider {
  if (config.PROVIDER_MODE === 'mock') {
    return createMockProvider({
      scenario: config.MOCK_SCENARIO,
      processingSeconds: config.MOCK_PROCESSING_SECONDS,
      webhookSecret: config.SPAITIAL_WEBHOOK_SECRET,
      outputsDir: config.MOCK_OUTPUTS_SET === 'demo-room' ? DEMO_ROOM_OUTPUTS_DIR : undefined,
    });
  }
  // WR-09: the factory that builds the spending object re-checks D-04 itself,
  // so a hand-built or cast Config can never reach the paid client.
  const { ALLOW_PAID_PROVIDER, SPAITIAL_API_KEY, SPAITIAL_WEBHOOK_SECRET, SPAITIAL_BASE_URL } = config;
  if (ALLOW_PAID_PROVIDER !== '1' || !SPAITIAL_API_KEY || !SPAITIAL_WEBHOOK_SECRET || !SPAITIAL_BASE_URL?.startsWith('https://')) {
    throw new Error('createProvider: live refused (D-04 guard)');
  }
  return createEcho3Provider({ apiKey: SPAITIAL_API_KEY, baseUrl: SPAITIAL_BASE_URL, webhookSecret: SPAITIAL_WEBHOOK_SECRET });
}
