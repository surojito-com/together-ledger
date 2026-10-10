#!/usr/bin/env node
// What the website actually sends, captured (TL-C-03, #261).
//
// Runs the shipped web app (the `_site` the Worker serves) and the API against a real
// PostgreSQL database, at their production hostnames, over TLS, and walks #261's flows in a real
// Chromium: first load, register, verify email, sign in, Continue with Google and with Apple,
// create a journey, add a moment, add and open a photo, invite and accept, open billing, start a
// checkout, recovery, and deleting an account. Every request that leaves the browser is recorded:
// host, method, path (ids and query values masked), what is sent, and why. So is everything the
// API itself sends on to Stripe, Apple, Google and the email sender, all of which are stood in
// for here. Nothing leaves this machine: Chromium resolves only our three hostnames, to this
// process, and every other host is answered by a stand-in or refused.
//
//   DATABASE_URL=postgres://…/a-throwaway-database node scripts/capture-outbound.mjs
//
// With --phone it inspects the phone app instead, without a device: every host either platform's
// exported JavaScript bundle names (npx expo export, the same Metro build EAS runs), the native
// libraries each platform links (the autolinking commands the Podfile and Gradle run), the privacy
// manifests and Android manifest entries those libraries bring, and, with --maven, the Android
// manifests of the Maven libraries Google sign-in and Play Billing pull in (needs the network).
// A real capture of the phone's traffic needs a device and a proxy; that is by hand
// (docs/OUTBOUND_CAPTURE.md).
//
//   node scripts/capture-outbound.mjs --phone [--maven]
//
// Options:
//   --out=DIR          where the reports go   (test-results/outbound-capture)
//   --chromium=PATH    a Chromium to use instead of Playwright's own
//
// The database is migrated and written to. Use one made for this, never a real one.
// The method, what is stood in for, and the by-hand phone capture are in docs/OUTBOUND_CAPTURE.md.
// It exits 1 if any check fails: a host nobody declared, cleartext http, a secret in a URL or a
// Referer, a font request, or Stripe's script on a page with no purchase.

import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import Stripe from 'stripe';
import { buildApp } from '../server/app.js';
import { appleSignInFor } from '../server/apple.js';
import { STRIPE_API_VERSION, createBillingService } from '../server/billing.js';
import { loadConfig } from '../server/config.js';
import { createPool, runMigrations } from '../server/db.js';
import { identityVerifierFor } from '../server/identity.js';
import { SmtpMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const options = { out: join(root, 'test-results', 'outbound-capture'), chromium: '', phone: false, maven: false };
for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 35).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  if (argument === '--phone' || argument === '--maven') {
    options[argument.slice(2)] = true;
    continue;
  }
  const match = /^--(out|chromium)=(.+)$/.exec(argument);
  if (!match) {
    console.error(`Unrecognised option: ${argument}`);
    process.exit(64);
  }
  options[match[1]] = resolve(match[2]);
}
if (!options.phone && !process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to a throwaway PostgreSQL database. It is migrated and written to.');
  process.exit(64);
}

// The hosts the web app is served from in production. Chromium is told these, and only these,
// resolve, to this process.
const APP = 'app.together-ledger.com';
const API = 'api.together-ledger.com';
const COMPANY = 'together-ledger.com';
const OUR_HOSTS = new Set([APP, API, COMPANY]);
const APP_ORIGIN = `https://${APP}`;
const API_ORIGIN = `https://${API}`;

// Third-party addresses the page is written to load, each answered here by a stand-in.
const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';
const APPLE_SCRIPT = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const GOOGLE_WEB_CLIENT_ID = 'capture-web-client.apps.googleusercontent.com';
const APPLE_SERVICES_ID = 'com.togetherledger.ledger.web';
const PRICE_ID = 'price_capture_additional_person';

// Hosts a browser could plausibly be pointed at for fonts. None should ever appear.
const FONT_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|use\.fontawesome\.com|fast\.fonts\.net)$/;

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() !== '';
const runTag = randomBytes(3).toString('hex');
const work = mkdtempSync(join(tmpdir(), 'tl-capture-'));

// ---------------------------------------------------------------------------------------------
// Recording

const browserRequests = [];
const serverRequests = [];
const frontLog = [];
const secrets = new Map(); // value -> what it is
const mail = [];
let currentStep = 'setup';
const steps = [];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STRIPE_ID = /\b(cs_test|cs_live|cus|price|sub|bps|pi|in)_[A-Za-z0-9_]+/g;

function keepSecret(value, label) {
  if (typeof value === 'string' && value.length >= 12) secrets.set(value, label);
}

function maskedPath(raw) {
  const url = new URL(raw);
  const path = decodeURIComponent(url.pathname).replace(UUID, ':id').replace(STRIPE_ID, '$1_…');
  const keys = [...new Set(url.searchParams.keys())];
  return path + (keys.length ? `?${keys.map((key) => `${key}=…`).join('&')}` : '') + (url.hash ? '#…' : '');
}

function maskedReferer(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.origin + maskedPath(value);
  } catch {
    return '(unparseable)';
  }
}

function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? `[${shape(value[0], depth + 1)}]` : '[]';
  if (value && typeof value === 'object') {
    if (depth > 1) return '{…}';
    return `{${Object.entries(value).map(([key, inner]) => `${key}${inner && typeof inner === 'object' ? `:${shape(inner, depth + 1)}` : ''}`).join(', ')}}`;
  }
  return '';
}

