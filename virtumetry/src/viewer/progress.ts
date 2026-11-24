/**
 * Honest download progress (D-05): stream the body ourselves and count bytes.
 * Percent is floor-rounded, clamped to 99 until the stream ends, then 100; null when Content-Length is unknown.
 */
export async function fetchWithProgress(
  url: string,
  onPct: (p: number | null) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw Object.assign(new Error(`fetch ${res.status}`), { status: res.status });
  const total = Number(res.headers.get('content-length')) || 0;
  if (!total) onPct(null);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (!total) continue;
    const pct = Math.min(99, Math.floor((got / total) * 100));
    if (pct > last) onPct((last = pct));
  }
  if (total) onPct(100);
  // Fresh buffer at offset 0: Spark's getSplatFileType reads new DataView(bytes.buffer).
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
