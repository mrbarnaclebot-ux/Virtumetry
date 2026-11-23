// Sliding-window failure counter (spec §10 R10).
//
// @fastify/rate-limit counts *requests*; this counts only requests that FAILED
// authentication, which is the signal that actually distinguishes a credential
// guesser from a busy client. A legitimate device makes hundreds of authorized
// calls a minute and zero failures; a token-guesser makes nothing but failures.
// Charging both against one bucket would mean either throttling real clients or
// barely inconveniencing the guesser.
//
// In-memory and per-process on purpose — see README: the api runs as a single
// replica, and a shared store would be a Redis dependency bought for nothing.
// Scaling the api past one replica means moving BOTH this and the plugin's store
// to Redis; until then, a per-process window is the honest bound.

export interface FailureThrottleOptions {
  /** Failures allowed inside the window before the key is blocked. */
  max: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class FailureThrottle {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: FailureThrottleOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Drop timestamps that have aged out, returning the survivors. */
  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /** True once `max` failures have landed inside the window. */
  isBlocked(key: string): boolean {
    return this.live(key).length >= this.max;
  }

  /** Record one failed attempt. */
  record(key: string): void {
    const kept = this.live(key);
    kept.push(this.now());
    this.hits.set(key, kept);
  }

  /** Clear a key's history — called on a SUCCESSFUL auth. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Seconds until the oldest failure in the window ages out (>= 1). */
  retryAfterSeconds(key: string): number {
    const kept = this.live(key);
    const oldest = kept[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  /** Number of tracked keys — lets tests assert the map does not grow forever. */
  get size(): number {
    return this.hits.size;
  }
}