function describeBody(buffer, contentType = '') {
  if (!buffer || !buffer.length) return '';
  if (/json/.test(contentType)) {
    try {
      return `JSON ${shape(JSON.parse(buffer.toString('utf8')))}`;
    } catch {
      return `${buffer.length} bytes (${contentType})`;
    }
  }
  if (/x-www-form-urlencoded/.test(contentType)) {
    const keys = [...new Set([...new URLSearchParams(buffer.toString('utf8')).keys()].map((key) => key.replace(/\[\d+\]/g, '[]')))];
    return `form {${keys.join(', ')}}`;
  }
  if (/^image\//.test(contentType)) return `${buffer.length} bytes ${contentType}, ${exifTags(buffer)}`;
  return `${buffer.length} bytes${contentType ? ` (${contentType})` : ''}`;
}

// The tags in a photo's first EXIF directory, read independently of src/photo-metadata.js so the
// capture checks the stripper rather than trusting it. GPS (0x8825), Make and Model are what must
// never leave the browser; Orientation is kept on purpose.
const EXIF_TAG_NAMES = { 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'DateTime', 0x8769: 'ExifIFD', 0x8825: 'GPS' };
function exifTags(buffer) {
  const at = buffer.indexOf(Buffer.from('Exif\0\0'));
  if (at < 0) return 'no EXIF';
  const tiff = buffer.subarray(at + 6);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (offset) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  try {
    const ifd = u32(4);
    const tags = Array.from({ length: u16(ifd) }, (_, index) => u16(ifd + 2 + index * 12));
    const names = tags.map((tag) => EXIF_TAG_NAMES[tag] || `0x${tag.toString(16)}`);
    return `EXIF tags: ${names.join(', ') || 'none'}${names.some((name) => ['GPS', 'Make', 'Model'].includes(name)) ? ' (LOCATION OR CAMERA LEFT THE BROWSER)' : ''}`;
  } catch {
    return 'EXIF unreadable';
  }
}

const API_REASONS = [
  [/^GET \/api\/v1\/session$/, 'Is this browser signed in; returns the account and a CSRF value'],
  [/^GET \/api\/v1\/auth\/providers$/, 'Which of Google and Apple this server can sign a browser in with (public client ids only)'],
  [/^POST \/api\/v1\/auth\/register$/, 'Open an account: username, email, password'],
  [/^POST \/api\/v1\/auth\/verify-email$/, 'Verify the email: the emailed one-time token, in the body'],
  [/^POST \/api\/v1\/auth\/login$/, 'Sign in: username or email, and password'],
  [/^POST \/api\/v1\/auth\/logout$/, 'Sign out'],
  [/^POST \/api\/v1\/auth\/google$/, "Continue with Google: Google's ID token"],
  [/^POST \/api\/v1\/auth\/apple$/, "Continue with Apple: Apple's ID token, one-time code, and the name on first sign-in"],
  [/^POST \/api\/v1\/auth\/link$/, 'Link Google or Apple to an existing account, with its password'],
  [/^GET \/api\/v1\/journeys$/, 'List the journeys this account is in'],
  [/^POST \/api\/v1\/journeys$/, 'Create a private journey'],
  [/^GET \/api\/v1\/journeys\/:id\/snapshot$/, 'Load a journey: moments, members, invitations, history'],
  [/^GET \/api\/v1\/journeys\/:id\/events$/, "Load a journey's history"],
  [/^POST \/api\/v1\/journeys\/:id\/moments$/, 'Hold a moment'],
  [/^PATCH \/api\/v1\/journeys\/:id\/moments\/:id$/, 'Change a moment'],
  [/^POST \/api\/v1\/journeys\/:id\/moments\/:id\/images$/, 'Attach a photo (the file name travels in X-Together-Image-Name)'],
  [/^GET \/api\/v1\/journeys\/:id\/moments\/:id\/images\/:id$/, 'Open a photo'],
  [/^GET \/api\/v1\/journeys\/:id\/moments\/:id\/image-slots$/, 'Which photo places a moment has'],
  [/^POST \/api\/v1\/journeys\/:id\/invitations$/, 'Invite or propose someone: their email and an optional note'],
  [/^POST \/api\/v1\/invitations\/accept$/, 'Accept an invitation: the emailed token, in the body'],
  [/^POST \/api\/v1\/invitations\/[^/]+\/accept$/, 'LEGACY accept route, token in the address'],
  [/^GET \/api\/v1\/journeys\/:id\/billing$/, "A journey's paid capacity"],
  [/^POST \/api\/v1\/journeys\/:id\/billing\/checkout-sessions$/, 'Start a Stripe checkout: offer, quantity, request id'],
  [/^POST \/api\/v1\/recovery\/request$/, 'Ask for a recovery email: the email address'],
  [/^POST \/api\/v1\/recovery\/confirm$/, 'Set a new password with the emailed token, in the body'],
  [/^DELETE \/api\/v1\/account$/, 'Delete the account: DELETE, and the password if it has one'],
  [/^PATCH \/api\/v1\/account$/, 'Change the display name'],
];

function reasonFor(host, method, path) {
  if (host === APP) {
    if (path === '/' || path.startsWith('/?')) return 'The app page itself';
    if (/^\/(privacy|terms|support)$/.test(path)) return 'A policy page';
    if (path.startsWith('/src/')) return "The app's own script or stylesheet";
    return 'An app asset';
  }
  if (host === COMPANY) return "The favicon and touch icon, linked from the app page to the company site's address";
  if (host === API) {
    const line = `${method} ${path.replace(/\?.*$/, '')}`;
    const found = API_REASONS.find(([pattern]) => pattern.test(line));
    return found ? found[1] : 'An API call (unlisted)';
  }
  if (`https://${host}${path}` === GOOGLE_SCRIPT) return "Google Identity Services, loaded only when a signed-out person opens Sign in (stand-in served)";
  if (`https://${host}${path}` === APPLE_SCRIPT) return 'Sign in with Apple JS, loaded only when a signed-out person opens Sign in (stand-in served)';
  if (host === 'checkout.stripe.com') return "Stripe's hosted checkout page, navigated to after the API makes a session (stand-in served)";
  if (host === 'billing.stripe.com') return "Stripe's customer portal (stand-in served)";
  return 'UNEXPECTED: no reason known';
}

function standInFor(url) {
  if (url === GOOGLE_SCRIPT) return { contentType: 'text/javascript', body: googleStandIn() };
  if (url === APPLE_SCRIPT) return { contentType: 'text/javascript', body: appleStandIn() };
  const parsed = new URL(url);
  if (parsed.hostname === 'checkout.stripe.com' || parsed.hostname === 'billing.stripe.com') {
    // Stripe's page would take the payment, then send the person back to success_url. The
    // stand-in does the sending back, so the return leg is captured too.
    const back = `${APP_ORIGIN}/?billing=success&session_id=${stripeState.lastSessionId}`;
    return { contentType: 'text/html', body: `<!doctype html><title>Stripe checkout (stand-in)</title><p>Stand-in for Stripe.</p><a id="return" href="${back}">Return</a>` };
  }
  return null;
}

async function recordBrowserRequest(request, person) {
  const url = request.url();
  if (url.startsWith('data:') || url.startsWith('blob:')) return;
  const entry = { step: currentStep, person, url, method: request.method(), type: request.resourceType(), navigation: request.isNavigationRequest() };
  browserRequests.push(entry);
  const headers = await request.allHeaders().catch(() => request.headers());
  const parsed = new URL(url);
  entry.scheme = parsed.protocol.replace(':', '');
  entry.host = parsed.host;
  entry.path = maskedPath(url);
  entry.referer = headers.referer || '';
  entry.origin = headers.origin || '';
  entry.cookieNames = (headers.cookie || '').split(';').map((part) => part.split('=')[0].trim()).filter(Boolean);
  entry.extraHeaders = Object.keys(headers).filter((name) => name.startsWith('x-')).sort();
  entry.sent = describeBody(request.postDataBuffer(), headers['content-type'] || '');
  entry.why = reasonFor(entry.host, entry.method, entry.path);
}

// ---------------------------------------------------------------------------------------------
// Stand-ins for what the server talks to: Google's and Apple's keys and Apple's token endpoint,
// Stripe's API, and the email sender.

const providerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const providerJwk = { ...providerKey.publicKey.export({ format: 'jwk' }), kid: 'capture-key', alg: 'RS256', use: 'sig' };
const appleSigningKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = part({ alg: 'RS256', kid: 'capture-key', typ: 'JWT' });
  const body = part({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(providerKey.privateKey).toString('base64url');
  const token = `${head}.${body}.${signature}`;
  keepSecret(token, `${claims.iss} ID token`);
  return token;
}

const googleSubject = `capture-google-${runTag}`;
const appleSubject = `capture-apple-${runTag}.0001`;
const googleToken = () => idToken({ iss: 'https://accounts.google.com', aud: GOOGLE_WEB_CLIENT_ID, sub: googleSubject, email: `google-${runTag}@example.test`, email_verified: true, name: 'Gita Capture' });
const appleIdToken = () => idToken({ iss: 'https://appleid.apple.com', aud: APPLE_SERVICES_ID, sub: appleSubject, email: `apple-${runTag}@example.test`, email_verified: 'true' });
const appleCode = `capture-apple-code-${randomBytes(12).toString('hex')}`;
keepSecret(appleCode, 'Apple authorization code');

function googleStandIn() {
  const token = googleToken();
  return `window.google = { accounts: { id: {
  initialize(config) { window.__google = config; },
  renderButton(element, options) {
    const button = document.createElement('div');
    button.setAttribute('role', 'button');
    button.id = 'capture-google-button';
    button.textContent = 'Continue with Google';
    button.style.cssText = 'height:40px;width:' + (options.width || 200) + 'px;border:1px solid #747775;display:flex;align-items:center;justify-content:center;cursor:pointer';
    button.addEventListener('click', () => window.__google.callback({ credential: ${JSON.stringify(token)}, select_by: 'btn' }));
    element.replaceChildren(button);
  },
  prompt() {}, disableAutoSelect() {}, cancel() {},
} } };`;
}

function appleStandIn() {
  return `window.AppleID = { auth: {
  init(config) { window.__apple = config; },
  signIn() {
    return Promise.resolve({
      authorization: { id_token: ${JSON.stringify(appleIdToken())}, code: ${JSON.stringify(appleCode)}, state: window.__apple.state },
      user: { email: ${JSON.stringify(`apple-${runTag}@example.test`)}, name: { firstName: 'Avi', lastName: 'Capture' } },
    });
  },
} };`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// The fetch the server's identity and Apple code use. Answers Google's and Apple's addresses; any
// other address the server tries is recorded and refused.
async function providerFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init.body ? Buffer.from(String(init.body)) : null;
  const contentType = init.headers?.['content-type'] || init.headers?.['Content-Type'] || '';
  const entry = { step: currentStep, from: 'API server', host: url.host, method: init.method || 'GET', path: maskedPath(url.href), sent: describeBody(body, contentType) };
  serverRequests.push(entry);
  if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') {
    entry.why = "Google's public keys, to check a Google ID token";
    return jsonResponse({ keys: [providerJwk] });
  }
  if (url.href === 'https://appleid.apple.com/auth/keys') {
    entry.why = "Apple's public keys, to check an Apple ID token";
    return jsonResponse({ keys: [providerJwk] });
  }
  if (url.href === 'https://appleid.apple.com/auth/token') {
    entry.why = "Exchange Apple's one-time code for a refresh token, kept encrypted so it can be revoked on deletion";
    const refresh = `capture-apple-refresh-${randomBytes(12).toString('hex')}`;
    keepSecret(refresh, 'Apple refresh token');
    return jsonResponse({ access_token: 'unused', token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, id_token: appleIdToken() });
  }
  if (url.href === 'https://appleid.apple.com/auth/revoke') {
    entry.why = "Revoke Apple's refresh token, because the account was deleted";
    return new Response('', { status: 200 });
  }
  entry.why = 'UNEXPECTED: refused';
  throw new Error(`capture: the server tried to reach ${url.host}, which has no stand-in`);
}

// A stand-in for Stripe's API. The real Stripe SDK is pointed at it, so what is recorded is what
// the SDK would have sent to api.stripe.com.
const stripeState = { lastSessionId: '' };
const stripeServer = createHttpServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(request.url, 'https://api.stripe.com');
    const form = new URLSearchParams(body.toString('utf8'));
    const entry = { step: currentStep, from: 'API server', host: 'api.stripe.com', method: request.method, path: maskedPath(url.href), sent: describeBody(body, request.headers['content-type'] || '') };
    // Which of our own references Stripe receives, by name. Values are ids, masked.
    const metadata = [...form.keys()].filter((key) => /metadata|client_reference_id|email/.test(key));
    if (metadata.length) entry.sent += `; carries ${metadata.join(', ')}`;
    serverRequests.push(entry);
    const send = (value) => {
      response.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${randomBytes(6).toString('hex')}` });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && url.pathname === `/v1/prices/${PRICE_ID}`) {
      entry.why = 'Check the price is the approved $1 monthly offer';
      return send({ id: PRICE_ID, object: 'price', active: true, type: 'recurring', livemode: false, currency: 'usd', unit_amount: 100, recurring: { interval: 'month', usage_type: 'licensed' } });
    }
    if (request.method === 'POST' && url.pathname === '/v1/customers') {
      entry.why = 'Make a Stripe customer for the payer: their email, our account id';
      return send({ id: `cus_capture${randomBytes(4).toString('hex')}`, object: 'customer' });
    }
    if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      entry.why = 'Make a checkout session: customer, price, quantity, return addresses, our account and journey ids';
      stripeState.lastSessionId = `cs_test_capture${randomBytes(8).toString('hex')}`;
      return send({ id: stripeState.lastSessionId, object: 'checkout.session', status: 'open', url: `https://checkout.stripe.com/c/pay/${stripeState.lastSessionId}#capture` });
    }
    entry.why = 'UNEXPECTED: no stand-in';
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'capture: no stand-in' } }));
  });
});

