import { describe, it, expect, vi } from 'vitest';
import {
  runGeneration,
  generationDisplayName,
  pendingOperationMarker,
  isPendingOperationMarker,
  NonRetryableJobError,
  type GenerationIO,
  type GenerationClock,
} from '../src/worker.js';
import {
  ProviderError,
  ProviderTimeoutError,
  type WorldGenProvider,
} from '../src/provider/index.js';
import { BudgetExceededError } from '../src/budget.js';
import { MAX_DISPLAY_NAME } from '../src/provider/worldlabs.js';
import { createMockProvider } from '../src/provider/mock.js';

// spec §10 R1 / §14 — the worlds:generate double-bill window.
//
// The old sequence was reserve → upload → generate → persist op id, so a crash
// (or a retryable timeout) between the generate call and the persist re-ran the
// whole money path on the next attempt. The fixed sequence persists a
// `pending:<jobId>` intent marker FIRST, and a resume that finds that marker
// RECONCILES against the provider instead of re-generating.

const instantClock: GenerationClock = { now: () => 0, sleep: async () => undefined };

const JOB_ID = 'job-abc';
const WORLD_ID = 'world-row-1';
const DISPLAY_NAME = generationDisplayName(JOB_ID);

function fakeProvider(overrides: Partial<WorldGenProvider> = {}): WorldGenProvider {
  return {
    mode: 'mock',
    creditsForModel: () => 150,
    uploadPano: vi.fn(async () => 'media-1'),
    generateWorld: vi.fn(async () => 'op-1'),
    getOperation: vi.fn(async () => ({ done: true, worldId: 'provider-world-1' })),
    getWorld: vi.fn(async () => ({ spzUrls: { k500: 'u500' }, caption: 'cap' })),
    downloadAsset: vi.fn(async () => Buffer.from('bytes')),
    findWorldByDisplayName: vi.fn(async () => null),
    ...overrides,
  } as WorldGenProvider;
}

interface FakeIO extends GenerationIO {
  /** Every value written to provider_operation_id, in order. */
  saved: string[];
  reserved: number[];
  released: number[];
  /** Current persisted value — null once the marker is cleared. */
  persisted: () => string | null;
}

function fakeIO(overrides: Partial<GenerationIO> = {}): FakeIO {
  const saved: string[] = [];
  const reserved: number[] = [];
  const released: number[] = [];
  let current: string | null = null;
  return {
    saved,
    reserved,
    released,
    persisted: () => current,
    reserveCredits: vi.fn(async (amount: number) => {
      reserved.push(amount);
    }),
    releaseCredits: vi.fn(async (amount: number) => {
      released.push(amount);
    }),
    getPanoBytes: vi.fn(async () => Buffer.from('pano')),
    saveOperationId: vi.fn(async (opId: string) => {
      saved.push(opId);
      current = opId;
    }),
    clearPendingMarker: vi.fn(async () => {
      if (current !== null && current.startsWith('pending:')) current = null;
    }),
    storeAsset: vi.fn(async (name: string) => `worlds/${WORLD_ID}/${name}`),
    ...overrides,
  };
}

const input = (existingOperationId: string | null) => ({
  jobId: JOB_ID,
  model: 'marble-1.0-draft' as const,
  displayName: DISPLAY_NAME,
  cost: 150,
  existingOperationId,
});

// --- display name: deterministic + unique per job ----------------------------

describe('generationDisplayName', () => {
  it('embeds the job id so the provider row is traceable back to the job', () => {
    expect(DISPLAY_NAME).toContain(JOB_ID);
  });

  it('is deterministic — the same job always produces the same name', () => {
    expect(generationDisplayName(JOB_ID)).toBe(DISPLAY_NAME);
  });

  it('is unique per job', () => {
    expect(generationDisplayName('job-2')).not.toBe(DISPLAY_NAME);
  });

  it('fits the provider 64-char display_name cap for real UUID job ids', () => {
    const a = generationDisplayName('8c433317-8f78-4527-aeab-d8c558aeaccd');
    const b = generationDisplayName('b936c74a-8b1c-4e7f-b0c4-c9eccc0ab83f');
    expect(a.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME);
    expect(b.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME);
    expect(a).not.toBe(b);
  });
});

