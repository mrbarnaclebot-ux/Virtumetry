// UI-SPEC §8.1: onboarding + coach-mark flags in expo-secure-store (sync API, like prep-flags.ts).
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

export type CoachId = 'capture-prep' | 'walk' | 'measure';

const ONBOARDED = 'vm.onboarding.v1';
const SKIPPED = 'vm.onboarding.skipped.v1';
const COACH_IDS: CoachId[] = ['capture-prep', 'walk', 'measure'];
const coachKey = (id: CoachId) => `vm.coach.${id}`;

// Secure store is unavailable on web; flags then read as unset. null = the read failed (e.g. locked keychain): don't cache it.
const tryRead = (k: string): boolean | null => {
  try {
    return SecureStore.getItem(k) === '1';
  } catch {
    return null;
  }
};
const read = (k: string) => tryRead(k) ?? false;
const write = (k: string, v: boolean) => {
  try {
    SecureStore.setItem(k, v ? '1' : '0');
  } catch {}
};

let onboarded: boolean | null = null; // cache: one sync read per session
let skipped: boolean | null = null;
let intent: 'scan' | null = null; // memory only, consumed once by Library
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const getOnboarded = () => {
  if (Platform.OS === 'web') return true;
  if (onboarded === null) onboarded = tryRead(ONBOARDED);
  return onboarded ?? true; // a failed read fails open to the Library, and is retried next render
};

export const markOnboarded = (next?: 'scan') => {
  write(ONBOARDED, true);
  onboarded = true;
  intent = next ?? null;
  listeners.forEach((l) => l());
};

/** Critique F3: the empty Library shows the how-it-works steps only to users who skipped the intro. */
export const markOnboardingSkipped = (v: boolean) => {
  write(SKIPPED, v);
  skipped = v;
};

// Web never shows onboarding, so it counts as skipped.
export const getOnboardingSkipped = () => {
  if (Platform.OS === 'web') return true;
  if (skipped === null) skipped = read(SKIPPED);
  return skipped;
};

export const useOnboarded = () => useSyncExternalStore(subscribe, getOnboarded, getOnboarded);

export const consumeIntent = () => {
  const i = intent;
  intent = null;
  return i;
};

/** Coach marks dismissed this session (SecureStore is unavailable on web). Cleared by resetCoachMarks. */
export const coachDismissed = new Set<CoachId>();

export const isCoachSeen = (id: CoachId) => read(coachKey(id));
export const markCoachSeen = (id: CoachId) => write(coachKey(id), true);

export const resetCoachMarks = () => {
  coachDismissed.clear();
  for (const id of COACH_IDS) {
    try {
      SecureStore.deleteItemAsync(coachKey(id)).catch(() => {});
    } catch {}
  }
};

export const __resetFirstRunForTest = () => {
  onboarded = null;
  skipped = null;
  intent = null;
};
