import type { PrecheckIssue } from '@/capture/precheck';
import type { Readiness } from '@/capture/readiness';

/** Server item from GET /v1/worlds (03-03). */
export type LibraryItem = {
  id: string;
  title: string | null;
  caption: string | null;
  status: string;
  phase: string | null;
  progress: number | null;
  heartbeat_at: string;
  created_at: string;
  failure_stage: string | null;
  failure_code: string | null;
  failure_message: string | null; // never rendered (T-03-28)
  charged?: boolean | null;
  eta_seconds: number | null;
  credits_spent: number | null;
  assets: { thumbnail_url?: string };
  /** Server-authoritative (D-08); missing = not retryable. */
  retryable?: boolean;
  submit_attempt?: number;
  frame_count?: number | null;
};


export type LocalUploadState = 'saved' | 'approved' | 'uploading' | 'paused' | 'done' | 'blocked' | 'failed';

/** Scan saved on the phone first (D-13); persisted by src/capture/store.ts. */
export type LocalScan = {
  /** = sessionId */
  id: string;
  sessionId: string;
  title: string | null;
  createdAt: string;
  /** Session dir uri (Paths.document/sessions/<sessionId>). */
  dir: string;
  frameCount: number;
  durationS: number;
  imageW: number;
  imageH: number;
  readiness: Readiness['level'];
  /** Readiness reason at Stop, shown again on review. */
  readinessReason?: string;
  precheckIssues: PrecheckIssue[];
  approvedMaxCredits?: number;
  serverWorldId?: string;
  uploadState: LocalUploadState;
  failureCode?: string | null;
  progress?: { uploaded: number; total: number };
};

export type DisplayState = {
  kind: 'saved_on_phone' | 'uploading' | 'processing' | 'ready' | 'failed' | 'cancelled';
  displayTitle: string;
  statusLine: string;
  secondaryLine: string | null;
  secondaryTone: 'muted' | 'warning';
  tone: 'muted' | 'accent' | 'destructive';
  progress: number | null;
  rowOpacity: 1 | 0.6;
  icon: 'iphone' | 'exclamationmark.triangle.fill' | null;
};

export const STALLED_MS = 15 * 60 * 1000;
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);

export const isTerminal = (status: string) => TERMINAL.has(status);

/** `force`: a local scan is uploading, so keep polling until its server row takes over (UI-SPEC timing). */
export function pollInterval(items?: { status: string }[], force = false): number | false {
  return force || items?.some((i) => !isTerminal(i.status)) ? 5000 : false;
}

const PROCESSING_LINES: Record<string, string> = {
  packing: 'Processing · Preparing upload',
  submitting: 'Processing · Sending for processing',
  processing: 'Processing · Building your 3D room',
  importing: 'Processing · Finishing up',
};

const CHECKS = "Didn't pass checks";
const UPLOAD = "Upload didn't finish";
const REJECTED = "The scan couldn't be turned into a room";
const TIMEOUT = 'Processing took too long';
const LIMIT = 'Stopped by your spending limit';
const UNKNOWN = 'Something went wrong while processing';

const REJECTED_CODES = new Set(['INVALID_INPUT', 'VALIDATION_FAILED', 'CAPTURE_FRAME_LIMIT_EXCEEDED', 'WORLD_GENERATION_FAILED']);
const LIMIT_CODES = new Set([
  'BUDGET_EXCEEDED',
  'INSUFFICIENT_CREDITS',
  'QUOTE_ABOVE_APPROVAL',
  'NOT_APPROVED',
  // A refused create (iter-2 WR-02): the scan-create error code, uppercased.
  'APPROVAL_BELOW_QUOTE',
  'SCAN_QUOTA_EXCEEDED',
]);
const UPLOAD_CODE = /^(UPLOAD_STALE|BUNDLE_NOT_RANGEABLE|MANIFEST_|ZIP_|IMAGES_MISSING|IMAGE_|EXIF_|CAMERA_FILE_INVALID_JSON|PER_FRAME_INTRINSICS_)/;

/** `retryable` (server, D-08) wins: a retryable run is never worded as a bad capture (WR-08). */
export function failureText(code: string | null, stage: string | null, retryable = false): string {
  const c = code ?? '';
  if (retryable) return LIMIT_CODES.has(c) || GUIDE_LIMIT.has(c) ? LIMIT : UNKNOWN;
  if (stage === 'validate') return CHECKS; // ahead of the code families (IMAGE_* would read as upload)
  if (UPLOAD_CODE.test(c)) return UPLOAD;
  if (REJECTED_CODES.has(c)) return REJECTED;
  if (c.includes('TIMEOUT')) return TIMEOUT;
  if (LIMIT_CODES.has(c)) return LIMIT;
  if (stage === 'upload' || stage === 'pack') return UPLOAD;
  return UNKNOWN;
}

const G_LIMIT = 'Your spending limit or credits stopped this run. Check the cost below before you try again.';
const G_PROVIDER = 'The processing service had a problem on its side. Trying again often works.';
const G_CAPTURE = "This capture can't be turned into a room. Scan again: move slowly, keep the room well lit and cover every wall.";
const G_UNCERTAIN = "We can't tell if this run was charged, so it can't be retried from the app. Scan the room again to get a new one.";
const G_IMPORT = "The room was built but couldn't be saved. It can't be retried from the app. Scan again to get a new room.";
const G_OTHER = "This scan can't be retried. Scan the room again to get a new one.";

