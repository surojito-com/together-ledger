// A photo's metadata, removed the moment the photo is added (#258). A camera writes where the
// picture was taken, what took it, and often much more into the file itself: EXIF and XMP carry
// GPS position, make, model, lens and serial numbers; IPTC carries place names and people. None
// of it is the picture, and none of it should reach the other journeyers.
//
// This works on the file's container, not its pixels. The compressed image data is copied
// through untouched, so nothing is re-encoded and the picture is exactly as it was. What stays is
// only what draws it correctly: the colour profile, and the orientation tag, rewritten on its own.
//
// It imports nothing and touches no browser API, so the web (before upload), the server (before
// storing, as a backstop) and the phone (once it can attach photos, #187) run the same code.
// Hand it the file's bytes; it hands back cleaned bytes and the type they really are.

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Said once the photo has been cleaned, where it was picked. Only true after stripPhotoMetadata ran. */
export const PHOTO_METADATA_REMOVED = 'Its location and camera details have been removed on this device, before it is uploaded.';

export class PhotoMetadataError extends Error {
  constructor(message = 'This photo could not be read. Choose a JPEG, PNG, or WebP photo.') {
    super(message);
    this.code = 'unreadable_photo';
  }
}

const ascii = (text) => Uint8Array.from(text, (character) => character.charCodeAt(0));
const startsWith = (bytes, prefix, offset = 0) => bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
const readAscii = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

const JPEG_SOI = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_HEADER = [...ascii('Exif'), 0, 0];

