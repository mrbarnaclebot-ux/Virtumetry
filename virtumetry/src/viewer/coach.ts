/** Viewer coach-mark decisions (UI-SPEC §8.2). Import-free: runs inside the 'use dom' viewer and in jest. */

export type ViewerCoachId = 'walk' | 'measure';

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

const key = (id: ViewerCoachId) => `vm.coach.${id}`;

export const coachText = (id: ViewerCoachId, touch: boolean) => (touch ? TEXT[id].touch : TEXT[id].desktop);

/** The app's prop list wins when defined; otherwise localStorage (private mode throws → not seen, show once per load). */
export function isSeen(id: ViewerCoachId, seenProp: string[] | undefined, storage?: Pick<Store, 'getItem'>): boolean {
  if (seenProp) return seenProp.includes(id);
  try {
    return storage?.getItem(key(id)) === '1';
  } catch {
    return false;
  }
}

export function markSeen(id: ViewerCoachId, onCoachSeen?: (id: string) => Promise<void>, storage?: Pick<Store, 'setItem'>): void {
  if (onCoachSeen) {
    void onCoachSeen(id)?.catch(() => {});
    return;
  }
  try {
    storage?.setItem(key(id), '1');
  } catch {
    // private mode: seen for this page load only
  }
}
