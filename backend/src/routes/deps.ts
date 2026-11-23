import type { Config } from '../config.js';
import type { StorageDriver } from '../storage/index.js';

export interface RouteDeps {
  config: Config;
  storage: StorageDriver;
}