describe('pendingOperationMarker', () => {
  it('round-trips and is recognisable as a marker, not an operation id', () => {
    const marker = pendingOperationMarker(JOB_ID);
    expect(marker).toBe(`pending:${JOB_ID}`);
    expect(isPendingOperationMarker(marker)).toBe(true);
    expect(isPendingOperationMarker('op-1')).toBe(false);
    expect(isPendingOperationMarker(null)).toBe(false);
  });
});

// --- the intent marker is persisted BEFORE the money call -------------------

describe('pending intent marker', () => {
  it('persists pending:<jobId> before generateWorld is called (and before reserving)', async () => {
    const io = fakeIO();
    const seenAtGenerate: string[] = [];
    const provider = fakeProvider({
      generateWorld: vi.fn(async () => {
        seenAtGenerate.push(...io.saved);
        return 'op-1';
      }),
    });

    await runGeneration(provider, io, input(null), instantClock);

    // The marker was already durable when the credit-spending call went out…
    expect(seenAtGenerate).toEqual([pendingOperationMarker(JOB_ID)]);
    // …and the real operation id replaced it immediately after.
    expect(io.saved).toEqual([pendingOperationMarker(JOB_ID), 'op-1']);
    // Marker lands before the reservation, so a crash in between cannot
    // reserve twice (the resume path reconciles instead of re-reserving).
    expect(io.reserved).toEqual([150]);
  });

  it('a throw from generateWorld itself leaves the marker behind', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      generateWorld: vi.fn(async () => {
        throw new Error('process killed');
      }),
    });

    await expect(runGeneration(provider, io, input(null), instantClock)).rejects.toThrow();
    expect(io.saved).toEqual([pendingOperationMarker(JOB_ID)]);
    // The call may have reached the provider, so the marker MUST survive.
    expect(io.persisted()).toBe(pendingOperationMarker(JOB_ID));
    expect(io.clearPendingMarker).not.toHaveBeenCalled();
    expect(io.releaseCredits).not.toHaveBeenCalled();
  });
});

// --- pre-generate failures unwind (QA regression on the R1 fix) --------------
//
// The marker lands before reserve/read/upload so a process death resumes into
// reconciliation. But a THROWN failure from any of those three proves generate
// was never submitted — pano upload is an ordinary network call and the likeliest
// failure in the whole path. Those must unwind and stay retryable, or a routine
// 5xx permanently parks the job and needs an operator.

