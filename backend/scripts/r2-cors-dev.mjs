// Set and check CORS on the virtumetry-dev R2 bucket so browsers (web share page)
// and the Expo Go viewer can fetch room bytes with Range. Dev bucket ONLY.
// Usage: cd backend && node --env-file=.env scripts/r2-cors-dev.mjs --origin <SHARE_ORIGIN> [--lan-any] [--check-only]
//   --lan-any     replace the LAN origin patterns with '*' (GET/HEAD only; the
//                 presigned URL stays the access control, CORS is not)
//   --check-only  skip PutBucketCors, only read the rule and run the preflights
// Prints statuses and CORS headers only, never the endpoint or keys.
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { assertDevBucket } from './dev-guard.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const origin = args[args.indexOf('--origin') + 1];

try {
  assertDevBucket();
  if (!args.includes('--origin') || !/^https:\/\/[^/]+$/.test(origin ?? '')) {
    throw new Error('--origin must be an https origin with no path');
  }
} catch (err) {
  console.error(`[r2-cors-dev] ${err.message}`);
  process.exit(1);
}

const bucket = process.env.S3_BUCKET; // virtumetry-dev (asserted above)
const client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const lanOrigins = flag('--lan-any')
  ? ['*']
  : ['http://192.168.*', 'http://10.*', 'https://*.exp.direct']; // Expo Go LAN or --tunnel (Metro serves the DOM viewer)
const rule = {
  AllowedOrigins: [origin, 'http://localhost:8081', 'http://localhost:8090', ...lanOrigins],
  AllowedMethods: ['GET', 'HEAD'],
  AllowedHeaders: ['Range'],
  ExposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag'],
  MaxAgeSeconds: 3600,
};

if (!flag('--check-only')) {
  try {
    await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [rule] } }));
    console.log('[r2-cors-dev] PutBucketCors ok; waiting 30 s for propagation');
    await new Promise((r) => setTimeout(r, 30_000));
  } catch (err) {
    console.error(`[r2-cors-dev] PutBucketCors failed: ${err.name}`);
    if (err.name === 'AccessDenied') {
      console.error('Paste this in Cloudflare dashboard -> R2 -> virtumetry-dev -> Settings -> CORS Policy, then re-run with --check-only:');
      console.error(JSON.stringify([{
        AllowedOrigins: rule.AllowedOrigins,
        AllowedMethods: rule.AllowedMethods,
        AllowedHeaders: rule.AllowedHeaders,
        ExposeHeaders: rule.ExposeHeaders,
        MaxAgeSeconds: rule.MaxAgeSeconds,
      }], null, 2));
    }
    process.exit(1);
  }
}

try {
  const got = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log('[r2-cors-dev] current rules:', JSON.stringify(got.CORSRules, null, 2));
} catch (err) {
  console.error(`[r2-cors-dev] GetBucketCors failed: ${err.name}`);
  process.exit(1);
}

const objectUrl = `${process.env.S3_ENDPOINT.replace(/\/$/, '')}/${bucket}/cors-preflight-probe`;
let failed = false;
for (const o of [origin, 'http://192.168.1.50:8081', 'https://abc-anonymous-8081.exp.direct']) {
  const res = await fetch(objectUrl, {
    method: 'OPTIONS',
    headers: { Origin: o, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
  });
  const allow = res.headers.get('access-control-allow-origin');
  console.log(`[r2-cors-dev] preflight ${o} -> ${res.status} allow-origin=${allow ?? '(none)'}`);
  if (o === origin && allow !== origin && allow !== '*') failed = true;
}
process.exit(failed ? 1 : 0);