// The email sender (Resend over SMTP in production): the real mailer composes each message and
// hands it to this transport instead of a socket.
const captureTransport = {
  async sendMail(message) {
    const links = [...String(message.text || '').matchAll(/https?:\/\/[^\s<>"]+/g)].map(([link]) => link);
    for (const link of links) {
      const url = new URL(link);
      for (const [key, value] of url.searchParams) keepSecret(value, `emailed ${key} token`);
    }
    mail.push({ step: currentStep, to: message.to, subject: message.subject, links });
    serverRequests.push({
      step: currentStep,
      from: 'API server',
      host: 'email sender (SMTP)',
      method: 'SMTP',
      path: message.subject,
      sent: `to, from, subject, text and HTML body; links: ${links.map((link) => `${new URL(link).origin}${maskedPath(link)}`).join(', ') || 'none'}`,
      why: 'Account email',
    });
    return { messageId: `<${randomUUID()}@capture>` };
  },
};

function mailFor(address, key) {
  const message = [...mail].reverse().find((item) => item.to === address && item.links.some((link) => new URL(link).searchParams.has(key)));
  if (!message) throw new Error(`No ${key} email reached ${address}`);
  return message.links.find((link) => new URL(link).searchParams.has(key));
}

// ---------------------------------------------------------------------------------------------
// The app, the API and the company site's icons, served at their production hostnames over TLS.

function buildSite() {
  execFileSync(process.execPath, [join(root, 'scripts', 'build-public-site.mjs')], {
    cwd: root,
    env: { ...process.env, TOGETHER_LEDGER_RELEASE_REVISION: revision },
    stdio: 'ignore',
  });
  return join(root, '_site');
}

function certificate() {
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Together Ledger outbound capture',
    '-addext', `subjectAltName=DNS:${APP},DNS:${API},DNS:${COMPANY}`, '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const TYPES = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Cloudflare's static assets, as wrangler.jsonc configures them: auto-trailing-slash HTML
// handling, a single-page-application fallback, and public/_headers.
function serveSite(site, request, response) {
  const pathname = decodeURIComponent(new URL(request.url, APP_ORIGIN).pathname);
  const relative = normalize(pathname).replace(/^[/\\]+/, '');
  let file = join(site, relative);
  if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) {
    file = existsSync(`${file}.html`) ? `${file}.html` : join(site, 'index.html');
  }
  const headers = { 'content-type': `${TYPES[extname(file)] || 'application/octet-stream'}; charset=utf-8` };
  if (pathname === '/release.json') headers['cache-control'] = 'no-store';
  response.writeHead(200, headers);
  response.end(readFileSync(file));
}

// together-ledger.com is the company site, a separate deployment. The app page links its favicon
// and touch icon there; this answers with the same files, so the request can be seen.
function serveCompany(request, response) {
  const pathname = new URL(request.url, `https://${COMPANY}`).pathname;
  const file = join(root, 'public', normalize(pathname).replace(/^[/\\]+/, ''));
  if (file.startsWith(join(root, 'public')) && existsSync(file) && statSync(file).isFile()) {
    response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    return response.end(readFileSync(file));
  }
  response.writeHead(404);
  response.end();
}

// ---------------------------------------------------------------------------------------------
// Flows

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
}

async function step(id, title, run) {
  currentStep = id;
  steps.push({ id, title });
  console.log(`· ${title}`);
  await run();
}

async function newPerson(browser, person) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const pending = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (OUR_HOSTS.has(url.hostname)) return route.continue();
    const standIn = standInFor(request.url());
    if (standIn) return route.fulfill({ status: 200, contentType: standIn.contentType, body: standIn.body });
    return route.abort('blockedbyclient');
  });
  context.on('request', (request) => pending.push(recordBrowserRequest(request, person)));
  context.on('response', async (response) => {
    if (new URL(response.url()).hostname !== API) return;
    const body = await response.json().catch(() => null);
    keepSecret(body?.data?.csrfToken, 'CSRF value');
  });
  context.on('websocket', (socket) => browserRequests.push({ step: currentStep, person, url: socket.url(), method: 'WEBSOCKET', host: new URL(socket.url()).host, scheme: new URL(socket.url()).protocol.replace(':', ''), path: maskedPath(socket.url()), why: 'UNEXPECTED: a WebSocket' }));
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const flush = async () => {
    await Promise.all(pending.splice(0));
    for (const cookie of await context.cookies()) keepSecret(cookie.value, `cookie ${cookie.name}`);
  };
  return { context, page, flush };
}

// The header's Sign in or Account settings, whichever this surface shows.
async function openAccount(page) {
  await page.locator('#account-button:visible, [data-open-account]:visible').first().click();
  await page.locator('#account-dialog').waitFor({ state: 'visible' });
}

const signedIn = (page) => page.waitForFunction(() => document.querySelector('#account-button')?.textContent.trim() === 'Account settings');

