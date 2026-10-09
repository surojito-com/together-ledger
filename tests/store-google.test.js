import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { GooglePlayDeveloperApi, GooglePlayError, GooglePushError, GooglePushVerifier, parseServiceAccount } from '../server/store-google.js';
import { appleChain } from './support/apple-signing.js';
import { GOOGLE_KEYS_URL, PUSH_AUDIENCE, PUSH_EMAIL, googleKeys, pushToken } from './support/google-push.js';

// The Play Developer API client (#272), against a stand-in for Google's HTTP endpoints, and the
// settings that turn each store on. No real Google credentials exist here: the key below is made
// for the test and never leaves it.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  clientEmail: 'play-purchases@together-ledger-test.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  tokenUri: 'https://oauth2.googleapis.com/token',
};

function fakeGoogle(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    const answer = routes(url, options, calls);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
      text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
    };
  };
  return { fetch, calls };
}

const tokenEndpoint = (url) => url === 'https://oauth2.googleapis.com/token';

test('it signs in as the service account and asks for exactly what a purchase needs', async () => {
  const google = fakeGoogle((url) => {
    if (tokenEndpoint(url)) return { status: 200, body: { access_token: 'ya29.fake', expires_in: 3600 } };
    if (url.endsWith(':consume') || url.endsWith(':acknowledge')) return { status: 204 };
    return { status: 200, body: { purchaseState: 0 } };
  });
  let clock = Date.parse('2026-10-08T12:00:00Z');
  const api = new GooglePlayDeveloperApi({ serviceAccount, packageName: 'com.togetherledger.ledger', fetch: google.fetch, now: () => clock });

  assert.deepEqual(await api.productPurchase('room_51_week_pass', 'opaque.token-1'), { purchaseState: 0 });
  await api.subscriptionPurchase('opaque.token-2');
  await api.consumeProduct('extra_photo', 'opaque.token-3');
  await api.acknowledgeSubscription('room_51_monthly', 'opaque.token-2');

  const [grant, ...rest] = google.calls;
  const form = new URLSearchParams(grant.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [head, body, signature] = form.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(claims.iss, serviceAccount.clientEmail);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.equal(claims.aud, serviceAccount.tokenUri);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(verify('sha256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')), 'signed with the service account key');

  const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.togetherledger.ledger/purchases';
  assert.deepEqual(rest.map((call) => [call.method, call.url]), [
    ['GET', `${base}/products/room_51_week_pass/tokens/opaque.token-1`],
    ['GET', `${base}/subscriptionsv2/tokens/opaque.token-2`],
    ['POST', `${base}/products/extra_photo/tokens/opaque.token-3:consume`],
    ['POST', `${base}/subscriptions/room_51_monthly/tokens/opaque.token-2:acknowledge`],
  ]);
  assert.ok(rest.every((call) => call.headers.authorization === 'Bearer ya29.fake'));
  assert.equal(google.calls.filter((call) => tokenEndpoint(call.url)).length, 1, 'one access token for the hour');

  clock += 56 * 60 * 1000;
  await api.subscriptionPurchase('opaque.token-2');
  assert.equal(google.calls.filter((call) => tokenEndpoint(call.url)).length, 2, 'renewed a few minutes before it ends');
});