/** The type the bytes really are, whatever the file was named: a JPEG, PNG or WebP, or ''. */
export function photoType(input) {
  const bytes = toBytes(input);
  if (startsWith(bytes, [...JPEG_SOI, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * Removes everything but the picture from a JPEG, PNG or WebP. Returns { bytes, contentType },
 * where contentType is the type the bytes are, not the type they claimed. Throws
 * PhotoMetadataError for anything it cannot read through, so a file it does not understand is
 * refused rather than sent on as it came.
 */
export function stripPhotoMetadata(input) {
  const bytes = toBytes(input);
  const contentType = photoType(bytes);
  try {
    if (contentType === 'image/jpeg') return { bytes: stripJpeg(bytes), contentType };
    if (contentType === 'image/png') return { bytes: stripPng(bytes), contentType };
    if (contentType === 'image/webp') return { bytes: stripWebp(bytes), contentType };
  } catch (error) {
    if (error instanceof PhotoMetadataError) throw error;
    throw new PhotoMetadataError();
  }
  throw new PhotoMetadataError();
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new PhotoMetadataError();
}

function concat(parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function unreadable() {
  return new PhotoMetadataError();
}

// A camera writes tens of segments or chunks; an encoder splitting a large PNG's image data, a few
// thousand. A file made of millions of tiny ones is not a photo, and walking it would cost the
// server seconds and gigabytes, so past this many it is refused.
const MAX_PARTS = 65536;

function countPart(parts) {
  if (parts >= MAX_PARTS) throw unreadable();
  return parts + 1;
}

// Orientation is the one EXIF tag that changes how the picture is drawn: a phone held sideways
// writes the pixels sideways and says so here. It is read from the original and written back as
// a TIFF structure holding nothing else.

const ORIENTATION_TAG = 0x0112;

function readOrientation(tiff) {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const u16 = (offset) => (little ? tiff[offset] | (tiff[offset + 1] << 8) : (tiff[offset] << 8) | tiff[offset + 1]);
  const u32 = (offset) => (little
    ? (tiff[offset] | (tiff[offset + 1] << 8) | (tiff[offset + 2] << 16) | (tiff[offset + 3] << 24)) >>> 0
    : ((tiff[offset] << 24) | (tiff[offset + 1] << 16) | (tiff[offset + 2] << 8) | tiff[offset + 3]) >>> 0);
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return 1;
    // A SHORT's value sits in the first two bytes of the value field, in the file's byte order.
    if (u16(entry) === ORIENTATION_TAG && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function orientationOnlyTiff(orientation) {
  return Uint8Array.of(
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00, // no next IFD, so no thumbnail
  );
}

// JPEG: a run of marker segments, then entropy-coded scans. Every APPn and comment segment is
// dropped except the three that affect drawing: JFIF (APP0, its thumbnail removed), the ICC
// colour profile (APP2) and Adobe's colour transform (APP14). EXIF and XMP live in APP1, IPTC in
// APP13, and MPF, FlashPix, C2PA and maker data in the others. Anything after the end-of-image
// marker goes too: that is where phones append a motion photo's video, a gain map, or a trailer.

const KEPT_JPEG_APP = new Map([
  [0xe0, ascii('JFIF\0')],
  [0xe2, ascii('ICC_PROFILE\0')],
  [0xee, ascii('Adobe')],
]);

// The segments that draw the picture: every start-of-frame (C0-CF but C4, C8 and CC), Huffman
// and arithmetic-coding tables (C4, CC), quantisation tables (DB), restart interval (DD), number
// of lines (DC) and start of scan (DA). Any other marker outside APPn and comments is refused, so
// metadata cannot ride through under a marker this does not know.
const PICTURE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, 0xc4, 0xcc, 0xdb, 0xdd, 0xdc, 0xda]);

function segment(marker, payload) {
  const length = payload.length + 2;
  if (length > 0xffff) throw unreadable();
  return concat([Uint8Array.of(0xff, marker, length >> 8, length & 0xff), payload]);
}

function stripJpeg(bytes) {
  const kept = [];
  let jfif = null;
  let orientation = 1;
  let position = 2;
  let ended = false;
  let parts = 0;
  while (position < bytes.length && !ended) {
    parts = countPart(parts);
    if (bytes[position] !== 0xff) throw unreadable();
    while (bytes[position] === 0xff) position += 1; // fill bytes before a marker
    const marker = bytes[position];
    position += 1;
    if (marker === undefined) throw unreadable();
    if (marker === 0xd9) {
      ended = true;
      break;
    }
    // Restart markers belong inside a scan, where the scan below steps over them. Out here they,
    // TEM and every marker not listed are not part of a photo.
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata && !PICTURE_MARKERS.has(marker)) throw unreadable();
    if (position + 2 > bytes.length) throw unreadable();
    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) throw unreadable();
    const whole = bytes.subarray(position - 2, position + length);
    const payload = bytes.subarray(position + 2, position + length);
    position += length;

    if (marker === 0xda) {
      // The scan runs until the next marker that is not stuffed data (FF00) or a restart (RSTn).
      let end = position;
      for (;;) {
        end = bytes.indexOf(0xff, end);
        if (end < 0 || end + 1 >= bytes.length) {
          end = bytes.length; // a file cut short after its last scan still draws what it holds
          ended = true;
          break;
        }
        const next = bytes[end + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) end += 2;
        else if (next === 0xff) end += 1;
        else break;
      }
      kept.push(whole, bytes.subarray(position, end));
      position = end;
      continue;
    }

    if (metadata) {
      if (marker === 0xe1 && orientation === 1 && startsWith(payload, EXIF_HEADER)) orientation = readOrientation(payload.subarray(EXIF_HEADER.length));
      const identifier = KEPT_JPEG_APP.get(marker);
      if (!identifier || !startsWith(payload, identifier)) continue;
      if (marker === 0xe0) {
        if (jfif || payload.length < 14) continue;
        jfif = payload.slice(0, 14);
        jfif[12] = 0; // no thumbnail
        jfif[13] = 0;
        continue;
      }
      kept.push(whole);
      continue;
    }

    kept.push(whole);
  }
  const head = [Uint8Array.of(...JPEG_SOI)];
  if (jfif) head.push(segment(0xe0, jfif));
  if (orientation !== 1) head.push(segment(0xe1, concat([Uint8Array.of(...EXIF_HEADER), orientationOnlyTiff(orientation)])));
  return concat([...head, ...kept, Uint8Array.of(0xff, 0xd9)]);
}

// PNG: chunks, each named and checksummed. Only the image itself, its colour, transparency,
// pixel density and APNG animation are kept. eXIf, tEXt, zTXt and iTXt (where XMP lives), tIME
// and anything unknown are dropped.

const KEPT_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const u32be = (value) => Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

function pngChunk(type, data) {
  const typed = concat([ascii(type), data]);
  return concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

function stripPng(bytes) {
  const kept = [];
  let orientation = 1;
  let position = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawEnd = false;
  let parts = 0;
  while (position < bytes.length && !sawEnd) {
    parts = countPart(parts);
    if (position + 12 > bytes.length) throw unreadable();
    const length = ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
    const type = readAscii(bytes, position + 4, 4);
    const end = position + 12 + length;
    if (end > bytes.length) throw unreadable();
    if (!sawHeader && type !== 'IHDR') throw unreadable();
    sawHeader = true;
    if (type === 'eXIf' && orientation === 1) {
      const data = bytes.subarray(position + 8, position + 8 + length);
      orientation = readOrientation(startsWith(data, EXIF_HEADER) ? data.subarray(EXIF_HEADER.length) : data);
    }
    if (KEPT_PNG_CHUNKS.has(type)) kept.push(bytes.subarray(position, end));
    if (type === 'IEND') sawEnd = true;
    position = end;
  }
  if (!sawHeader) throw unreadable();
  if (!sawEnd) kept.push(pngChunk('IEND', new Uint8Array()));
  // eXIf must come before the image data; straight after the header is always allowed.
  if (orientation !== 1) kept.splice(1, 0, pngChunk('eXIf', orientationOnlyTiff(orientation)));
  return concat([Uint8Array.of(...PNG_SIGNATURE), ...kept]);
}

// WebP: a RIFF container. The extended form (VP8X) may carry EXIF and XMP chunks and flags that
// announce them; both are dropped, along with any chunk WebP does not define for drawing.

const KEPT_WEBP_CHUNKS = new Set(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L']);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

const u32le = (value) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);

const WEBP_PAD = Uint8Array.of(0);

function webpChunk(fourcc, data) {
  return concat([ascii(fourcc), u32le(data.length), data, data.length % 2 ? WEBP_PAD : new Uint8Array()]);
}

function stripWebp(bytes) {
  const riffSize = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  const limit = Math.min(bytes.length, 8 + riffSize);
  const kept = [];
  let extended = null;
  let orientation = 1;
  let sawImage = false;
  let position = 12;
  let parts = 0;
  while (position + 8 <= limit) {
    parts = countPart(parts);
    const fourcc = readAscii(bytes, position, 4);
    const size = (bytes[position + 4] | (bytes[position + 5] << 8) | (bytes[position + 6] << 16) | (bytes[position + 7] << 24)) >>> 0;
    const dataEnd = position + 8 + size;
    if (dataEnd > limit) throw unreadable();
    const data = bytes.subarray(position + 8, dataEnd);
    if (fourcc === 'EXIF' && orientation === 1) orientation = readOrientation(startsWith(data, EXIF_HEADER) ? data.subarray(EXIF_HEADER.length) : data);
    if (fourcc === 'VP8X') {
      if (extended || size < 10) throw unreadable();
      extended = data.slice();
      extended[0] &= ~(VP8X_EXIF | VP8X_XMP);
      kept.push(null); // the header is written last, once its flags are known
    } else if (KEPT_WEBP_CHUNKS.has(fourcc)) {
      if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') sawImage = true;
      // A view of the chunk as it stands, header included, rather than a copy of each one.
      kept.push(bytes.subarray(position, dataEnd));
      if (size % 2) kept.push(WEBP_PAD);
    }
    position = dataEnd + (size % 2);
  }
  if (!sawImage) throw unreadable();
  // Orientation is only read from an extended file, which is the only kind that can announce it.
  if (extended && orientation !== 1) {
    extended[0] |= VP8X_EXIF;
    kept.push(webpChunk('EXIF', orientationOnlyTiff(orientation)));
  }
  const chunks = kept.map((chunk) => chunk ?? webpChunk('VP8X', extended));
  const body = concat([ascii('WEBP'), ...chunks]);
  return concat([ascii('RIFF'), u32le(body.length), body]);
}
