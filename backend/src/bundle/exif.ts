// Hand-written EXIF APP1 writer (D-05): three capture-time tags, no dependency.
// Byte-identical to the Pillow APP1 in SpAItial's sample JPEG.

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Size of the APP1 segment exifApp1 produces; output JPEG = input + this. */
export const EXIF_APP1_BYTES = 106;

/** Fixed 106-byte APP1: IFD0{ExifIFD ptr} → ExifIFD{DateTimeOriginal, OffsetTimeOriginal, SubSecTimeOriginal}. */
export function exifApp1(wallMs: number, tzOffset: string): Buffer {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tzOffset);
  if (!m) throw new Error(`bad tzOffset ${tzOffset}`);
  const offMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const d = new Date(wallMs + offMin * 60_000); // local wall time, read with getUTC*
  const dto = `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}\0`; // 20 B
  const sub = `${String(((wallMs % 1000) + 1000) % 1000).padStart(3, '0')}\0`; // 4 B → inline value
  const t = Buffer.alloc(96); // big-endian TIFF block
  t.write('MM', 0, 'latin1'); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8);                                                   // IFD0: 1 entry
  t.writeUInt16BE(0x8769, 10); t.writeUInt16BE(4, 12); t.writeUInt32BE(1, 14); t.writeUInt32BE(26, 18);
  t.writeUInt32BE(0, 22);                                                  // no IFD1
  t.writeUInt16BE(3, 26);                                                  // ExifIFD: 3 entries, ascending tags
  const ent = (o: number, tag: number, count: number) => { t.writeUInt16BE(tag, o); t.writeUInt16BE(2, o + 2); t.writeUInt32BE(count, o + 4); };
  ent(28, 0x9003, 20); t.writeUInt32BE(68, 36);                            // DateTimeOriginal -> @68
  ent(40, 0x9011, 7);  t.writeUInt32BE(88, 48);                            // OffsetTimeOriginal -> @88
  ent(52, 0x9291, 4);  t.write(sub, 60, 'latin1');                         // SubSecTimeOriginal inline
  t.writeUInt32BE(0, 64);
  t.write(dto, 68, 'latin1'); t.write(`${tzOffset}\0`, 88, 'latin1');
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0xffe1, 0); head.writeUInt16BE(2 + 6 + t.length, 2); head.write('Exif\0\0', 4, 'latin1');
  return Buffer.concat([head, t]);
}

/** D-05: APP1 right after SOI. Frames arrive without EXIF by contract (validate rejects an existing Exif APP1). */
export function withExif(jpeg: Buffer, wallMs: number, tzOffset: string): Buffer {
  if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG');
  return Buffer.concat([jpeg.subarray(0, 2), exifApp1(wallMs, tzOffset), jpeg.subarray(2)]);
}

/** Encoded JPEG dimensions from the first SOF marker. Throws if none is found. */
export function jpegSize(b: Buffer): { w: number; h: number } {
  let p = 2;
  while (p + 9 < b.length && b[p] === 0xff) {
    const mk = b[p + 1]!, len = b.readUInt16BE(p + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc)
      return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  throw new Error('no SOF marker');
}
