// D-21: app-scoped upload manager. Started from the root layout while signed in; one pass on start,
// on AppState 'active' and on kick. Logs scan ids only, never URLs (T-04-30).
import { Directory } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { AppState, Platform, type NativeEventSubscription } from 'react-native';

import { getLocalScan, getLocalScans, updateLocalScan } from '@/capture/store';
import type { LocalUploadState } from '@/library/display-state';
import { completeScan, createScan, getMissing, presignUploads, UnauthorizedError } from '@/lib/api';
import { reconcile, type UploadProgress } from '@/upload/reconcile';
import { uploader } from '@/upload/uploader';

const ACTIVE: LocalUploadState[] = ['approved', 'uploading', 'paused'];
const THROTTLE_MS = 500; // <= 2 Hz

let started = false;
let sub: NativeEventSubscription | null = null;
let running = false;
let again = false;

const progress = new Map<string, UploadProgress>();
const lastEmit = new Map<string, number>();
const listeners = new Set<() => void>();

function setProgress(id: string, p: UploadProgress) {
  const now = Date.now();
  if (p.uploaded < p.total && now - (lastEmit.get(id) ?? 0) < THROTTLE_MS) return;
  lastEmit.set(id, now);
  progress.set(id, p);
  updateLocalScan(id, { progress: p });
  listeners.forEach((l) => l());
}

/** Deletes the session dir but keeps the index entry, so the row still maps to its server world. */
async function deleteFiles(id: string) {
  const scan = getLocalScan(id);
  if (!scan) return;
  const dir = new Directory(scan.dir);
  if (dir.exists) dir.delete();
}

const deps = {
  api: { createScan, presignUploads, getMissing, completeScan },
  uploader,
  local: { update: updateLocalScan, deleteFiles },
};

async function passOnce() {
  for (const scan of getLocalScans().filter((s) => ACTIVE.includes(s.uploadState))) {
    try {
      await reconcile(scan, deps, (p) => setProgress(scan.id, p));
    } catch (e) {
      if (e instanceof UnauthorizedError) return; // signed out: stop the pass
      console.warn('upload pass failed for scan', scan.id); // one bad scan never blocks another
    }
  }
}

/** One pass at a time; a request during a pass schedules exactly one follow-up (T-04-31). */
async function runPass() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await passOnce();
    } while (again && started);
  } finally {
    running = false;
  }
}

export function startUploadManager() {
  if (started) return;
  started = true;
  if (Platform.OS !== 'web') {
    sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void runPass();
    });
  }
  void runPass();
}

export function stopUploadManager() {
  started = false;
  sub?.remove();
  sub = null;
}

export function kickUploadManager() {
  void runPass();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useUploadProgress(id: string) {
  return useSyncExternalStore(subscribe, () => progress.get(id));
}
