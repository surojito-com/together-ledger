// Google and Apple sign-in on the server (#214), with the linking rule the owner decided on
// Sep 30, 2026: a sign-in whose email already has a password account asks for that password
// once, and nothing is ever linked because two emails match.
//
// Each provider is a fake that signs ID tokens with a key generated here and serves the public
// half the way Google and Apple publish theirs, so the verifier does real signature checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { IdentityVerifier } from '../server/identity.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const origin = 'http://127.0.0.1:4174';
const PASSWORD = 'correct horse battery staple';
const GOOGLE_CLIENT = 'test-web-client.apps.googleusercontent.com';
const APPLE_APP = 'com.togetherledger.ledger';
const NOW = new Date('2026-09-30T12:00:00.000Z');

const MIGRATIONS = [
  '001_platform.sql', '003_private_usernames.sql', '004_shared_moments.sql', '005_make-shared-journeys-more-humane.sql',
  '006_expand-shared-moment-vocabulary.sql', '007_person_specific_moment_visibility.sql', '008_stripe_web_billing.sql',
  '009_reserve-group-places.sql', '011_hold-one-image-with-each-moment.sql', '012_bill-additional-moment-images.sql',
  '013_name-moment-image-attachments.sql', '014_hold-places-with-shared-moments.sql', '016_make-extra-image-payments-one-time.sql',
  '017_keep-one-removed-photo-per-moment.sql', '018_allow-ninety-nine-paid-journey-places.sql', '019_let-moments-carry-their-own-atmosphere.sql',
  '020_let-entitlements-hold-ninety-nine-places.sql', '021_let-unpaid-capacity-rest-without-losing-history.sql',
  '022_agree-together-before-adding-someone.sql', '023_let-a-phone-carry-its-own-key.sql', '024_let-google-and-apple-open-an-account.sql',
];

function provider(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
const google = provider('google-test');
const apple = provider('apple-test');
const stranger = provider('google-test');

function idToken(signer, claims, { header = {} } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'RS256', kid: signer.kid, typ: 'JWT', ...header });
  const iat = Math.floor(NOW.getTime() / 1000);
  const body = encode({ iat, exp: iat + 600, ...claims });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signer.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const googleToken = (claims, options) => idToken(google, { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, email_verified: true, ...claims }, options);
const appleToken = (claims, options) => idToken(apple, { iss: 'https://appleid.apple.com', aud: APPLE_APP, ...claims }, options);

async function setup(overrides = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) await pool.query(await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8'));
  const config = loadConfig({
    NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    GOOGLE_CLIENT_IDS: GOOGLE_CLIENT,
    ...overrides,
  });
  const fetch = async (url) => {
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [apple.jwk] });
    throw new Error(`no network in tests: ${url}`);
  };
  const identity = new IdentityVerifier({ googleClientIds: config.googleClientIds, appleClientIds: config.appleClientIds, fetch, now: () => NOW.getTime() });
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => NOW, identity });
  const app = await buildApp({ platform, config });
  return { app, pool, mailer };
}

const post = (app, url, payload, headers = {}) => app.inject({ method: 'POST', url, headers: { origin, ...headers }, payload });

async function registerWithPassword(app, email) {
  const response = await post(app, '/api/v1/auth/register', { email, username: `p${Math.random().toString(36).slice(2, 10)}`, password: PASSWORD });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data.user;
}

test('a Google ID token opens an account on first sign-in and finds the same one again', async () => {
  const { app, pool } = await setup();
  const token = googleToken({ sub: 'g-1', email: 'Asha@Example.com', name: 'Asha' });
  const first = await post(app, '/api/v1/auth/google', { idToken: token });
  assert.equal(first.statusCode, 200, first.body);
  const { user, csrfToken } = first.json().data;
  assert.equal(user.email, 'asha@example.com');
  assert.equal(user.displayName, 'Asha');
  assert.match(user.username, /^journeyer-[0-9a-f]{8}$/);
  assert.equal(user.emailVerified, true);
  assert.ok(csrfToken);
  assert.match(first.headers['set-cookie'], /tl_session=/);

  const again = await post(app, '/api/v1/auth/google', { idToken: token });
  assert.equal(again.json().data.user.id, user.id);
  const rows = await pool.query('SELECT provider, subject FROM user_identities WHERE user_id=$1', [user.id]);
  assert.deepEqual(rows.rows, [{ provider: 'google', subject: 'g-1' }]);
});