async function closeAccount(page) {
  if (await page.locator('#account-dialog').isVisible()) await page.locator('#account-dialog').evaluate((dialog) => dialog.close());
}

async function register(page, { username, email, password }) {
  await openAccount(page);
  const form = page.locator('#register-form');
  if (!await form.isVisible()) await page.getByRole('button', { name: /create an account/i }).first().click().catch(() => {});
  await form.locator('[name="username"]').fill(username);
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(password);
  await form.locator('button[type="submit"], button.primary').first().click();
  await signedIn(page);
  await closeAccount(page);
}

async function signIn(page, { username, password }) {
  await openAccount(page);
  await page.locator('#login-form [name="identifier"]').fill(username);
  await page.locator('#login-form [name="password"]').fill(password);
  await page.locator('#login-form button.primary').click();
  await signedIn(page);
  await closeAccount(page);
}

async function signOut(page) {
  await openAccount(page);
  await page.locator('#logout-button').click();
  await page.locator('#account-dialog').waitFor({ state: 'hidden' });
}

async function deleteAccount(page, password) {
  await openAccount(page);
  const form = page.locator('#delete-account-form');
  await form.scrollIntoViewIfNeeded();
  if (password) await form.locator('[name="password"]').fill(password);
  await form.locator('[name="confirmation"]').fill('DELETE');
  await form.locator('button.danger').click();
  await page.locator('#consequence-dialog-accept').click();
  await page.locator('#account-dialog').waitFor({ state: 'hidden' });
}