describe('pre-generate failures unwind the marker', () => {
  it('a transient uploadPano failure clears the marker and stays retryable', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      uploadPano: vi.fn(async () => {
        throw new ProviderError('media upload failed: 503');
      }),
    });

    const err = await runGeneration(provider, io, input(null), instantClock).catch(
      (e: unknown) => e,
    );

    // Original error, original retryability — NOT parked.
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect((err as Error).message).toContain('503');
    // Marker gone, reservation given back.
    expect(io.persisted()).toBeNull();
    expect(io.clearPendingMarker).toHaveBeenCalledOnce();
    expect(io.released).toEqual([150]);
    expect(provider.generateWorld).not.toHaveBeenCalled();
  });

  it('a getPanoBytes failure likewise clears the marker and releases the reservation', async () => {
    const io = fakeIO({
      getPanoBytes: vi.fn(async () => {
        throw new Error('R2 read blip');
      }),
    });
    const provider = fakeProvider();

    const err = await runGeneration(provider, io, input(null), instantClock).catch(
      (e: unknown) => e,
    );

    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect((err as Error).message).toBe('R2 read blip');
    expect(io.persisted()).toBeNull();
    expect(io.released).toEqual([150]);
    expect(provider.uploadPano).not.toHaveBeenCalled();
    expect(provider.generateWorld).not.toHaveBeenCalled();
  });

  it('the retry after a cleared marker generates ONCE and reserves ONCE', async () => {
    // Attempt 1: upload blips.
    const io1 = fakeIO();
    const provider1 = fakeProvider({
      uploadPano: vi.fn(async () => {
        throw new ProviderError('media upload failed: 503');
      }),
    });
    await expect(
      runGeneration(provider1, io1, input(null), instantClock),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(io1.persisted()).toBeNull();
    // Net ledger effect of the failed attempt is zero: reserved then released.
    expect(io1.reserved).toEqual([150]);
    expect(io1.released).toEqual([150]);

    // Attempt 2 starts clean (operation id is NULL again) — a normal fresh run,
    // not a reconciliation, and certainly not a park.
    const io2 = fakeIO();
    const provider2 = fakeProvider();
    const result = await runGeneration(provider2, io2, input(null), instantClock);

    expect(provider2.findWorldByDisplayName).not.toHaveBeenCalled();
    expect(provider2.generateWorld).toHaveBeenCalledOnce();
    expect(io2.reserved).toEqual([150]); // exactly one reservation for this attempt
    expect(io2.released).toEqual([]);
    expect(io2.saved).toEqual([pendingOperationMarker(JOB_ID), 'op-1']);
    expect(result.worldId).toBe('provider-world-1');
  });

  it('BudgetExceeded still parks, and releases nothing (no reservation was taken)', async () => {
    const io = fakeIO({
      reserveCredits: vi.fn(async () => {
        throw new BudgetExceededError(150, 400, 500);
      }),
    });
    const provider = fakeProvider();

    const err = await runGeneration(provider, io, input(null), instantClock).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BudgetExceededError); // handleJobError parks this
    expect(io.released).toEqual([]);
    // The marker is still cleared — nothing is pending for a retry to reconcile.
    expect(io.persisted()).toBeNull();
    expect(provider.generateWorld).not.toHaveBeenCalled();
  });

  it('a failing marker-clear leaves the marker and still rethrows the ORIGINAL error', async () => {
    const io = fakeIO({
      clearPendingMarker: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });
    const provider = fakeProvider({
      uploadPano: vi.fn(async () => {
        throw new ProviderError('media upload failed: 503');
      }),
    });

    const err = await runGeneration(provider, io, input(null), instantClock).catch(
      (e: unknown) => e,
    );

    // Fail safe: the caller sees the upload failure, and the marker survives, so
    // the retry reconciles (and at worst parks) instead of risking a re-bill.
    expect((err as Error).message).toContain('503');
    expect(io.persisted()).toBe(pendingOperationMarker(JOB_ID));
  });

  it('a failing credit release does not mask the original error either', async () => {
    const io = fakeIO({
      releaseCredits: vi.fn(async () => {
        throw new Error('ledger insert failed');
      }),
    });
    const provider = fakeProvider({
      uploadPano: vi.fn(async () => {
        throw new ProviderError('media upload failed: 503');
      }),
    });

    const err = await runGeneration(provider, io, input(null), instantClock).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toContain('503');
    // The marker is still cleared, so the retry is a clean fresh attempt.
    expect(io.persisted()).toBeNull();
  });
});

// --- a failed/timed-out generate call is NON-retryable -----------------------

describe('generate-phase failures are non-retryable', () => {
  it('a generateWorld timeout parks the job dead instead of re-submitting', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      generateWorld: vi.fn(async () => {
        throw new ProviderTimeoutError('request timed out after 120000ms');
      }),
    });

    await expect(
      runGeneration(provider, io, input(null), instantClock),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(provider.generateWorld).toHaveBeenCalledOnce();
  });

  it('any generateWorld error is non-retryable (never blind-resubmit)', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      generateWorld: vi.fn(async () => {
        throw new ProviderError('500 internal');
      }),
    });

    await expect(
      runGeneration(provider, io, input(null), instantClock),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
  });

  it('a POLL-phase timeout stays retryable — it resumes by operation id', async () => {
    const io = fakeIO();
    const provider = fakeProvider({ getOperation: vi.fn(async () => ({ done: false })) });
    let t = 0;
    const clock: GenerationClock = { now: () => (t += 1_000_000), sleep: async () => undefined };

    const err = await runGeneration(provider, io, input(null), clock, {
      timeoutMs: 1,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
  });
});

// --- resume from a pending marker → reconcile, never re-generate -------------