test('a phone asking for a token gets a token pair, not a cookie', async () => {
  const { app } = await setup();
  const response = await app.inject({
    method: 'POST', url: '/api/v1/auth/apple', headers: { 'x-together-client': 'app' },
    payload: { idToken: appleToken({ sub: 'a-1', email: 'a1@example.com' }), displayName: 'Kiran' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.ok(data.token && data.refreshToken);
  assert.equal(data.user.displayName, 'Kiran');
  assert.equal(response.headers['set-cookie'], undefined);
});

test('refuses a bad signature, a wrong audience, an expired token and another issuer, all alike', async () => {
  const { app, pool } = await setup();
  const refusals = [
    idToken(stranger, { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'g-x', email: 'x@example.com' }),
    googleToken({ sub: 'g-x', aud: 'someone-elses-app.apps.googleusercontent.com' }),
    googleToken({ sub: 'g-x', exp: Math.floor(NOW.getTime() / 1000) - 3600 }),
    googleToken({ sub: 'g-x', iss: 'https://appleid.apple.com' }),
    googleToken({ sub: 'g-x' }, { header: { alg: 'none' } }),
    'not-a-token',
  ];
  for (const token of refusals) {
    const response = await post(app, '/api/v1/auth/google', { idToken: token });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json().error.code, 'invalid_token');
  }
  assert.equal((await pool.query('SELECT * FROM user_identities')).rowCount, 0);
});

test('Google stays off until its client IDs are configured', async () => {
  const memoryConfig = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(memoryConfig.googleClientIds, []);
  assert.deepEqual(memoryConfig.appleClientIds, ['com.togetherledger.ledger', 'com.togetherledger.ledger.web']);
  const verifier = new IdentityVerifier({ googleClientIds: [], appleClientIds: [APPLE_APP], fetch: async () => { throw new Error('no network'); } });
  assert.equal(verifier.configured('google'), false);
  assert.equal(verifier.configured('apple'), true);
});

test('an email that already has a password account asks for that password once, then links', async () => {
  const { app } = await setup();
  const owner = await registerWithPassword(app, 'ma@example.com');
  const token = googleToken({ sub: 'g-ma', email: 'ma@example.com' });

  const asked = await post(app, '/api/v1/auth/google', { idToken: token });
  assert.equal(asked.statusCode, 409);
  assert.equal(asked.json().error.code, 'link_required');
  assert.deepEqual(asked.json().error.details, { email: 'ma@example.com' });

  const wrong = await post(app, '/api/v1/auth/link', { provider: 'google', idToken: token, password: 'not the password at all' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'invalid_credentials');

  const linked = await post(app, '/api/v1/auth/link', { provider: 'google', idToken: token, password: PASSWORD });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().data.user.id, owner.id);

  const direct = await post(app, '/api/v1/auth/google', { idToken: token });
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.json().data.user.id, owner.id);
});

test('an email held by an account without a password is refused, never linked', async () => {
  const { app, pool } = await setup();
  await post(app, '/api/v1/auth/google', { idToken: googleToken({ sub: 'g-2', email: 'same@example.com' }) });
  const refused = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-2', email: 'same@example.com' }) });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, 'email_in_use');
  assert.equal((await pool.query(`SELECT * FROM user_identities WHERE subject='a-2'`)).rowCount, 0);

  // Nor can a password account be registered over it.
  const register = await post(app, '/api/v1/auth/register', { email: 'same@example.com', username: 'someone-else', password: PASSWORD });
  assert.equal(register.statusCode, 409);
});

test('an Apple Hide My Email address always opens a new account', async () => {
  const { app } = await setup();
  const response = await post(app, '/api/v1/auth/apple', {
    idToken: appleToken({ sub: 'a-3', email: 'x7q2@privaterelay.appleid.com', is_private_email: 'true' }),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.user.email, 'x7q2@privaterelay.appleid.com');
});

test('an account with no password cannot sign in with one, has nothing to recover, and deletes without one', async () => {
  const { app, pool, mailer } = await setup();
  const signedIn = await post(app, '/api/v1/auth/google', { idToken: googleToken({ sub: 'g-4', email: 'nopw@example.com' }) });
  const { user, csrfToken } = signedIn.json().data;
  const cookie = signedIn.headers['set-cookie'].split(';')[0];

  const login = await post(app, '/api/v1/auth/login', { identifier: user.username, password: PASSWORD });
  assert.equal(login.statusCode, 401);

  const before = mailer.messages.length;
  const recovery = await post(app, '/api/v1/recovery/request', { email: 'nopw@example.com' });
  assert.equal(recovery.statusCode, 202);
  assert.equal(mailer.messages.length, before);

  const deleted = await app.inject({
    method: 'DELETE', url: '/api/v1/account',
    headers: { origin, cookie, 'x-together-csrf': csrfToken },
    payload: { confirmation: 'DELETE' },
  });
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal((await pool.query('SELECT * FROM user_identities WHERE user_id=$1', [user.id])).rowCount, 0);

  // The identity is free again: the same Google account opens a fresh one.
  const fresh = await post(app, '/api/v1/auth/google', { idToken: googleToken({ sub: 'g-4', email: 'nopw@example.com' }) });
  assert.equal(fresh.statusCode, 200);
  assert.notEqual(fresh.json().data.user.id, user.id);
});

test('a browser sign-in still has to come from our own origin', async () => {
  const { app } = await setup();
  const response = await app.inject({
    method: 'POST', url: '/api/v1/auth/google', headers: { origin: 'https://elsewhere.example' },
    payload: { idToken: googleToken({ sub: 'g-5', email: 'g5@example.com' }) },
  });
  assert.equal(response.statusCode, 403);
});

test('Apple\'s first-sign-in name is kept, and the journeyer- name is only a fallback', async () => {
  const { app } = await setup();
  const named = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-n1', email: 'n1@example.com' }), displayName: 'Meera Rao' });
  assert.equal(named.json().data.user.displayName, 'Meera Rao');

  // No name on the first sign-in: the fallback. A later sign-in that brings one saves it...
  const unnamed = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-n2', email: 'n2@example.com' }) });
  const fallback = unnamed.json().data.user;
  assert.equal(fallback.displayName, fallback.username);
  const later = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-n2' }), displayName: 'Sam' });
  assert.equal(later.json().data.user.displayName, 'Sam');
  // ...but never overwrites a name the account already has.
  const again = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-n2' }), displayName: 'Someone Else' });
  assert.equal(again.json().data.user.displayName, 'Sam');
});

test('with no Apple or Google config at all, the server still starts and email sign-in works', async () => {
  // A production environment file that has none of the sign-in values yet must load cleanly.
  const production = loadConfig({
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://app.together-ledger.com', API_ORIGIN: 'https://api.together-ledger.com',
    ACCOUNT_ORIGIN: 'https://app.together-ledger.com', COOKIE_SECURE: 'true', SESSION_SECRET: 'p'.repeat(40),
    AUDIT_HMAC_KEY: 'q'.repeat(40), SMTP_URL: 'smtp://relay.example.test:587',
    GOOGLE_CLIENT_IDS: '', APPLE_CLIENT_IDS: '',
  });
  assert.deepEqual(production.googleClientIds, []);
  assert.deepEqual(production.appleClientIds, []);

  const { app } = await setup({ GOOGLE_CLIENT_IDS: '', APPLE_CLIENT_IDS: '' });
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  const user = await registerWithPassword(app, 'plain@example.com');
  const login = await post(app, '/api/v1/auth/login', { identifier: 'plain@example.com', password: PASSWORD });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().data.user.id, user.id);
  for (const provider of ['google', 'apple']) {
    const refused = await post(app, `/api/v1/auth/${provider}`, { idToken: 'anything' });
    assert.equal(refused.statusCode, 404);
    assert.equal(refused.json().error.code, 'sign_in_unavailable');
  }
});