async function run() {
  console.log(`Capturing outbound traffic at ${revision.slice(0, 7)}${dirty ? ' (with uncommitted changes)' : ''}…`);
  const site = buildSite();
  const tls = certificate();
  await new Promise((done) => stripeServer.listen(0, '127.0.0.1', done));

  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: APP_ORIGIN,
    API_ORIGIN,
    ACCOUNT_ORIGIN: APP_ORIGIN,
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'false',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_KEY: randomBytes(32).toString('hex'),
    SMTP_URL: 'smtp://capture.invalid:25',
    JOURNEY_CAPACITY_MODE: 'billing',
    BILLING_ENABLED: 'true',
    STRIPE_ENVIRONMENT: 'test',
    STRIPE_SECRET_KEY: 'sk_test_capture',
    STRIPE_WEBHOOK_SECRET: 'whsec_capture',
    STRIPE_ADDITIONAL_PERSON_PRICE_ID: PRICE_ID,
    GOOGLE_WEB_CLIENT_ID,
    APPLE_SIGN_IN_PRIVATE_KEY: appleSigningKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    APPLE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    APPLE_WEB_REDIRECT_URI: `${APP_ORIGIN}/`,
  });
  const pool = createPool(config);
  await runMigrations(pool);
  const mailer = new SmtpMailer({ from: config.MAIL_FROM, accountOrigin: config.ACCOUNT_ORIGIN, transport: captureTransport });
  const platform = new PlatformService({
    pool,
    config,
    mailer,
    identity: identityVerifierFor(config, { fetch: providerFetch }),
    apple: appleSignInFor(config, { fetch: providerFetch }),
  });
  const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    host: '127.0.0.1',
    port: stripeServer.address().port,
    protocol: 'http',
    maxNetworkRetries: 0,
    telemetry: false,
  });
  const billing = createBillingService({ pool, config, stripe });
  const app = await buildApp({ platform, billing, config });
  await app.ready();

  const front = createHttpsServer(tls, (request, response) => {
    const host = (request.headers.host || '').replace(/:\d+$/, '');
    frontLog.push({ step: currentStep, host, method: request.method, path: maskedPath(`https://${host}${request.url}`), referer: maskedReferer(request.headers.referer), rawReferer: request.headers.referer || '', rawUrl: `https://${host}${request.url}` });
    if (host === API) return app.routing(request, response);
    if (host === APP) return serveSite(site, request, response);
    if (host === COMPANY) return serveCompany(request, response);
    response.writeHead(421);
    return response.end();
  });
  await new Promise((done) => front.listen(0, '127.0.0.1', done));
  const port = front.address().port;

  const browser = await chromium.launch({
    ...(options.chromium ? { executablePath: options.chromium } : {}),
    args: [
      '--no-proxy-server',
      `--host-resolver-rules=${[...OUR_HOSTS].map((host) => `MAP ${host} 127.0.0.1:${port}`).join(', ')}, MAP * ~NOTFOUND`,
    ],
  });

  const password = `capture-${randomBytes(9).toString('base64url')}`;
  keepSecret(password, 'password');
  const newPassword = `capture-new-${randomBytes(9).toString('base64url')}`;
  keepSecret(newPassword, 'new password');
  const asha = { username: `asha-${runTag}`, email: `asha-${runTag}@example.test`, password };
  const ben = { username: `ben-${runTag}`, email: `ben-${runTag}@example.test`, password };

  try {
    const a = await newPerson(browser, 'Asha');
    await step('first-load', 'First load of the app, and its policy pages', async () => {
      await a.page.goto(`${APP_ORIGIN}/`);
      await settle(a.page);
      for (const path of ['/privacy', '/terms', '/support']) {
        await a.page.goto(`${APP_ORIGIN}${path}`);
        await settle(a.page);
      }
      await a.page.goto(`${APP_ORIGIN}/`);
      await settle(a.page);
      await a.flush();
    });

    await step('register', 'Open Sign in, and register with a password', async () => {
      await register(a.page, asha);
      await settle(a.page);
      await a.flush();
    });

    await step('verify-email', 'Open the emailed verification link', async () => {
      await a.page.goto(mailFor(asha.email, 'verify'));
      await settle(a.page);
      await a.flush();
    });

    await step('sign-in', 'Sign out, then sign in with the password', async () => {
      await signOut(a.page);
      await settle(a.page);
      await signIn(a.page, asha);
      await settle(a.page);
      await a.flush();
    });

    await step('create-journey', 'Create a private journey', async () => {
      await a.page.locator('#settings-button').click();
      await a.page.locator('#sharing-create-journey-button').click();
      const form = a.page.locator('#journey-form');
      await form.locator('[name="name"]').fill('Capture weekend');
      for (const name of ['memberOne', 'memberTwo']) {
        const field = form.locator(`[name="${name}"]`);
        if (await field.isVisible()) await field.fill(name === 'memberOne' ? 'Asha' : 'Ben');
      }
      await a.page.locator('#save-journey-button').click();
      await a.page.locator('#journey-dialog').waitFor({ state: 'hidden' });
      await a.page.locator('#sync-badge').filter({ hasText: 'Private sync' }).waitFor();
      await settle(a.page);
      await a.flush();
    });

    const openMomentForm = async () => {
      const add = a.page.getByRole('button', { name: /Add your own moment|Hold a moment|Add a moment/ }).first();
      await add.click();
      await a.page.locator('#moment-dialog').waitFor({ state: 'visible' });
    };

    await step('add-moment', 'Hold a moment, with a place typed in words', async () => {
      await openMomentForm();
      const form = a.page.locator('#moment-form');
      await form.locator('[name="kind"]').selectOption('memory');
      await form.locator('[name="title"]').fill('A walk after dinner');
      await form.locator('[name="detail"]').fill('Synthetic words for the capture.');
      await a.page.locator('#manual-location').fill('The river path');
      await a.page.locator('#add-manual-location').click();
      await a.page.locator('#save-moment').click();
      await a.page.locator('#moment-dialog').waitFor({ state: 'hidden' });
      await settle(a.page);
      await a.flush();
    });

    await step('add-photo', 'Hold a moment with a photo that carries GPS EXIF', async () => {
      await openMomentForm();
      const form = a.page.locator('#moment-form');
      await form.locator('[name="kind"]').selectOption('memory');
      await form.locator('[name="title"]').fill('The view from the bridge');
      await form.locator('[name="image"]').setInputFiles(join(root, 'tests', 'fixtures', 'photos', 'sideways-with-gps.jpg'));
      await a.page.waitForTimeout(500);
      await a.page.locator('#save-moment').click();
      await a.page.locator('#moment-dialog').waitFor({ state: 'hidden' });
      await settle(a.page);
      await a.flush();
    });

    await step('open-photo', 'Open the photo', async () => {
      await a.page.reload();
      await settle(a.page);
      const opener = a.page.locator('[data-open-moment-image], .moment-image-attachment button, [data-moment-image-preview]').first();
      await opener.click();
      await a.page.locator('#moment-image-viewer').waitFor({ state: 'visible' });
      await settle(a.page);
      await a.page.locator('#moment-image-viewer').evaluate((dialog) => dialog.close());
      await a.flush();
    });

    await step('invite', 'Invite someone by email', async () => {
      await a.page.locator('#settings-button').click();
      const form = a.page.locator('#invite-form');
      await form.locator('[name="email"]').fill(ben.email);
      await form.locator('[name="note"]').fill('A synthetic note');
      await form.locator('button[type="submit"]').click();
      await settle(a.page);
      await a.page.locator('#settings-dialog').evaluate((dialog) => dialog.close());
      await a.flush();
    });

    const b = await newPerson(browser, 'Ben');
    await step('accept-invite', 'The invited person registers, verifies, and opens the invitation', async () => {
      await b.page.goto(`${APP_ORIGIN}/`);
      await settle(b.page);
      await register(b.page, ben);
      await b.page.goto(mailFor(ben.email, 'verify'));
      await settle(b.page);
      await b.page.goto(mailFor(ben.email, 'invite'));
      await settle(b.page);
      await b.page.locator('#sync-badge').filter({ hasText: 'Private sync' }).waitFor();
      await b.flush();
    });

    await step('open-billing', 'Open the account dialog, where billing lives', async () => {
      await a.page.reload();
      await settle(a.page);
      await openAccount(a.page);
      await settle(a.page);
      await a.flush();
    });

    await step('checkout', 'Start a Stripe checkout, and come back from it', async () => {
      const offer = a.page.locator('[data-billing-offer]').first();
      await offer.scrollIntoViewIfNeeded();
      await offer.click();
      await a.page.waitForURL(/checkout\.stripe\.com/);
      await settle(a.page);
      await a.page.locator('#return').click();
      await a.page.waitForURL(`${APP_ORIGIN}/**`);
      await settle(a.page);
      await a.flush();
    });

    const r = await newPerson(browser, 'Asha, another browser');
    await step('recovery', 'Ask for a recovery email, open it, and set a new password', async () => {
      await r.page.goto(`${APP_ORIGIN}/`);
      await settle(r.page);
      await openAccount(r.page);
      await r.page.locator('#recovery-button').click();
      await r.page.locator('#recovery-request-form [name="email"]').fill(asha.email);
      await r.page.locator('#recovery-request-form button.primary').click();
      await r.page.locator('#recovery-request-dialog').waitFor({ state: 'hidden' });
      await settle(r.page);
      await r.page.goto(mailFor(asha.email, 'recovery'));
      await settle(r.page);
      const form = r.page.locator('#recovery-confirm-form');
      await form.locator('[name="password"]').fill(newPassword);
      await form.locator('[name="confirmPassword"]').fill(newPassword);
      await form.locator('button.primary').click();
      await r.page.locator('#recovery-confirm-dialog').waitFor({ state: 'hidden' });
      await settle(r.page);
      await r.flush();
    });

    await step('delete-account', 'The invited person deletes their account', async () => {
      await deleteAccount(b.page, ben.password);
      await settle(b.page);
      await b.flush();
    });

    const g = await newPerson(browser, 'Gita (Google)');
    await step('continue-with-google', 'Continue with Google, then sign out', async () => {
      await g.page.goto(`${APP_ORIGIN}/`);
      await settle(g.page);
      await openAccount(g.page);
      await g.page.locator('#capture-google-button').click();
      await signedIn(g.page);
      await settle(g.page);
      await signOut(g.page);
      await settle(g.page);
      await g.flush();
    });

    const p = await newPerson(browser, 'Avi (Apple)');
    await step('continue-with-apple', 'Continue with Apple, then delete that account', async () => {
      await p.page.goto(`${APP_ORIGIN}/`);
      await settle(p.page);
      await openAccount(p.page);
      await p.page.locator('#apple-sign-in-button').click();
      await signedIn(p.page);
      await settle(p.page);
      await closeAccount(p.page);
      await deleteAccount(p.page, '');
      await settle(p.page);
      await p.flush();
    });
  } catch (error) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    mkdirSync(options.out, { recursive: true });
    await Promise.all(pages.map((page, index) => page.screenshot({ path: join(options.out, `failure-${index}.png`), fullPage: true }).catch(() => {})));
    throw error;
  } finally {
    await browser.close();
    await new Promise((done) => front.close(done));
    await new Promise((done) => stripeServer.close(done));
    await app.close();
    await pool.end();
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Checks and report

const STEP_TITLE = () => new Map(steps.map(({ id, title }) => [id, title]));

function checks() {
  const results = [];
  const add = (name, failures, passText) => results.push({ name, ok: failures.length === 0, detail: failures.length ? failures : [passText] });

  const known = (entry) => !entry.why || !entry.why.startsWith('UNEXPECTED');
  add('Every host the browser reached is ours or a known provider stand-in', browserRequests.filter((entry) => !known(entry)).map((entry) => `${entry.step}: ${entry.method} ${entry.host}${entry.path}`), 'No other host was asked for.');
  add('Every host the server reached is a known processor', serverRequests.filter((entry) => !known(entry)).map((entry) => `${entry.step}: ${entry.method} ${entry.host}${entry.path}`), 'Stripe, Apple, Google and the email sender only.');
  add('No cleartext http', browserRequests.filter((entry) => entry.scheme !== 'https' && entry.scheme !== 'wss').map((entry) => `${entry.step}: ${entry.scheme}://${entry.host}${entry.path}`), 'Every request the browser made was https.');
  add('No font requests', browserRequests.filter((entry) => entry.type === 'font' || FONT_HOSTS.test(entry.host)).map((entry) => `${entry.step}: ${entry.host}${entry.path}`), 'No font file, and no font host, was requested.');
  const stripeScripts = browserRequests.filter((entry) => /(^|\.)stripe\.(com|network)$/.test(entry.host) && entry.host !== 'checkout.stripe.com');
  add("Stripe's script never loads on our pages", stripeScripts.map((entry) => `${entry.step}: ${entry.host}${entry.path}`), 'No js.stripe.com or other Stripe asset was requested by our pages; only the checkout navigation reached Stripe.');

  // A secret may travel in a request body, or a cookie, to our API. It must never be in an address
  // (except the emailed link's own page load, reported below), nor in any Referer.
  const leaks = [];
  const emailedLoads = [];
  for (const entry of frontLog) {
    for (const [value, label] of secrets) {
      if (entry.rawUrl.includes(value) || entry.rawUrl.includes(encodeURIComponent(value))) {
        if (entry.host === APP && entry.path.startsWith('/?') && /emailed/.test(label)) emailedLoads.push(`${entry.step}: GET ${entry.host}${entry.path} (${label})`);
        else leaks.push(`${entry.step}: ${label} in the address ${entry.method} ${entry.host}${entry.path}`);
      }
      if (!entry.rawReferer.includes(value)) continue;
      // The emailed page's own files, fetched from the same host that was just sent the link.
      if (entry.host === APP && /emailed/.test(label) && new URL(entry.rawReferer).host === APP) emailedLoads.push(`${entry.step}: Referer of GET ${entry.host}${entry.path} (${label})`);
      else leaks.push(`${entry.step}: ${label} in the Referer of ${entry.method} ${entry.host}${entry.path}`);
    }
  }
  for (const entry of browserRequests.filter((item) => !OUR_HOSTS.has(item.host?.replace(/:\d+$/, '')))) {
    for (const [value, label] of secrets) {
      if (entry.url.includes(value)) leaks.push(`${entry.step}: ${label} in the address of ${entry.host}${entry.path}`);
    }
  }
  for (const entry of browserRequests.filter((item) => item.referer && item.host !== APP)) {
    for (const [value, label] of secrets) if (entry.referer.includes(value)) leaks.push(`${entry.step}: ${label} in the Referer of ${entry.method} ${entry.host}${entry.path}`);
  }
  add('No request used the old accept route, which carries the invitation token in its address', browserRequests.filter((entry) => entry.why?.startsWith('LEGACY')).map((entry) => `${entry.step}: ${entry.method} ${entry.host}${entry.path}`), 'Invitations were accepted at /api/v1/invitations/accept, with the token in the body (#208).');
  add('No token, code or session value in any address or Referer, beyond the emailed link itself', [...new Set(leaks)], `Checked ${secrets.size} secrets (cookies, CSRF values, emailed tokens, ID tokens, Apple's code, passwords) against every address and Referer, on every host.`);
  results.push({
    name: "Where an emailed link's token travels (by design; reported, not passed)",
    ok: true,
    note: true,
    detail: emailedLoads.length
      ? ['Opening an emailed link sends its token to app.together-ledger.com in the address, and again in the Referer of the page\'s own three files, to the same host, before the page removes it. No other host receives it.', ...emailedLoads]
      : ['None seen.'],
  });
  const photos = browserRequests.filter((entry) => /^image\//.test(entry.sent || '') || /bytes image\//.test(entry.sent || ''));
  add('No location or camera details in an uploaded photo', photos.filter((entry) => /LEFT THE BROWSER|EXIF unreadable/.test(entry.sent)).map((entry) => `${entry.step}: ${entry.sent}`), photos.length ? `Uploaded: ${photos.map((entry) => entry.sent).join('; ')} (the file sent carried Make, Model, Orientation, Software, ExifIFD and GPS)` : 'No photo was uploaded.');

  const stripeNavigation = browserRequests.filter((entry) => entry.host === 'checkout.stripe.com' && entry.navigation);
  results.push({
    name: 'Referer sent to Stripe on checkout',
    ok: stripeNavigation.length > 0 && stripeNavigation.every((entry) => !entry.referer || /^https:\/\/app\.together-ledger\.com\/(#…)?$/.test(entry.referer)),
    detail: stripeNavigation.length ? stripeNavigation.map((entry) => `${entry.path}: Referer ${entry.referer ? `"${entry.referer}"` : 'none'}`) : ['No checkout navigation was seen.'],
  });
  return results;
}

function hostTable(entries, whoFor) {
  const byHost = new Map();
  for (const entry of entries) {
    const host = entry.host;
    if (!byHost.has(host)) byHost.set(host, { count: 0, steps: new Set(), why: new Set() });
    const row = byHost.get(host);
    row.count += 1;
    row.steps.add(entry.step);
    row.why.add(entry.why);
  }
  const lines = ['| Host | Who | Requests | Steps | Why |', '|---|---|---|---|---|'];
  for (const [host, row] of byHost) lines.push(`| \`${host}\` | ${whoFor(host)} | ${row.count} | ${[...row.steps].join(', ')} | ${[...row.why].slice(0, 4).join('; ')}${row.why.size > 4 ? '; …' : ''} |`);
  return lines.join('\n');
}

function who(host) {
  if (host === APP) return 'Us: the web app (Cloudflare)';
  if (host === API) return 'Us: the API (AWS)';
  if (host === COMPANY) return 'Us: the company site (Cloudflare)';
  if (/google/.test(host)) return 'Google';
  if (/apple/.test(host)) return 'Apple';
  if (/stripe/.test(host)) return 'Stripe';
  if (/email/.test(host)) return 'Email sender (Resend)';
  return '**Unknown**';
}

function report(results) {
  const titles = STEP_TITLE();
  const lines = [];
  lines.push('# Outbound capture: the website');
  lines.push('');
  lines.push(`- Commit: \`${revision}\`${dirty ? ' (with uncommitted changes)' : ''}`);
  lines.push(`- Captured: ${new Date().toISOString()}`);
  lines.push(`- Browser: Chromium ${browserVersion}, headless`);
  lines.push('- Method: `scripts/capture-outbound.mjs`, described in `docs/OUTBOUND_CAPTURE.md`');
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  for (const result of results) {
    lines.push(`- **${result.note ? 'NOTE' : result.ok ? 'PASS' : 'FAIL'}** ${result.name}`);
    for (const detail of result.detail) lines.push(`  - ${detail}`);
  }
  lines.push('');
  lines.push('## Hosts the browser reached');
  lines.push('');
  lines.push(hostTable(browserRequests, who));
  lines.push('');
  lines.push('## Hosts the API reached on the browser\'s behalf (stand-ins)');
  lines.push('');
  lines.push(hostTable(serverRequests, who));
  lines.push('');
  lines.push('## Every request, by step');
  lines.push('');
  lines.push('Ids are `:id`; query values and fragments are `…`. "Sent" is the body\'s shape, never its values.');
  for (const { id } of steps) {
    lines.push('');
    lines.push(`### ${titles.get(id)} (\`${id}\`)`);
    lines.push('');
    lines.push('| From | Method | Host | Path | Sent | Referer | Why |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const entry of browserRequests.filter((item) => item.step === id)) {
      const sent = [entry.sent, entry.cookieNames?.length ? `cookie ${entry.cookieNames.join(', ')}` : '', entry.extraHeaders?.length ? `headers ${entry.extraHeaders.join(', ')}` : ''].filter(Boolean).join('; ');
      lines.push(`| ${entry.person} | ${entry.method} | \`${entry.host}\` | \`${entry.path}\` | ${sent || '—'} | ${entry.referer ? `\`${maskedReferer(entry.referer)}\`` : '—'} | ${entry.why} |`);
    }
    for (const entry of serverRequests.filter((item) => item.step === id)) {
      lines.push(`| API server | ${entry.method} | \`${entry.host}\` | \`${entry.path}\` | ${entry.sent || '—'} | — | ${entry.why} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The phone, by inspection

const mobile = join(root, 'apps', 'mobile');

// Every host either bundle names, and what the app can do with it. 'calls' is a request the app
// makes; 'opens' is a page the system shows; everything else is never requested by a release
// build, and says why. A host not listed here fails the inspection until someone reads it.
const PHONE_HOSTS = {
  'api.together-ledger.com': ['calls', 'Our API: every request the app makes (src/api/client.ts), over https'],
  'accounts.google.com': ['opens', "iPhone: Google's sign-in page, in the system's sign-in sheet (src/auth/google-sheet.ts). Android: the same constant is in the shared module (src/auth/social-sign-in.ts) but unused; Google's native SDK signs in there"],
  'oauth2.googleapis.com': ['calls', "iPhone: exchanges Google's one-time code for the ID token (src/auth/google-sheet.ts). Android: unused constant, as above"],
  'kit.openiap.dev': ['never', "expo-iap's optional IAPKit service; reached only through kitApi() or verifyPurchaseWithProvider(), which the app never calls (checked below)"],
  'clients3.google.com': ['never', "NetInfo's internet-reachability probe, switched off (src/shell/use-connection.ts, checked below)"],
  'auth.expo.io': ['never', "expo-auth-session's proxy; the app returns through its own reversed-client-id scheme (googleRedirectUri)"],
  'apps.apple.com': ['never', "expo-iap's deepLinkToSubscriptions(), which the app never calls"],
  'play.google.com': ['never', "expo-iap's deepLinkToSubscriptions(), which the app never calls"],
  'classic-assets.eascdn.net': ['never', 'expo-asset, only inside Expo Go'],
  'localhost:8081': ['never', 'The Metro dev server, development builds only'],
  'localhost:3000': ['never', 'expo-router web/server hint, in an error message'],
  'expo.dev': ['never', 'expo-router hint, in an error message'],
  hostname: ['never', 'A base for parsing a path (new URL), never requested'],
  e: ['never', 'A base for parsing a path (new URL), never requested'],
  'phony.example': ['never', 'A base for parsing a path (new URL), never requested'],
};
const DOC_HOSTS = new Set(['github.com', 'reactnavigation.org', 'docs.expo.dev', 'react.dev', 'openid.net', 'openiap.dev', 'docs.swmansion.com', 'developer.apple.com', 'developer.android.com', 'reactnative.dev', 'fb.me', 'expo.fyi']);

function runIn(cwd, command, args, env = {}) {
  return execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function walkFiles(directory, name, found = []) {
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (['node_modules', 'build', 'androidTest', 'test', 'debug', 'example', 'Example'].includes(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(path, name, found);
    else if (entry.name === name) found.push(path);
  }
  return found;
}

const relativeToRoot = (path) => path.replace(`${root}/`, '');

async function inspectPhone() {
  const results = [];
  const add = (name, failures, passText) => results.push({ name, ok: failures.length === 0, detail: failures.length ? failures : [passText].flat() });
  const sections = [];

  // 1. Hosts in the JavaScript each platform ships.
  const exportEnv = {
    CI: '1',
    EXPO_OFFLINE: '1',
    EXPO_NO_TELEMETRY: '1',
    EXPO_PUBLIC_API_ORIGIN: 'https://api.together-ledger.com',
    // Placeholders, so the bundles are the ones a build with Google configured ships.
    EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'capture-ios.apps.googleusercontent.com',
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'capture-web.apps.googleusercontent.com',
  };
  const hosts = new Map();
  const bundles = {};
  for (const platform of ['ios', 'android']) {
    const out = join(work, `export-${platform}`);
    console.log(`· Exporting the ${platform} bundle`);
    runIn(mobile, 'npx', ['expo', 'export', '--platform', platform, '--no-bytecode', '--output-dir', out], exportEnv);
    const files = [];
    const collect = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (entry.name.endsWith('.js')) files.push(path);
      }
    };
    collect(join(out, '_expo'));
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    bundles[platform] = text;
    for (const [, scheme, host] of text.matchAll(/\b(https?|wss?):\/\/([A-Za-z0-9.-]+(?::\d+)?)/g)) {
      const key = host.replace(/\.$/, '');
      if (!hosts.has(key)) hosts.set(key, { schemes: new Set(), platforms: new Set() });
      hosts.get(key).schemes.add(scheme);
      hosts.get(key).platforms.add(platform);
    }
  }
  const unknownHosts = [...hosts.keys()].filter((host) => !PHONE_HOSTS[host] && !DOC_HOSTS.has(host));
  add('Every host in either bundle is accounted for', unknownHosts.map((host) => `${host} (${[...hosts.get(host).platforms].join(', ')}): not read yet`), `${hosts.size} hosts named across both bundles; each is listed below.`);
  const cleartext = [...hosts].filter(([host, row]) => row.schemes.has('http') && PHONE_HOSTS[host]?.[0] !== 'never' && !DOC_HOSTS.has(host)).map(([host]) => host);
  add('No http:// address the app can reach', cleartext, 'Every http:// address in the bundles is a development server, a parsing base or an error message.');
  const source = readdirSync(join(mobile, 'src'), { recursive: true }).concat(readdirSync(join(mobile, 'app'), { recursive: true }).map((file) => `../app/${file}`))
    .filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => readFileSync(join(mobile, 'src', file), 'utf8')).join('\n');
  add("The app never calls expo-iap's IAPKit, verification or subscription-link functions", ['kitApi', 'verifyPurchaseWithProvider', 'verifyPurchase(', 'deepLinkToSubscriptions'].filter((name) => source.includes(name)).map((name) => `${name} is called`), 'kitApi, verifyPurchaseWithProvider, verifyPurchase and deepLinkToSubscriptions appear nowhere in apps/mobile/src or apps/mobile/app.');
  add("NetInfo's reachability probe stays off", source.includes('reachabilityShouldRun: () => false') ? [] : ['src/shell/use-connection.ts no longer turns reachabilityShouldRun off'], 'NetInfo.configure({ reachabilityShouldRun: () => false }) in src/shell/use-connection.ts.');
  add('Sign-in code per platform: Google\'s browser flow only on the iPhone, Google\'s SDK only on Android', [
    bundles.ios.includes('RNGoogleSignin') ? 'the iOS bundle carries @react-native-google-signin' : '',
    bundles.android.includes('expo-auth-session') ? 'the Android bundle carries expo-auth-session' : '',
  ].filter(Boolean), 'iOS bundle: expo-auth-session, no RNGoogleSignin. Android bundle: RNGoogleSignin, no expo-auth-session.');
  sections.push(['Hosts named in the phone\'s JavaScript', ['| Host | In | Scheme | Can the app reach it? | Why it is there |', '|---|---|---|---|---|',
    ...[...hosts].sort(([a], [b]) => a.localeCompare(b)).map(([host, row]) => `| \`${host}\` | ${[...row.platforms].join(', ')} | ${[...row.schemes].join(', ')} | ${PHONE_HOSTS[host]?.[0] || (DOC_HOSTS.has(host) ? 'never' : '**unread**')} | ${PHONE_HOSTS[host]?.[1] || (DOC_HOSTS.has(host) ? 'A link in documentation or an error message' : '')} |`)].join('\n')]);

  // 2. Native libraries, linked the way the Podfile and Gradle link them.
  const autolinking = (command, platform) => JSON.parse(runIn(mobile, 'npx', ['expo-modules-autolinking', command, '--platform', platform, '--json']));
  const linked = { ios: new Map(), android: new Map() };
  for (const module of autolinking('resolve', 'apple').modules) linked.ios.set(module.packageName, module.pods.map((pod) => pod.podspecDir));
  for (const module of autolinking('resolve', 'android').modules) linked.android.set(module.packageName, module.projects.map((project) => project.sourceDir));
  for (const [platform, cli] of [['ios', 'ios'], ['android', 'android']]) {
    for (const [name, dependency] of Object.entries(autolinking('react-native-config', cli).dependencies)) {
      const config = dependency.platforms?.[cli];
      if (config) linked[platform].set(name, [platform === 'ios' ? dependency.root : config.sourceDir]);
    }
  }
  add('The iPhone links no Google SDK', [...linked.ios.keys()].filter((name) => /google/i.test(name)).map((name) => `${name} is linked on iOS`), "No Google package is linked on iOS; @react-native-google-signin/google-signin is excluded (apps/mobile/package.json, expo.autolinking.ios.exclude), so neither Google's GoogleSignIn pod nor its privacy manifest ships.");
  sections.push(['Native libraries linked', [...['ios', 'android'].map((platform) => `- **${platform}** (${linked[platform].size}): ${[...linked[platform].keys()].sort().join(', ')}`)].join('\n')]);

  // 3. Privacy manifests from linked pods.
  const manifestRows = [];
  const trackingFailures = [];
  for (const [name, directories] of linked.ios) {
    for (const file of directories.flatMap((directory) => walkFiles(directory, 'PrivacyInfo.xcprivacy'))) {
      const xml = readFileSync(file, 'utf8');
      const apis = [...xml.matchAll(/<string>(NSPrivacyAccessedAPICategory\w+)<\/string>/g)].map((match) => match[1].replace('NSPrivacyAccessedAPICategory', ''));
      const collected = [...xml.matchAll(/<string>(NSPrivacyCollectedDataType(?!Purpose)\w+)<\/string>/g)].map((match) => match[1]);
      const tracking = /<key>NSPrivacyTracking<\/key>\s*<true\/>/.test(xml) || /<key>NSPrivacyTrackingDomains<\/key>\s*<array>\s*<string>/.test(xml);
      if (tracking || collected.length) trackingFailures.push(`${name}: ${tracking ? 'declares tracking' : ''} ${collected.join(', ')}`.trim());
      manifestRows.push(`| ${name} | \`${relativeToRoot(file)}\` | ${apis.join(', ') || '—'} | ${collected.join(', ') || 'none'} | ${tracking ? '**yes**' : 'no'} |`);
    }
  }
  const reactNative = dirname(require_resolve('react-native/package.json'));
  for (const file of walkFiles(reactNative, 'PrivacyInfo.xcprivacy')) {
    const xml = readFileSync(file, 'utf8');
    const apis = [...xml.matchAll(/<string>(NSPrivacyAccessedAPICategory\w+)<\/string>/g)].map((match) => match[1].replace('NSPrivacyAccessedAPICategory', ''));
    manifestRows.push(`| react-native | \`${relativeToRoot(file)}\` | ${apis.join(', ') || '—'} | none | no |`);
  }
  add('No linked library declares collected data or tracking in its privacy manifest', trackingFailures, `${manifestRows.length} library privacy manifests read; each declares required-reason APIs only.`);
  sections.push(['Privacy manifests that ship in the iPhone app (besides the app\'s own, `expo.ios.privacyManifests`)', ['| Library | File | Required-reason APIs | Collected data | Tracking |', '|---|---|---|---|---|', ...manifestRows].join('\n')]);

  // 4. Android manifest entries from linked libraries.
  const appJson = JSON.parse(readFileSync(join(mobile, 'app.json'), 'utf8')).expo.android;
  const granted = new Set(appJson.permissions || []);
  const blocked = new Set(appJson.blockedPermissions || []);
  const androidRows = [];
  const surprises = [];
  const permissionRow = (source, file, xml) => {
    const permissions = [...xml.matchAll(/<uses-permission(?:-sdk-23)?[^>]*android:name="([^"]+)"/g)].map((match) => match[1]);
    const components = [...xml.matchAll(/<(activity|service|receiver|provider)\b[^>]*?android:name="([^"]+)"/g)].map((match) => `${match[1]} ${match[2]}`);
    if (!permissions.length && !components.length) return;
    for (const permission of permissions) if (!granted.has(permission) && !blocked.has(permission)) surprises.push(`${source}: ${permission}`);
    androidRows.push(`| ${source} | ${file} | ${permissions.map((permission) => `${permission}${blocked.has(permission) ? ' (blocked)' : granted.has(permission) ? '' : ' **(not declared)**'}`).join(', ') || '—'} | ${components.join(', ') || '—'} |`);
  };
  for (const [name, directories] of linked.android) {
    for (const file of directories.flatMap((directory) => walkFiles(directory, 'AndroidManifest.xml')).filter((path) => !/\/src\/(amazon|horizon)\//.test(path))) {
      permissionRow(name, `\`${relativeToRoot(file)}\``, readFileSync(file, 'utf8'));
    }
  }
  if (options.maven) {
    for (const [coordinate, label] of [[`com.google.android.gms:play-services-auth:${googleSignInPlayServicesVersion()}`, 'Google sign-in'], [`com.android.billingclient:billing:${playBillingVersion()}`, 'Play Billing']]) {
      console.log(`· Reading ${coordinate} and what it depends on, from Maven`);
      for (const row of await mavenManifests(coordinate)) permissionRow(`${row.coordinate} (${label})`, 'Maven AAR', row.manifest);
    }
  }
  add('Android: every permission a linked library asks for is granted or blocked in app.json', surprises, `Granted: ${[...granted].join(', ')}. Everything else the libraries ask for is blocked (${[...blocked].join(', ')}).${options.maven ? ' Includes the Maven libraries behind Google sign-in and Play Billing.' : ' Run with --maven to include the Maven libraries behind Google sign-in and Play Billing.'}`);
  sections.push(['Android manifest entries the libraries bring', ['| Library | From | Permissions | Components |', '|---|---|---|---|', ...androidRows].join('\n')]);

  const lines = ['# Outbound inspection: the phone', '', `- Commit: \`${revision}\`${dirty ? ' (with uncommitted changes)' : ''}`, `- Inspected: ${new Date().toISOString()}`, '- Method: `node scripts/capture-outbound.mjs --phone' + (options.maven ? ' --maven' : '') + '`, described in `docs/OUTBOUND_CAPTURE.md`', '- This is not a capture. What the phone sends on a real device is captured by hand (docs/OUTBOUND_CAPTURE.md).', '', '## Checks', ''];
  for (const result of results) {
    lines.push(`- **${result.ok ? 'PASS' : 'FAIL'}** ${result.name}`);
    for (const detail of result.detail) lines.push(`  - ${detail}`);
  }
  for (const [title, body] of sections) lines.push('', `## ${title}`, '', body);
  lines.push('');
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'phone.md'), lines.join('\n'));
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.detail.join('\n      ')}`}`);
  console.log(`Wrote ${join(options.out, 'phone.md')}.`);
  return results;
}

