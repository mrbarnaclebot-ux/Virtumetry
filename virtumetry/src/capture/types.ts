// D-01: the capture source contract. The fixture source (Expo Go) and the
// native ARKit module (Phase 8) both emit raw session-format values; every
// conversion happens in the backend.

export type TrackingState = 'normal' | 'limited' | 'notAvailable';

/** Mirror of backend/src/bundle/manifest.ts SessionV1 (schema 1). */
export type Session = {
  sessionId: string;
  schema: 1;
  device: string;
  appVersion: string;
  imageWidth: number;
  imageHeight: number;
  startedAtISO: string;
  /** Capture-time UTC offset, `±HH:MM`. */
  tzOffset: string;
  gateConfig: Record<string, unknown>;
};

/** Mirror of backend/src/bundle/manifest.ts FrameLineV1 (one frames.jsonl line). */
export type FrameLine = {
  i: number;
  file: string;
  /** Seconds since session start. */
  t: number;
  /** Wall-clock capture time, Unix ms. */
  wallMs: number;
  /** ARKit camera.transform (world_from_camera), 16 floats column-major. */
  T_arkit: number[];
  K: { fx: number; fy: number; cx: number; cy: number };
  tracking: string;
  blurPx?: number;
  expS?: number;
};

export type KeyframeEvent = Omit<FrameLine, 'expS' | 'tracking'> & { tracking: TrackingState };
export type PoseEvent = { t: number; T_arkit: number[]; tracking: TrackingState };
export type TrackingEvent = { t: number; tracking: TrackingState };
export type ThermalEvent = { state: string };

export type CaptureEventMap = {
  pose: PoseEvent;
  keyframe: KeyframeEvent;
  tracking: TrackingEvent;
  thermal: ThermalEvent;
};

export type GateConfig = Record<string, unknown>;

export interface CaptureSource {
  readonly kind: 'fixture' | 'native';
  isAvailable(): boolean;
  start(gateConfig: GateConfig): Promise<{ sessionId: string }>;
  stop(): Promise<{ sessionId: string; frameCount: number; dir: string }>;
  cancel(): Promise<void>;
  addListener<K extends keyof CaptureEventMap>(event: K, cb: (e: CaptureEventMap[K]) => void): { remove(): void };
}
