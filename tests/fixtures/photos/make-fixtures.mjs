// Writes the photos tests/photo-metadata.test.js and the browser suite strip: a JPEG (baseline and
// progressive), a PNG and a WebP, each carrying what a phone camera writes into a file. GPS position (Kolkata), the
// camera's make, model, lens and serial number, the moment it was taken, XMP and, for the JPEG,
// IPTC, a comment and a motion-photo trailer after the image. Each is stored sideways with
// Orientation 6, the way a phone held upright saves it, so stripping must keep it the right way up.
//
// The pixels come from sharp, which is in node_modules through Expo, not a dependency of this
// repository; it is needed only to regenerate these files. The metadata is written by hand below,
// so what it holds is visible here rather than left to an encoder.
//
//   node tests/fixtures/photos/make-fixtures.mjs

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const sharp = createRequire(import.meta.url)('sharp');
const here = new URL('./', import.meta.url);

export const WIDTH = 64;
export const HEIGHT = 40;

// Stored sideways: red fills the stored top-left corner, so once Orientation 6 turns the picture
// a quarter clockwise, red sits at the top right of what is shown.
function pixels() {
  const data = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      const colour = x < WIDTH / 2 && y < HEIGHT / 2 ? [220, 30, 30] : x >= WIDTH / 2 && y >= HEIGHT / 2 ? [30, 160, 60] : [40, 70, 200];
      data.set(colour, offset);
    }
  }
  return data;
}

const ascii = (text) => Buffer.from(`${text}\0`, 'latin1');
const rational = (pairs) => Buffer.concat(pairs.map(([n, d]) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(d, 4); return b; }));

// A little-endian TIFF with IFD0, the EXIF sub-IFD and the GPS sub-IFD. Types: 2 ASCII, 3 SHORT,
// 4 LONG, 5 RATIONAL.
function exifTiff() {
  const ifd0 = [
    [0x010f, 2, ascii('Fixture Camera Co')],
    [0x0110, 2, ascii('FX-100 Pocket')],
    [0x0112, 3, 6],
    [0x0131, 2, ascii('FixtureOS 7.1')],
    [0x8769, 4, 'exif'],
    [0x8825, 4, 'gps'],
  ];
  const exif = [
    [0x9003, 2, ascii('2026:10:07 18:42:05')],
    [0xa431, 2, ascii('SN-FIXTURE-0042')],
    [0xa434, 2, ascii('Fixture Lens 4.2mm f/1.8')],
  ];
  const gps = [
    [0x0001, 2, ascii('N')],
    [0x0002, 5, rational([[22, 1], [34, 1], [2136, 100]])],
    [0x0003, 2, ascii('E')],
    [0x0004, 5, rational([[88, 1], [21, 1], [3960, 100]])],
  ];
  const size = (entries) => 2 + entries.length * 12 + 4 + entries.reduce((total, [, , value]) => total + (Buffer.isBuffer(value) && value.length > 4 ? value.length + (value.length % 2) : 0), 0);
  const offsets = { ifd0: 8 };
  offsets.exif = offsets.ifd0 + size(ifd0);
  offsets.gps = offsets.exif + size(exif);
  const write = (entries, start) => {
    const head = Buffer.alloc(2 + entries.length * 12 + 4);
    const data = [];
    let dataOffset = start + head.length;
    head.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, value], index) => {
      const entry = 2 + index * 12;
      head.writeUInt16LE(tag, entry);
      head.writeUInt16LE(type, entry + 2);
      if (type === 3) { head.writeUInt32LE(1, entry + 4); head.writeUInt16LE(value, entry + 8); return; }
      if (type === 4) { head.writeUInt32LE(1, entry + 4); head.writeUInt32LE(offsets[value], entry + 8); return; }
      head.writeUInt32LE(type === 5 ? value.length / 8 : value.length, entry + 4);
      if (value.length <= 4) { value.copy(head, entry + 8); return; }
      head.writeUInt32LE(dataOffset, entry + 8);
      const padded = value.length % 2 ? Buffer.concat([value, Buffer.alloc(1)]) : value;
      data.push(padded);
      dataOffset += padded.length;
    });
    return Buffer.concat([head, ...data]);
  };
  return Buffer.concat([Buffer.from('II*\0\x08\0\0\0', 'latin1'), write(ifd0, offsets.ifd0), write(exif, offsets.exif), write(gps, offsets.gps)]);
}

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" exif:GPSLatitude="22,34.356N" exif:GPSLongitude="88,21.66E" photoshop:City="Kolkata" xmp:CreatorTool="FixtureOS 7.1"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

