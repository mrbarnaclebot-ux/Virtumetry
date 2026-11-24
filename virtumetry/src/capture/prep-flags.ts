// D-11: prep checklist / camera priming flags, persisted in expo-secure-store (sync API).
import * as SecureStore from 'expo-secure-store';

const SEEN = 'vm.prep.seen';
const SKIP = 'vm.prep.skip';
const ASKED = 'vm.camera.asked';

// Secure store is unavailable on web; flags then read as unset.
const read = (k: string) => {
  try {
    return SecureStore.getItem(k) === '1';
  } catch {
    return false;
  }
};
const write = (k: string, v: boolean) => {
  try {
    SecureStore.setItem(k, v ? '1' : '0');
  } catch {}
};

export const getPrepFlags = () => ({ seen: read(SEEN), skip: read(SKIP), askedOnce: read(ASKED) });
export const markPrepSeen = () => write(SEEN, true);
export const setSkipPrep = (v: boolean) => write(SKIP, v);
export const markPermissionAsked = () => write(ASKED, true);
