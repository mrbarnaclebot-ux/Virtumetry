// World-generation provider contract (spec §4 "World Labs job contract", §14).
// Two implementations: worldlabs.ts (live, money-path) and mock.ts (offline,
// zero-credit). The worker (src/worker.ts) only ever talks to this interface.

/** Supported Marble models and their credit cost (spec §2.1 / pricing). */
export type WorldModel = 'marble-1.0-draft' | 'marble-1.1';

export const MODEL_CREDITS: Record<WorldModel, number> = {
  'marble-1.0-draft': 150,
  'marble-1.1': 1500,
};

/** Pure credit lookup — exported for reuse + testing. */
export function creditsForModel(model: WorldModel): number {
  const credits = MODEL_CREDITS[model];
  if (credits === undefined) {
    throw new ProviderError(`unknown model: ${model}`);
  }
  return credits;
}

/** Result of GET /operations/{id} — normalized across provider quirks. */
export interface OperationStatus {
  done: boolean;
  worldId?: string;
  error?: string;
}

/**
 * Normalized world assets. All URLs point at the PROVIDER CDN; the worker
 * downloads them and re-hosts on our storage before exposing anything (spec
 * §14 "asset ownership"). spzUrls keys map to the provider's 100k/500k/full_res.
 */
export interface WorldAssets {
  spzUrls: { k100?: string; k500?: string; full?: string };
  colliderMeshUrl?: string;
  thumbnailUrl?: string;
  caption?: string;
}

/**
 * A provider-side world found by reconciliation (spec §10 R1). Returned when a
 * worker resumes a job whose `provider_operation_id` is still the
 * `pending:<jobId>` intent marker and must find out whether its
 * credit-spending `worlds:generate` actually went through.
 */
export interface WorldMatch {
  /** The provider's world id. */
  worldId: string;
  /** The operation to resume polling on, when the provider still exposes one. */
  operationId?: string;
  /**
   * Whether generation has finished. `false` means "exists but still running"
   * (reconcile again later); `undefined` means the listing doesn't say, and the
   * caller treats the world as adoptable.
   */
  done?: boolean;
}

export interface WorldGenProvider {
  readonly mode: 'mock' | 'live';
  /** prepare_upload + PUT the pano (FREE). Returns the media_asset_id. */
  uploadPano(bytes: Buffer, filename: string): Promise<string>;
  /**
   * worlds:generate (SPENDS CREDITS). Returns the operation_id. MUST NOT be
   * retried internally — a blind resubmit double-bills (spec §14).
   */
  generateWorld(
    mediaAssetId: string,
    model: WorldModel,
    displayName: string,
  ): Promise<string>;
  /** Poll an operation (FREE). */
  getOperation(operationId: string): Promise<OperationStatus>;
  /**
   * Reconciliation lookup (FREE): find a world this account already owns whose
   * display name matches exactly. Used ONLY to resolve a `pending:<jobId>`
   * intent marker — i.e. to learn whether a `worlds:generate` that we could not
   * confirm actually spent credits (spec §10 R1). Returns null when no such
   * world is listed. A thrown error means "could not determine" and MUST leave
   * the money path untouched.
   */
  findWorldByDisplayName(displayName: string): Promise<WorldMatch | null>;
  /** Fetch a finished world's asset URLs (FREE). */
  getWorld(worldId: string): Promise<WorldAssets>;
  /**
   * Download an asset's bytes from a provider URL. Part of the interface (not
   * in the original 5-method sketch) so mock mode can serve fixture bytes for
   * an end-to-end offline run without a real HTTP fetch.
   */
  downloadAsset(url: string): Promise<Buffer>;
  creditsForModel(model: WorldModel): number;
}

/** Typed provider failure. `retryable` distinguishes transient vs terminal. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly endpoint?: string;
  constructor(
    message: string,
    opts?: { status?: number; endpoint?: string; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.status = opts?.status;
    this.endpoint = opts?.endpoint;
  }
}

/** A request exceeded its deadline. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, endpoint?: string) {
    super(message, endpoint !== undefined ? { endpoint } : undefined);
    this.name = 'ProviderTimeoutError';
  }
}