const GUIDE_LIMIT = new Set(['BUDGET_EXCEEDED', 'QUOTE_ABOVE_APPROVAL', 'HTTP_402', 'INSUFFICIENT_CREDITS']);
const GUIDE_PROVIDER = new Set(['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'WORLD_GENERATION_FAILED']);
const GUIDE_UNCERTAIN = new Set(['SUBMIT_UNCERTAIN', 'IDEMPOTENCY_KEY_REUSED']);
const CAPTURE_CODE = /^(IMAGES_MISSING|ZIP_|EXIF_)/;

/** Failure sheet guidance body (06-UI-SPEC copy table). Never shows a code. */
export function failureGuidance(
  stage: string | null,
  code: string | null,
  charged: boolean | null | undefined,
  retryable = false,
): string {
  const c = code ?? '';
  // WR-08: the sheet shows "Approve and retry" exactly when retryable, so the copy must invite a retry.
  if (retryable) return GUIDE_LIMIT.has(c) ? G_LIMIT : G_PROVIDER;
  if (stage === 'validate' || stage === 'pack' || stage === 'upload' || CAPTURE_CODE.test(c)) return G_CAPTURE;
  if (GUIDE_UNCERTAIN.has(c)) return G_UNCERTAIN;
  if (GUIDE_LIMIT.has(c)) return G_LIMIT;
  if (GUIDE_PROVIDER.has(c)) return G_PROVIDER;
  if (stage === 'import') return G_IMPORT;
  if (charged == null) return G_UNCERTAIN;
  return G_OTHER;
}

/** Charge line on the failure sheet (the Library row keeps its shorter "Not charged"). */
export const chargeLine = (charged: boolean | null | undefined) =>
  charged === true ? 'Charged for this run' : charged === false ? 'Not charged for this run' : 'Charge unknown';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function estimate(eta: number | null): string {
  if (eta == null) return 'Usually 30 min to 2 h';
  const min = Math.ceil(eta / 60);
  return eta < 60 ? 'Almost done' : `About ${min} min left`;
}

/** Stalled hint when the heartbeat is older than 15 min, else null. */
function stalled(heartbeatAt: string, now: Date): string | null {
  const age = now.getTime() - new Date(heartbeatAt).getTime();
  if (!(age > STALLED_MS)) return null;
  const min = Math.floor(age / 60_000);
  const span = min >= 60 ? `${Math.floor(min / 60)} h` : `${min} min`;
  return `Stalled? No update for ${span}. Pull down to refresh.`;
}

const base = {
  secondaryTone: 'muted',
  tone: 'muted',
  progress: null,
  rowOpacity: 1,
  icon: null,
} as const;

export function toDisplayState(item: LibraryItem | (LocalScan & { local: true }), now: Date): DisplayState {
  const displayTitle = item.title?.trim() || 'Untitled scan';

  if ('local' in item) {
    const date = formatDate(item.createdAt);
    switch (item.uploadState ?? 'saved') {
      case 'saved':
        return {
          ...base,
          kind: 'saved_on_phone',
          displayTitle,
          statusLine: `Saved on phone · ${item.precheckIssues?.length ? CHECKS : 'Not uploaded'}`,
          secondaryLine: item.frameCount != null ? `${item.frameCount} frames · ${date}` : date,
          icon: 'iphone',
        };
      case 'blocked':
      case 'failed':
        return {
          ...base,
          kind: 'failed',
          displayTitle,
          statusLine: `Failed · ${item.uploadState === 'blocked' ? CHECKS : failureText(item.failureCode ?? null, null)}`,
          secondaryLine: `Not charged · ${date}`,
          tone: 'destructive',
          icon: 'exclamationmark.triangle.fill',
        };
      case 'done':
        return { ...base, kind: 'processing', displayTitle, statusLine: 'Uploaded · Processing started', secondaryLine: null };
    }
    const p = item.progress;
    const pct = p && p.total > 0 ? (p.uploaded / p.total) * 100 : null;
    return {
      ...base,
      kind: 'uploading',
      displayTitle,
      statusLine:
        item.uploadState === 'paused'
          ? 'Upload paused · Waiting for connection'
          : pct != null
            ? `Uploading · ${Math.round(pct)}%`
            : 'Uploading…',
      progress: pct,
      secondaryLine: null,
    };
  }

  const date = formatDate(item.created_at);
  switch (item.status) {
    case 'ready':
      return { ...base, kind: 'ready', displayTitle, statusLine: 'Ready', secondaryLine: date, tone: 'accent' };
    case 'cancelled':
      return { ...base, kind: 'cancelled', displayTitle, statusLine: 'Cancelled', secondaryLine: date, rowOpacity: 0.6 };
    case 'failed': {
      const charge =
        item.charged === true ? 'Charged for this run' : item.charged === false ? 'Not charged' : 'Charge unknown';
      return {
        ...base,
        kind: 'failed',
        displayTitle,
        statusLine: `Failed · ${failureText(item.failure_code, item.failure_stage, item.retryable === true)}`,
        secondaryLine: `${charge} · ${date}`,
        tone: 'destructive',
        icon: 'exclamationmark.triangle.fill',
      };
    }
  }

  const stall = stalled(item.heartbeat_at, now);
  const stallTone = stall ? ('warning' as const) : ('muted' as const);
  if (item.status === 'uploading') {
    const known = item.progress != null;
    return {
      ...base,
      kind: 'uploading',
      displayTitle,
      statusLine: known ? `Uploading · ${Math.round(item.progress!)}%` : 'Uploading…',
      progress: known ? item.progress : null,
      secondaryLine: stall,
      secondaryTone: stallTone,
    };
  }
  return {
    ...base,
    kind: 'processing',
    displayTitle,
    statusLine: PROCESSING_LINES[item.status] ?? 'Processing',
    progress: item.progress,
    secondaryLine: stall ?? estimate(item.eta_seconds),
    secondaryTone: stallTone,
  };
}
