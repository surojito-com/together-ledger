import { X509Certificate, verify as verifySignature } from 'node:crypto';

// Checking a StoreKit 2 transaction on our own server (#272). A purchase is real when this says it
// is, never because a phone said so: a phone can be modified, and tools that fake exactly this
// exist and are easy to find.
//
// StoreKit 2 hands the app each transaction as a JWS (JSON Web Signature) that Apple signed. The
// phone forwards it untouched, and it is checked here, locally, with no call to Apple on the
// purchase path:
//
//   1. The header names ES256 and carries the signing chain in `x5c`: Apple's leaf certificate,
//      the Apple Worldwide Developer Relations intermediate, and Apple Root CA - G3.
//   2. The root in the chain must be byte for byte one of the roots this server was given
//      (APPLE_ROOT_CERTIFICATES). That is the whole of the trust: a chain ending anywhere else is
//      refused, however well formed.
//   3. Each certificate is issued and signed by the next, the intermediate is a CA, and each was
//      valid when Apple signed the transaction (`signedDate`), give or take a minute of clock skew.
//   4. The leaf carries Apple's marker for App Store receipt signing (OID 1.2.840.113635.100.6.11.1)
//      and the intermediate Apple's marker for its WWDR intermediates (1.2.840.113635.100.6.2.1),
//      the same two checks Apple's own App Store Server Library makes. Without them, any
//      certificate Apple's root ever issued, for anything, could sign a purchase.
//   5. The signature over `header.payload` verifies with the leaf's P-256 key.
//
// Only then is the payload read. What it must say (our bundle, a product we sell, the right
// environment, our account token) is the purchase service's to check, in store-purchases.js.
//
// Not done here: asking Apple whether a certificate has been revoked (OCSP). That is a network call
// on every purchase, which this design rules out, and Apple's library leaves it optional for the
// same reason. A revoked Apple signing key would be news, and replacing the configured root is the
// answer to it.
//
// Sources. The chain, OID, skew and signing-date checks follow Apple's own App Store Server Library
// (MIT), read on Oct 8, 2026: https://github.com/apple/app-store-server-library-node, jws_verification.ts.
// Apple's documentation pages and certificate download could not be opened from the environment
// this was written in, so the payload fields are as that library and Apple document them, and the
// root certificate is the owner's to download and check (docs/STORE_PURCHASES.md):
//   https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload
//   https://www.apple.com/certificateauthority/ (Apple Root CA - G3)

const LEAF_MARKER = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_MARKER = '1.2.840.113635.100.6.2.1';
const MAX_JWS_LENGTH = 32 * 1024;
const MAX_SKEW_MS = 60 * 1000;

export class AppleVerificationError extends Error {
  constructor(reason) {
    super(`The App Store transaction did not verify: ${reason}.`);
    this.name = 'AppleVerificationError';
    this.reason = reason;
  }
}

// The DER encoding of an object identifier. Node's X509Certificate does not list a certificate's
// extensions, and Apple's markers are extensions whose presence is the whole of what is checked,
// so the extensions are read from the certificate's DER below and compared with these.
export function oidBytes(oid) {
  const parts = oid.split('.').map(Number);
  const body = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const groups = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) groups.unshift((rest & 0x7f) | 0x80);
    body.push(...groups);
  }
  return Buffer.from([0x06, body.length, ...body]);
}

const LEAF_MARKER_BYTES = oidBytes(LEAF_MARKER);
const INTERMEDIATE_MARKER_BYTES = oidBytes(INTERMEDIATE_MARKER);

// One DER element: its tag, and where its contents start and end.
function element(der, offset) {
  if (offset + 2 > der.length) throw new AppleVerificationError('a certificate in its chain is malformed');
  const tag = der[offset];
  let size = der[offset + 1];
  let start = offset + 2;
  if (size & 0x80) {
    const count = size & 0x7f;
    if (count < 1 || count > 4 || start + count > der.length) throw new AppleVerificationError('a certificate in its chain is malformed');
    size = 0;
    for (let index = 0; index < count; index += 1) size = size * 256 + der[start + index];
    start += count;
  }
  if (start + size > der.length) throw new AppleVerificationError('a certificate in its chain is malformed');
  return { tag, start, end: start + size };
}

function children(der, parent) {
  const found = [];
  for (let offset = parent.start; offset < parent.end;) {
    const child = element(der, offset);
    found.push(child);
    offset = child.end;
  }
  return found;
}