function iptc() {
  const dataset = (record, number, text) => { const value = Buffer.from(text, 'latin1'); const head = Buffer.from([0x1c, record, number, 0, 0]); head.writeUInt16BE(value.length, 3); return Buffer.concat([head, value]); };
  const block = Buffer.concat([dataset(2, 90, 'Kolkata'), dataset(2, 101, 'India'), dataset(2, 80, 'Fixture Photographer')]);
  const resource = Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([0x04, 0x04, 0, 0]), Buffer.alloc(4), block, block.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  resource.writeUInt32BE(block.length, 8);
  return Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), resource]);
}

const segment = (marker, payload) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([head, payload]); };

async function jpeg({ progressive = false } = {}) {
  const plain = await sharp(pixels(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).jpeg({ quality: 90, progressive }).withIccProfile('srgb').toBuffer();
  const metadata = Buffer.concat([
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff()])),
    segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(XMP, 'utf8')])),
    segment(0xed, iptc()),
    segment(0xfe, Buffer.from('Taken near Kolkata', 'latin1')),
  ]);
  // A JFIF header carrying a 2x1 thumbnail, as an edited photo often has. Thumbnails are a second
  // copy of the picture, and the thumbnail an editor left behind is not always the edited one.
  const jfif = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 2, 1]), Buffer.from([220, 30, 30, 40, 70, 200])]));
  // Sharp writes the ICC profile straight after SOI; the camera's segments follow it.
  const afterProfile = 2 + 2 + plain.readUInt16BE(4);
  const trailer = Buffer.from('MotionPhoto_Data\0Kolkata fixture video', 'latin1');
  return Buffer.concat([plain.subarray(0, 2), jfif, plain.subarray(2, afterProfile), metadata, plain.subarray(afterProfile), trailer]);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => { const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]); const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed)); return Buffer.concat([head, typed, crc]); };

async function png() {
  const plain = await sharp(pixels(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
  const afterHeader = 8 + 12 + plain.readUInt32BE(8);
  const metadata = Buffer.concat([
    pngChunk('eXIf', exifTiff()),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(XMP, 'utf8')])),
    pngChunk('tEXt', Buffer.from('Location\0Kolkata, India', 'latin1')),
    pngChunk('tEXt', Buffer.from('Source\0Fixture Camera Co FX-100 Pocket', 'latin1')),
    pngChunk('tIME', Buffer.from([0x07, 0xea, 10, 7, 18, 42, 5])),
  ]);
  return Buffer.concat([plain.subarray(0, afterHeader), metadata, plain.subarray(afterHeader)]);
}

const webpChunk = (fourcc, data) => { const head = Buffer.alloc(8); head.write(fourcc, 0, 'latin1'); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };

async function webp() {
  const plain = await sharp(pixels(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).webp({ quality: 90 }).withIccProfile('srgb').toBuffer();
  const chunks = [];
  for (let position = 12; position + 8 <= plain.length;) {
    const fourcc = plain.toString('latin1', position, position + 4);
    const size = plain.readUInt32LE(position + 4);
    chunks.push([fourcc, plain.subarray(position + 8, position + 8 + size)]);
    position += 8 + size + (size % 2);
  }
  const vp8x = Buffer.from(chunks.find(([fourcc]) => fourcc === 'VP8X')[1]);
  vp8x[0] |= 0x08 | 0x04; // EXIF and XMP present
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    ...chunks.map(([fourcc, data]) => webpChunk(fourcc, fourcc === 'VP8X' ? vp8x : data)),
    webpChunk('EXIF', exifTiff()),
    webpChunk('XMP ', Buffer.from(XMP, 'utf8')),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeFileSync(new URL('sideways-with-gps.jpg', here), await jpeg());
  writeFileSync(new URL('sideways-with-gps.png', here), await png());
  writeFileSync(new URL('sideways-with-gps.webp', here), await webp());
  writeFileSync(new URL('progressive-with-gps.jpg', here), await jpeg({ progressive: true }));
  console.log('Wrote sideways-with-gps.{jpg,png,webp} and progressive-with-gps.jpg.');
}
