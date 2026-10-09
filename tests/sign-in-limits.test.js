// The sign-in and recovery limits, proved by tripping them (#259). Nothing here reads a limit
// back from the configuration: each test sends requests until the limiter refuses one, and says
// at what count it did.
//
// What these show about @fastify/rate-limit 11.2.0 as server/app.js uses it:
// - Each route with its own limit has its own count. Hitting one never spends another.
// - The count is kept per client address (request.ip) for a fixed window that starts at that
//   address's first request on the route and resets whole when it ends. It is not sliding.
// - It is a count, not a lockout: nothing is kept against an account, and another address is
//   never refused because of what this one did.
//
// The last test runs the Caddyfile that ships, in front of the app, when CADDY_BIN points to a
// caddy binary (the production image is caddy:2.10). Without one it is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const origin = 'http://127.0.0.1:4174';
const PASSWORD = 'correct horse battery staple';
const RATE_LIMITED = { error: { code: 'rate_limit_exceeded', message: 'Too many requests. Wait and try again.' } };
const NOW = new Date('2026-10-09T12:00:00.000Z');

const MIGRATIONS = [
  '001_platform.sql', '003_private_usernames.sql', '004_shared_moments.sql', '005_make-shared-journeys-more-humane.sql',
  '006_expand-shared-moment-vocabulary.sql', '007_person_specific_moment_visibility.sql', '008_stripe_web_billing.sql',
  '009_reserve-group-places.sql', '011_hold-one-image-with-each-moment.sql', '012_bill-additional-moment-images.sql',
  '013_name-moment-image-attachments.sql', '014_hold-places-with-shared-moments.sql', '015_bill-additional-moment-places.sql',
  '016_make-extra-image-payments-one-time.sql', '017_keep-one-removed-photo-per-moment.sql', '018_allow-ninety-nine-paid-journey-places.sql',
  '019_let-moments-carry-their-own-atmosphere.sql', '020_let-entitlements-hold-ninety-nine-places.sql',
  '021_let-unpaid-capacity-rest-without-losing-history.sql', '022_agree-together-before-adding-someone.sql',
  '023_let-a-phone-carry-its-own-key.sql', '024_let-google-and-apple-open-an-account.sql',
  '025_revoke-sign-in-with-apple-when-an-account-is-deleted.sql', '026_remember-a-refused-apple-deletion.sql',
];

// Signature checks have their own tests (tests/social-sign-in.test.js). Here an ID token is just
// `provider:subject:email`, so a test can say whose sign-in it is in one line.
const identity = {
  configured: () => true,
  accepts: () => false,
  async verify(provider, idToken) {
    const [tokenProvider, subject, email] = String(idToken || '').split(':');
    if (tokenProvider !== provider || !subject) return null;
    return { provider, subject, email: email || null, emailVerified: true, isPrivateEmail: false, audience: 'test' };
  },
};
const apple = { configured: () => false };

async function setup({ trustProxy = false, logger = false } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  memory.public.registerFunction({ name: 'jsonb_array_length', args: ['jsonb'], returns: 'integer', implementation: (value) => (Array.isArray(value) ? value.length : 0) });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) await pool.query(await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8'));
  const config = loadConfig({
    NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    TRUST_PROXY: trustProxy ? 'true' : 'false',
  });
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => NOW, identity, apple });
  const app = await buildApp({ platform, config, logger });
  return { app, pool, mailer };
}

const post = (app, url, payload, { from = '203.0.113.10', headers = {} } = {}) => (
  app.inject({ method: 'POST', url, remoteAddress: from, headers: { origin, ...headers }, payload })
);

// Sends `send(i)` until the limiter refuses one, and returns how many it let through. Every
// request it let through must have been answered by the route itself, never by the limiter.
async function tripLimit(send, { ceiling = 400 } = {}) {
  for (let i = 0; i < ceiling; i += 1) {
    const response = await send(i);
    if (response.statusCode === 429) {
      assert.deepEqual(response.json(), RATE_LIMITED);
      assert.ok(Number(response.headers['retry-after']) > 0, 'a refusal says how long to wait');
      return { allowed: i, refused: response };
    }
  }
  assert.fail(`the limiter never fired in ${ceiling} requests`);
}

