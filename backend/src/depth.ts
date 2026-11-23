// Capture v2 LiDAR depth maps (spec §5.2). Shared by the upload route, the
// stitch worker and purge so all three agree on the object key.

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { MAX_DEPTH_BYTES, type StorageDriver } from './storage/index.js';

/** Depth map for frame `i`, stored beside `frame_<i>.heic` under the capture prefix. */
export const depthKeyName = (i: number): string => `depth_${i}.png`;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Frame indices whose pose says a depth map was uploaded (spec §5.2 item 1:
 * `depth` is present iff the file exists). Bounded to the capture's frames so a
 * stray pose index cannot make the worker read keys it never presigned.
 */
export function depthIndices(posesJson: unknown, frameCount: number): number[] {
  if (!Array.isArray(posesJson)) return [];
  const out = new Set<number>();
  for (const p of posesJson) {
    if (!p || typeof p !== 'object') continue;
    const { index, depth } = p as { index?: unknown; depth?: unknown };
    if (
      depth && typeof depth === 'object' &&
      Number.isInteger(index) && (index as number) >= 0 && (index as number) < frameCount
    ) {
      out.add(index as number);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Stage every advertised depth map as `<depthDir>/depth_<i>.png` and return how
 * many landed. Depth is an enhancement, never a requirement: a missing,
 * oversize, unreadable or non-PNG map is logged and that frame stitches without
 * depth. Nothing here throws for a depth problem, so it can never fail or retry
 * the stitch job. Same HEAD-before-read cap as frames (spec §10 R7).
 */
export async function stageDepthMaps(opts: {
  storage: StorageDriver;
  prefix: string;
  posesJson: unknown;
  frameCount: number;
  depthDir: string;
  log?: (msg: string) => void;
}): Promise<number> {
  const log = opts.log ?? ((m: string) => console.warn(`[worker] ${m}`));
  let staged = 0;
  for (const i of depthIndices(opts.posesJson, opts.frameCount)) {
    const key = `${opts.prefix}/${depthKeyName(i)}`;
    try {
      const size = await opts.storage.objectSize(key);
      if (size > MAX_DEPTH_BYTES) {
        log(`depth ${key} is ${size} bytes, over the ${MAX_DEPTH_BYTES}-byte cap; stitching frame ${i} without depth`);
        continue;
      }
      const bytes = await opts.storage.getObject(key);
      if (bytes.length > MAX_DEPTH_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
        log(`depth ${key} is not a PNG within the cap; stitching frame ${i} without depth`);
        continue;
      }
      await writeFile(path.join(opts.depthDir, depthKeyName(i)), bytes);
      staged++;
    } catch (err) {
      log(`depth ${key} unavailable (${String(err)}); stitching frame ${i} without depth`);
    }
  }
  return staged;
}
