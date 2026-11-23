import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { worldsRoutes } from '../src/routes/worlds.js';
import { accountRoutes } from '../src/routes/account.js';
import { worlds, jobs, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// spec §10 R27 — every status flip / soft delete and the job that carries it on
// must be written in ONE transaction. A crash between two separate statements
// left a world with no job: generating_hq forever, or a deleted world whose
// assets were never purged (§13).

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

const WORLD_ID = '11111111-2222-3333-4444-555555555555';

const world = {
  id: WORLD_ID,
  ownerId: 'user-1',
  status: 'draft_ready',
  deletedAt: null,
} as unknown as World;

/** Every write, tagged with whether it went through a transaction handle. */
type Write = { op: 'update' | 'insert' | 'delete'; table: unknown; inTx: boolean };

function makeDb(writes: Write[]) {
  const build = (inTx: boolean) => {
    const handle = {
      select: () => ({
        from: () => {
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: async () => [world],
            then: (res: (v: unknown) => void) => res([{ id: WORLD_ID }]),
          };
          return chain;
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            writes.push({ op: 'update', table, inTx });
            const rows = [{ ...world, ...patch }];
            return Object.assign(Promise.resolve(rows), { returning: async () => rows });
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: () => ({
          returning: async () => {
            writes.push({ op: 'insert', table, inTx });
            return [{ id: 'job-1' }];
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: async () => {
          writes.push({ op: 'delete', table, inTx });
        },
      }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(build(true)),
      // budgetFits' SUM (enhance's advisory credit check): nothing spent.
      execute: async () => ({ rows: [{ total: 0 }] }),
    };
    return handle;
  };
  return build(false);
}

async function makeApp(writes: Write[]) {
  currentDb = makeDb(writes);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  worldsRoutes(app, { config, storage: {} as StorageDriver });
  accountRoutes(app);
  await app.ready();
  return app;
}

/** The world write and the job insert both happened, both inside a tx. */
function expectFlipAndJobInTx(writes: Write[]) {
  const flip = writes.find((w) => w.op === 'update' && w.table === worlds);
  const job = writes.find((w) => w.op === 'insert' && w.table === jobs);
  expect(flip?.inTx).toBe(true);
  expect(job?.inTx).toBe(true);
}

describe('flip + enqueue atomicity (§10 R27)', () => {
  it(':enhance flips to generating_hq and enqueues generate_hq in one transaction', async () => {
    const writes: Write[] = [];
    const app = await makeApp(writes);
    const res = await app.inject({ method: 'POST', url: `/v1/worlds/${WORLD_ID}:enhance` });
    expect(res.statusCode).toBe(200);
    expectFlipAndJobInTx(writes);
    await app.close();
  });

  it('DELETE /v1/worlds/:id soft-deletes and enqueues the purge in one transaction', async () => {
    const writes: Write[] = [];
    const app = await makeApp(writes);
    const res = await app.inject({ method: 'DELETE', url: `/v1/worlds/${WORLD_ID}` });
    expect(res.statusCode).toBe(200);
    expectFlipAndJobInTx(writes);
    await app.close();
  });

  it('DELETE /v1/account soft-deletes each world with its purge in one transaction', async () => {
    const writes: Write[] = [];
    const app = await makeApp(writes);
    const res = await app.inject({ method: 'DELETE', url: '/v1/account' });
    expect(res.statusCode).toBe(200);
    expect(res.json().worlds_purged).toBe(1);
    expectFlipAndJobInTx(writes);
    await app.close();
  });
});