async function registered(app, email, from = '198.51.100.200') {
  const response = await post(app, '/api/v1/auth/register', { email, username: email.split('@')[0], password: PASSWORD }, { from });
  assert.equal(response.statusCode, 201, response.body);
  return response;
}

test('signing in with a password is refused on the 11th try in 15 minutes from one address', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  const { allowed, refused } = await tripLimit(() => post(app, '/api/v1/auth/login', { identifier: 'asha@example.test', password: 'not the password at all' }));
  assert.equal(allowed, 10);
  assert.ok(Number(refused.headers['retry-after']) <= 15 * 60);
  // Refused before the password is looked at: the right one is refused too.
  const right = await post(app, '/api/v1/auth/login', { identifier: 'asha@example.test', password: PASSWORD });
  assert.equal(right.statusCode, 429);
});

test('registering is refused on the 6th try in 15 minutes, successful ones included', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  const statuses = [];
  const { allowed } = await tripLimit(async (i) => {
    const response = await post(app, '/api/v1/auth/register', { email: `new${i}@example.test`, username: `new${i}`, password: PASSWORD });
    statuses.push(response.statusCode);
    return response;
  });
  assert.equal(allowed, 5);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test('asking for a recovery link is refused on the 6th try in 30 minutes', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  const { allowed, refused } = await tripLimit(() => post(app, '/api/v1/recovery/request', { email: 'asha@example.test' }));
  assert.equal(allowed, 5);
  assert.ok(Number(refused.headers['retry-after']) > 15 * 60, 'the recovery window is 30 minutes');
  assert.equal(mailer.messages.filter((message) => message.type === 'recovery').length, 5);
});

test('confirming a recovery is refused on the 11th try in 30 minutes', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  const { allowed } = await tripLimit((i) => post(app, '/api/v1/recovery/confirm', { token: `guess-${i}`, password: PASSWORD }));
  assert.equal(allowed, 10);
});

test('Google, Apple and linking are each refused on the 11th try in 15 minutes, with their own counts', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  const google = await tripLimit((i) => post(app, '/api/v1/auth/google', { idToken: `google:g-${i}:g${i}@example.test` }));
  assert.equal(google.allowed, 10);
  // One address tripped Google; Apple and linking still have their whole allowance for it.
  const apple = await tripLimit((i) => post(app, '/api/v1/auth/apple', { idToken: `apple:a-${i}` }));
  assert.equal(apple.allowed, 10);
  const link = await tripLimit(() => post(app, '/api/v1/auth/link', { provider: 'google', idToken: 'google:g-x:asha@example.test', password: 'not the password at all' }));
  assert.equal(link.allowed, 10);
  // Linking is a password check with its own 10, not a share of login's: this address can still
  // try the password 10 more times at /auth/login.
  const login = await tripLimit(() => post(app, '/api/v1/auth/login', { identifier: 'asha@example.test', password: 'not the password at all' }));
  assert.equal(login.allowed, 10);
});

test('the rest of the account routes trip at their own numbers too', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  const session = await registered(app, 'asha@example.test', '203.0.113.10');
  const cookie = session.headers['set-cookie'].split(';')[0];
  const csrf = session.json().data.csrfToken;
  const verify = await tripLimit((i) => post(app, '/api/v1/auth/verify-email', { token: `guess-${i}` }));
  assert.equal(verify.allowed, 10);
  const resend = await tripLimit(() => post(app, '/api/v1/auth/resend-verification', {}, { headers: { cookie, 'x-together-csrf': csrf } }));
  assert.equal(resend.allowed, 3);
  const refresh = await tripLimit((i) => post(app, '/api/v1/auth/refresh', { refreshToken: `guess-${i}` }));
  assert.equal(refresh.allowed, 30);
  const notifications = await tripLimit(() => post(app, '/api/v1/auth/apple/notifications', { payload: 'not-signed' }));
  assert.equal(notifications.allowed, 120);
  // A route with no limit of its own falls under the global one: 300 a minute.
  const providers = await tripLimit(() => app.inject({ method: 'GET', url: '/api/v1/auth/providers', remoteAddress: '203.0.113.10' }));
  assert.equal(providers.allowed, 300);
});

