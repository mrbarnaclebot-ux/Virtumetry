import { useSyncExternalStore } from 'react';

import type { LocalScan } from '@/library/display-state';

// Scans saved on the phone but not uploaded. Empty in Phase 3; Phase 4 capture adds entries (D-19).
let scans: LocalScan[] = [];
const listeners = new Set<() => void>();

function set(next: LocalScan[]) {
  scans = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLocalScans() {
  return {
    scans: useSyncExternalStore(subscribe, () => scans),
    remove: (id: string) => set(scans.filter((s) => s.id !== id)),
  };
}

export const __setLocalScansForTest = set;
