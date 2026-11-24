// D-02: native ARKit module when present (Phase 8 dev build), else the fixture replay (Expo Go, jest).
import { requireOptionalNativeModule } from 'expo';

import { FixtureCaptureSource } from '@/capture/fixture-source';
import type { CaptureSource } from '@/capture/types';

function wrapNative(_native: object): CaptureSource {
  throw new Error('Native capture lands in Phase 8');
}

let fixture: FixtureCaptureSource | null = null;

export function getCaptureSource(): CaptureSource {
  const native = requireOptionalNativeModule('VmCapture');
  if (native) return wrapNative(native);
  return (fixture ??= new FixtureCaptureSource());
}

export const isFixtureSource = (src: CaptureSource): src is FixtureCaptureSource => src.kind === 'fixture';