test('the window is fixed: it starts at the first request and resets whole, so its edge allows nearly twice the limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  const ask = () => post(app, '/api/v1/recovery/request', { email: 'nobody@example.test' });
  assert.equal((await ask()).statusCode, 202);
  // 29 minutes 59 seconds later, the first window still has four left.
  t.mock.timers.tick(30 * 60 * 1000 - 1000);
  for (let i = 0; i < 4; i += 1) assert.equal((await ask()).statusCode, 202);
  const refused = await ask();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers['retry-after'], '1');
  // Asking again while refused does not push the reset back.
  for (let i = 0; i < 20; i += 1) assert.equal((await ask()).statusCode, 429);
  // One second later the window is new and whole: nine requests got through in two seconds,
  // where a sliding window would have allowed none.
  t.mock.timers.tick(1000);
  for (let i = 0; i < 5; i += 1) assert.equal((await ask()).statusCode, 202);
  assert.equal((await ask()).statusCode, 429);
});

test('the count is per address: one address tripping the limit locks no account and refuses no one else', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  const attacker = '203.0.113.66';
  const { allowed } = await tripLimit(() => post(app, '/api/v1/auth/login', { identifier: 'asha@example.test', password: 'not the password at all' }, { from: attacker }));
  assert.equal(allowed, 10);
  // Asha, at her own address, signs straight in. There is no per-account lockout to trip.
  const asha = await post(app, '/api/v1/auth/login', { identifier: 'asha@example.test', password: PASSWORD }, { from: '198.51.100.20' });
  assert.equal(asha.statusCode, 200, asha.body);
  // IPv6 is counted per /64: a neighbour in the same /64 shares the count, the next /64 does not.
  const v6a = await tripLimit(() => post(app, '/api/v1/auth/login', { identifier: 'asha@example.test', password: 'nope nope nope' }, { from: '2001:db8:1:1::a' }));
  assert.equal(v6a.allowed, 10);
  assert.equal((await post(app, '/api/v1/auth/login', { identifier: 'x@example.test', password: 'nope nope nope' }, { from: '2001:db8:1:1::b' })).statusCode, 429);
  assert.equal((await post(app, '/api/v1/auth/login', { identifier: 'x@example.test', password: 'nope nope nope' }, { from: '2001:db8:1:2::a' })).statusCode, 401);
});

test('with TRUST_PROXY=true the count is keyed on the leftmost X-Forwarded-For address, whoever wrote it', async (t) => {
  // This is why the app must only ever be reached through Caddy, which replaces the header
  // (the last test). Reached directly, a client would choose its own key.
  const { app, pool } = await setup({ trustProxy: true });
  t.after(async () => { await app.close(); await pool.end(); });
  const caddy = '172.18.0.4';
  const login = (forwardedFor) => post(app, '/api/v1/auth/login', { identifier: 'x@example.test', password: 'nope nope nope' }, { from: caddy, headers: { 'x-forwarded-for': forwardedFor } });
  const { allowed } = await tripLimit(() => login('198.51.100.7'));
  assert.equal(allowed, 10);
  assert.equal((await login('198.51.100.8')).statusCode, 401, 'another forwarded address has its own count');
  assert.equal((await login('198.51.100.9, 198.51.100.7')).statusCode, 401, 'the rightmost entry is not the key');
  assert.equal((await login('198.51.100.7, 198.51.100.9')).statusCode, 429, 'the leftmost entry is');
});

