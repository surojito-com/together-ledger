// Files built to cost the stripper as much as possible, at just under the 25 MB upload limit
// (#332 review). None is a photo; each must be refused quickly, before it allocates per part.

export const UPLOAD_LIMIT = 25 * 1024 * 1024;

const ascii = (text) => Buffer.from(text, 'latin1');

// SOI, then nothing but restart markers: legal only inside a scan.
export function jpegOfRestarts(size = UPLOAD_LIMIT - 64) {
  const bytes = Buffer.alloc(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  for (let index = 2; index + 1 < size; index += 2) {
    bytes[index] = 0xff;
    bytes[index + 1] = 0xd0;
  }
  return bytes;
}

// SOI, then millions of empty quantisation-table segments: each one a known marker, four bytes long.
export function jpegOfEmptyTables(size = UPLOAD_LIMIT - 64) {
  const bytes = Buffer.alloc(size - ((size - 2) % 4));
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  for (let index = 2; index + 3 < bytes.length; index += 4) bytes.set([0xff, 0xdb, 0x00, 0x02], index);
  return bytes;
}

// A WebP holding one empty lossless image, then millions of empty alpha chunks.
export function webpOfEmptyChunks(size = UPLOAD_LIMIT - 64) {
  const bytes = Buffer.alloc(size - (size % 8));
  ascii('RIFF').copy(bytes, 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  ascii('WEBP').copy(bytes, 8);
  ascii('VP8L').copy(bytes, 12);
  for (let index = 20; index + 8 <= bytes.length; index += 8) ascii('ALPH').copy(bytes, index);
  return bytes;
}

// A PNG header, then millions of empty chunks of a type nothing defines.
export function pngOfEmptyChunks(size = UPLOAD_LIMIT - 64) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0]);
  const bytes = Buffer.alloc(size - ((size - header.length) % 12));
  header.copy(bytes, 0);
  for (let index = header.length; index + 12 <= bytes.length; index += 12) ascii('zzZz').copy(bytes, index + 4);
  return bytes;
}
