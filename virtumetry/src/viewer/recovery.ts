/** Viewer crash recovery (D-13, T-05-22). Pure, no runtime imports. */
import type { Pose } from './types';

export const RECOVERY_CAP = 3;
export const RECOVERY_WINDOW_MS = 60_000;

export type RecoveryState = {
  mountKey: number;
  savedPose: Pose | null;
  /** savedPose frozen at the last remount: the viewer's startPose prop (a live pose prop would re-render the DOM tree at 2 Hz). */
  mountPose: Pose | null;
  crashes: number[];
  capped: boolean;
  reconnecting: boolean;
};

export type RecoveryAction =
  | { type: 'pose'; pose: Pose }
  | { type: 'crash'; at: number }
  | { type: 'reload' }
  | { type: 'ready' };

export const initialRecovery: RecoveryState = {
  mountKey: 0,
  savedPose: null,
  mountPose: null,
  crashes: [],
  capped: false,
  reconnecting: false,
};

export function recoveryReducer(s: RecoveryState, a: RecoveryAction): RecoveryState {
  switch (a.type) {
    case 'pose':
      return { ...s, savedPose: a.pose };
    case 'ready':
      return s.reconnecting ? { ...s, reconnecting: false } : s;
    case 'reload':
      return { ...s, crashes: [], capped: false, reconnecting: true, mountKey: s.mountKey + 1, mountPose: s.savedPose };
    case 'crash': {
      if (s.capped) return s;
      const crashes = [...s.crashes.filter((c) => a.at - c < RECOVERY_WINDOW_MS), a.at];
      if (crashes.length > RECOVERY_CAP) return { ...s, crashes, capped: true, reconnecting: false };
      return { ...s, crashes, reconnecting: true, mountKey: s.mountKey + 1, mountPose: s.savedPose };
    }
  }
}
