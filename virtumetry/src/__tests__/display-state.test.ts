import {
  isTerminal,
  pollInterval,
  STALLED_MS,
  toDisplayState,
  type LibraryItem,
  type LocalScan,
} from '@/library/display-state';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const CREATED = '2026-11-24T10:00:00.000Z';
const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function item(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'w1',
    title: 'Kitchen',
    caption: null,
    status: 'processing',
    phase: null,
    progress: null,
    heartbeat_at: minsAgo(1),
    created_at: CREATED,
    failure_stage: null,
    failure_code: null,
    failure_message: null,
    charged: false,
    eta_seconds: null,
    credits_spent: null,
    assets: {},
    ...over,
  };
}

const ds = (over: Partial<LibraryItem> = {}) => toDisplayState(item(over), NOW);

describe('toDisplayState: uploading', () => {
  it('shows the percentage when progress is known', () => {
    const s = ds({ status: 'uploading', progress: 40 });
    expect(s.kind).toBe('uploading');
    expect(s.statusLine).toBe('Uploading · 40%');
    expect(s.progress).toBe(40);
    expect(s.secondaryLine).toBeNull();
    expect(s.tone).toBe('muted');
  });

  it('shows an ellipsis when progress is unknown', () => {
    const s = ds({ status: 'uploading', progress: null });
    expect(s.statusLine).toBe('Uploading…');
    expect(s.progress).toBeNull();
  });

  it('shows the stalled hint when the heartbeat is stale', () => {
    const s = ds({ status: 'uploading', progress: 40, heartbeat_at: minsAgo(20) });
    expect(s.secondaryLine).toBe('Stalled? No update for 20 min. Pull down to refresh.');
    expect(s.secondaryTone).toBe('warning');
  });
});

describe('toDisplayState: processing states', () => {
  it.each([
    ['packing', 'Processing · Preparing upload'],
    ['submitting', 'Processing · Sending for processing'],
    ['processing', 'Processing · Building your 3D room'],
    ['importing', 'Processing · Finishing up'],
  ])('%s → %s', (status, line) => {
    const s = ds({ status });
    expect(s.kind).toBe('processing');
    expect(s.statusLine).toBe(line);
  });

  it('uses the generic estimate when eta is unknown', () => {
    expect(ds({ eta_seconds: null }).secondaryLine).toBe('Usually 30 min – 2 h');
  });

  it('rounds the eta up to whole minutes', () => {
    expect(ds({ eta_seconds: 125 }).secondaryLine).toBe('About 3 min left');
  });

  it('says almost done under a minute', () => {
    expect(ds({ eta_seconds: 30 }).secondaryLine).toBe('Almost done');
  });

  it('shows the progress bar when progress is known', () => {
    expect(ds({ progress: 55 }).progress).toBe(55);
  });

  it('flags stalled after 15 min without a heartbeat', () => {
    const s = ds({ heartbeat_at: minsAgo(16), eta_seconds: 125 });
    expect(s.secondaryLine).toBe('Stalled? No update for 16 min. Pull down to refresh.');
    expect(s.secondaryTone).toBe('warning');
  });

  it('uses hours for long stalls', () => {
    expect(ds({ heartbeat_at: minsAgo(130) }).secondaryLine).toBe(
      'Stalled? No update for 2 h. Pull down to refresh.',
    );
  });

  it('is not stalled at 14 min', () => {
    const s = ds({ heartbeat_at: minsAgo(14) });
    expect(s.secondaryLine).toBe('Usually 30 min – 2 h');
    expect(s.secondaryTone).toBe('muted');
  });

  it('treats an unknown status as processing', () => {
    const s = ds({ status: 'weird' });
    expect(s.kind).toBe('processing');
    expect(s.statusLine).toBe('Processing');
  });

  it('exposes the 15 min threshold', () => {
    expect(STALLED_MS).toBe(15 * 60 * 1000);
  });
});

describe('toDisplayState: terminal states', () => {
  it('ready is accent with the date and never stalled', () => {
    const s = ds({ status: 'ready', heartbeat_at: minsAgo(500) });
    expect(s.statusLine).toBe('Ready');
    expect(s.tone).toBe('accent');
    expect(s.secondaryLine).toBe(date(CREATED));
    expect(s.secondaryTone).toBe('muted');
    expect(s.progress).toBeNull();
  });

  it('cancelled is muted at 0.6 opacity', () => {
    const s = ds({ status: 'cancelled' });
    expect(s.statusLine).toBe('Cancelled');
    expect(s.tone).toBe('muted');
    expect(s.rowOpacity).toBe(0.6);
    expect(s.secondaryLine).toBe(date(CREATED));
  });

  it.each([
    ['WORLD_GENERATION_FAILED', 'The scan couldn\'t be turned into a room'],
    ['INVALID_INPUT', 'The scan couldn\'t be turned into a room'],
    ['CAPTURE_FRAME_LIMIT_EXCEEDED', 'The scan couldn\'t be turned into a room'],
    ['UPLOAD_STALE', 'Upload didn\'t finish'],
    ['ZIP_UNREADABLE', 'Upload didn\'t finish'],
    ['MANIFEST_MISSING', 'Upload didn\'t finish'],
    ['BUDGET_EXCEEDED', 'Stopped by your spending limit'],
    ['INSUFFICIENT_CREDITS', 'Stopped by your spending limit'],
    ['PROVIDER_TIMEOUT', 'Processing took too long'],
    ['SOMETHING_NEW', 'Something went wrong while processing'],
  ])('failed %s → human message', (code, msg) => {
    const s = ds({ status: 'failed', failure_code: code });
    expect(s.statusLine).toBe(`Failed · ${msg}`);
    expect(s.tone).toBe('destructive');
    expect(s.icon).toBe('exclamationmark.triangle.fill');
  });

  it('maps an unknown code at the upload stage to the upload family', () => {
    expect(ds({ status: 'failed', failure_code: 'X', failure_stage: 'pack' }).statusLine).toBe(
      'Failed · Upload didn\'t finish',
    );
  });

  it('shows the charge note with the date', () => {
    expect(ds({ status: 'failed', charged: false }).secondaryLine).toBe(`Not charged · ${date(CREATED)}`);
    expect(ds({ status: 'failed', charged: true }).secondaryLine).toBe(
      `Charged for this run · ${date(CREATED)}`,
    );
    expect(
      ds({ status: 'failed', charged: undefined as unknown as boolean }).secondaryLine,
    ).toBe(`Charge unknown · ${date(CREATED)}`);
  });

  it('never shows the raw failure message', () => {
    const s = ds({ status: 'failed', failure_code: 'X', failure_message: 'SECRET provider stack' });
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });
});

