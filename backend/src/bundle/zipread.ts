// Central-directory reader over byte ranges, for the mock provider and pack tests.
// ponytail: no ZIP64 (bundles < 4 GiB / 65,535 entries); add when real bundles exceed that.

export type ReadRange = (start: number, endInclusive: number) => Promise<Buffer>;
export interface ZipEntry { name: string; method: number; csize: number; usize: number; lho: number }

export async function readCentralDirectory(total: number, read: ReadRange): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, total - 65_557);
  const tail = await read(tailStart, total - 1);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    const count = tail.readUInt16LE(i + 10), size = tail.readUInt32LE(i + 12), off = tail.readUInt32LE(i + 16);
    if (count === 0xffff || size === 0xffffffff || off === 0xffffffff) throw new Error('ZIP64 not supported');
    const cd = await read(off, off + size - 1);
    const out: ZipEntry[] = [];
    for (let p = 0, k = 0; k < count; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
      const n = cd.readUInt16LE(p + 28), m = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + n), method: cd.readUInt16LE(p + 10),
                 csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), lho: cd.readUInt32LE(p + 42) });
      p += 46 + n + m + c;
    }
    return out;
  }
  throw new Error('EOCD not found');
}

/** Read an entry's stored bytes (method 0). `max` caps the read, e.g. 65536 for EXIF heads. */
export async function readEntry(e: ZipEntry, read: ReadRange, max = e.csize): Promise<Buffer> {
  const lh = await read(e.lho, e.lho + 29);
  const start = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return read(start, start + Math.min(max, e.csize) - 1);
}
// HTTP ReadRange: fetch(url, { headers: { Range: `bytes=${a}-${b}` } }) → expect 206.
// total comes from the preflight's Content-Range "bytes 0-15/<total>".
