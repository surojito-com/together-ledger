// Sign out everywhere, and changing the password while signed in (#194).
//
// Both are proved through the routes, from a browser (a cookie and its CSRF value) and from a
// phone (a bearer token family), against every other kind of sign-in the account holds. The same
// checks against real PostgreSQL are in tests/postgres-integration.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const origin = 'http://127.0.0.1:4174';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different, longer passphrase';
const WRONG = { error: { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' } };
const SIGNED_OUT = { error: { code: 'authentication_required', message: 'Sign in to continue.' } };
const REFUSED_REFRESH = { error: { code: 'invalid_token', message: 'Sign in again to continue.' } };

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
  '027_tie-every-store-purchase-to-an-account.sql', '028_turn-a-store-purchase-into-capacity.sql',
  '029_rest-read-only-and-let-the-payer-ask-for-time.sql', '031_let-a-lost-renewal-reply-be-asked-again.sql',
];

// Here an ID token is just `provider:subject:email`, so a test can open a Google account in a line.
const identity = {
  configured: () => true,
  accepts: () => false,
  async verify(provider, idToken) {
    const [tokenProvider, subject, email] = String(idToken || '').split(':');
    if (tokenProvider !== provider || !subject) return null;
    return { provider, subject, email: email || null, emailVerified: true, isPrivateEmail: false, audience: 'test' };
  },
};

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  memory.public.registerFunction({ name: 'jsonb_array_length', args: ['jsonb'], returns: 'integer', implementation: (value) => (Array.isArray(value) ? value.length : 0) });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) await pool.query(await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8'));
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, identity, apple: { configured: () => false } });
  const app = await buildApp({ platform, config });
  return { app, pool, mailer, platform };
}

const call = (app, method, url, { payload, browser, phone, headers = {}, from = '203.0.113.20' } = {}) => app.inject({
  method,
  url,
  remoteAddress: from,
  headers: {
    ...(browser ? { origin, cookie: browser.cookie, 'x-together-csrf': browser.csrf } : {}),
    ...(phone ? { authorization: `Bearer ${phone.token}`, 'x-together-client': 'app' } : {}),
    ...headers,
  },
  payload,
});

async function register(app, email, password = PASSWORD) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload: { email, username: email.split('@')[0], password } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data.user;
}

// A browser's sign-in: its cookie and the CSRF value that goes with it.
async function browserSignIn(app, identifier, password = PASSWORD) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: response.headers['set-cookie'].split(';')[0], csrf: response.json().data.csrfToken };
}

// A phone's sign-in: an access and refresh pair of its own family.
async function phoneSignIn(app, identifier, password = PASSWORD) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-together-client': 'app' }, payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const { token, refreshToken } = response.json().data;
  return { token, refreshToken };
}

const browserIsIn = async (app, browser) => (await call(app, 'GET', '/api/v1/session', { browser })).statusCode === 200;
const phoneIsIn = async (app, phone) => (await call(app, 'GET', '/api/v1/session', { phone })).statusCode === 200;
const refresh = (app, phone) => app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: phone.refreshToken } });

async function assertBrowserOut(app, browser) {
  const read = await call(app, 'GET', '/api/v1/session', { browser });
  assert.equal(read.statusCode, 401);
  assert.deepEqual(read.json(), SIGNED_OUT);
  // A change sent with the old cookie and its CSRF value fails as cleanly as a read does.
  const write = await call(app, 'PATCH', '/api/v1/account', { browser, payload: { displayName: 'Still here?' } });
  assert.equal(write.statusCode, 401);
  assert.deepEqual(write.json(), SIGNED_OUT);
}

async function assertPhoneOut(app, phone) {
  const read = await call(app, 'GET', '/api/v1/session', { phone });
  assert.equal(read.statusCode, 401);
  assert.deepEqual(read.json(), SIGNED_OUT, 'the access token is refused');
  // Refused with the one answer that signs a phone out (#353), not one it would try again.
  const renewed = await refresh(app, phone);
  assert.equal(renewed.statusCode, 401);
  assert.deepEqual(renewed.json(), REFUSED_REFRESH, 'the refresh token is refused too');
}

