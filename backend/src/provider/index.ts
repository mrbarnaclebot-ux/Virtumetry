import type { Config } from '../config.js';
import { createMockProvider } from './mock.js';
import { createWorldLabsProvider } from './worldlabs.js';
import type { WorldGenProvider } from './types.js';

export * from './types.js';

/**
 * Select the provider from config. PROVIDER_MODE=mock (default) never touches
 * the network or spends credits; live requires WORLDLABS_API_KEY.
 */
export function createProvider(config: Config): WorldGenProvider {
  if (config.PROVIDER_MODE === 'mock') {
    return createMockProvider();
  }
  if (!config.WORLDLABS_API_KEY) {
    throw new Error('PROVIDER_MODE=live requires WORLDLABS_API_KEY');
  }
  return createWorldLabsProvider({
    apiKey: config.WORLDLABS_API_KEY,
    ...(config.WORLDLABS_ASSET_HOSTS ? { assetHosts: config.WORLDLABS_ASSET_HOSTS } : {}),
    assetMaxBytes: config.WORLDLABS_ASSET_MAX_BYTES,
  });
}
