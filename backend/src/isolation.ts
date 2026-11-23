// Resource isolation constants (D-08). Hostnames and endpoint ids are not
// secrets. config.ts refine() uses these so the server, worker and migrate.ts
// all refuse to boot against VirtSpace or (outside production) against
// Virtumetry production.

/** VirtSpace production Neon endpoint (aws-us-east-2). Never reachable from here. */
export const VIRTSPACE_NEON_ENDPOINT_IDS: readonly string[] = ['ep-withered-paper-ajlntp59'];

/** VirtSpace's Neon region. Virtumetry lives in aws-us-west-2. */
export const DENY_HOST_SUFFIXES: readonly string[] = ['.us-east-2.aws.neon.tech'];

/** Virtumetry Neon `production` branch endpoint (project blue-star-06453943). */
export const VIRTUMETRY_PROD_ENDPOINT_IDS: readonly string[] = ['ep-cold-bread-arwg787p'];

/** Lowercased hostname of a connection string. Throws on an unparseable URL. */
export function dbHost(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** 'ep-foo-123-pooler.c-3.us-west-2.aws.neon.tech' -> 'ep-foo-123'; non-Neon -> null. */
export function neonEndpointId(url: string): string | null {
  const label = dbHost(url).split('.')[0] ?? '';
  return label.startsWith('ep-') ? label.replace(/-pooler$/, '') : null;
}

/** True when the first hostname label is a Neon pgbouncer pooler. */
export function isPoolerUrl(url: string): boolean {
  return (dbHost(url).split('.')[0] ?? '').endsWith('-pooler');
}

/** Bucket-name substrings refused in every environment (case-insensitive). */
export const DENY_BUCKET_SUBSTRINGS: readonly string[] = ['virtspace'];

/** True when a connection string targets a denylisted endpoint or region. */
export function isDeniedDbUrl(url: string): boolean {
  const host = dbHost(url);
  const ep = neonEndpointId(url);
  return (
    (ep !== null && VIRTSPACE_NEON_ENDPOINT_IDS.includes(ep)) ||
    DENY_HOST_SUFFIXES.some((s) => host.endsWith(s))
  );
}

/** True when a bucket name contains a denylisted substring. */
export function isDeniedBucket(name: string): boolean {
  return DENY_BUCKET_SUBSTRINGS.some((s) => name.toLowerCase().includes(s));
}
