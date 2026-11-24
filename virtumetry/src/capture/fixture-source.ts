// D-03/D-05: replays the bundled TUM tiny session through the CaptureSource contract and writes a real
// schema-1 session dir (Paths.document/sessions/<sessionId>/). Values stay raw ARKit; the backend converts.
import { uuid } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';

import { FIXTURE_FRAMES, FIXTURE_IMAGE, resolveFixtureFrame } from '@/capture/fixture-assets';
import type {
  CaptureEventMap,
  CaptureSource,
  FrameLine,
  GateConfig,
  KeyframeEvent,
  Session,
  TrackingState,
} from '@/capture/types';

export const FIXTURE_SCENARIOS = ['good', 'too-few', 'tracking-gap', 'pose-jump'] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

type Options = {
  resolveFrame?: (k: number) => Promise<string>;
  now?: () => number;
  speed?: number;
  frames?: FrameLine[];
};

type Listeners = { [K in keyof CaptureEventMap]: Set<(e: CaptureEventMap[K]) => void> };

const pad = (n: number) => String(n).padStart(2, '0');

function tzOffset(d: Date): string {
  const m = -d.getTimezoneOffset();
  const a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** D-05: shape the recorded frames per scenario. */
function applyScenario(frames: FrameLine[], s: FixtureScenario): FrameLine[] {
  if (s === 'too-few') return frames.slice(0, 8);
  return frames.map((f) => {
    if (s === 'tracking-gap' && f.i >= 10 && f.i <= 17) return { ...f, tracking: 'limited' };
    if (s === 'pose-jump' && f.i >= 15) {
      const T = [...f.T_arkit];
      T[12] += 0.6;
      return { ...f, T_arkit: T };
    }
    return f;
  });
}

export class FixtureCaptureSource implements CaptureSource {
  readonly kind = 'fixture' as const;
  private scenario: FixtureScenario = 'good';
  private listeners: Listeners = { pose: new Set(), keyframe: new Set(), tracking: new Set(), thermal: new Set() };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sessionId = '';
  private dir: Directory | null = null;
  private emitted = 0;
  /** Bumped by start/stop/cancel: a start still resolving assets when it changes is abandoned (WR-05). */
  private gen = 0;
  private readonly resolveFrame: (k: number) => Promise<string>;
  private readonly now: () => number;
  private readonly speed: number;
  private readonly frames: FrameLine[];

  constructor({ resolveFrame = resolveFixtureFrame, now = Date.now, speed = 2, frames = FIXTURE_FRAMES }: Options = {}) {
    this.resolveFrame = resolveFrame;
    this.now = now;
    this.speed = speed;
    this.frames = frames;
  }

  setScenario(s: FixtureScenario) {
    this.scenario = s;
  }

  isAvailable() {
    return true;
  }

  addListener<K extends keyof CaptureEventMap>(event: K, cb: (e: CaptureEventMap[K]) => void) {
    const set = this.listeners[event] as Set<(e: CaptureEventMap[K]) => void>;
    set.add(cb);
    return { remove: () => void set.delete(cb) };
  }

  private emit<K extends keyof CaptureEventMap>(event: K, e: CaptureEventMap[K]) {
    (this.listeners[event] as Set<(e: CaptureEventMap[K]) => void>).forEach((cb) => cb(e));
  }

  async start(gateConfig: GateConfig): Promise<{ sessionId: string }> {
    this.clearTimer();
    this.dir = null; // nothing for cancel() to delete until this start creates its own dir
    const gen = ++this.gen;
    const frames = applyScenario(this.frames, this.scenario);
    // Pre-resolve before the timer runs (Pitfall 7).
    const uris = await Promise.all(frames.map((_, k) => this.resolveFrame(k)));
    if (gen !== this.gen) throw new Error('capture cancelled');

    const now0 = this.now();
    const sessionId = uuid.v4();
    const dir = new Directory(Paths.document, 'sessions', sessionId);
    new Directory(dir, 'frames').create({ intermediates: true, idempotent: true });
    const session: Session = {
      sessionId,
      schema: 1,
      device: 'Fixture (TUM fr3)',
      appVersion: 'fixture',
      imageWidth: FIXTURE_IMAGE.width,
      imageHeight: FIXTURE_IMAGE.height,
      startedAtISO: new Date(now0).toISOString(),
      tzOffset: tzOffset(new Date(now0)),
      gateConfig: { ...gateConfig, fixtureScenario: this.scenario },
    };
    new File(dir, 'session.json').writeSync(JSON.stringify(session, null, 2));
    const jsonl = new File(dir, 'frames.jsonl');
    jsonl.create({ overwrite: true });

    this.sessionId = sessionId;
    this.dir = dir;
    this.emitted = 0;
    let lastTracking: string | null = null;
    const t0 = frames[0]?.t ?? 0;

    const step = (k: number) => {
      const src = frames[k];
      const file = `frames/${String(k + 1).padStart(6, '0')}.jpg`;
      // Pitfall 9: rebase wallMs from the original t, not the sped-up timer.
      const line: FrameLine = { ...src, i: k + 1, file, wallMs: now0 + Math.round((src.t - t0) * 1000) };
      new File(uris[k]).copySync(new File(dir, file));
      jsonl.writeSync(JSON.stringify(line) + '\n', { append: true });
      this.emitted = k + 1;

      const tracking = line.tracking as TrackingState;
      this.emit('pose', { t: line.t, T_arkit: line.T_arkit, tracking });
      if (tracking !== lastTracking) {
        lastTracking = tracking;
        this.emit('tracking', { t: line.t, tracking });
      }
      const { expS: _expS, ...kf } = line;
      this.emit('keyframe', { ...kf, tracking } as KeyframeEvent);

      const next = frames[k + 1];
      this.timer = next ? setTimeout(() => step(k + 1), ((next.t - src.t) / this.speed) * 1000) : null;
    };
    if (frames.length) this.timer = setTimeout(() => step(0), 0);
    return { sessionId };
  }

  async stop() {
    this.gen++;
    this.clearTimer();
    const r = { sessionId: this.sessionId, frameCount: this.emitted, dir: this.dir?.uri ?? '' };
    this.dir = null; // a stopped session belongs to the store now; cancel() must never delete it
    return r;
  }

  async cancel() {
    this.gen++;
    this.clearTimer();
    if (this.dir?.exists) this.dir.delete();
    this.dir = null;
    this.emitted = 0;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