test('sign out everywhere from the browser ends this browser, every other browser, and every phone', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const here = await browserSignIn(app, 'asha@example.test');
  const otherBrowser = await browserSignIn(app, 'asha');
  const phone = await phoneSignIn(app, 'asha@example.test');
  const secondPhone = await phoneSignIn(app, 'asha@example.test');

  const response = await call(app, 'POST', '/api/v1/auth/logout-everywhere', { browser: here });
  assert.equal(response.statusCode, 204);
  assert.match(response.headers['set-cookie'], /^tl_session=;/, 'this browser\'s cookie is cleared');

  await assertBrowserOut(app, here);
  await assertBrowserOut(app, otherBrowser);
  await assertPhoneOut(app, phone);
  await assertPhoneOut(app, secondPhone);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM api_tokens WHERE revoked_at IS NULL')).rows[0].n, 0);
  // Nothing else changed: the same password signs in again.
  assert.ok(await browserIsIn(app, await browserSignIn(app, 'asha@example.test')));
});

test('sign out everywhere from the phone ends this phone, every other phone, and every browser', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const browser = await browserSignIn(app, 'asha@example.test');
  const here = await phoneSignIn(app, 'asha@example.test');
  const otherPhone = await phoneSignIn(app, 'asha@example.test');

  const response = await call(app, 'POST', '/api/v1/auth/logout-everywhere', { phone: here, payload: {} });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['set-cookie'], undefined, 'a phone is never sent a cookie');

  await assertPhoneOut(app, here);
  await assertPhoneOut(app, otherPhone);
  await assertBrowserOut(app, browser);
});

test('sign out everywhere needs a sign-in, and a browser\'s own CSRF value and origin', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const browser = await browserSignIn(app, 'asha@example.test');
  const nobody = await app.inject({ method: 'POST', url: '/api/v1/auth/logout-everywhere', headers: { origin } });
  assert.equal(nobody.statusCode, 401);
  const noCsrf = await call(app, 'POST', '/api/v1/auth/logout-everywhere', { headers: { origin, cookie: browser.cookie } });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error.code, 'invalid_csrf');
  const elsewhere = await call(app, 'POST', '/api/v1/auth/logout-everywhere', { headers: { origin: 'https://evil.example', cookie: browser.cookie, 'x-together-csrf': browser.csrf } });
  assert.equal(elsewhere.statusCode, 403);
  assert.equal(elsewhere.json().error.code, 'invalid_origin');
  assert.ok(await browserIsIn(app, browser), 'a refused request ends nothing');
});

test('one person signing out everywhere never touches anyone else\'s sign-ins', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  await register(app, 'ben@example.test');
  const asha = await browserSignIn(app, 'asha@example.test');
  const benBrowser = await browserSignIn(app, 'ben@example.test');
  const benPhone = await phoneSignIn(app, 'ben@example.test');
  // Nothing in the request says whose sign-ins end; a body naming someone else is ignored.
  const ben = await call(app, 'GET', '/api/v1/session', { browser: benBrowser });
  const response = await call(app, 'POST', '/api/v1/auth/logout-everywhere', { browser: asha, payload: { userId: ben.json().data.user.id } });
  assert.equal(response.statusCode, 204);
  await assertBrowserOut(app, asha);
  assert.ok(await browserIsIn(app, benBrowser));
  assert.ok(await phoneIsIn(app, benPhone));
  assert.equal((await refresh(app, benPhone)).statusCode, 200);
});

