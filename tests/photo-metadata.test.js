import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PHOTO_METADATA_REMOVED, PhotoMetadataError, photoType, stripPhotoMetadata } from '../src/photo-metadata.js';
import { jpegOfEmptyTables, jpegOfRestarts, pngOfEmptyChunks, webpOfEmptyChunks } from './fixtures/photos/crafted.js';

// The fixtures carry what a phone camera writes (tests/fixtures/photos/make-fixtures.mjs). This
// file reads them with its own small parser, not the one under test, so a mistake in one is not
// repeated in the other.

const fixture = (name) => readFile(new URL(`./fixtures/photos/${name}`, import.meta.url));
const jpeg = await fixture('sideways-with-gps.jpg');
const progressive = await fixture('progressive-with-gps.jpg');
const png = await fixture('sideways-with-gps.png');
const webp = await fixture('sideways-with-gps.webp');

// Words the fixtures' metadata carries, and nothing else in the file does.
const IDENTIFYING = ['Kolkata', 'Fixture Camera Co', 'FX-100', 'SN-FIXTURE-0042', 'Fixture Lens', 'FixtureOS', 'Fixture Photographer', '2026:10:07', 'ns.adobe.com/xap', 'Photoshop 3.0', '8BIM', 'MotionPhoto'];
const GPS_INFO = 0x8825;
const EXIF_IFD = 0x8769;
const MAKE = 0x010f;
const MODEL = 0x0110;
const ORIENTATION = 0x0112;

const latin = (bytes) => Buffer.from(bytes).toString('latin1');

