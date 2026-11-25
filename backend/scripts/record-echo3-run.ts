// OWNER-ONLY, during the paid session (D-07). Never run by an agent past its refusal.
// After the first real Echo-3 run reaches `ready`, records the real response
// shapes (status, envelope, exports — free GETs, no new world) as the replay set
// test/fixtures/echo3-recorded/manifest.json, scrubbed of every URL, signature
// and key, and server-side copies the world's re-hosted outputs in R2 dev to
// fixtures/echo3-run-1/ (nothing is downloaded from SpAItial; nothing big is committed).
// Usage:
//   cd backend && PROVIDER_MODE=live ALLOW_PAID_PROVIDER=1 node --env-file=.env --import tsx scripts/record-echo3-run.ts <worldId>
// Prints counts only — never the key, the connection string or any URL.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { CopyObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { assertDevBucket, assertDevDb } from './dev-guard.mjs';

const MANIFEST = fileURLToPath(new URL('../test/fixtures/echo3-recorded/manifest.json', import.meta.url));
const R2_PREFIX = 'fixtures/echo3-run-1/';
const LEAK = /X-Amz-|Signature=|spt_live_|:\/\//;

/**
 * Deep copy without any `*_url`, `url` or `location` key; throws if a remaining
 * string still looks like a URL, a signature or an API key (T-06-25).
 */
export function scrubRecorded<T>(obj: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (/_url$/i.test(k) || k === 'url' || k === 'location') continue;
        out[k] = walk(x);
      }
      return out;
    }
    if (typeof v === 'string' && LEAK.test(v)) {
      throw new Error('scrubRecorded: refusing to write a value that looks like a URL, signature or key');
    }
    return v;
  };
  return walk(obj) as T;
}

async function main(): Promise<void> {
  // Every refusal happens before any DB, R2 or network access.
  if (process.env.PROVIDER_MODE !== 'live' || process.env.ALLOW_PAID_PROVIDER !== '1') {
    throw new Error('refused: owner-only, paid session (needs PROVIDER_MODE=live and ALLOW_PAID_PROVIDER=1)');
  }
  if (process.env.NODE_ENV === 'production') throw new Error('refused: NODE_ENV=production');
  const dbUrl = assertDevDb('MIGRATE_DATABASE_URL');
  assertDevBucket();
  const apiKey = process.env.SPAITIAL_API_KEY;
  if (!apiKey) throw new Error('refused: SPAITIAL_API_KEY is not set');
  const base = (process.env.SPAITIAL_BASE_URL ?? 'https://api.spaitial.ai').replace(/\/$/, '');
  if (!base.startsWith('https://')) throw new Error('refused: SPAITIAL_BASE_URL must be https');
  const worldId = process.argv[2] ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new Error('usage: record-echo3-run.ts <worldId>');

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  let world: { status: string; provider_request_id: string | null; asset_version: number } | undefined;
  try {
    world = (await pool.query('SELECT status, provider_request_id, asset_version FROM worlds WHERE id = $1', [worldId]))
      .rows[0];
  } finally {
    await pool.end();
  }
  if (!world) throw new Error('world not found');
  if (world.status !== 'ready' || !world.provider_request_id) throw new Error(`world is ${world.status}, need ready + request id`);
  const req = `/v1/worlds/requests/${encodeURIComponent(world.provider_request_id)}`;

  // Read-only GETs: they never create a world, so they cost nothing.
  const get = async (endpoint: string, path: string): Promise<object> => {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`);
    return (await res.json()) as object;
  };
  const status = scrubRecorded(await get('status', `${req}/status`));
  const envelope = scrubRecorded(await get('envelope', req));
  const floorplan = scrubRecorded(await get('export floorplan', `${req}/exports/floorplan`));
  const mesh = scrubRecorded(await get('export mesh-simplified', `${req}/exports/mesh-simplified`));

  // Server-side copy inside R2 dev (assertDevBucket above): outputs stay out of git.
  const bucket = process.env.S3_BUCKET!;
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '' },
  });
  const src = `worlds/${worldId}/v${world.asset_version}/`;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: src }));
  let copied = 0;
  for (const o of listed.Contents ?? []) {
    if (!o.Key) continue;
    const name = o.Key.slice(src.length);
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: `${R2_PREFIX}${name}`,
        CopySource: `${bucket}/${o.Key.split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
    copied++;
  }

  const manifest = scrubRecorded({
    synthetic: false,
    note: 'recorded from the first paid Echo-3 run by scripts/record-echo3-run.ts; bodies scrubbed of URLs/keys',
    statusSequence: ['COMPLETED'],
    status: { COMPLETED: status },
    envelope,
    exports: { 'mesh-simplified': [mesh], floorplan: [floorplan] },
    artifacts: {
      splat: 'mock-outputs/splat.ply',
      collider: 'mock-outputs/collider.ply',
      floorplan: 'mock-outputs/floorplan.png',
      cameras: 'mock-outputs/cameras.json',
    },
    outputsR2Prefix: R2_PREFIX,
  });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`recorded 4 response bodies and copied ${copied} R2 object(s); review the manifest diff before committing`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`[record:echo3] ${(err instanceof Error ? err.message : String(err)).replace(/\w+:\/\/\S+/g, '[url]')}`);
      process.exit(1);
    },
  );
}