test('a wrong password, an unknown account and a Google-only account get the same answer', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  const socialOnly = await post(app, '/api/v1/auth/google', { idToken: 'google:g-1:ravi@example.test' }, { from: '198.51.100.201' });
  assert.equal(socialOnly.statusCode, 200, socialOnly.body);
  const answers = [];
  for (const identifier of ['asha@example.test', 'nobody@example.test', 'ravi@example.test']) {
    const response = await post(app, '/api/v1/auth/login', { identifier, password: 'not the password at all' }, { from: `198.51.100.${answers.length + 30}` });
    answers.push({ status: response.statusCode, body: response.json() });
  }
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[2], answers[0]);
  assert.deepEqual(answers[0], { status: 401, body: { error: { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' } } });
});

test('asking for a recovery link answers the same for a real address, an unknown one and a Google-only one', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  await post(app, '/api/v1/auth/google', { idToken: 'google:g-1:ravi@example.test' }, { from: '198.51.100.201' });
  const answers = [];
  for (const email of ['asha@example.test', 'nobody@example.test', 'ravi@example.test', 'not an email']) {
    const response = await post(app, '/api/v1/recovery/request', { email }, { from: `198.51.100.${answers.length + 40}` });
    answers.push({ status: response.statusCode, body: response.body, cookie: response.headers['set-cookie'] });
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(answers[0].status, 202);
  assert.deepEqual(mailer.messages.filter((message) => message.type === 'recovery').map((message) => message.to), ['asha@example.test']);
});

test('linking answers the same for an unknown email, a Google-only account and a wrong password', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await registered(app, 'asha@example.test');
  await post(app, '/api/v1/auth/google', { idToken: 'google:g-1:ravi@example.test' }, { from: '198.51.100.201' });
  const answers = [];
  for (const idToken of ['google:g-2:asha@example.test', 'google:g-3:nobody@example.test', 'google:g-4:ravi@example.test', 'google:g-5']) {
    const response = await post(app, '/api/v1/auth/link', { provider: 'google', idToken, password: 'not the password at all' }, { from: `198.51.100.${answers.length + 50}` });
    answers.push({ status: response.statusCode, body: response.json() });
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(answers[0].status, 401);
});

// The Caddyfile that ships, with only its upstream changed to point at this test's app. Caddy
// 2.5 and later drop an X-Forwarded-For a client sends, unless it comes from a trusted_proxies
// range (there are none), and write the address it was actually connected from instead.
test('behind the shipped Caddyfile, a client cannot choose its own address', { skip: !process.env.CADDY_BIN && 'set CADDY_BIN to a caddy binary to run this' }, async (t) => {
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(...String(chunk).trim().split('\n')); done(); } });
  const { app, pool } = await setup({ trustProxy: true, logger: { level: 'info', stream } });
  const appAddress = await app.listen({ host: '127.0.0.1', port: 0 });
  const appPort = new URL(appAddress).port;
  const directory = await mkdtemp(join(tmpdir(), 'tl-caddy-'));
  const shipped = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  assert.match(shipped, /reverse_proxy app:4174\n/);
  await writeFile(join(directory, 'Caddyfile'), shipped.replace('reverse_proxy app:4174', `reverse_proxy 127.0.0.1:${appPort}`));
  const caddyPort = 20000 + Math.floor(Math.random() * 20000);
  const caddy = spawn(process.env.CADDY_BIN, ['run', '--config', join(directory, 'Caddyfile'), '--adapter', 'caddyfile'], {
    env: { ...process.env, CADDY_DOMAIN: `http://127.0.0.1:${caddyPort}`, CADDY_EMAIL: 'ops@example.test', CADDY_ADMIN: '127.0.0.1:0', XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory, HOME: directory },
    stdio: 'ignore',
  });
  t.after(async () => { caddy.kill(); await app.close(); await pool.end(); await rm(directory, { recursive: true, force: true }); });
  const through = (forwardedFor) => fetch(`http://127.0.0.1:${caddyPort}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ identifier: 'x@example.test', password: 'nope nope nope' }),
  });
  for (let tries = 0; ; tries += 1) {
    try { await fetch(`http://127.0.0.1:${caddyPort}/healthz`); break; } catch { if (tries > 50) throw new Error('caddy did not start'); await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  // Ten different made-up addresses, and the eleventh is still refused: all of them were
  // counted as the one address Caddy was connected from.
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await through(`198.51.100.${i + 1}`)).status);
  assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  const seen = lines.map((line) => JSON.parse(line)).filter((entry) => entry.req?.url === '/api/v1/auth/login').map((entry) => entry.req.remoteAddress);
  assert.equal(seen.length, 11);
  assert.deepEqual([...new Set(seen)], ['127.0.0.1']);
});
