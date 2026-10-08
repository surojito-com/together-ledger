import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { GooglePlayDeveloperApi, GooglePlayError, parseServiceAccount } from '../server/store-google.js';
import { appleChain } from './support/apple-signing.js';

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
