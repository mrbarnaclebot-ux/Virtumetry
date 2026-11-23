import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { PresignedUpload, StorageDriver } from './index.js';

// Local disk driver for dev. "Presigned" URLs are plain HTTP URLs served by the
// Fastify /dev-storage/* route below (PUT to upload, GET to download). Only
// registered when STORAGE_DRIVER=local — never in production.

export interface LocalStorage extends StorageDriver {
  readonly kind: 'local';
  resolvePath(key: string): string;
  maxBytesFor(key: string): number | undefined;
}

// Guard against path traversal in keys before touching the filesystem.
function safeJoin(baseDir: string, key: string): string {
  const target = path.resolve(baseDir, key);
  const base = path.resolve(baseDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return target;
}

export function createLocalStorage(config: Config): LocalStorage {
  const baseDir = path.resolve(config.LOCAL_STORAGE_DIR);
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  // Track per-key size limits announced at presign time; enforced on PUT.
  const limits = new Map<string, number>();

  const resolvePath = (key: string) => safeJoin(baseDir, key);

  return {
    kind: 'local',
    resolvePath,
    maxBytesFor: (key) => limits.get(key),

    async presignUpload(key, _contentType, maxBytes, exactBytes): Promise<PresignedUpload> {
      // Mirror the S3 driver's ceiling semantics (spec §10 R7): a declared exact
      // size is the tighter limit the /dev-storage PUT route enforces.
      const limit =
        typeof exactBytes === 'number' && exactBytes > 0 && exactBytes <= maxBytes
          ? exactBytes
          : maxBytes;
      limits.set(key, limit);
      const headers: Record<string, string> = { 'content-type': _contentType };
      if (limit === exactBytes) headers['content-length'] = String(exactBytes);
      return {
        url: `${base}/dev-storage/${key}`,
        method: 'PUT',
        headers,
      };
    },

    async presignDownload(key, _ttlSeconds): Promise<string> {
      return `${base}/dev-storage/${key}`;
    },

    async putObject(key, bytes): Promise<void> {
      const file = resolvePath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    },

    async getObject(key): Promise<Buffer> {
      return fs.readFile(resolvePath(key));
    },

    async deleteObject(key): Promise<void> {
      await fs.rm(resolvePath(key), { force: true });
    },

    async objectSize(key): Promise<number> {
      const st = await fs.stat(resolvePath(key));
      return st.size;
    },
  };
}

/** Register the dev-only upload/download route. No-op unless driver is local. */
export function registerDevStorageRoutes(
  app: FastifyInstance,
  storage: StorageDriver,
): void {
  if (storage.kind !== 'local') return;
  const local = storage as LocalStorage;

  // Accept raw bytes for any content-type on upload.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.put<{ Params: { '*': string } }>('/dev-storage/*', async (req, reply) => {
    const key = req.params['*'];
    const body = req.body as Buffer;
    const max = local.maxBytesFor(key);
    if (max !== undefined && Buffer.isBuffer(body) && body.byteLength > max) {
      return reply.code(413).send({ error: 'payload_too_large', maxBytes: max });
    }
    await local.putObject(key, body);
    return reply.code(200).send({ ok: true, key, bytes: body.byteLength });
  });

  app.get<{ Params: { '*': string } }>('/dev-storage/*', async (req, reply) => {
    const key = req.params['*'];
    try {
      const bytes = await local.getObject(key);
      return reply.code(200).send(bytes);
    } catch {
      return reply.code(404).send({ error: 'not_found', key });
    }
  });
}
