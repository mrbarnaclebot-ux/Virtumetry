import type { Config } from '../config.js';
import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/**
 * Per-frame upload ceiling (spec §8 / §10 R7). Enforced in three places: the
 * request validator, the presigned URL itself (when the client declares an exact
 * size), and — always — the worker before it reads a frame into memory.
 */
export const MAX_FRAME_BYTES = 12 * 1024 * 1024;

// Storage driver contract (task requirement 4). Keys are opaque paths like
// `captures/{captureId}/frame_0.heic`.
export interface StorageDriver {
  readonly kind: 'local' | 's3';
  /**
   * Presign a single PUT. `maxBytes` is the policy ceiling. `exactBytes`, when
   * the client declared the object's exact size, is SIGNED into the URL as
   * Content-Length so the object store itself rejects a different payload
   * (spec §10 R7) — a max cannot be signed, only an exact length.
   */
  presignUpload(
    key: string,
    contentType: string,
    maxBytes: number,
    exactBytes?: number,
  ): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds: number): Promise<string>;
  putObject(key: string, bytes: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
  /**
   * Size of a stored object in bytes. Used by the worker to size-check a frame
   * BEFORE reading it into memory; throws when the object does not exist.
   */
  objectSize(key: string): Promise<number>;
}

export function createStorage(config: Config): StorageDriver {
  return config.STORAGE_DRIVER === 's3'
    ? createS3Storage(config)
    : createLocalStorage(config);
}

export { registerDevStorageRoutes } from './local.js';
