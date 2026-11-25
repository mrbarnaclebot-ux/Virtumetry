import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

let spent = { day: 0, month: 0 };
let executes = 0;
vi.mock('../src/db/client.js', () => ({
  getDb: () => ({
    execute: async () => {
      executes += 1;
      return { rows: [{ day: String(spent.day), month: String(spent.month) }] };
    },
  }),
}));

import { scansRoutes } from '../src/routes/scans.js';
import { loadConfig } from '../src/config.js';
import { createMockProvider } from '../src/provider/mock.js';
import type { StorageDriver } from '../src/storage/index.js';

// D-18 quote + D-08 capture config: read-only, computed on the server.

const DEV_JSON =
  '{"readiness":{"minFramesGreen":25,"minFramesAmber":15,"minSectorsGreen":1,"minSectorsAmber":1},"precheck":{"minFrames":20,"minCoverageSectors":1}}';

async function buildApp(env: Record<string, string> = {}, authed = true) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DEV_AUTH_TOKEN: 't',
    DAILY_CREDIT_BUDGET: '10000',
    MONTHLY_CREDIT_BUDGET: '100000',
    ...env,
  } as NodeJS.ProcessEnv);
  const app = Fastify();
  if (authed) app.addHook('preHandler', async (req) => { req.userId = 'user-1'; });
  scansRoutes(app, { config, storage: {} as StorageDriver, provider: createMockProvider({}) });
  await app.ready();
  return app;
}

describe('GET /v1/quote', () => {
  it('quotes 900 + n credits against an empty ledger', async () => {
    spent = { day: 0, month: 0 };
    executes = 0;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/quote?frames=30' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      credits: 930, usd: 9.3, budgetRemaining: 10000, budgetWindow: 'daily', withinBudget: true, budgetAlert: null,
    });
    expect(executes).toBe(1); // one read, no reservation
    await app.close();
  });

  it('is not within budget when the daily window cannot cover it', async () => {
    spent = { day: 9500, month: 9500 };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/quote?frames=30' });
    expect(res.json()).toMatchObject({ budgetRemaining: 500, budgetWindow: 'daily', withinBudget: false });
    await app.close();
  });

  it('reports the monthly window when it is the tighter one', async () => {
    spent = { day: 0, month: 99500 };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/quote?frames=30' });
    expect(res.json()).toMatchObject({ budgetRemaining: 500, budgetWindow: 'monthly', withinBudget: false });
    await app.close();
  });

  it('floors budgetRemaining at 0', async () => {
    spent = { day: 12000, month: 12000 };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/quote?frames=1' });
    expect(res.json()).toMatchObject({ budgetRemaining: 0, withinBudget: false });
    await app.close();
  });

  it.each(['frames=0', 'frames=abc', 'frames=5001', 'frames=1.5', ''])('400s on %s', async (q) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/quote?${q}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    await app.close();
  });

  it('401s without auth', async () => {
    const app = await buildApp({}, false);
    const res = await app.inject({ method: 'GET', url: '/v1/quote?frames=30' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /v1/capture/config', () => {
  it('merges CAPTURE_CONFIG_JSON over defaults with pricing and limits', async () => {
    const app = await buildApp({ CAPTURE_CONFIG_JSON: DEV_JSON });
    const res = await app.inject({ method: 'GET', url: '/v1/capture/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.readiness.minFramesGreen).toBe(25);
    expect(body.readiness.maxBlurShareGreen).toBe(0.1); // default kept
    expect(body.precheck.minFrames).toBe(20);
    expect(body.pricing).toEqual({ baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 });
    expect(body.limits).toEqual({ minFrames: 20, maxFrames: 5000 });
    await app.close();
  });

  it('serves defaults without the env var', async () => {
    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/v1/capture/config' })).json();
    expect(body.precheck.minFrames).toBe(50);
    expect(body.limits.minFrames).toBe(50);
    await app.close();
  });

  it('401s without auth', async () => {
    const app = await buildApp({}, false);
    const res = await app.inject({ method: 'GET', url: '/v1/capture/config' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
