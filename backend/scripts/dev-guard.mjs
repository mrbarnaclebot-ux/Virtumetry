// Guards for scripts that touch real dev resources from a laptop (T-02-06/07).
// Plain .mjs (cannot import src/isolation.ts), so this mirrors its host logic.
// Errors name the variable, never its value.

const DEV_ENDPOINT = 'ep-mute-fog-arwonnkz';

/** Return process.env[varName] only if it is the DIRECT Neon dev-branch host. */
export function assertDevDb(varName) {
  const v = process.env[varName];
  if (!v) throw new Error(`${varName} is not set`);
  let host;
  try {
    host = new URL(v).hostname.toLowerCase();
  } catch {
    throw new Error(`${varName} is not a valid connection URL`);
  }
  if (!host.includes(DEV_ENDPOINT)) {
    throw new Error(`${varName} refused: not the Neon dev branch (${DEV_ENDPOINT})`);
  }
  if (host.includes('-pooler')) {
    throw new Error(`${varName} refused: must be the direct host, not the -pooler host`);
  }
  return v;
}

/** S3_BUCKET must be the dev bucket. */
export function assertDevBucket() {
  if (process.env.S3_BUCKET !== 'virtumetry-dev') {
    throw new Error('S3_BUCKET refused: must be virtumetry-dev');
  }
}
