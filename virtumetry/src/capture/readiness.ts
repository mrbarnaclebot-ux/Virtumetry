import type { ReadinessConfig } from './capture-config';
import { BLUR_PX_THRESHOLD } from './rules';
import type { KeyframeEvent } from './types';

export type Level = 'green' | 'amber' | 'red';
export type Signal = 'tracking' | 'blur' | 'frames' | 'coverage';
export type Readiness = { level: Level | 'idle'; signal: Signal | null; label: string; reason: string };

const RANK: Record<Level, number> = { green: 0, amber: 1, red: 2 };
export const LABEL: Record<Level, string> = { green: 'Good to finish', amber: 'Almost there', red: 'Keep scanning' };

const atLeast = (v: number, green: number, amber: number): Level => (v >= green ? 'green' : v >= amber ? 'amber' : 'red');
const atMost = (v: number, green: number, amber: number): Level => (v <= green ? 'green' : v <= amber ? 'amber' : 'red');

/** D-07: worst of four signals; one reason, priority tracking -> blur -> frames -> coverage. */
export function readiness(frames: KeyframeEvent[], sectorsSeen: number, cfg: ReadinessConfig): Readiness {
  const n = frames.length;
  if (n === 0) return { level: 'idle', signal: null, label: 'Ready to scan', reason: 'Tap Start, then walk slowly around the room' };

  const share = (pred: (f: KeyframeEvent) => boolean) => frames.filter(pred).length / n;
  const missing = Math.max(0, cfg.minFramesGreen - n);
  const grades: [Signal, Level, string][] = [
    [
      'tracking',
      atMost(share((f) => f.tracking !== 'normal'), cfg.maxTrackingGapShareGreen, cfg.maxTrackingGapShareAmber),
      'Tracking dropped — move slower and keep the lights on',
    ],
    [
      'blur',
      atMost(share((f) => (f.blurPx ?? 0) > BLUR_PX_THRESHOLD), cfg.maxBlurShareGreen, cfg.maxBlurShareAmber),
      'Slow down — too many blurry photos',
    ],
    ['frames', atLeast(n, cfg.minFramesGreen, cfg.minFramesAmber), `Keep going — ${missing} more frame${missing === 1 ? '' : 's'}`],
    ['coverage', atLeast(sectorsSeen, cfg.minSectorsGreen, cfg.minSectorsAmber), 'Look around the rest of the room'],
  ];

  const level = grades.reduce<Level>((w, [, g]) => (RANK[g] > RANK[w] ? g : w), 'green');
  if (level === 'green') return { level, signal: null, label: LABEL.green, reason: 'You can stop now' };
  const [signal, , reason] = grades.find(([, g]) => g === level)!;
  return { level, signal, label: LABEL[level], reason };
}
