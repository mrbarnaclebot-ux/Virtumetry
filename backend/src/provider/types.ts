import { createHmac } from 'node:crypto';
import type { Readable } from 'node:stream';
import { secretEquals } from '../auth.js';

// Reconstruction provider contract (D-11). Implementations: mock.ts (default,
// zero-credit) and echo3.ts (Phase 6, money path). The pipeline jobs only ever
// talk to this interface.

export interface ProviderLimits {
  minFrames: number;
  maxFrames: number;
}

export interface ProviderQuote {
  credits: number;
  available: number;
}

export interface ProviderStatus {
  /** PENDING | PROCESSING | COMPLETED | FAILED | CANCELLED | unknown (open enum: unknown = keep polling). */
  status: string;
  /** 0..1, or null when the provider doesn't say. Never treat null as 0. */
  progress: number | null;
  error?: { code: string; message: string };
  issues?: { code: string; message: string }[];
}

export type ExportKind = 'mesh-simplified' | 'floorplan';
export type ArtifactKind = 'splat' | 'collider' | 'floorplan' | 'floorplan_meta' | 'cameras';

export interface Artifact {
  kind: ArtifactKind;
  name: string;
  contentType: string;
  /** Provider-specific locator, resolved fresh by open(). */
  ref: string;
}

export interface ReconProvider {
  readonly mode: 'mock' | 'live';
  /** Frame-count limits (FREE). */
  limits(): Promise<ProviderLimits>;
  /** Credit quote for a capture of `frameCount` frames (FREE). */
  quote(frameCount: number): Promise<ProviderQuote>;
  /**
   * Submit a capture bundle (SPENDS CREDITS). `body` is the exact persisted JSON
   * and `idempotencyKey` the persisted submission_key: a resubmit MUST reuse
   * both. Never retried internally.
   */
  submit(body: string, idempotencyKey: string): Promise<{ requestId: string }>;
  /** Poll a request (FREE). */
  status(requestId: string): Promise<ProviderStatus>;
  /** Start or poll an export (FREE). */
  ensureExport(requestId: string, kind: ExportKind): Promise<'pending' | 'ready' | 'failed'>;
  /** List a finished request's downloadable outputs (FREE). */
  artifacts(requestId: string): Promise<Artifact[]>;
  /** Stream one artifact's bytes (FREE download). */
  open(artifact: Artifact): Promise<Readable>;
  cancel(requestId: string): Promise<void>;
  /** (FREE) ask the provider to delete its copy; ProviderError 404 = already gone. */
  deleteWorld(requestId: string): Promise<void>;
  /** HMAC check over the exact raw body bytes. */
  verifyWebhook(raw: Buffer, signatureHeader: string | undefined): boolean;
}

/** Typed provider failure: HTTP status + provider error code + Retry-After. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly endpoint?: string;
  readonly code?: string;
  readonly retryAfterS?: number;
  constructor(
    message: string,
    opts?: { status?: number; endpoint?: string; code?: string; retryAfterS?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.status = opts?.status;
    this.endpoint = opts?.endpoint;
    this.code = opts?.code;
    this.retryAfterS = opts?.retryAfterS;
  }
}

/** A request exceeded its deadline. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, endpoint?: string) {
    super(message, endpoint !== undefined ? { endpoint } : undefined);
    this.name = 'ProviderTimeoutError';
  }
}

/** `X-Spaitial-Signature` value: 'sha256=' + hex HMAC-SHA256 of the raw bytes. */
export function signWebhook(secret: string, raw: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** Constant-time signature check. Unset secret or missing header → false (fail closed). */
export function verifyWebhookSignature(
  secret: string | undefined,
  raw: Buffer,
  header: string | undefined,
): boolean {
  if (!secret || typeof header !== 'string') return false;
  return secretEquals(header, signWebhook(secret, raw));
}