test('Google’s answers become the three outcomes the purchase service acts on', async () => {
  let status = 404;
  const google = fakeGoogle((url) => (tokenEndpoint(url) ? { status: 200, body: { access_token: 'ya29.fake' } } : { status, body: {} }));
  const api = new GooglePlayDeveloperApi({ serviceAccount, packageName: 'com.togetherledger.ledger', fetch: google.fetch });
  for (const [answer, kind] of [[400, 'not-found'], [404, 'not-found'], [410, 'not-found'], [401, 'refused'], [403, 'refused'], [500, 'unavailable'], [503, 'unavailable']]) {
    status = answer;
    await assert.rejects(api.productPurchase('extra_place', 'opaque.token'), (error) => error instanceof GooglePlayError && error.kind === kind && error.status === answer);
  }
  // A 200 that is not JSON (a proxy's error page) is Google being unavailable, never a purchase.
  const garbled = { ok: true, status: 200, text: async () => '<html>Bad gateway</html>' };
  const proxied = new GooglePlayDeveloperApi({ serviceAccount, packageName: 'p', fetch: async (url) => (tokenEndpoint(url) ? { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake' }) } : garbled) });
  await assert.rejects(proxied.productPurchase('extra_place', 'opaque.token'), (error) => error instanceof GooglePlayError && error.kind === 'unavailable');
  const offline = new GooglePlayDeveloperApi({ serviceAccount, packageName: 'p', fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(offline.subscriptionPurchase('t'), (error) => error.kind === 'unavailable');
  const refusedKey = new GooglePlayDeveloperApi({ serviceAccount, packageName: 'p', fetch: fakeGoogle(() => ({ status: 400, body: { error: 'invalid_grant' } })).fetch });
  await assert.rejects(refusedKey.subscriptionPurchase('t'), (error) => error.kind === 'refused');
});

test('each store is off until its trust is configured, and a bad value stops the server', () => {
  const plain = loadConfig({ NODE_ENV: 'test' });
  assert.equal(plain.storeEnvironment, 'sandbox');
  assert.deepEqual(plain.appleRootCertificates, []);
  assert.equal(plain.googlePlayServiceAccount, null);
  assert.equal(plain.storePurchasesConfigured, false);
  assert.equal(plain.APPLE_BUNDLE_ID, 'com.togetherledger.ledger');
  assert.equal(plain.GOOGLE_PLAY_PACKAGE_NAME, 'com.togetherledger.ledger');

  const keyJson = JSON.stringify({ type: 'service_account', client_email: serviceAccount.clientEmail, private_key: serviceAccount.privateKey });
  const chain = appleChain();
  const configured = loadConfig({ NODE_ENV: 'test', APPLE_ROOT_CERTIFICATES: chain.rootBase64, GOOGLE_PLAY_SERVICE_ACCOUNT: Buffer.from(keyJson).toString('base64'), JOURNEY_CAPACITY_MODE: 'billing' });
  assert.equal(configured.appleRootCertificates.length, 1);
  assert.equal(configured.googlePlayServiceAccount.clientEmail, serviceAccount.clientEmail);
  assert.equal(configured.journeyCapacityMode, 'billing', 'store purchases are enough to read capacity from');
  assert.deepEqual(configured.billingEnvironments, ['test', 'sandbox']);
  assert.deepEqual(parseServiceAccount(keyJson), { ...serviceAccount });

  // A leaf is not a root, and a key that is not a key is not one.
  assert.throws(() => loadConfig({ APPLE_ROOT_CERTIFICATES: chain.x5c[0] }), /self-signed CA/);
  assert.throws(() => loadConfig({ GOOGLE_PLAY_SERVICE_ACCOUNT: '{"client_email":"a@b"}' }), /client_email and private_key/);
  assert.throws(() => loadConfig({ GOOGLE_PLAY_SERVICE_ACCOUNT: 'not json' }), /service account key JSON/);
  // Live web payments never sit beside sandbox store purchases.
  assert.throws(() => loadConfig({
    BILLING_ENABLED: 'true', STRIPE_ENVIRONMENT: 'live', STRIPE_SECRET_KEY: 'sk_live_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_live',
  }), /STORE_ENVIRONMENT=live/);
  assert.deepEqual(loadConfig({ STORE_ENVIRONMENT: 'live' }).billingEnvironments, ['test', 'live']);
  assert.deepEqual(plain.storeSandboxAccountIds, []);
  assert.throws(() => loadConfig({ STORE_SANDBOX_ACCOUNT_IDS: 'app-review-sam' }), /must be account ids/);
});

test('voided purchases are listed with Google, subscriptions included, following its pages', async () => {
  const pages = {
    first: { voidedPurchases: [{ purchaseToken: 'opaque.token-1', orderId: 'GPA.1', voidedTimeMillis: '1791633600000' }], tokenPagination: { nextPageToken: 'page-2' } },
    'page-2': { voidedPurchases: [{ purchaseToken: 'opaque.token-2', orderId: 'GPA.2', voidedTimeMillis: '1791633600000' }] },
  };
  const google = fakeGoogle((url) => {
    if (tokenEndpoint(url)) return { status: 200, body: { access_token: 'ya29.fake', expires_in: 3600 } };
    const query = new URL(url).searchParams;
    return { status: 200, body: pages[query.get('pageSelection.token') || 'first'] };
  });
  const api = new GooglePlayDeveloperApi({ serviceAccount, packageName: 'com.togetherledger.ledger', fetch: google.fetch });
  const voided = await api.voidedPurchases({ since: 1791547200000 });
  assert.deepEqual(voided.map((entry) => entry.purchaseToken), ['opaque.token-1', 'opaque.token-2']);
  const [first, second] = google.calls.filter((call) => !tokenEndpoint(call.url)).map((call) => new URL(call.url));
  assert.equal(first.pathname, '/androidpublisher/v3/applications/com.togetherledger.ledger/purchases/voidedpurchases');
  assert.equal(first.searchParams.get('type'), '1', 'subscriptions as well as one-time products');
  assert.equal(first.searchParams.get('startTime'), '1791547200000');
  assert.equal(second.searchParams.get('pageSelection.token'), 'page-2');
  assert.equal(second.searchParams.get('startTime'), null, 'Google ignores the start once it gives a page');
});

// --- Pub/Sub push authentication (#273) ---------------------------------------------------------

const PUSHED = Date.parse('2026-10-10T12:00:00Z');

test('a push is accepted only with Google’s signature, our audience and our push service account', async () => {
  const keys = googleKeys();
  let clock = PUSHED;
  const verifier = new GooglePushVerifier({ audience: PUSH_AUDIENCE, serviceAccountEmail: PUSH_EMAIL, fetch: keys.fetch, now: () => clock });
  const key = keys.current();
  const claims = await verifier.verify(`Bearer ${pushToken(key, {}, { now: clock })}`);
  assert.equal(claims.email, PUSH_EMAIL);
  assert.deepEqual(keys.calls, [GOOGLE_KEYS_URL]);

  const stranger = keys.rotate({ publish: false });
  const genuine = pushToken(key, {}, { now: clock });
  const [head, body] = genuine.split('.');
  const otherBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), email: 'someone@else.iam.gserviceaccount.com' })).toString('base64url');
  const refusals = {
    'no header': undefined,
    'an empty header': '',
    'not a bearer token': `Basic ${genuine}`,
    'not a token': 'Bearer not-a-token',
    'claims changed after signing': `Bearer ${head}.${otherBody}.${genuine.split('.')[2]}`,
    'signed by a key Google never published': `Bearer ${pushToken({ ...stranger, kid: key.kid }, {}, { now: clock })}`,
    'a key id Google never published': `Bearer ${pushToken(stranger, {}, { now: clock })}`,
    'unsigned': `Bearer ${pushToken(key, {}, { now: clock, header: { alg: 'none' } }).split('.').slice(0, 2).join('.')}.`,
    'HS256': `Bearer ${pushToken(key, {}, { now: clock, header: { alg: 'HS256' } })}`,
    'another audience': `Bearer ${pushToken(key, { aud: 'https://example.test/push' }, { now: clock })}`,
    'another service account': `Bearer ${pushToken(key, { email: 'someone@else.iam.gserviceaccount.com' }, { now: clock })}`,
    'an unverified email': `Bearer ${pushToken(key, { email_verified: false }, { now: clock })}`,
    'another issuer': `Bearer ${pushToken(key, { iss: 'https://evil.example' }, { now: clock })}`,
    'expired': `Bearer ${pushToken(key, {}, { now: clock - 2 * 60 * 60 * 1000 })}`,
    'issued in the future': `Bearer ${pushToken(key, {}, { now: clock + 60 * 60 * 1000 })}`,
  };
  for (const [what, authorization] of Object.entries(refusals)) {
    await assert.rejects(verifier.verify(authorization), (error) => error instanceof GooglePushError && error.kind === 'unauthenticated', what);
  }
  assert.equal(keys.calls.length, 1, 'an unknown key id within a minute of reading the keys reads nothing more');

  // Google rotates its keys: a key id we don't hold reads them again, at most once a minute.
  clock += 61 * 1000;
  const rotated = keys.rotate();
  await verifier.verify(`Bearer ${pushToken(rotated, {}, { now: clock })}`);
  assert.equal(keys.calls.length, 2);
  await assert.rejects(verifier.verify(`Bearer ${pushToken(keys.rotate({ publish: false }), {}, { now: clock })}`), (error) => error.reason === 'unknown key');
  assert.equal(keys.calls.length, 2);

  // With either setting empty, nothing is accepted.
  for (const settings of [{ audience: '', serviceAccountEmail: PUSH_EMAIL }, { audience: PUSH_AUDIENCE, serviceAccountEmail: '' }]) {
    const unset = new GooglePushVerifier({ ...settings, fetch: keys.fetch, now: () => clock });
    await assert.rejects(unset.verify(`Bearer ${pushToken(key, {}, { now: clock })}`), (error) => error.kind === 'unauthenticated' && error.reason === 'not configured');
  }
});

test('Google’s keys are kept for as long as Google says, and a push is retried when they can’t be read', async () => {
  const keys = googleKeys();
  let clock = PUSHED;
  const verifier = new GooglePushVerifier({ audience: PUSH_AUDIENCE, serviceAccountEmail: PUSH_EMAIL, fetch: keys.fetch, now: () => clock });
  keys.state.available = false;
  await assert.rejects(verifier.verify(`Bearer ${pushToken(keys.current(), {}, { now: clock })}`), (error) => error.kind === 'unavailable');

  keys.state.available = true;
  clock += 61 * 1000;
  await verifier.verify(`Bearer ${pushToken(keys.current(), {}, { now: clock })}`);
  const fetched = keys.calls.length;
  clock += 30 * 60 * 1000;
  await verifier.verify(`Bearer ${pushToken(keys.current(), {}, { now: clock })}`);
  assert.equal(keys.calls.length, fetched, 'held for the hour Google’s Cache-Control gives');
  clock += 31 * 60 * 1000;
  await verifier.verify(`Bearer ${pushToken(keys.current(), {}, { now: clock })}`);
  assert.equal(keys.calls.length, fetched + 1, 'and read again after it');
});

test('Google Play notifications are off until both push settings are set, and a bad email stops the server', () => {
  const plain = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(plain.googlePlayNotifications, { audience: '', serviceAccountEmail: '' });
  const set = loadConfig({ NODE_ENV: 'test', GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE: ` ${PUSH_AUDIENCE} `, GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL: PUSH_EMAIL.toUpperCase() });
  assert.deepEqual(set.googlePlayNotifications, { audience: PUSH_AUDIENCE, serviceAccountEmail: PUSH_EMAIL });
  assert.throws(() => loadConfig({ GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL: 'play-notifications' }), /GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL/);
});
