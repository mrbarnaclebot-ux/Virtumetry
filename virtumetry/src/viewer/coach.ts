/** Viewer coach-mark and first-reveal decisions (UI-SPEC §8.2, critique R1 #9). Import-free: runs inside the 'use dom' viewer and in jest. */

export type ViewerCoachId = 'walk' | 'measure';
/** 'reveal' = the world's first-open camera move already played (per world). */
export type ViewerSeenId = ViewerCoachId | 'reveal';

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

const TEXT: Record<ViewerCoachId, { touch: string; desktop: string }> = {
  walk: {
    touch: 'Drag on the left to move. Drag on the right to look around.',
    desktop: 'Use WASD or the arrow keys to move. Drag to look around.',
  },
  measure: {
    touch: 'Tap two points on a surface. The distance shows here.',
    desktop: 'Click two points on a surface. The distance shows here.',
  },
};

/** `scope` makes a localStorage flag per world (web has no world id: the splat URL path stands in). */
const key = (id: ViewerSeenId, scope?: string) => (scope ? `vm.coach.${id}.${scope}` : `vm.coach.${id}`);

export const coachText = (id: ViewerCoachId, touch: boolean) => (touch ? TEXT[id].touch : TEXT[id].desktop);

/** The app's prop list wins when defined (already scoped to this world); otherwise localStorage (private mode throws → not seen). */
export function isSeen(id: ViewerSeenId, seenProp: string[] | undefined, storage?: Pick<Store, 'getItem'>, scope?: string): boolean {
  if (seenProp) return seenProp.includes(id);
  try {
    return storage?.getItem(key(id, scope)) === '1';
  } catch {
    return false;
  }
}

export function markSeen(
  id: ViewerSeenId,
  onCoachSeen?: (id: string) => Promise<void>,
  storage?: Pick<Store, 'setItem'>,
  scope?: string,
): void {
  if (onCoachSeen) {
    void onCoachSeen(id)?.catch(() => {});
    return;
  }
  try {
    storage?.setItem(key(id, scope), '1');
  } catch {
    // private mode: seen for this page load only
  }
}

/** Presigned URLs change per fetch; the path (bucket key) is stable per world. */
export const urlScope = (url: string) => url.split(/[?#]/)[0];

export const REVEAL_MS = 900;
const REVEAL_SCALE = 1.25;
const REVEAL_YAW = (15 * Math.PI) / 180;

export const outExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/** Wonder moment: orbit radius scale (1.25 → 1) and extra yaw (15° → 0) at `ms` into the reveal, outExpo. */
export function revealAt(ms: number) {
  const t = Math.min(1, Math.max(0, ms / REVEAL_MS));
  const e = outExpo(t);
  return { scale: REVEAL_SCALE - (REVEAL_SCALE - 1) * e, yaw: REVEAL_YAW * (1 - e), done: t === 1 };
}
