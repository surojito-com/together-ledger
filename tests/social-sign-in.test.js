// Google and Apple sign-in on the server (#214), with the linking rule the owner decided on
// Sep 30, 2026: a sign-in whose email already has a password account asks for that password
// once, and nothing is ever linked because two emails match. Then Sign in with Apple's REST API
// (#218): exchanging the code at sign-in and revoking at deletion; and Apple's own server-to-server
// notifications (#250).
//
// Each provider is a fake that signs ID tokens with a key generated here and serves the public
// half the way Google and Apple publish theirs, so the verifier does real signature checks. The
// fake Apple also checks our ES256 client secret against the throwaway key generated here, and
// honours one-time codes, the way Apple's /auth/token and /auth/revoke do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { AppleSignIn } from '../server/apple.js';
import { IdentityVerifier } from '../server/identity.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { DisabledBillingService } from '../server/billing.js';
import { finishRefusedAppleDeletion, listRefusedAppleDeletions } from '../server/apple-deletion-followup.js';

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
  '025_revoke-sign-in-with-apple-when-an-account-is-deleted.sql',
  '026_remember-a-refused-apple-deletion.sql',
  '031_let-a-lost-renewal-reply-be-asked-again.sql',
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

const signInKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });

// Apple's side of the REST API, as its docs describe it: the client secret must be ES256 with our
// key ID, iss = the Team ID, sub = the client ID, aud = https://appleid.apple.com; a code works
// once, for the client it was issued to.
class FakeApple {
  constructor() { this.reset(); }
  reset() { this.down = false; this.calls = []; this.codes = new Map(); }
  issueCode(sub, clientId = APPLE_APP) {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.codes.set(code, { sub, clientId, used: false });
    return code;
  }
  secretIsValid(form) {
    const [head, body, signature] = String(form.client_secret || '').split('.');
    if (!signature) return false;
    const header = JSON.parse(Buffer.from(head, 'base64url'));
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    const signed = verify('sha256', Buffer.from(`${head}.${body}`), { key: signInKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
    return signed && header.alg === 'ES256' && header.kid === '985BDXJP8S' && claims.iss === '769MBW6826'
      && claims.aud === 'https://appleid.apple.com' && claims.sub === form.client_id && claims.exp > claims.iat;
  }
  async handle(url, init) {
    if (this.down) throw new TypeError('fetch failed');
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    this.calls.push({ url, form });
    if (!this.secretIsValid(form)) return Response.json({ error: 'invalid_client' }, { status: 400 });
    if (url.endsWith('/auth/revoke')) return new Response(null, { status: 200 });
    const issued = this.codes.get(form.code);
    if (!issued || issued.used || issued.clientId !== form.client_id) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    issued.used = true;
    return Response.json({
      access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${form.code}`,
      id_token: idToken(apple, { iss: 'https://appleid.apple.com', aud: issued.clientId, sub: issued.sub }),
    });
  }
}
const fakeApple = new FakeApple();

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
  const fetch = async (url, init) => {
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [apple.jwk] });
    if (url === 'https://appleid.apple.com/auth/token' || url === 'https://appleid.apple.com/auth/revoke') return fakeApple.handle(url, init);
    throw new Error(`no network in tests: ${url}`);
  };
  fakeApple.reset();
  const identity = new IdentityVerifier({ googleClientIds: config.googleClientIds, appleClientIds: config.appleClientIds, fetch, now: () => NOW.getTime() });
  const appleSignIn = new AppleSignIn({
    teamId: '769MBW6826',
    keyId: '985BDXJP8S',
    // One line, as it arrives through the production environment file.
    privateKey: signInKey.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    encryptionKey: randomBytes(32).toString('base64'),
    redirectUri: config.APPLE_WEB_REDIRECT_URI,
    fetch,
    now: () => NOW.getTime(),
  });
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => NOW, identity, apple: appleSignIn });
  const app = await buildApp({ platform, config });
  return { app, pool, mailer, platform };
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
    payload: { idToken: appleToken({ sub: 'a-1', email: 'a1@example.com' }), authorizationCode: fakeApple.issueCode('a-1'), displayName: 'Kiran' },
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
  const refused = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-2', email: 'same@example.com' }), authorizationCode: fakeApple.issueCode('a-2') });
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
    authorizationCode: fakeApple.issueCode('a-3'),
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

// Sign in with Apple's REST API (#218).

const tokenCalls = () => fakeApple.calls.filter((call) => call.url.endsWith('/auth/token'));
const revokeCalls = () => fakeApple.calls.filter((call) => call.url.endsWith('/auth/revoke'));

async function appleAccount(app, sub, { email = `${sub}@example.com`, aud = APPLE_APP } = {}) {
  const code = fakeApple.issueCode(sub, aud);
  const response = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub, email, aud }), authorizationCode: code });
  assert.equal(response.statusCode, 200, response.body);
  const { user, csrfToken } = response.json().data;
  return { user, csrfToken, code, cookie: response.headers['set-cookie'].split(';')[0] };
}

const deleteAccount = (app, account) => app.inject({
  method: 'DELETE', url: '/api/v1/account',
  headers: { origin, cookie: account.cookie, 'x-together-csrf': account.csrfToken },
  payload: { confirmation: 'DELETE' },
});

test('a first Apple sign-in exchanges its code and keeps the refresh token encrypted', async () => {
  const { app, pool } = await setup();
  const account = await appleAccount(app, 'a-10');
  assert.equal(tokenCalls().length, 1);
  assert.equal(tokenCalls()[0].form.client_id, APPLE_APP);
  assert.equal(tokenCalls()[0].form.redirect_uri, undefined, 'a native code is exchanged without a return URL');
  const row = (await pool.query(`SELECT apple_client_id, apple_refresh_token FROM user_identities WHERE subject='a-10'`)).rows[0];
  assert.equal(row.apple_client_id, APPLE_APP);
  assert.match(row.apple_refresh_token, /^v1\./);
  assert.ok(!row.apple_refresh_token.includes(`rt-${account.code}`));

  // A returning sign-in doesn't exchange again.
  await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-10' }), authorizationCode: fakeApple.issueCode('a-10') });
  assert.equal(tokenCalls().length, 1);
});

test('a code from the web is exchanged with the Services ID and the Return URL', async () => {
  const { app } = await setup();
  await appleAccount(app, 'a-11', { aud: 'com.togetherledger.ledger.web' });
  assert.equal(tokenCalls()[0].form.client_id, 'com.togetherledger.ledger.web');
  assert.equal(tokenCalls()[0].form.redirect_uri, 'https://app.together-ledger.com/');
});

test('no Apple account opens without a working code, or while Apple is unreachable', async () => {
  const { app, pool } = await setup();
  const token = appleToken({ sub: 'a-12', email: 'a12@example.com' });
  assert.equal((await post(app, '/api/v1/auth/apple', { idToken: token })).statusCode, 400);
  assert.equal((await post(app, '/api/v1/auth/apple', { idToken: token, authorizationCode: 'never-issued' })).statusCode, 401);
  assert.equal((await post(app, '/api/v1/auth/apple', { idToken: token, authorizationCode: fakeApple.issueCode('someone-else') })).statusCode, 401);
  fakeApple.down = true;
  assert.equal((await post(app, '/api/v1/auth/apple', { idToken: token, authorizationCode: fakeApple.issueCode('a-12') })).statusCode, 503);
  assert.equal((await pool.query(`SELECT * FROM user_identities WHERE subject='a-12'`)).rowCount, 0);
});

test('deleting an Apple account revokes its token with the client it was issued to', async () => {
  const { app, pool } = await setup();
  const account = await appleAccount(app, 'a-13');
  const deleted = await deleteAccount(app, account);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal(revokeCalls().length, 1);
  assert.deepEqual(
    { client_id: revokeCalls()[0].form.client_id, token: revokeCalls()[0].form.token, hint: revokeCalls()[0].form.token_type_hint },
    { client_id: APPLE_APP, token: `rt-${account.code}`, hint: 'refresh_token' },
  );
  assert.equal((await pool.query('SELECT * FROM apple_revocations')).rowCount, 0);
});

test('deletion still happens when Apple is unreachable, and a later retry revokes', async () => {
  const { app, pool, platform } = await setup();
  const account = await appleAccount(app, 'a-14');
  fakeApple.down = true;
  assert.equal((await deleteAccount(app, account)).statusCode, 204);
  assert.ok((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [account.user.id])).rows[0].deleted_at);
  const queued = (await pool.query('SELECT * FROM apple_revocations')).rows;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].attempts, 1);
  assert.ok(!queued[0].refresh_token.includes('rt-'));

  fakeApple.down = false;
  await pool.query('UPDATE apple_revocations SET next_attempt_at=$1', [new Date(NOW.getTime() - 1000)]);
  assert.deepEqual(await platform.drainAppleRevocations(), { revoked: 1, retrying: 0, dropped: 0 });
  assert.equal(revokeCalls().at(-1).form.token, `rt-${account.code}`);
  assert.equal((await pool.query('SELECT * FROM apple_revocations')).rowCount, 0);
});

test('an account that never used Apple makes no call to Apple when deleted', async () => {
  const { app } = await setup();
  const signedIn = await post(app, '/api/v1/auth/google', { idToken: googleToken({ sub: 'g-20', email: 'g20@example.com' }) });
  const { csrfToken } = signedIn.json().data;
  const cookie = signedIn.headers['set-cookie'].split(';')[0];
  assert.equal((await deleteAccount(app, { cookie, csrfToken })).statusCode, 204);
  assert.equal(fakeApple.calls.length, 0);
});

test('linking Apple exchanges its code only once the password is right', async () => {
  const { app, pool } = await setup();
  const owner = await registerWithPassword(app, 'link@example.com');
  const token = appleToken({ sub: 'a-15', email: 'link@example.com' });
  const code = fakeApple.issueCode('a-15');
  assert.equal((await post(app, '/api/v1/auth/apple', { idToken: token, authorizationCode: code })).statusCode, 409);
  assert.equal((await post(app, '/api/v1/auth/link', { provider: 'apple', idToken: token, authorizationCode: code, password: 'not the password at all' })).statusCode, 401);
  assert.equal(tokenCalls().length, 0);
  const linked = await post(app, '/api/v1/auth/link', { provider: 'apple', idToken: token, authorizationCode: code, password: PASSWORD });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().data.user.id, owner.id);
  assert.match((await pool.query(`SELECT apple_refresh_token FROM user_identities WHERE subject='a-15'`)).rows[0].apple_refresh_token, /^v1\./);
});

function notification(type, sub, signer = apple) {
  return idToken(signer, { iss: 'https://appleid.apple.com', aud: APPLE_APP, jti: 'n', events: JSON.stringify({ type, sub, event_time: NOW.getTime() }) });
}
const notify = (app, payload) => app.inject({ method: 'POST', url: '/api/v1/auth/apple/notifications', payload: { payload } });

test('Apple notifications: an unsigned one is refused, the email ones are acknowledged', async () => {
  const { app } = await setup();
  assert.equal((await notify(app, notification('account-deleted', 'a-16', google))).statusCode, 400);
  assert.equal((await notify(app, 'not-a-jwt')).statusCode, 400);
  assert.equal((await notify(app, notification('email-disabled', 'nobody'))).statusCode, 200);
  assert.equal((await notify(app, notification('email-enabled', 'nobody'))).statusCode, 200);
});

test('consent-revoked signs the person out everywhere and drops the token, keeping the account', async () => {
  const { app, pool } = await setup();
  const account = await appleAccount(app, 'a-17');
  assert.equal((await notify(app, notification('consent-revoked', 'a-17'))).statusCode, 200);
  const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: account.cookie } });
  assert.equal(session.statusCode, 401);
  assert.equal((await pool.query(`SELECT apple_refresh_token FROM user_identities WHERE subject='a-17'`)).rows[0].apple_refresh_token, null);
  assert.equal((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [account.user.id])).rows[0].deleted_at, null);
});

test('account-deleted deletes an Apple-only account, and only unlinks one that has a password', async () => {
  const { app, pool } = await setup();
  const only = await appleAccount(app, 'a-18');
  assert.equal((await notify(app, notification('account-deleted', 'a-18'))).statusCode, 200);
  assert.ok((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [only.user.id])).rows[0].deleted_at);

  const owner = await registerWithPassword(app, 'both@example.com');
  const token = appleToken({ sub: 'a-19', email: 'both@example.com' });
  await post(app, '/api/v1/auth/link', { provider: 'apple', idToken: token, authorizationCode: fakeApple.issueCode('a-19'), password: PASSWORD });
  assert.equal((await notify(app, notification('account-deleted', 'a-19'))).statusCode, 200);
  assert.equal((await pool.query(`SELECT * FROM user_identities WHERE subject='a-19'`)).rowCount, 0);
  assert.equal((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [owner.id])).rows[0].deleted_at, null);
  assert.equal((await post(app, '/api/v1/auth/login', { identifier: 'both@example.com', password: PASSWORD })).statusCode, 200);
});

test('Apple\'s first-sign-in name is kept, and the journeyer- name is only a fallback', async () => {
  const { app } = await setup();
  const named = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-n1', email: 'n1@example.com' }), authorizationCode: fakeApple.issueCode('a-n1'), displayName: 'Meera Rao' });
  assert.equal(named.json().data.user.displayName, 'Meera Rao');

  // No name on the first sign-in: the fallback. A later sign-in that brings one saves it...
  const unnamed = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-n2', email: 'n2@example.com' }), authorizationCode: fakeApple.issueCode('a-n2') });
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

test('with the Apple key or encryption key missing or malformed, the server still starts and email sign-in works', async () => {
  for (const apple of [
    { privateKey: '', encryptionKey: '' },
    { privateKey: 'not-a-key', encryptionKey: 'short' },
  ]) {
    const { app, platform } = await setup();
    platform.apple = new AppleSignIn({ teamId: '769MBW6826', keyId: '985BDXJP8S', ...apple, fetch: async () => { throw new Error('must not be called'); } });
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    const owner = await registerWithPassword(app, 'still@example.com');
    const login = await post(app, '/api/v1/auth/login', { identifier: 'still@example.com', password: PASSWORD });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().data.user.id, owner.id);
    // Google keeps working; only a new Apple account waits, and says so without a 500.
    assert.equal((await post(app, '/api/v1/auth/google', { idToken: googleToken({ sub: `g-${apple.encryptionKey}`, email: `g-${apple.encryptionKey || 'none'}@example.com` }) })).statusCode, 200);
    const refused = await post(app, '/api/v1/auth/apple', { idToken: appleToken({ sub: 'a-cfg', email: 'cfg@example.com' }), authorizationCode: fakeApple.issueCode('a-cfg') });
    assert.equal(refused.statusCode, 503, refused.body);
    assert.equal(refused.json().error.code, 'sign_in_unavailable');
    // And a password account still deletes.
    const cookie = login.headers['set-cookie'].split(';')[0];
    const deleted = await app.inject({
      method: 'DELETE', url: '/api/v1/account',
      headers: { origin, cookie, 'x-together-csrf': login.json().data.csrfToken },
      payload: { confirmation: 'DELETE', password: PASSWORD },
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
  }
});

test('account-deleted for an owner of a shared journey does exactly what Delete account does: refuses, and changes nothing', async () => {
  const { app, pool } = await setup();
  const owner = await appleAccount(app, 'a-30');
  const headers = { origin, cookie: owner.cookie, 'x-together-csrf': owner.csrfToken };
  const journey = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers,
    payload: { name: 'Shared', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(journey.statusCode, 201, journey.body);
  const journeyId = journey.json().data.journey.id;
  const partner = await registerWithPassword(app, 'partner@example.com');
  await pool.query(`INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'member')`, [journeyId, partner.id]);

  // In the app, deleting is refused until the journey is handed over...
  const inApp = await app.inject({ method: 'DELETE', url: '/api/v1/account', headers, payload: { confirmation: 'DELETE' } });
  assert.equal(inApp.statusCode, 409);
  assert.equal(inApp.json().error.code, 'ownership_transfer_required');

  // ...and Apple's event is refused the same way. Nothing is deleted or unlinked.
  assert.equal((await notify(app, notification('account-deleted', 'a-30'))).statusCode, 200);
  assert.equal((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [owner.user.id])).rows[0].deleted_at, null);
  assert.equal((await pool.query(`SELECT * FROM user_identities WHERE subject='a-30'`)).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM journey_members WHERE journey_id=$1', [journeyId])).rowCount, 2);
  assert.equal((await pool.query('SELECT * FROM apple_revocations')).rowCount, 0);
});

test('a refused Apple deletion is remembered, listed with its journey, and finished by handing the journey over', async () => {
  const { app, pool, platform } = await setup();
  const owner = await appleAccount(app, 'a-31');
  const headers = { origin, cookie: owner.cookie, 'x-together-csrf': owner.csrfToken };
  const journey = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers,
    payload: { name: 'Held together', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  const journeyId = journey.json().data.journey.id;
  const partner = await registerWithPassword(app, 'keeps@example.com');
  await pool.query(`INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'member')`, [journeyId, partner.id]);
  await notify(app, notification('account-deleted', 'a-31'));

  // Remembered on the identity, so the follow-up survives the container's log being lost.
  const [waiting] = await listRefusedAppleDeletions(pool, new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000));
  assert.equal(waiting.userId, owner.user.id);
  assert.equal(waiting.daysWaiting, 3);
  assert.deepEqual(waiting.journeys.map((j) => j.journeyId), [journeyId]);
  assert.deepEqual(waiting.journeys[0].members.map((m) => m.userId), [partner.id]);

  const services = { pool, platform, billing: new DisabledBillingService() };
  // Without handing the journey over, deletion still refuses, exactly as in the app.
  await assert.rejects(finishRefusedAppleDeletion(services, owner.user.id, []), { code: 'ownership_transfer_required' });
  // A password account isn't this tool's to delete.
  await assert.rejects(finishRefusedAppleDeletion(services, partner.id, []), { code: 'not_a_refused_apple_deletion' });

  const done = await finishRefusedAppleDeletion(services, owner.user.id, [{ journeyId, toUserId: partner.id }]);
  assert.deepEqual(done, { deleted: true, handedOver: 1 });
  assert.ok((await pool.query('SELECT deleted_at FROM users WHERE id=$1', [owner.user.id])).rows[0].deleted_at);
  assert.equal((await pool.query('SELECT owner_user_id FROM journeys WHERE id=$1', [journeyId])).rows[0].owner_user_id, partner.id);
  assert.deepEqual(await listRefusedAppleDeletions(pool), []);
  // Deleting it revoked its Apple token like any other deletion.
  assert.equal(revokeCalls().at(-1).form.token.startsWith('rt-'), true);
});
