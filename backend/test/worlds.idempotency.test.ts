import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { isUniqueViolation } from '../src/routes/worlds.js';
import { scansRoutes } from '../src/routes/scans.js';
import { createMockProvider } from '../src/provider/mock.js';
import { worlds, captures, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// spec §10 R4 — a retried create must never mint a second billable world.
// POST /v1/scans REQUIRES `Idempotency-Key: <session UUID>`; a repeat returns
// the SAME world, charged once.

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

const KEY = '11111111-2222-4333-8444-555555555555';

function fakeWorld(overrides: Partial<World> = {}): World {
  return {
    id: 'w-1', ownerId: 'user-1', title: null, caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status: 'uploading', phase: null, progress: null,
    clientRequestId: null,
    splatKey: null, colliderKey: null, floorplanKey: null,
    camerasKey: null, thumbnailKey: null, assetVersion: 1, provider: null,
    creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'), deletedAt: null,
    ...overrides,
  };
}

interface DbState {
  /** Worlds keyed by client_request_id (the idempotency lookup). */
  byKey: Map<string, World>;
  capture: { id: string; worldId: string; frameCount: number; r2FramesPrefix: string | null } | null;
  inserts: Record<string, unknown>[];
  quotaCharges: number;
  quotaReleases: number;
  /** When set, the worlds INSERT throws it (concurrent-duplicate simulation). */
  insertError?: unknown;
  /** Row the loser of the race then finds. */
  raceWinner?: World;
}

function makeDb(state: DbState) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          _key: null as string | null,
          where: (cond: unknown) => {
            // The only keyed lookup in this route is by client_request_id; the
            // fake resolves it from the state map below.
            void cond;
            return chain;
          },
          orderBy: () => chain,
          limit: async () => {
            if (table === worlds) {
              const found = [...state.byKey.values()];
              return found.length > 0 ? [found[0]] : [];
            }
            if (table === captures) return state.capture ? [state.capture] : [];
            return [];
          },
        };
        return chain;
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          state.inserts.push({ table, ...vals });
          if (table === worlds) {
            if (state.insertError) {
              if (state.raceWinner) {
                state.byKey.set(KEY, state.raceWinner);
              }
              throw state.insertError;
            }
            const created = fakeWorld({
              clientRequestId: (vals['clientRequestId'] as string | null) ?? null,
            });
            if (created.clientRequestId) state.byKey.set(created.clientRequestId, created);
            return [created];
          }
          state.capture = {
            id: 'cap-1',
            worldId: 'w-1',
            frameCount: vals['frameCount'] as number,
            r2FramesPrefix: 'captures/cap-1',
          };
          return [state.capture];
        },
      }),
    }),
    execute: async (q: unknown) => {
      // Two raw statements exist on this path: the quota charge and its refund.
      const text = JSON.stringify(q);
      if (text.includes('GREATEST')) {
        state.quotaReleases += 1;
        return { rows: [] };
      }
      state.quotaCharges += 1;
      return {
        rows: [
          { user_id: 'user-1', new_count: 1, reset_at: new Date('2026-09-18T00:00:00Z') },
        ],
      };
    },
  };
}

function makeStorage() {
  const presignUpload = vi.fn(async (key: string, contentType: string) => ({
    url: `https://signed.example/${key}?sig=${Math.random()}`,
    method: 'PUT' as const,
    headers: { 'content-type': contentType },
  }));
  return { kind: 'local', presignUpload, presignDownload: vi.fn(), putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn(), objectSize: vi.fn() } as unknown as StorageDriver & {
    presignUpload: typeof presignUpload;
  };
}

async function buildApp(storage: StorageDriver) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  scansRoutes(app, { config, storage, provider: createMockProvider({}) });
  await app.ready();
  return app;
}

function newState(): DbState {
  return { byKey: new Map(), capture: null, inserts: [], quotaCharges: 0, quotaReleases: 0 };
}

describe('isUniqueViolation', () => {
  it('detects SQLSTATE 23505, directly or wrapped in a cause chain', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('wrapped'), { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

const BODY = { frame_count: 30, image_w: 1920, image_h: 1440, approved_max_credits: 930 };

function post(app: Awaited<ReturnType<typeof buildApp>>, key?: string, payload: object = BODY) {
  return app.inject({
    method: 'POST',
    url: '/v1/scans',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    payload,
  });
}

describe('POST /v1/scans with Idempotency-Key', () => {
  it('first call creates the world, storing the key', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, KEY);

    expect(res.statusCode).toBe(201);
    const worldInsert = state.inserts.find((i) => i['table'] === worlds)!;
    expect(worldInsert['clientRequestId']).toBe(KEY);
    expect(worldInsert['approvedMaxCredits']).toBe(930);
    expect(state.quotaCharges).toBe(1);
    await app.close();
  });

  it('a repeat with the same key returns the SAME world, no second row, no second charge', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const first = await post(app, KEY);
    const second = await post(app, KEY);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().world).toEqual(first.json().world);
    expect(state.inserts.filter((i) => i['table'] === worlds)).toHaveLength(1);
    expect(state.quotaCharges).toBe(1);
    await app.close();
  });

  it('rejects a non-UUID key with 400 invalid_idempotency_key (before any charge)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, 'not-a-uuid');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_idempotency_key');
    expect(state.quotaCharges).toBe(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('requires the header: 400 missing_idempotency_key, no charge', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('missing_idempotency_key');
    expect(state.quotaCharges).toBe(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('rejects an approval below the quote before any charge', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, KEY, { ...BODY, approved_max_credits: 929 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'approval_below_quote', quote_credits: 930 });
    expect(state.quotaCharges).toBe(0);
    await app.close();
  });

  it('accepts a GUID that is not RFC 9562 (zod 3 .uuid() contract kept on zod 4)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());
    const guid = '00000000-0000-0000-0000-000000000001'; // no version/variant bits

    const res = await post(app, guid);

    expect(res.statusCode).toBe(201);
    expect(state.inserts.find((i) => i['table'] === worlds)?.['clientRequestId']).toBe(guid);
    await app.close();
  });

  it('409s when the key maps to a soft-deleted world', async () => {
    const state = newState();
    state.byKey.set(KEY, fakeWorld({ clientRequestId: KEY, deletedAt: new Date() }));
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, KEY);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'idempotency_key_world_deleted', world_id: 'w-1' });
    expect(state.quotaCharges).toBe(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('loses the concurrent-insert race gracefully: replays the winner and refunds the scan', async () => {
    const state = newState();
    state.insertError = Object.assign(new Error('duplicate key value'), { code: '23505' });
    state.raceWinner = fakeWorld({ clientRequestId: KEY });
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, KEY);

    expect(res.statusCode).toBe(200);
    expect(res.json().world.id).toBe('w-1');
    // The scan this request charged is given back — the winner already paid.
    expect(state.quotaCharges).toBe(1);
    expect(state.quotaReleases).toBe(1);
    await app.close();
  });

  it('rethrows a non-unique insert failure instead of masking it', async () => {
    const state = newState();
    state.insertError = Object.assign(new Error('connection reset'), { code: '08006' });
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, KEY);

    expect(res.statusCode).toBe(500);
    expect(state.quotaReleases).toBe(0);
    await app.close();
  });

  it('accepts a random session UUID (the real client contract)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await post(app, randomUUID());

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
