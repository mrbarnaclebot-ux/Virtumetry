import { describe, it, expect } from 'vitest';
import { EXIF_APP1_BYTES, exifApp1, jpegSize, withExif } from '../../src/bundle/exif.js';
import { captureExifTimestampSeconds, readCaptureExif } from '../helpers/capture-exif.js';

/** Minimal JPEG head: SOI, JFIF APP0, SOF0 (baseline) for w x h, EOI. Enough for marker scans. */
function fakeJpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

describe('exifApp1 / withExif', () => {
  it('is exactly 106 bytes', () => {
    expect(EXIF_APP1_BYTES).toBe(106);
    expect(exifApp1(1341847980722, '+02:00')).toHaveLength(106);
  });

  it('inserts APP1 right after SOI and SpAItial\'s reader reads it back', () => {
    const jpeg = fakeJpeg(640, 480);
    const out = withExif(jpeg, 1341847980722, '+02:00');
    expect(out.length).toBe(jpeg.length + 106);
    expect(out.readUInt16BE(0)).toBe(0xffd8);
    expect(out.readUInt16BE(2)).toBe(0xffe1);
    const exif = readCaptureExif(out)!;
    expect(exif.offsetTimeOriginal).toBe('+02:00');
    expect(exif.subSecTimeOriginal).toBe('722');
    expect(exif.dateTimeOriginal).toBe('2012:07:09 17:33:00');
    expect(captureExifTimestampSeconds(exif)).toBeCloseTo(1341847980.722, 6);
    expect(jpegSize(out)).toEqual({ w: 640, h: 480 });
  });

  it('handles negative offsets and zero-padded millis', () => {
    const exif = readCaptureExif(withExif(fakeJpeg(8, 8), 1700000000005, '-05:30'))!;
    expect(exif.subSecTimeOriginal).toBe('005');
    expect(captureExifTimestampSeconds(exif)).toBeCloseTo(1700000000.005, 6);
  });

  it('produces strictly increasing read-back times for increasing wallMs', () => {
    const ts = [1341847980722, 1341847980999, 1341847981000].map(
      (ms) => captureExifTimestampSeconds(readCaptureExif(withExif(fakeJpeg(8, 8), ms, '+02:00'))!)!,
    );
    expect(ts[0]! < ts[1]! && ts[1]! < ts[2]!).toBe(true);
  });

  it('rejects a tzOffset not matching ±HH:MM and non-JPEG input', () => {
    expect(() => exifApp1(0, '+0200')).toThrow();
    expect(() => exifApp1(0, 'Z')).toThrow();
    expect(() => withExif(Buffer.from('nope'), 0, '+00:00')).toThrow();
  });
});

describe('jpegSize', () => {
  it('reads width/height from the SOF marker', () => {
    expect(jpegSize(fakeJpeg(640, 480))).toEqual({ w: 640, h: 480 });
    expect(jpegSize(fakeJpeg(1920, 1440))).toEqual({ w: 1920, h: 1440 });
  });
  it('throws when there is no SOF', () => {
    expect(() => jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow();
  });
});