test('changing the password from the browser keeps this browser and ends every other sign-in', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const here = await browserSignIn(app, 'asha@example.test');
  const otherBrowser = await browserSignIn(app, 'asha@example.test');
  const phone = await phoneSignIn(app, 'asha@example.test');

  const response = await call(app, 'POST', '/api/v1/account/password', { browser: here, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.user.email, 'asha@example.test');
  assert.equal(response.headers['set-cookie'], undefined, 'this browser keeps the session it has: nothing is re-issued');

  // This browser carries on with the same cookie and CSRF value, for reading and for changing.
  assert.ok(await browserIsIn(app, here));
  const rename = await call(app, 'PATCH', '/api/v1/account', { browser: here, payload: { displayName: 'Asha' } });
  assert.equal(rename.statusCode, 200, rename.body);
  await assertBrowserOut(app, otherBrowser);
  await assertPhoneOut(app, phone);

  // The new password signs in; the old one is wrong now.
  assert.ok(await browserIsIn(app, await browserSignIn(app, 'asha@example.test', NEW_PASSWORD)));
  const old = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'asha@example.test', password: PASSWORD } });
  assert.equal(old.statusCode, 401);
  // One notice, to the account's own address, and nothing in it but where it goes.
  const notices = mailer.messages.filter((message) => message.type === 'password-changed');
  assert.deepEqual(notices, [{ type: 'password-changed', to: 'asha@example.test' }]);
});

test('changing the password from the phone keeps this phone\'s tokens and ends every other sign-in', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const browser = await browserSignIn(app, 'asha@example.test');
  const here = await phoneSignIn(app, 'asha@example.test');
  const otherPhone = await phoneSignIn(app, 'asha@example.test');

  const response = await call(app, 'POST', '/api/v1/account/password', { phone: here, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.token, undefined, 'no new tokens: this phone keeps the pair it has');

  assert.ok(await phoneIsIn(app, here), 'this phone\'s access token still works');
  const renewed = await refresh(app, here);
  assert.equal(renewed.statusCode, 200, 'and so does its refresh token');
  assert.ok(await phoneIsIn(app, { token: renewed.json().data.token }));
  await assertPhoneOut(app, otherPhone);
  await assertBrowserOut(app, browser);
});

test('a recovery link asked for before the change stops working', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const here = await browserSignIn(app, 'asha@example.test');
  await app.inject({ method: 'POST', url: '/api/v1/recovery/request', headers: { origin }, payload: { email: 'asha@example.test' } });
  await app.afterReplies();
  const link = mailer.messages.find((message) => message.type === 'recovery').token;
  assert.equal((await call(app, 'POST', '/api/v1/account/password', { browser: here, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).statusCode, 200);
  const late = await app.inject({ method: 'POST', url: '/api/v1/recovery/confirm', headers: { origin }, payload: { token: link, password: 'yet another passphrase here' } });
  assert.equal(late.statusCode, 400);
  assert.equal(late.json().error.code, 'invalid_token');
  assert.ok(await browserIsIn(app, here));
});

test('a wrong current password is refused in login\'s words, changes nothing, and sends nothing', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const here = await browserSignIn(app, 'asha@example.test');
  const phone = await phoneSignIn(app, 'asha@example.test');
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'asha@example.test', password: 'not the password at all' } });
  for (const currentPassword of ['not the password at all', '', undefined, 12345678901234]) {
    const response = await call(app, 'POST', '/api/v1/account/password', { browser: here, payload: { currentPassword, newPassword: NEW_PASSWORD } });
    assert.equal(response.statusCode, login.statusCode);
    assert.deepEqual(response.json(), login.json());
    assert.deepEqual(response.json(), WRONG);
  }
  // From the phone the answer is the same, and the phone's tokens are not spent on it: a wrong
  // password is never mistaken for being signed out.
  const fromPhone = await call(app, 'POST', '/api/v1/account/password', { phone, payload: { currentPassword: 'not the password at all', newPassword: NEW_PASSWORD } });
  assert.deepEqual(fromPhone.json(), WRONG);
  assert.ok(await browserIsIn(app, here));
  assert.ok(await phoneIsIn(app, phone));
  assert.equal(mailer.messages.filter((message) => message.type === 'password-changed').length, 0);
  assert.ok(await browserIsIn(app, await browserSignIn(app, 'asha@example.test', PASSWORD)), 'the password is unchanged');
});

