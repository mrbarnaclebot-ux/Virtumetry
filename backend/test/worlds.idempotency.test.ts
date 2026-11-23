import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { worldsRoutes, isUniqueViolation } from '../src/routes/worlds.js';
import { worlds, captures, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// spec §10 R4 (backend half) — POST /v1/worlds had no idempotency key, so the
// iOS client's retry of a complete-but-failing session minted a fresh, billable
// world (and burned quota) on every attempt. `Idempotency-Key: <session UUID>`
// now returns the SAME world, charged once.

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
    panoUrl: null, thumbnailUrl: null, spz100kUrl: null, spz500kUrl: null,
    spzFullUrl: null, colliderGlbUrl: null, assetVersion: 1, provider: null,
    draftWorldId: null, hqWorldId: null, draftModel: null, hqModel: null, creditsSpent: 0,
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
  worldsRoutes(app, { config, storage });
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

describe('POST /v1/worlds with Idempotency-Key', () => {
  it('first call creates the world, storing the key', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 2 },
    });

    expect(res.statusCode).toBe(201);
    const worldInsert = state.inserts.find((i) => i['table'] === worlds)!;
    expect(worldInsert['clientRequestId']).toBe(KEY);
    expect(state.quotaCharges).toBe(1);
    await app.close();
  });

  it('a repeat with the same key returns the SAME world, no second row, no second charge', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const first = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 2 },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 2 },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    // Same world + same capture, and the create response shape is preserved.
    expect(second.json().world).toEqual(first.json().world);
    expect(second.json().capture_id).toBe(first.json().capture_id);
    expect(second.json().uploads).toHaveLength(2);
    expect(second.json().uploads[0].key).toBe(first.json().uploads[0].key);
    // Fresh signatures are fine (the originals have usually expired).
    expect(second.json().idempotent_replay).toBe(true);
    // Exactly one world row and one quota charge.
    expect(state.inserts.filter((i) => i['table'] === worlds)).toHaveLength(1);
    expect(state.quotaCharges).toBe(1);
    await app.close();
  });

  it('a depth replay returns the same depth_uploads keys as the original', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());
    const req = {
      method: 'POST' as const,
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 2, depth: true },
    };

    const first = await app.inject(req);
    const second = await app.inject(req);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const keys = (r: typeof first) =>
      r.json().depth_uploads.map((u: { key: string }) => u.key);
    expect(keys(first)).toHaveLength(2);
    expect(keys(second)).toEqual(keys(first));
    expect(keys(first)[0]).toMatch(/\/depth_0\.png$/);
    expect(state.quotaCharges).toBe(1);
    await app.close();
  });

  it('rejects a non-UUID key with 400 invalid_idempotency_key (before any charge)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': 'not-a-uuid' },
      payload: { frame_count: 1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_idempotency_key');
    expect(state.quotaCharges).toBe(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('accepts a GUID that is not RFC 9562 (zod 3 .uuid() contract kept on zod 4)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());
    const guid = '00000000-0000-0000-0000-000000000001'; // no version/variant bits

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': guid },
      payload: { frame_count: 1 },
    });

    expect(res.statusCode).toBe(201);
    expect(state.inserts.find((i) => i['table'] === worlds)?.['clientRequestId']).toBe(guid);
    await app.close();
  });

  it('409s when the key maps to a soft-deleted world', async () => {
    const state = newState();
    state.byKey.set(KEY, fakeWorld({ clientRequestId: KEY, deletedAt: new Date() }));
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 1 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'idempotency_key_world_deleted', world_id: 'w-1' });
    expect(state.quotaCharges).toBe(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('409s when the key maps to a world that never got a usable capture', async () => {
    const state = newState();
    state.byKey.set(KEY, fakeWorld({ clientRequestId: KEY }));
    state.capture = null;
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 1 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('idempotency_key_incomplete_world');
    await app.close();
  });

  it('loses the concurrent-insert race gracefully: replays the winner and refunds the scan', async () => {
    const state = newState();
    state.insertError = Object.assign(new Error('duplicate key value'), { code: '23505' });
    state.raceWinner = fakeWorld({ clientRequestId: KEY });
    state.capture = {
      id: 'cap-1',
      worldId: 'w-1',
      frameCount: 3,
      r2FramesPrefix: 'captures/cap-1',
    };
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 3 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().world.id).toBe('w-1');
    expect(res.json().uploads).toHaveLength(3);
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

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': KEY },
      payload: { frame_count: 1 },
    });

    expect(res.statusCode).toBe(500);
    expect(state.quotaReleases).toBe(0);
    await app.close();
  });

  it('without the header behaves exactly as before (null key, 201, one charge)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const first = await app.inject({ method: 'POST', url: '/v1/worlds', payload: { frame_count: 1 } });
    const second = await app.inject({ method: 'POST', url: '/v1/worlds', payload: { frame_count: 1 } });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const worldInserts = state.inserts.filter((i) => i['table'] === worlds);
    expect(worldInserts).toHaveLength(2); // no key → no deduplication
    expect(worldInserts[0]!['clientRequestId']).toBeNull();
    expect(state.quotaCharges).toBe(2);
    await app.close();
  });

  it('accepts a random session UUID (the real client contract)', async () => {
    const state = newState();
    currentDb = makeDb(state);
    const app = await buildApp(makeStorage());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      headers: { 'idempotency-key': randomUUID() },
      payload: { frame_count: 1 },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
