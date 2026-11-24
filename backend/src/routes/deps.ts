import type { Config } from '../config.js';
import type { StorageDriver } from '../storage/index.js';
import type { Auth } from '../auth/better-auth.js';
import type { ReconProvider } from '../provider/index.js';

export interface RouteDeps {
  config: Config;
  storage: StorageDriver;
  /** Better Auth instance; present only when AUTH_MODE=session. */
  auth?: Auth;
  /** quote()/limits() for scan approval; defaults to createProvider(config). */
  provider?: ReconProvider;
}