// The time a wrong password takes is login's: one argon2 verification, of the account's own hash
// or of the same padding hash login uses for an account that has none. Each is timed several
// times and the middle values compared, so a slow first run or one busy moment does not decide it.
test('a wrong current password takes about as long as a wrong password at login', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const here = await browserSignIn(app, 'asha@example.test');
  const google = await app.inject({ method: 'POST', url: '/api/v1/auth/google', headers: { origin }, payload: { idToken: 'google:g-1:gita@example.test' } });
  const noPassword = { cookie: google.headers['set-cookie'].split(';')[0], csrf: google.json().data.csrfToken };
  // Each request comes from its own address, so the rate limit never answers in place of the route.
  let address = 0;
  const from = () => { address += 1; return `198.51.100.${address}`; };
  const median = async (send) => {
    const times = [];
    for (let i = 0; i < 7; i += 1) {
      const started = process.hrtime.bigint();
      const response = await send(from());
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(response.statusCode, 401, response.body);
    }
    return times.sort((a, b) => a - b)[3];
  };
  const wrongLogin = (identifier) => (remoteAddress) => app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, headers: { origin }, payload: { identifier, password: 'not the password at all' } });
  await median(wrongLogin('asha'));
  const login = await median(wrongLogin('asha@example.test'));
  const change = await median((address) => call(app, 'POST', '/api/v1/account/password', { browser: here, from: address, payload: { currentPassword: 'not the password at all', newPassword: NEW_PASSWORD } }));
  const none = await median((address) => call(app, 'POST', '/api/v1/account/password', { browser: noPassword, from: address, payload: { currentPassword: 'not the password at all', newPassword: NEW_PASSWORD } }));
  for (const [name, took] of [['a wrong current password', change], ['an account with no password', none]]) {
    assert.ok(took > login * 0.5 && took < login * 2, `${name} took ${took.toFixed(1)} ms; a wrong login takes ${login.toFixed(1)} ms`);
  }
});

test('the new password follows the rule every password does: 12 to 128 characters', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const here = await browserSignIn(app, 'asha@example.test');
  const phone = await phoneSignIn(app, 'asha@example.test');
  for (const newPassword of ['x'.repeat(11), 'x'.repeat(129), '', undefined]) {
    const response = await call(app, 'POST', '/api/v1/account/password', { browser: here, payload: { currentPassword: PASSWORD, newPassword } });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: { code: 'invalid_input', message: 'Use a password between 12 and 128 characters.' } });
  }
  assert.ok(await phoneIsIn(app, phone), 'a refused change ends nothing');
  assert.equal(mailer.messages.filter((message) => message.type === 'password-changed').length, 0);
  let current = PASSWORD;
  for (const newPassword of ['y'.repeat(12), 'z'.repeat(128)]) {
    const response = await call(app, 'POST', '/api/v1/account/password', { browser: here, payload: { currentPassword: current, newPassword } });
    assert.equal(response.statusCode, 200, response.body);
    current = newPassword;
  }
  assert.ok(await browserIsIn(app, await browserSignIn(app, 'asha@example.test', 'z'.repeat(128))));
});

test('an account opened with Google has no password to change: refused as a wrong one, and nothing ends', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  const google = await app.inject({ method: 'POST', url: '/api/v1/auth/google', headers: { origin }, payload: { idToken: 'google:g-1:gita@example.test' } });
  assert.equal(google.statusCode, 200, google.body);
  assert.equal(google.json().data.user.hasPassword, false, 'the clients are told, and offer no Change password');
  const browser = { cookie: google.headers['set-cookie'].split(';')[0], csrf: google.json().data.csrfToken };
  for (const currentPassword of ['', 'anything at all here', undefined]) {
    const response = await call(app, 'POST', '/api/v1/account/password', { browser, payload: { currentPassword, newPassword: NEW_PASSWORD } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), WRONG);
  }
  assert.ok(await browserIsIn(app, browser));
  assert.equal((await pool.query('SELECT password_hash FROM users WHERE email_normalized=$1', ['gita@example.test'])).rows[0].password_hash, null, 'no password was set');
  assert.equal(mailer.messages.filter((message) => message.type === 'password-changed').length, 0);
  // Sign out everywhere is for every account, with a password or without.
  assert.equal((await call(app, 'POST', '/api/v1/auth/logout-everywhere', { browser })).statusCode, 204);
  await assertBrowserOut(app, browser);
});