// The OIDs of a certificate's extensions, read from where X.509 puts them (tbsCertificate's [3]),
// so a marker counts only as an extension, never as bytes that happen to appear in a name.
function extensionOids(certificate) {
  const der = certificate.raw;
  const [tbs] = children(der, element(der, 0));
  const wrapper = children(der, tbs).find((child) => child.tag === 0xa3);
  if (!wrapper) return [];
  const [list] = children(der, wrapper);
  return children(der, list).map((extension) => {
    const [id] = children(der, extension);
    return id.tag === 0x06 ? der.subarray(id.start - 2, id.end) : Buffer.alloc(0);
  });
}

function hasExtension(certificate, marker) {
  return extensionOids(certificate).some((id) => id.equals(marker));
}

// Roots arrive from the environment as base64 DER (Apple publishes the .cer as DER) or as PEM, one
// per comma. Each must be a self-signed CA certificate, or the server refuses to start.
export function parseRootCertificates(value) {
  const entries = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.map((entry) => {
    const pem = entry.replace(/\\n/g, '\n');
    const certificate = new X509Certificate(pem.includes('-----BEGIN') ? pem : Buffer.from(pem, 'base64'));
    if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
      throw new Error('Every APPLE_ROOT_CERTIFICATES entry must be a self-signed CA certificate.');
    }
    return certificate;
  });
}

function decodeSegment(segment, what) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new AppleVerificationError(`its ${what} is not base64url`);
  let value;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new AppleVerificationError(`its ${what} is not JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppleVerificationError(`its ${what} is not a JSON object`);
  return value;
}

function certificateFrom(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new AppleVerificationError('a certificate in its chain is not base64');
  try {
    return new X509Certificate(Buffer.from(value, 'base64'));
  } catch {
    throw new AppleVerificationError('a certificate in its chain could not be read');
  }
}

function validAt(certificate, when) {
  return new Date(certificate.validFrom).getTime() - MAX_SKEW_MS <= when.getTime()
    && when.getTime() <= new Date(certificate.validTo).getTime() + MAX_SKEW_MS;
}

export class AppleTransactionVerifier {
  constructor({ rootCertificates }) {
    this.roots = rootCertificates;
  }

  // The verified payload of a signed transaction, or an AppleVerificationError saying which check
  // failed. The reason is for our log; the person is told only that it could not be confirmed.
  // App Store Server Notifications (#273) are signed the same way, with the same chain, and carry
  // the transaction inside them as a JWS of its own, so a notification may be longer.
  verify(signedTransaction, { maxLength = MAX_JWS_LENGTH } = {}) {
    if (typeof signedTransaction !== 'string' || signedTransaction.length > maxLength) throw new AppleVerificationError('it is not a signed transaction');
    const parts = signedTransaction.split('.');
    if (parts.length !== 3) throw new AppleVerificationError('it is not a compact JWS');
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    const header = decodeSegment(headerSegment, 'header');
    if (header.alg !== 'ES256') throw new AppleVerificationError('it is not signed with ES256');
    if (!Array.isArray(header.x5c) || header.x5c.length !== 3) throw new AppleVerificationError('it does not carry a three-certificate chain');
    const [leaf, intermediate, root] = header.x5c.map(certificateFrom);

    if (!this.roots.some((trusted) => trusted.raw.equals(root.raw))) throw new AppleVerificationError('its chain does not end at a trusted Apple root');
    if (!intermediate.ca || !intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new AppleVerificationError('its intermediate was not issued by the root');
    if (leaf.ca || !leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new AppleVerificationError('its leaf was not issued by the intermediate');
    if (!hasExtension(leaf, LEAF_MARKER_BYTES)) throw new AppleVerificationError('its leaf is not an App Store signing certificate');
    if (!hasExtension(intermediate, INTERMEDIATE_MARKER_BYTES)) throw new AppleVerificationError('its intermediate is not an Apple WWDR intermediate');
    const key = leaf.publicKey;
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new AppleVerificationError('its leaf key is not P-256');

    if (!/^[A-Za-z0-9_-]+$/.test(signatureSegment)) throw new AppleVerificationError('its signature is not base64url');
    const signature = Buffer.from(signatureSegment, 'base64url');
    const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
    if (signature.length !== 64 || !verifySignature('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)) {
      throw new AppleVerificationError('its signature does not verify');
    }

    // Only now is anything in the payload believed.
    const payload = decodeSegment(payloadSegment, 'payload');
    const signedAt = new Date(Number(payload.signedDate));
    if (!Number.isFinite(signedAt.getTime())) throw new AppleVerificationError('it has no signing date');
    if (![leaf, intermediate, root].every((certificate) => validAt(certificate, signedAt))) {
      throw new AppleVerificationError('a certificate in its chain was not valid when it was signed');
    }
    return payload;
  }
}
