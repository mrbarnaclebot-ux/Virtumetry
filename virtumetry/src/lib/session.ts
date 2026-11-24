import * as SecureStore from 'expo-secure-store';

import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';

let sessionEndedNotice = false;

/**
 * Ends the local session. Never traps the user signed in: if the network sign-out fails,
 * the stored cookie and session cache are wiped and useSession is told to refetch (→ null).
 */
export async function endSession({ notice }: { notice: boolean }): Promise<void> {
  if (notice) sessionEndedNotice = true;
  try {
    const res = await authClient.signOut();
    if (res?.error) throw res.error;
  } catch {
    await SecureStore.deleteItemAsync('virtumetry_cookie');
    await SecureStore.deleteItemAsync('virtumetry_session_data');
    // Drop the in-memory session now (the refetch may also fail while offline), then refetch.
    const session = authClient.$store.atoms.session;
    session?.set({ ...session.get(), data: null, error: null, isPending: false });
    authClient.$store.notify('$sessionSignal');
  } finally {
    queryClient.clear();
  }
}

/** Returns true once after endSession({ notice: true }), then resets. */
export function consumeSessionEndedNotice(): boolean {
  const v = sessionEndedNotice;
  sessionEndedNotice = false;
  return v;
}