describe('toDisplayState: local and titles', () => {
  it('local saved_on_phone item', () => {
    const s = toDisplayState({ local: true, id: 'l1', title: 'Hall', createdAt: CREATED } as LocalScan & { local: true }, NOW);
    expect(s.kind).toBe('saved_on_phone');
    expect(s.statusLine).toBe('Saved on phone · Not uploaded');
    expect(s.secondaryLine).toBe(date(CREATED));
    expect(s.icon).toBe('iphone');
  });

  const loc = (over: Partial<LocalScan> = {}) =>
    toDisplayState(
      {
        local: true,
        id: 'l1',
        sessionId: 'l1',
        title: 'Hall',
        createdAt: CREATED,
        dir: 'file:///x',
        frameCount: 30,
        durationS: 7,
        imageW: 640,
        imageH: 480,
        readiness: 'green',
        precheckIssues: [],
        uploadState: 'saved',
        ...over,
      },
      NOW,
    );

  it('saved shows the frame count with the date', () => {
    const s = loc();
    expect(s.statusLine).toBe('Saved on phone · Not uploaded');
    expect(s.secondaryLine).toBe(`30 frames · ${date(CREATED)}`);
  });

  it('saved with failed checks', () => {
    const s = loc({ precheckIssues: [{ code: 'BLUR_SHARE' }] });
    expect(s.statusLine).toBe("Saved on phone · Didn't pass checks");
    expect(s.secondaryLine).toBe(`30 frames · ${date(CREATED)}`);
  });

  it.each(['approved', 'uploading'] as const)('%s without progress → Uploading…', (uploadState) => {
    const s = loc({ uploadState });
    expect(s.kind).toBe('uploading');
    expect(s.statusLine).toBe('Uploading…');
    expect(s.progress).toBeNull();
    expect(s.secondaryLine).toBeNull();
  });

  it('uploading with progress shows the percent', () => {
    const s = loc({ uploadState: 'uploading', progress: { uploaded: 12, total: 32 } });
    expect(s.statusLine).toBe('Uploading · 38%');
    expect(s.progress).toBe(37.5);
  });

  it('paused waits for a connection', () => {
    expect(loc({ uploadState: 'paused' }).statusLine).toBe('Upload paused · Waiting for connection');
  });

  it('blocked did not pass checks and is not charged', () => {
    const s = loc({ uploadState: 'blocked', failureCode: 'CAMERA_JUMP' });
    expect(s.statusLine).toBe("Failed · Didn't pass checks");
    expect(s.secondaryLine).toBe(`Not charged · ${date(CREATED)}`);
    expect(s.tone).toBe('destructive');
  });

  it('server failure at validate wins over the IMAGE_ upload family', () => {
    const s = ds({ status: 'failed', failure_stage: 'validate', failure_code: 'IMAGE_LONG_EDGE', charged: false });
    expect(s.statusLine).toBe("Failed · Didn't pass checks");
    expect(s.secondaryLine).toMatch(/^Not charged/);
  });

  it.each([null, '', '   '])('title %p → Untitled scan', (title) => {
    expect(ds({ title }).displayTitle).toBe('Untitled scan');
  });
});

describe('isTerminal / pollInterval', () => {
  it.each([
    ['ready', true],
    ['failed', true],
    ['cancelled', true],
    ['uploading', false],
    ['processing', false],
    ['packing', false],
  ])('isTerminal(%s) = %s', (status, v) => {
    expect(isTerminal(status)).toBe(v);
  });

  it('polls every 5 s while anything is in flight', () => {
    expect(pollInterval([{ status: 'ready' }, { status: 'processing' }])).toBe(5000);
  });

  it('stops polling when everything is terminal, empty or unknown', () => {
    expect(pollInterval([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
    expect(pollInterval([])).toBe(false);
    expect(pollInterval(undefined)).toBe(false);
  });

  it('keeps polling while a local scan is uploading even if every server item is terminal', () => {
    expect(pollInterval([{ status: 'ready' }], true)).toBe(5000);
  });
});
