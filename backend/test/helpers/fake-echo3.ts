import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

// Hermetic stand-in for the Echo-3 API (docs.spaitial.ai), bound to 127.0.0.1.
// Signed download redirects point at http://localhost:<port> — a different
// origin from the 127.0.0.1 API base — so tests can prove the bearer token never
// follows a redirect. Binaries are the committed mock-outputs fixtures.

export type Step = 'accept' | '429' | '503' | '500' | '401' | '402' | 'timeout' | 'drop-after-accept';
type Kind = 'mesh-simplified' | 'floorplan';

const FIXTURES = fileURLToPath(new URL('../fixtures/mock-outputs/', import.meta.url));
const SIGNED: Record<string, string> = {
  splat: 'splat.ply',
  cameras: 'cameras.json',
  'mesh-simplified': 'collider.ply',
  floorplan: 'floorplan.png',
};
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export async function startFakeEcho3(
  opts: {
    apiKey?: string;
    submitScript?: Step[];
    statusSequence?: string[];
    failedEnvelope?: object;
    exportScript?: Partial<Record<Kind, string[]>>;
    thumbnailUrl?: string | null;
    /** Seconds or HTTP date sent as Retry-After with a scripted 429. */
    retryAfter?: string;
  } = {},
) {
  const apiKey = opts.apiKey ?? 'spt_live_test';
  const script = [...(opts.submitScript ?? [])];
  const statusSeq = opts.statusSequence ?? ['PROCESSING', 'COMPLETED'];
  const exportSeq: Record<Kind, string[]> = {
    'mesh-simplified': [...(opts.exportScript?.['mesh-simplified'] ?? ['READY'])],
    floorplan: [...(opts.exportScript?.floorplan ?? ['READY'])],
  };
  const floorplanMeta = JSON.parse(readFileSync(`${FIXTURES}floorplan.json`, 'utf8')) as unknown;
  const byKey = new Map<string, { body: string; requestId: string }>();
  const known = new Set<string>();
  const statusCursor = new Map<string, number>();
  const cancelled = new Set<string>();
  const state = {
    billed: 0,
    submits: [] as { key: string; body: string; auth?: string }[],
    signedHits: [] as { path: string; auth?: string }[],
    calls: {} as Record<string, number>,
  };
  let port = 0;

  const currentStatus = (id: string) =>
    cancelled.has(id) ? 'CANCELLED' : statusSeq[Math.min(Math.max((statusCursor.get(id) ?? 0) - 1, 0), statusSeq.length - 1)]!;
  /** Walk a script; the last value sticks. */
  const next = (seq: string[]) => (seq.length > 1 ? seq.shift()! : seq[0]!);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const json = (code: number, body: unknown, h: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...h });
      res.end(JSON.stringify(body));
    };
    const err = (code: number, c: string, h?: Record<string, string>) =>
      json(code, { error: { code: c, message: c, details: {} } }, h);
    const redirect = (name: string) => {
      res.writeHead(302, { location: `http://localhost:${port}/signed/${name}` });
      res.end();
    };
    const count = (k: string) => (state.calls[k] = (state.calls[k] ?? 0) + 1);

    if (p.startsWith('/signed/')) {
      state.signedHits.push({ path: p, auth: req.headers.authorization });
      const file = SIGNED[p.slice('/signed/'.length)];
      if (!file) return err(404, 'NOT_FOUND');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(readFileSync(`${FIXTURES}${file}`));
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) return err(401, 'UNAUTHORIZED');

    if (req.method === 'POST' && p === '/v1/worlds') {
      count('submit');
      const key = String(req.headers['idempotency-key']);
      state.submits.push({ key, body: raw, auth: req.headers.authorization });
      const step = script.shift() ?? 'accept';
      if (step === '429') return err(429, 'RATE_LIMIT_EXCEEDED', { 'retry-after': opts.retryAfter ?? '7' });
      if (step === '503') return err(503, 'WORLD_INTAKE_UNAVAILABLE');
      if (step === '500') return err(500, 'INTERNAL_ERROR');
      if (step === '401') return err(401, 'UNAUTHORIZED');
      if (step === '402') return err(402, 'INSUFFICIENT_CREDITS');
      const prior = byKey.get(key);
      if (prior && prior.body !== raw) return err(409, 'IDEMPOTENCY_KEY_REUSED');
      const rec = prior ?? { body: raw, requestId: `req_${randomUUID()}` };
      if (!prior) {
        byKey.set(key, rec);
        known.add(rec.requestId);
        state.billed++; // billed = distinct worlds created
      }
      if (step === 'drop-after-accept') return void req.socket.destroy();
      if (step === 'timeout') return; // never answer; the client's AbortSignal fires
      return json(202, { request_id: rec.requestId });
    }

    if (req.method === 'GET' && p === '/v1/captures/limits') {
      count('limits');
      return json(200, { min_frames: 1, max_frames: 5000 });
    }
    if (req.method === 'GET' && p === '/v1/captures/process-quote') {
      count('quote');
      const n = Number(url.searchParams.get('frame_count'));
      if (url.searchParams.get('model') !== 'echo-3' || !Number.isInteger(n)) return err(400, 'INVALID_INPUT');
      return json(200, { required_credits: 900 + n, available_credits: 100000, has_enough: true });
    }

    const m = /^\/v1\/worlds\/requests\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return err(404, 'NOT_FOUND');
    const id = decodeURIComponent(m[1]!);
    const rest = m[2] ?? '';

    if (req.method === 'GET' && rest === '/status') {
      count('status');
      statusCursor.set(id, (statusCursor.get(id) ?? 0) + 1);
      const s = currentStatus(id);
      return json(200, {
        status: s,
        progress: s === 'COMPLETED' ? 1 : null,
        ...(s === 'FAILED' ? { error: { code: 'WORLD_GENERATION_FAILED', message: 'failed' } } : {}),
      });
    }
    if (req.method === 'GET' && rest === '') {
      count('envelope');
      return json(200, {
        world: { splat_format: 'spz', thumbnail_url: opts.thumbnailUrl ?? null },
        validation: { passed: true, issues: [] },
        error: null,
        ...opts.failedEnvelope,
      });
    }
    if (req.method === 'GET' && (rest === '/splat' || rest === '/cameras')) {
      count(rest.slice(1));
      return redirect(rest.slice(1));
    }
    const ex = /^\/exports\/(mesh-simplified|floorplan)$/.exec(rest);
    if (ex) {
      const kind = ex[1] as Kind;
      if (req.method === 'GET' && url.searchParams.get('download') === '1') {
        count(`download:${kind}`);
        return redirect(kind);
      }
      if (req.method === 'GET') {
        count(`export:GET:${kind}`);
        const s = next(exportSeq[kind]);
        if (s === '404') return err(404, 'EXPORT_NOT_FOUND');
        return json(200, {
          status: s,
          ...(s === 'READY' && kind === 'floorplan' ? { floorplan: floorplanMeta, download_url: 'unused' } : {}),
        });
      }
      if (req.method === 'POST') {
        count(`export:POST:${kind}`);
        // 200 when the next scripted state is READY (already done), else 202 started.
        return exportSeq[kind][0] === 'READY' ? json(200, { status: 'READY' }) : json(202, { status: 'PROCESSING' });
      }
    }
    if (req.method === 'POST' && rest === '/cancel') {
      count('cancel');
      if (TERMINAL.has(currentStatus(id))) return err(409, 'REQUEST_NOT_CANCELLABLE');
      cancelled.add(id);
      return json(202, { status: 'CANCELLED' });
    }
    if (req.method === 'DELETE' && rest === '') {
      count('delete');
      if (!known.delete(id)) return err(404, 'REQUEST_NOT_FOUND');
      res.writeHead(204);
      res.end();
      return;
    }
    return err(404, 'NOT_FOUND');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections(); // the 'timeout' step leaves a socket hanging
        server.close(() => r());
      }),
  };
}
