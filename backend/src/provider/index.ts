import type { Config } from '../config.js';
import { createMockProvider } from './mock.js';
import type { WorldGenProvider } from './types.js';

export * from './types.js';

/**
 * Select the provider from config. PROVIDER_MODE=mock (default) never touches
 * the network or spends credits. There is no live provider in this build.
 */
export function createProvider(config: Config): WorldGenProvider {
  if (config.PROVIDER_MODE === 'mock') {
    return createMockProvider();
  }
  throw new Error('no live provider in this build (Phase 6)');
}