test('changing a password changes only the signed-in person\'s, and ends only their sign-ins', async (t) => {
  const { app, pool, mailer } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  const BEN_PASSWORD = 'bens own long passphrase';
  await register(app, 'asha@example.test');
  await register(app, 'ben@example.test', BEN_PASSWORD);
  const asha = await browserSignIn(app, 'asha@example.test');
  const benBrowser = await browserSignIn(app, 'ben@example.test', BEN_PASSWORD);
  const benPhone = await phoneSignIn(app, 'ben@example.test', BEN_PASSWORD);
  const benId = (await call(app, 'GET', '/api/v1/session', { browser: benBrowser })).json().data.user.id;
  // Ben's password, offered from Asha's browser, is simply a wrong password there, whatever the
  // body says about whose account it is.
  const borrowed = await call(app, 'POST', '/api/v1/account/password', { browser: asha, payload: { currentPassword: BEN_PASSWORD, newPassword: NEW_PASSWORD, userId: benId } });
  assert.deepEqual(borrowed.json(), WRONG);
  const own = await call(app, 'POST', '/api/v1/account/password', { browser: asha, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: benId } });
  assert.equal(own.statusCode, 200, 'Asha\'s own password changes Asha\'s own account');
  assert.equal(own.json().data.user.email, 'asha@example.test');
  assert.ok(await browserIsIn(app, benBrowser));
  assert.ok(await phoneIsIn(app, benPhone));
  assert.equal((await refresh(app, benPhone)).statusCode, 200);
  assert.ok(await browserIsIn(app, await browserSignIn(app, 'ben@example.test', BEN_PASSWORD)), 'Ben\'s password is as it was');
  assert.ok(await browserIsIn(app, await browserSignIn(app, 'asha@example.test', NEW_PASSWORD)));
  assert.deepEqual(mailer.messages.filter((message) => message.type === 'password-changed').map((message) => message.to), ['asha@example.test']);
});

test('a revoked sign-in is refused cleanly everywhere it is used, never half-answered', async (t) => {
  const { app, pool } = await setup();
  t.after(async () => { await app.close(); await pool.end(); });
  await register(app, 'asha@example.test');
  const browser = await browserSignIn(app, 'asha@example.test');
  const phone = await phoneSignIn(app, 'asha@example.test');
  const journey = await call(app, 'POST', '/api/v1/journeys', { browser, payload: { name: 'Kept', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 } });
  assert.equal(journey.statusCode, 201, journey.body);
  const journeyId = journey.json().data.journey.id;
  assert.equal((await call(app, 'POST', '/api/v1/auth/logout-everywhere', { phone })).statusCode, 204);
  for (const [method, url, payload] of [['GET', '/api/v1/journeys'], ['GET', `/api/v1/journeys/${journeyId}/snapshot`], ['POST', '/api/v1/auth/logout-everywhere', {}], ['POST', '/api/v1/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }]]) {
    for (const who of [{ browser }, { phone }]) {
      const response = await call(app, method, url, { ...who, payload });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.deepEqual(response.json(), SIGNED_OUT, `${method} ${url}`);
    }
  }
  // Signing out everywhere deleted nothing: the journey is there when Asha signs in again.
  const again = await browserSignIn(app, 'asha@example.test');
  assert.deepEqual((await call(app, 'GET', '/api/v1/journeys', { browser: again })).json().data.journeys.map((entry) => entry.id), [journeyId]);
});
