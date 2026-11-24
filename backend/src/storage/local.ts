import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
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

    async presignUpload(key, _contentType, maxBytes, exactBytes, _ttlSeconds): Promise<PresignedUpload> {
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

    putStream(key, body, _contentType) {
      const file = resolvePath(key);
      // pipeline attaches only after mkdir; an abort before that would emit 'error' with no listener.
      body.on('error', () => undefined);
      const done = fs
        .mkdir(path.dirname(file), { recursive: true })
        .then(() => pipeline(body, createWriteStream(file)));
      return { done, abort: (e) => void body.destroy(e instanceof Error ? e : new Error(String(e ?? 'aborted'))) };
    },

    async getStream(key) {
      const file = resolvePath(key);
      await fs.stat(file); // reject (ENOENT) before handing out a stream
      return createReadStream(file);
    },

    async list(prefix) {
      const dir = resolvePath(prefix);
      let entries;
      try {
        entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const out: { key: string; size: number }[] = [];
      for (const d of entries) {
        if (!d.isFile()) continue;
        const full = path.join(d.parentPath, d.name);
        const key = path.relative(baseDir, full).split(path.sep).join('/');
        out.push({ key, size: (await fs.stat(full)).size });
      }
      return out;
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
    let bytes: Buffer;
    try {
      bytes = await local.getObject(key);
    } catch {
      return reply.code(404).send({ error: 'not_found', key });
    }
    reply.header('accept-ranges', 'bytes');
    const range = req.headers.range;
    if (!range) return reply.code(200).send(bytes);
    // Single range only (`bytes=a-b` or `bytes=a-`), bounded to the object size.
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    const total = bytes.length;
    const start = m ? Number(m[1]) : NaN;
    const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (!m || start >= total || start > end) {
      return reply.code(416).header('content-range', `bytes */${total}`).send();
    }
    return reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${total}`)
      .header('content-length', end - start + 1)
      .send(bytes.subarray(start, end + 1));
  });
}
