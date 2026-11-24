// D-13/D-14: scans saved on the phone first, persisted in Paths.document/sessions/index.json.
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import type { LocalScan } from '@/library/display-state';

const sessionsDir = () => new Directory(Paths.document, 'sessions');
const indexFile = () => new File(Paths.document, 'sessions', 'index.json');

let scans: LocalScan[] | null = null;
const listeners = new Set<() => void>();

/** Lazy sync load; a missing or corrupt index loads as [] (T-04-21). */
function load(): LocalScan[] {
  if (scans) return scans;
  try {
    const f = indexFile();
    const parsed: unknown = f.exists ? JSON.parse(f.textSync()) : [];
    scans = Array.isArray(parsed) ? (parsed as LocalScan[]) : [];
  } catch {
    scans = [];
  }
  return scans;
}

function set(next: LocalScan[], persist = true) {
  scans = next;
  if (persist) {
    sessionsDir().create({ intermediates: true, idempotent: true });
    indexFile().writeSync(JSON.stringify(next));
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const getLocalScans = () => load();
export const getLocalScan = (id: string) => load().find((s) => s.id === id);

export function addLocalScan(scan: LocalScan) {
  set([scan, ...load().filter((s) => s.id !== scan.id)]);
}

export function updateLocalScan(id: string, patch: Partial<LocalScan>) {
  set(load().map((s) => (s.id === id ? { ...s, ...patch } : s)));
}

/** Deletes the session dir, then the entry. Throws (entry kept) if the delete fails (T-04-22). */
export function discardLocalScan(id: string) {
  const scan = getLocalScan(id);
  if (scan) {
    const dir = new Directory(sessionsDir(), scan.sessionId);
    if (dir.exists) dir.delete();
  }
  set(load().filter((s) => s.id !== id));
}

export function useLocalScans() {
  return { scans: useSyncExternalStore(subscribe, load), remove: discardLocalScan };
}

export function useLocalScan(id: string) {
  return useSyncExternalStore(subscribe, () => getLocalScan(id));
}

/** Sets memory only (no disk). */
export const __setLocalScansForTest = (next: LocalScan[]) => set(next, false);
/** Simulates an app restart: the next read reloads from disk. */
export const __reloadForTest = () => {
  scans = null;
};