function require_resolve(specifier) {
  return createRequire(join(mobile, 'package.json')).resolve(specifier);
}

function googleSignInPlayServicesVersion() {
  const gradle = readFileSync(join(dirname(require_resolve('@react-native-google-signin/google-signin/package.json')), 'android', 'build.gradle'), 'utf8');
  return /googlePlayServicesAuthVersion', '([\d.]+)'/.exec(gradle)?.[1] || '21.4.0';
}

function playBillingVersion() {
  // expo-iap's Android library is OpenIAP; its published POM names the Play Billing it uses.
  return mavenBillingVersion || '9.1.0';
}
let mavenBillingVersion = '';

const MAVEN = ['https://dl.google.com/dl/android/maven2', 'https://repo1.maven.org/maven2'];
async function mavenFile(path) {
  for (const repository of MAVEN) {
    const response = await fetch(`${repository}/${path}`);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  }
  return null;
}

// Walks a Maven artifact's compile and runtime dependencies and reads each Android library's
// manifest, the way Gradle's manifest merger would meet them.
async function mavenManifests(rootCoordinate) {
  const seen = new Set();
  const rows = [];
  const visit = async (group, artifact, version) => {
    if (seen.has(`${group}:${artifact}`)) return;
    seen.add(`${group}:${artifact}`);
    const base = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}`;
    const pom = (await mavenFile(`${base}.pom`))?.toString('utf8');
    if (!pom) return;
    const aar = await mavenFile(`${base}.aar`);
    if (aar) {
      const file = join(work, `${artifact}-${version}.aar`);
      writeFileSync(file, aar);
      let manifest = '';
      try {
        manifest = execFileSync('unzip', ['-p', file, 'AndroidManifest.xml'], { encoding: 'utf8' });
      } catch {}
      rows.push({ coordinate: `${group}:${artifact}:${version}`, manifest });
    }
    const dependencies = pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, '');
    for (const [, block] of dependencies.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const field = (name) => new RegExp(`<${name}>\\[?([^<\\],]+)`).exec(block)?.[1];
      if (/<optional>true/.test(block) || ['test', 'provided'].includes(field('scope'))) continue;
      if (field('groupId') && field('artifactId') && field('version') && !field('version').includes('$')) await visit(field('groupId'), field('artifactId'), field('version'));
    }
  };
  const [group, artifact, version] = rootCoordinate.split(':');
  await visit(group, artifact, version);
  return rows;
}

let browserVersion = '';
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  browserVersion = browser.version();
  return browser;
};

if (options.phone) {
  try {
    const openiap = JSON.parse(readFileSync(join(dirname(require_resolve('expo-iap/package.json')), 'openiap-versions.json'), 'utf8'));
    if (options.maven) {
      const pom = (await mavenFile(`io/github/hyochan/openiap/openiap-google/${openiap.google}/openiap-google-${openiap.google}.pom`))?.toString('utf8') || '';
      mavenBillingVersion = /<artifactId>billing<\/artifactId>\s*<version>([^<]+)/.exec(pom)?.[1] || '';
    }
    const results = await inspectPhone();
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } catch (error) {
    console.error(`The phone inspection did not finish: ${error.message}`);
    process.exitCode = 2;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  await captureWeb();
}

async function captureWeb() {
  try {
    await run();
  } catch (error) {
    console.error(`The capture did not finish at "${currentStep}": ${error.message}`);
    process.exitCode = 2;
  }
  const results = checks();
  mkdirSync(options.out, { recursive: true });
  const forJson = (entries) => entries.map(({ url, rawUrl, rawReferer, ...entry }) => ({ ...entry, referer: entry.referer ? maskedReferer(entry.referer) : undefined }));
  writeFileSync(join(options.out, 'capture.json'), `${JSON.stringify({ revision, dirty, capturedAt: new Date().toISOString(), browser: browserVersion, steps, checks: results, browser_requests: forJson(browserRequests), server_requests: serverRequests, front_log: forJson(frontLog) }, null, 2)}\n`);
  writeFileSync(join(options.out, 'capture.md'), report(results));
  for (const result of results) console.log(`${result.note ? 'NOTE' : result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.detail.join('\n      ')}`}`);
  console.log(`Wrote ${join(options.out, 'capture.md')} and capture.json.`);
  if (!process.exitCode && results.some((result) => !result.ok)) process.exitCode = 1;
}
