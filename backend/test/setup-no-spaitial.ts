// HARD MONEY RULE (T-06-01): Echo-3 has no sandbox, so any test that reaches
// *.spaitial.ai would spend real credits. Registered as a vitest setupFile, this
// wrapper throws before a socket opens; everything else goes to the real fetch.
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let host = '';
  try {
    host = new URL(href).hostname.toLowerCase();
  } catch {
    // relative/invalid URL: the real fetch rejects it on its own
  }
  if (host === 'spaitial.ai' || host.endsWith('.spaitial.ai')) {
    throw new Error(`HARD MONEY RULE: test tried to call ${host} (spaitial.ai is blocked in tests)`);
  }
  return realFetch(input, init);
}) as typeof fetch;
