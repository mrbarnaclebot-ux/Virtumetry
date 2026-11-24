// Bundled TUM tiny session (CC BY 4.0, see assets/fixtures/tiny-session/README.md).
// Metro can't require .jsonl, so frames.json mirrors backend/test/fixtures/tiny-session/frames.jsonl (drift-tested).
import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';

import framesJson from '../../assets/fixtures/tiny-session/frames.json';
import type { FrameLine } from '@/capture/types';

export const FIXTURE_FRAME_MODULES: number[] = [
  require('../../assets/fixtures/tiny-session/frames/000001.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000002.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000003.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000004.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000005.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000006.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000007.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000008.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000009.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000010.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000011.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000012.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000013.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000014.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000015.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000016.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000017.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000018.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000019.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000020.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000021.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000022.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000023.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000024.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000025.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000026.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000027.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000028.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000029.jpg'),
  require('../../assets/fixtures/tiny-session/frames/000030.jpg'),
];

export const FIXTURE_FRAMES = framesJson as FrameLine[];
export const FIXTURE_IMAGE = { width: 640, height: 480 };

/** File uri of fixture frame k (0-based). Research A1: download into the cache if the asset has no localUri. */
export async function resolveFixtureFrame(k: number): Promise<string> {
  const [asset] = await Asset.loadAsync(FIXTURE_FRAME_MODULES[k]);
  if (asset.localUri) return asset.localUri;
  const dest = new File(Paths.cache, `fixture-${String(k + 1).padStart(6, '0')}.jpg`);
  if (dest.exists) return dest.uri;
  return (await File.downloadFileAsync(asset.uri, dest)).uri;
}