function tiffTags(tiff) {
  const bytes = Buffer.from(tiff);
  const little = bytes.toString('latin1', 0, 2) === 'II';
  const u16 = (offset) => (little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
  const u32 = (offset) => (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
  const ifd = u32(4);
  const tags = new Map();
  for (let index = 0; index < u16(ifd); index += 1) {
    const entry = ifd + 2 + index * 12;
    tags.set(u16(entry), u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));
  }
  return { tags, next: u32(ifd + 2 + u16(ifd) * 12) };
}

function jpegParts(bytes) {
  const buffer = Buffer.from(bytes);
  const segments = [];
  let position = 2;
  for (;;) {
    const marker = buffer[position + 1];
    if (marker === 0xd9) return { segments, trailer: buffer.subarray(position + 2) };
    const length = buffer.readUInt16BE(position + 2);
    const payload = buffer.subarray(position + 4, position + 2 + length);
    position += 2 + length;
    let scan = Buffer.alloc(0);
    if (marker === 0xda) {
      let end = position;
      while (!(buffer[end] === 0xff && buffer[end + 1] !== 0 && (buffer[end + 1] < 0xd0 || buffer[end + 1] > 0xd7))) end += 1;
      scan = buffer.subarray(position, end);
      position = end;
    }
    segments.push({ marker, payload, scan });
  }
}

function pngChunks(bytes) {
  const buffer = Buffer.from(bytes);
  const chunks = [];
  for (let position = 8; position < buffer.length;) {
    const length = buffer.readUInt32BE(position);
    chunks.push({ type: buffer.toString('latin1', position + 4, position + 8), data: buffer.subarray(position + 8, position + 8 + length), crc: buffer.readUInt32BE(position + 8 + length), typed: buffer.subarray(position + 4, position + 8 + length) });
    position += 12 + length;
  }
  return chunks;
}

function webpChunks(bytes) {
  const buffer = Buffer.from(bytes);
  const chunks = [];
  for (let position = 12; position < buffer.length;) {
    const size = buffer.readUInt32LE(position + 4);
    chunks.push({ fourcc: buffer.toString('latin1', position, position + 4), data: buffer.subarray(position + 8, position + 8 + size) });
    position += 8 + size + (size % 2);
  }
  return { riffSize: buffer.readUInt32LE(4), chunks };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const isApp = (marker) => (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
const appName = ({ marker, payload }) => `${marker.toString(16)}:${latin(payload.subarray(0, 12)).replace(/\0.*$/s, '')}`;
const pictureSegments = (bytes) => jpegParts(bytes).segments.filter(({ marker }) => !isApp(marker)).map(({ marker, payload, scan }) => [marker, latin(payload), latin(scan)]);

function assertNothingIdentifying(bytes, label) {
  const text = latin(bytes);
  for (const word of IDENTIFYING) assert.equal(text.includes(word), false, `${label} still carries "${word}"`);
}

test('the fixtures really carry GPS position and camera details, so the tests below prove something', () => {
  const exif = jpegParts(jpeg).segments.find(({ marker, payload }) => marker === 0xe1 && latin(payload).startsWith('Exif\0\0'));
  const { tags } = tiffTags(exif.payload.subarray(6));
  for (const tag of [GPS_INFO, EXIF_IFD, MAKE, MODEL, ORIENTATION]) assert.ok(tags.has(tag), `JPEG fixture tag ${tag.toString(16)}`);
  assert.equal(tags.get(ORIENTATION), 6);
  assert.ok(tiffTags(pngChunks(png).find(({ type }) => type === 'eXIf').data).tags.has(GPS_INFO));
  assert.ok(tiffTags(webpChunks(webp).chunks.find(({ fourcc }) => fourcc === 'EXIF').data).tags.has(GPS_INFO));
  for (const [bytes, label] of [[jpeg, 'JPEG'], [progressive, 'progressive JPEG'], [png, 'PNG'], [webp, 'WebP']]) {
    assert.ok(IDENTIFYING.some((word) => latin(bytes).includes(word)), `${label} fixture holds identifying words`);
  }
});

for (const [label, original] of [['JPEG', jpeg], ['progressive JPEG', progressive]]) {
  test(`a ${label} keeps its picture, colour profile and orientation, and nothing else`, () => {
    const { bytes, contentType } = stripPhotoMetadata(original);
    assert.equal(contentType, 'image/jpeg');
    assertNothingIdentifying(bytes, label);
    const { segments, trailer } = jpegParts(bytes);
    assert.equal(trailer.length, 0, 'nothing follows the end of the image: no motion-photo video, no trailer');
    assert.deepEqual(segments.filter(({ marker }) => isApp(marker)).map(appName), ['e0:JFIF', 'e1:Exif', 'e2:ICC_PROFILE']);
    const jfif = segments.find(({ marker }) => marker === 0xe0).payload;
    assert.deepEqual([jfif.length, jfif[12], jfif[13]], [14, 0, 0], 'JFIF keeps its density and loses its thumbnail');
    const { tags, next } = tiffTags(segments.find(({ marker }) => marker === 0xe1).payload.subarray(6));
    assert.deepEqual([...tags], [[ORIENTATION, 6]], 'the only EXIF tag left is the orientation');
    assert.equal(next, 0, 'no second IFD, so no thumbnail');
    const icc = (parts) => parts.segments.find(({ marker }) => marker === 0xe2).payload;
    assert.deepEqual(icc(jpegParts(bytes)), icc(jpegParts(original)));
    // The compressed picture is the same bytes: tables, frame header and every scan.
    assert.deepEqual(pictureSegments(bytes), pictureSegments(original));
  });
}

test('a progressive JPEG keeps every one of its scans', () => {
  const scans = (bytes) => jpegParts(bytes).segments.filter(({ marker }) => marker === 0xda).length;
  assert.ok(scans(progressive) > 1);
  assert.equal(scans(stripPhotoMetadata(progressive).bytes), scans(progressive));
});

test('a PNG keeps its image data and orientation, and loses eXIf, XMP, text and time', () => {
  const { bytes, contentType } = stripPhotoMetadata(png);
  assert.equal(contentType, 'image/png');
  assertNothingIdentifying(bytes, 'PNG');
  const chunks = pngChunks(bytes);
  assert.deepEqual(chunks.map(({ type }) => type), ['IHDR', 'eXIf', 'pHYs', 'IDAT', 'IEND'], 'pixel density stays; it is not about the person');
  for (const chunk of chunks) assert.equal(chunk.crc, crc32(chunk.typed), `${chunk.type} checksum`);
  assert.deepEqual([...tiffTags(chunks[1].data).tags], [[ORIENTATION, 6]]);
  const picture = (list) => list.filter(({ type }) => ['IHDR', 'pHYs', 'IDAT'].includes(type)).map(({ data }) => latin(data));
  assert.deepEqual(picture(chunks), picture(pngChunks(png)));
});

test('a WebP keeps its image, colour profile and orientation, and announces only what it holds', () => {
  const { bytes, contentType } = stripPhotoMetadata(webp);
  assert.equal(contentType, 'image/webp');
  assertNothingIdentifying(bytes, 'WebP');
  const { riffSize, chunks } = webpChunks(bytes);
  assert.equal(riffSize, bytes.length - 8);
  assert.deepEqual(chunks.map(({ fourcc }) => fourcc), ['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
  const flags = chunks[0].data[0];
  assert.equal(flags & 0x04, 0, 'XMP is no longer announced');
  assert.equal(flags & 0x08, 0x08, 'the orientation-only EXIF is announced');
  assert.deepEqual([...tiffTags(chunks[3].data).tags], [[ORIENTATION, 6]]);
  const original = webpChunks(webp).chunks;
  for (const fourcc of ['ICCP', 'VP8 ']) assert.deepEqual(chunks.find((chunk) => chunk.fourcc === fourcc).data, original.find((chunk) => chunk.fourcc === fourcc).data);
  assert.deepEqual(chunks[0].data.subarray(4), original.find(({ fourcc }) => fourcc === 'VP8X').data.subarray(4), 'canvas size unchanged');
});

test('a photo already the right way up carries no EXIF at all', () => {
  const upright = Buffer.from(jpeg);
  const exif = upright.indexOf('Exif\0\0', 0, 'latin1') + 6;
  const ifd = exif + upright.readUInt32LE(exif + 4);
  for (let index = 0; index < upright.readUInt16LE(ifd); index += 1) {
    const entry = ifd + 2 + index * 12;
    if (upright.readUInt16LE(entry) === ORIENTATION) upright.writeUInt16LE(1, entry + 8);
  }
  const { segments } = jpegParts(stripPhotoMetadata(upright).bytes);
  assert.deepEqual(segments.filter(({ marker }) => isApp(marker)).map(appName), ['e0:JFIF', 'e2:ICC_PROFILE']);
});

test('stripping twice changes nothing more, so the device and the server can both do it', () => {
  for (const original of [jpeg, progressive, png, webp]) {
    const once = stripPhotoMetadata(original);
    assert.deepEqual(stripPhotoMetadata(once.bytes), once);
  }
});

test('the type comes from the bytes, not the name or the claimed type', () => {
  assert.equal(photoType(png), 'image/png');
  assert.equal(stripPhotoMetadata(new Uint8Array(png)).contentType, 'image/png');
  assert.equal(stripPhotoMetadata(png.buffer.slice(png.byteOffset, png.byteOffset + png.length)).contentType, 'image/png');
  assert.equal(photoType(Buffer.from('GIF89a')), '');
});

test('a file it cannot read through is refused, never passed on as it came', () => {
  const unreadable = [
    Buffer.from('image-bytes'),
    Buffer.from('GIF89a\x01\x00\x01\x00'),
    jpeg.subarray(0, 40), // cut off inside a segment
    png.subarray(0, 30),
    Buffer.concat([webp.subarray(0, 12), Buffer.from('EXIF\x04\0\0\0Kolk')]), // no image at all
  ];
  for (const bytes of unreadable) {
    assert.throws(() => stripPhotoMetadata(bytes), (error) => error instanceof PhotoMetadataError && error.code === 'unreadable_photo');
  }
});

test('a JPEG marker it does not know is refused, so metadata cannot ride through under one', () => {
  // The fixture's EXIF segment with its marker changed from APP1 (E1) to a byte no JPEG uses.
  const disguised = Buffer.from(jpeg);
  const exif = disguised.indexOf('Exif\0\0', 0, 'latin1');
  assert.deepEqual([disguised[exif - 4], disguised[exif - 3]], [0xff, 0xe1]);
  disguised[exif - 3] = 0x55;
  assert.throws(() => stripPhotoMetadata(disguised), (error) => error.code === 'unreadable_photo');
  // A restart marker belongs inside a scan; out here it is not part of a photo.
  assert.throws(() => stripPhotoMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd9])), (error) => error.code === 'unreadable_photo');
});

// Before #332's review fix, the first of these took ~22 s and ~3.5 GB, the third ~9 s and ~1 GB.
for (const [label, make] of [['restart markers', jpegOfRestarts], ['empty JPEG tables', jpegOfEmptyTables], ['empty WebP chunks', webpOfEmptyChunks], ['empty PNG chunks', pngOfEmptyChunks]]) {
  test(`a 25 MB file of ${label} is refused at once, without allocating per part`, () => {
    const crafted = make();
    const before = process.memoryUsage().rss;
    const started = performance.now();
    assert.throws(() => stripPhotoMetadata(crafted), (error) => error.code === 'unreadable_photo');
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
    assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024, 'grew by more than 200 MB');
  });
}

test('the line said beneath the picker is one sentence about location and camera details', () => {
  assert.match(PHOTO_METADATA_REMOVED, /^[^.]+\.$/);
  assert.match(PHOTO_METADATA_REMOVED, /location and camera details/);
  assert.match(PHOTO_METADATA_REMOVED, /before it is uploaded/);
});
