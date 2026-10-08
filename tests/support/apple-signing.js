import { generateKeyPairSync, sign } from 'node:crypto';
import { oidBytes } from '../../server/store-apple.js';

// A stand-in for Apple's signing chain, made fresh for each test run, so the StoreKit 2 checks in
// server/store-apple.js can be exercised end to end without Apple and without a private key ever
// being committed. It builds three X.509 certificates the way Apple's are shaped (a self-signed
// root CA, an intermediate CA carrying Apple's WWDR marker, a leaf carrying Apple's App Store
// signing marker) and signs transactions with the leaf's P-256 key exactly as StoreKit's JWS is
// signed. Node can read certificates but not write them, hence the few lines of DER below.

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...contents) => {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...contents) => tlv(0x30, ...contents);
const set = (...contents) => tlv(0x31, ...contents);
const integer = (bytes) => tlv(0x02, Buffer.from(bytes));
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (...contents) => tlv(0x04, ...contents);
const bits = (buffer) => tlv(0x03, Buffer.from([0]), buffer);
const explicit = (number, ...contents) => tlv(0xa0 + number, ...contents);
const text = (value) => tlv(0x0c, Buffer.from(value, 'utf8'));
const time = (date) => tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const name = (commonName) => sequence(set(sequence(oidBytes('2.5.4.3'), text(commonName))));
const ECDSA_SHA256 = sequence(oidBytes('1.2.840.10045.4.3.2'));

export const APPLE_LEAF_MARKER = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_MARKER = '1.2.840.113635.100.6.2.1';

let serial = 1;

function certificate({ subject, issuer, publicKey, signingKey, ca, marker, notBefore, notAfter }) {
  const extensions = [];
  if (ca) extensions.push(sequence(oidBytes('2.5.29.19'), boolean(true), octets(sequence(boolean(true)))));
  if (marker) extensions.push(sequence(oidBytes(marker), octets(Buffer.from([0x05, 0x00]))));
  serial += 1;
  const tbs = sequence(
    explicit(0, integer([2])),
    integer([0x01, serial & 0xff, (serial >> 8) & 0xff]),
    ECDSA_SHA256,
    name(issuer),
    sequence(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    ...(extensions.length ? [explicit(3, sequence(...extensions))] : []),
  );
  return sequence(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, signingKey)));
}

const keys = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

// A chain shaped like Apple's. Options make each kind of wrong one: a leaf or intermediate
// without Apple's marker, a leaf key on another curve, certificates that had expired.
export function appleChain({ rootName = 'Test Root CA - G3', leafMarker = APPLE_LEAF_MARKER, intermediateMarker = APPLE_INTERMEDIATE_MARKER,
  notBefore = new Date('2025-01-01T00:00:00Z'), notAfter = new Date('2035-01-01T00:00:00Z') } = {}) {
  const root = keys();
  const intermediate = keys();
  const leaf = keys();
  const rootDer = certificate({ subject: rootName, issuer: rootName, publicKey: root.publicKey, signingKey: root.privateKey, ca: true, notBefore, notAfter });
  const intermediateDer = certificate({ subject: 'Test WWDR CA - G6', issuer: rootName, publicKey: intermediate.publicKey, signingKey: root.privateKey, ca: true, marker: intermediateMarker, notBefore, notAfter });
  const leafDer = certificate({ subject: 'Test StoreKit Signing', issuer: 'Test WWDR CA - G6', publicKey: leaf.publicKey, signingKey: intermediate.privateKey, ca: false, marker: leafMarker, notBefore, notAfter });
  return {
    rootBase64: rootDer.toString('base64'),
    x5c: [leafDer, intermediateDer, rootDer].map((der) => der.toString('base64')),
    leafKey: leaf.privateKey,
  };
}

const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

// A StoreKit 2 signed transaction: ES256 over header.payload, with the chain in x5c.
export function signTransaction(chain, payload, { header = {} } = {}) {
  const head = segment({ alg: 'ES256', x5c: chain.x5c, ...header });
  const body = segment(payload);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key: chain.leafKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
}

// A payload the way StoreKit 2 fills one in (JWSTransactionDecodedPayload). Times are in ms.
export function transactionPayload(overrides = {}) {
  const purchaseDate = overrides.purchaseDate ?? Date.parse('2026-10-08T12:00:00Z');
  return {
    transactionId: '2000000900000001',
    originalTransactionId: '2000000900000001',
    bundleId: 'com.togetherledger.ledger',
    productId: 'room_51_week_pass',
    type: 'Non-Renewing Subscription',
    purchaseDate,
    originalPurchaseDate: purchaseDate,
    quantity: 1,
    inAppOwnershipType: 'PURCHASED',
    signedDate: purchaseDate + 1000,
    environment: 'Sandbox',
    transactionReason: 'PURCHASE',
    storefront: 'USA',
    storefrontId: '143441',
    price: 5000,
    currency: 'USD',
    ...overrides,
  };
}
