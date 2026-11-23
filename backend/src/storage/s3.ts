import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
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
      //    pre-read size check (handleStitch) is the backstop.
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
  };
}
