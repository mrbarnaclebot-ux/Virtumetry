import { initialRecovery, RECOVERY_CAP, RECOVERY_WINDOW_MS, recoveryReducer, type RecoveryState } from '@/viewer/recovery';
import type { Pose } from '@/viewer/types';

const POSE: Pose = { position: [1, 1.6, 2], quaternion: [0, 0, 0, 1] };
const crash = (s: RecoveryState, at: number) => recoveryReducer(s, { type: 'crash', at });

describe('recovery reducer (D-13)', () => {
  it('starts clean', () => {
    expect(initialRecovery).toEqual({ mountKey: 0, savedPose: null, crashes: [], capped: false, reconnecting: false });
    expect(RECOVERY_CAP).toBe(3);
    expect(RECOVERY_WINDOW_MS).toBe(60_000);
  });

  it('pose is saved', () => {
    expect(recoveryReducer(initialRecovery, { type: 'pose', pose: POSE }).savedPose).toEqual(POSE);
  });

  it('a crash remounts with the saved pose and shows reconnecting until ready', () => {
    const s = crash(recoveryReducer(initialRecovery, { type: 'pose', pose: POSE }), 1000);
    expect(s).toMatchObject({ mountKey: 1, savedPose: POSE, crashes: [1000], capped: false, reconnecting: true });
    expect(recoveryReducer(s, { type: 'ready' }).reconnecting).toBe(false);
  });

  it('the 4th crash within 60 s caps and does not remount', () => {
    let s = initialRecovery;
    for (const at of [0, 10_000, 20_000]) s = crash(s, at);
    expect(s).toMatchObject({ mountKey: 3, capped: false });
    s = crash(s, 30_000);
    expect(s).toMatchObject({ mountKey: 3, capped: true });
    // Further crashes while capped change nothing.
    expect(crash(s, 31_000)).toBe(s);
  });

  it('old crashes age out: 3 crashes over 2 minutes never cap', () => {
    let s = initialRecovery;
    for (const at of [0, 30_000, 61_000, 92_000, 123_000]) s = crash(s, at);
    expect(s.capped).toBe(false);
    expect(s.mountKey).toBe(5);
  });

  it('reload uncaps, clears crashes, remounts and keeps the pose', () => {
    let s = recoveryReducer(initialRecovery, { type: 'pose', pose: POSE });
    for (const at of [0, 1, 2, 3]) s = crash(s, at);
    expect(s.capped).toBe(true);
    s = recoveryReducer(s, { type: 'reload' });
    expect(s).toMatchObject({ capped: false, crashes: [], mountKey: 4, savedPose: POSE, reconnecting: true });
  });
});