describe('resume from a pending marker', () => {
  it('MATCH with an operation id: adopts it, polls, and never re-bills', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      findWorldByDisplayName: vi.fn(async () => ({
        worldId: 'provider-world-9',
        operationId: 'op-9',
      })),
    });

    const result = await runGeneration(
      provider,
      io,
      input(pendingOperationMarker(JOB_ID)),
      instantClock,
    );

    expect(provider.findWorldByDisplayName).toHaveBeenCalledWith(DISPLAY_NAME);
    expect(io.reserveCredits).not.toHaveBeenCalled();
    expect(provider.uploadPano).not.toHaveBeenCalled();
    expect(provider.generateWorld).not.toHaveBeenCalled();
    // The marker is replaced by the real id so the next resume skips reconcile.
    expect(io.saved).toEqual(['op-9']);
    expect(provider.getOperation).toHaveBeenCalledWith('op-9');
    expect(result.worldId).toBe('provider-world-1');
  });

  it('MATCH with a finished world but no operation id: adopts the world directly', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      findWorldByDisplayName: vi.fn(async () => ({
        worldId: 'provider-world-7',
        done: true,
      })),
    });

    const result = await runGeneration(
      provider,
      io,
      input(pendingOperationMarker(JOB_ID)),
      instantClock,
    );

    expect(io.reserveCredits).not.toHaveBeenCalled();
    expect(provider.generateWorld).not.toHaveBeenCalled();
    expect(provider.getOperation).not.toHaveBeenCalled();
    expect(provider.getWorld).toHaveBeenCalledWith('provider-world-7');
    expect(result.worldId).toBe('provider-world-7');
  });

  it('MATCH still generating and no operation id: RETRYABLE, reconcile again later', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      findWorldByDisplayName: vi.fn(async () => ({
        worldId: 'provider-world-7',
        done: false,
      })),
    });

    const err = await runGeneration(
      provider,
      io,
      input(pendingOperationMarker(JOB_ID)),
      instantClock,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect(provider.generateWorld).not.toHaveBeenCalled();
  });

  it('NO MATCH: parks the job dead — never re-generates on an unprovable state', async () => {
    const io = fakeIO();
    const provider = fakeProvider({ findWorldByDisplayName: vi.fn(async () => null) });

    const err = await runGeneration(
      provider,
      io,
      input(pendingOperationMarker(JOB_ID)),
      instantClock,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NonRetryableJobError);
    expect(provider.generateWorld).not.toHaveBeenCalled();
    expect(provider.uploadPano).not.toHaveBeenCalled();
    expect(io.reserveCredits).not.toHaveBeenCalled();
  });

  it('a reconciliation lookup failure is retryable and never re-generates', async () => {
    const io = fakeIO();
    const provider = fakeProvider({
      findWorldByDisplayName: vi.fn(async () => {
        throw new ProviderError('list failed: 503');
      }),
    });

    const err = await runGeneration(
      provider,
      io,
      input(pendingOperationMarker(JOB_ID)),
      instantClock,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect(provider.generateWorld).not.toHaveBeenCalled();
  });

  it('credits are never reserved twice for one job across a crash + resume', async () => {
    // Attempt 1 dies right after the marker lands (before the reservation).
    const io = fakeIO({
      reserveCredits: vi.fn(async () => {
        throw new Error('worker SIGKILL');
      }),
    });
    const provider = fakeProvider();
    await expect(runGeneration(provider, io, input(null), instantClock)).rejects.toThrow();
    expect(io.saved).toEqual([pendingOperationMarker(JOB_ID)]);

    // Attempt 2 resumes from the marker: reconcile, adopt, no second reserve.
    const io2 = fakeIO();
    const provider2 = fakeProvider({
      findWorldByDisplayName: vi.fn(async () => ({ worldId: 'provider-world-5', done: true })),
    });
    await runGeneration(
      provider2,
      io2,
      input(pendingOperationMarker(JOB_ID)),
      instantClock,
    );
    expect(io2.reserved).toEqual([]);
    expect(provider2.generateWorld).not.toHaveBeenCalled();
  });

  it('a real (non-marker) operation id still resumes straight to polling', async () => {
    const io = fakeIO();
    const provider = fakeProvider();

    await runGeneration(provider, io, input('op-existing'), instantClock);

    expect(provider.findWorldByDisplayName).not.toHaveBeenCalled();
    expect(io.reserveCredits).not.toHaveBeenCalled();
    expect(provider.generateWorld).not.toHaveBeenCalled();
    expect(provider.getOperation).toHaveBeenCalledWith('op-existing');
  });
});

// --- mock provider supports reconciliation ----------------------------------

describe('mock provider reconciliation', () => {
  it('finds a world it generated by display name, and nothing otherwise', async () => {
    const provider = createMockProvider();
    expect(await provider.findWorldByDisplayName(DISPLAY_NAME)).toBeNull();

    const operationId = await provider.generateWorld('media-1', 'marble-1.0-draft', DISPLAY_NAME);
    const match = await provider.findWorldByDisplayName(DISPLAY_NAME);

    expect(match).not.toBeNull();
    expect(match!.operationId).toBe(operationId);
    expect(match!.worldId).toMatch(/^mock-world-/);
    expect(await provider.findWorldByDisplayName('some other name')).toBeNull();
  });
});
