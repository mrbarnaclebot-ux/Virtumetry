// D-13/D-14: scans saved on the phone first, persisted in Paths.document/sessions/index.json.
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import type { LocalScan } from '@/library/display-state';

const sessionsDir = () => new Directory(Paths.document, 'sessions');
const indexFile = () => new File(Paths.document, 'sessions', 'index.json');

let scans: LocalScan[] | null = null;
const listeners = new Set<() => void>();

const tmpFile = () => new File(Paths.document, 'sessions', 'index.json.tmp');
const corruptFile = () => new File(Paths.document, 'sessions', 'index.corrupt.json');

function readIndex(f: File): LocalScan[] | null {
  try {
    if (!f.exists) return null;
    const parsed: unknown = JSON.parse(f.textSync());
    return Array.isArray(parsed) ? (parsed as LocalScan[]) : null;
  } catch {
    return null;
  }
}

/**
 * Lazy sync load (T-04-21). Falls back to index.json.tmp, which holds the newest list if a
 * write was cut off between removing index.json and moving the tmp over it. A corrupt index
 * is set aside as index.corrupt.json (never overwritten by the next write) and loads as [].
 */
function load(): LocalScan[] {
  if (scans) return scans;
  scans = readIndex(indexFile()) ?? readIndex(tmpFile());
  if (!scans) {
    scans = [];
    try {
      const f = indexFile();
      if (f.exists) f.moveSync(corruptFile(), { overwrite: true });
    } catch {
      // Best effort: keep going with an empty list.
    }
  }
  return scans;
}

/** Write-to-tmp then move over index.json, so a force-quit never leaves a torn index (CR-02). */
function set(next: LocalScan[], persist = true) {
  scans = next;
  if (persist) {
    sessionsDir().create({ intermediates: true, idempotent: true });
    const tmp = tmpFile();
    tmp.writeSync(JSON.stringify(next));
    tmp.moveSync(indexFile(), { overwrite: true });
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
