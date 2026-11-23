import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import type { PresignedUpload, StorageDriver } from './index.js';

// S3-compatible driver. Endpoint-configurable so it works against Cloudflare R2
// (production) as well as AWS S3 / MinIO. forcePathStyle keeps R2 happy.

export function createS3Storage(config: Config): StorageDriver {
  const bucket = config.S3_BUCKET as string;
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID as string,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY as string,
    },
  });

  return {
    kind: 's3',

    async presignUpload(key, contentType, maxBytes, exactBytes): Promise<PresignedUpload> {
      // Size enforcement (spec §10 R7). SigV4 can only bind an EXACT
      // Content-Length, not a ceiling, so:
      //  - client declared its size → sign Content-Length into the URL; R2/S3
      //    then rejects any payload of a different length outright.
      //  - it didn't → nothing can be bound here, and the worker's mandatory
      //    pre-read size check (worker objectSize HEAD before any frame read) is the backstop.
      // `maxBytes` is validated by the route before we ever get here.
      const signExact = typeof exactBytes === 'number' && exactBytes > 0 && exactBytes <= maxBytes;
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ...(signExact ? { ContentLength: exactBytes } : {}),
      });
      const url = await getSignedUrl(client, cmd, {
        expiresIn: 900,
        // content-length must be named explicitly: the presigner signs only
        // `host` by default, so an unlisted header is not bound to the URL.
        ...(signExact ? { signableHeaders: new Set(['content-length']) } : {}),
      });
      const headers: Record<string, string> = { 'content-type': contentType };
      if (signExact) headers['content-length'] = String(exactBytes);
      return { url, method: 'PUT', headers };
    },

    async presignDownload(key, ttlSeconds): Promise<string> {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(client, cmd, { expiresIn: ttlSeconds });
    },

    async putObject(key, bytes): Promise<void> {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }),
      );
    },

    async getObject(key): Promise<Buffer> {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error(`Empty object: ${key}`);
      return Buffer.from(bytes);
    },

    async deleteObject(key): Promise<void> {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    },

    async objectSize(key): Promise<number> {
      // HEAD, not GET — the caller is deciding whether the object is safe to
      // read into memory at all (spec §10 R7).
      const res = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (typeof res.ContentLength !== 'number') {
        throw new Error(`HEAD ${key} returned no ContentLength`);
      }
      return res.ContentLength;
    },

    putStream(key, body, contentType) {
      // R2 needs equal part sizes except the last, so partSize is fixed.
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
        partSize: 16 * 1024 * 1024,
        queueSize: 4,
        leavePartsOnError: false,
      });
      return { done: upload.done().then(() => undefined), abort: () => void upload.abort() };
    },

    async getStream(key): Promise<Readable> {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = res.Body as unknown;
      if (body instanceof Readable) return body;
      if (body && typeof (body as ReadableStream).getReader === 'function') {
        return Readable.fromWeb(body as import('node:stream/web').ReadableStream);
      }
      throw new Error(`Empty object: ${key}`);
    },

    async list(prefix) {
      const out: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}
