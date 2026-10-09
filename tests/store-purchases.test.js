import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { StripeBillingService } from '../server/billing.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { AppleTransactionVerifier } from '../server/store-apple.js';
import { GooglePlayError, GooglePushVerifier } from '../server/store-google.js';
import { passEnd, storeProduct } from '../server/store-products.js';
import { StorePurchaseService } from '../server/store-purchases.js';
import { appleChain, signNotification, signTransaction, transactionPayload } from './support/apple-signing.js';
import { PUSH_AUDIENCE, PUSH_EMAIL, googleKeys, pushBody, pushToken } from './support/google-push.js';

// TL-P-05 (#272): a store purchase becomes capacity only once our server has verified it. Apple's
// signed transactions are checked against a test chain made here (tests/support/apple-signing.js),
// Google's against recorded responses (tests/fixtures/google-play). Synthetic data only.

const MIGRATIONS = [
  '001_platform', '003_private_usernames', '004_shared_moments', '005_make-shared-journeys-more-humane', '006_expand-shared-moment-vocabulary',
  '007_person_specific_moment_visibility', '008_stripe_web_billing', '009_reserve-group-places', '011_hold-one-image-with-each-moment',
  '012_bill-additional-moment-images', '013_name-moment-image-attachments', '014_hold-places-with-shared-moments', '015_bill-additional-moment-places',
  '016_make-extra-image-payments-one-time', '017_keep-one-removed-photo-per-moment', '018_allow-ninety-nine-paid-journey-places',
  '019_let-moments-carry-their-own-atmosphere', '020_let-entitlements-hold-ninety-nine-places', '021_let-unpaid-capacity-rest-without-losing-history',
  '022_agree-together-before-adding-someone', '023_let-a-phone-carry-its-own-key', '024_let-google-and-apple-open-an-account',
  '025_revoke-sign-in-with-apple-when-an-account-is-deleted', '026_remember-a-refused-apple-deletion', '027_tie-every-store-purchase-to-an-account',
  '028_turn-a-store-purchase-into-capacity', '029_rest-read-only-and-let-the-payer-ask-for-time', '030_ask-for-six-weeks-a-year',
  '031_let-a-lost-renewal-reply-be-asked-again', '033_let-a-moment-held-offline-arrive-once', '034_hear-refunds-and-renewals-from-the-stores',
  '035_hear-reversed-refunds-and-refunded-extras',
];
const origin = 'http://127.0.0.1:4174';
const PURCHASED = Date.parse('2026-10-08T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/google-play/${name}.json`, import.meta.url), 'utf8'));

// Google, answering from recorded responses. Each purchase token maps to a response, and every
// acknowledgement and consumption is written down so a test can prove it happened.
class RecordedGooglePlay {
  constructor() {
    this.purchases = new Map();
    this.calls = [];
    this.failNext = [];
    // What purchases.voidedpurchases.list answers, and whether Google can be reached at all.
    this.voided = [];
    this.unreachable = false;
  }

  record(token, response) {
    this.purchases.set(token, response);
  }

  lookUp(token) {
    if (this.unreachable) throw new GooglePlayError('unavailable', 503);
    if (!this.purchases.has(token)) throw new GooglePlayError('not-found', 404);
    return structuredClone(this.purchases.get(token));
  }

  async productPurchase(productId, token) {
    this.calls.push(['get', productId, token]);
    return this.lookUp(token);
  }

  async subscriptionPurchase(token) {
    this.calls.push(['getSubscription', token]);
    return this.lookUp(token);
  }

  async consumeProduct(productId, token) {
    this.calls.push(['consume', productId, token]);
    if (this.failNext.length) throw this.failNext.shift();
    const purchase = this.purchases.get(token);
    purchase.consumptionState = 1;
    purchase.acknowledgementState = 1;
  }

  async acknowledgeSubscription(productId, token) {
    this.calls.push(['acknowledge', productId, token]);
    if (this.failNext.length) throw this.failNext.shift();
    this.purchases.get(token).acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  }

  async voidedPurchases({ since }) {
    this.calls.push(['voided', since]);
    if (this.unreachable) throw new GooglePlayError('unavailable', 503);
    return structuredClone(this.voided);
  }

  acknowledgements() {
    return this.calls.filter(([call]) => call === 'consume' || call === 'acknowledge');
  }
}

async function harness(t, { environment = 'sandbox', now = new Date(PURCHASED + 5 * 60 * 1000) } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  memory.public.registerFunction({ name: 'jsonb_array_length', args: ['jsonb'], returns: 'integer', implementation: (value) => (Array.isArray(value) ? value.length : 0) });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) {
    // Postgres names an unnamed column check `<table>_<column>_check`, which is what migration 028
    // drops to let a slot be 'sandbox'. pg-mem names it `<table>_constraint_<n>` instead, so here
    // the old check is dropped by pg-mem's name just before 028 runs. tests/postgres-integration
    // runs 028 itself against real Postgres.
    if (name.startsWith('028_')) {
      await pool.query('ALTER TABLE moment_image_slots DROP CONSTRAINT IF EXISTS moment_image_slots_constraint_1');
      await pool.query('ALTER TABLE moment_location_slots DROP CONSTRAINT IF EXISTS moment_location_slots_constraint_1');
    }
    // 035 widens 034's outcome check, which Postgres names billing_store_notifications_outcome_check
    // and pg-mem `<table>_constraint_3`. The same thing as for 028: pg-mem's name is dropped first.
    if (name.startsWith('035_')) await pool.query('ALTER TABLE billing_store_notifications DROP CONSTRAINT IF EXISTS billing_store_notifications_constraint_3');
    // pg-mem cannot parse NOT VALID (030); tests/postgres-integration runs 030 as written.
    await pool.query((await readFile(new URL(`../server/migrations/${name}.sql`, import.meta.url), 'utf8')).replace(') NOT VALID;', ');'));
    // Postgres lets a NULL through a CHECK (`environment IN (…)` is unknown, not false), and a Google
    // notification about no purchase we hold has no environment. pg-mem refuses it, so here the same
    // check is restated in a form pg-mem reads the same way. tests/postgres-integration runs 034 as written.
    if (name.startsWith('034_')) {
      await pool.query('ALTER TABLE billing_store_notifications DROP CONSTRAINT IF EXISTS billing_store_notifications_constraint_2');
      await pool.query("ALTER TABLE billing_store_notifications ADD CONSTRAINT billing_store_notifications_environment CHECK (environment IS NULL OR environment IN ('sandbox','live'))");
    }
  }

  const chain = appleChain();
  const settings = {
    NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    JOURNEY_CAPACITY_MODE: 'billing', STORE_ENVIRONMENT: environment, APPLE_ROOT_CERTIFICATES: chain.rootBase64,
    GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE: PUSH_AUDIENCE, GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL: PUSH_EMAIL,
  };
  const config = loadConfig(settings);
  // Account ids exist only once people register, so a test sets the ones that depend on them
  // afterwards, through the same parsing the server uses.
  const configure = (overrides) => Object.assign(config, loadConfig({ ...settings, ...overrides }));
  const clock = { now };
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => clock.now });
  const google = new RecordedGooglePlay();
  const keys = googleKeys();
  const logged = [];
  const store = new StorePurchaseService({
    pool, config, now: () => clock.now, google, history: (client, event) => platform.appendEvent(client, event),
    googlePush: new GooglePushVerifier({ ...config.googlePlayNotifications, fetch: keys.fetch, now: () => clock.now.getTime() }),
    apple: new AppleTransactionVerifier({ rootCertificates: config.appleRootCertificates }),
    log: (level, message, fields) => logged.push({ level, message, ...fields }),
  });
  const app = await buildApp({ platform, config, store });
  t.after(async () => { await app.close(); await pool.end(); });

  async function person(name) {
    const email = `${name}@example.test`;
    const { user } = await platform.register({ email, username: name, password: 'a long enough password' }, origin, { issueSession: false });
    await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
    const { token } = await platform.issueTokens(user.id);
    return { id: user.id, token };
  }
  const journey = (owner, name = 'Ours') => platform.createJourney(owner.id, { name, location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const identity = (holder, journeyId) => platform.storePurchaseIdentity(holder.id, journeyId);
  // Someone else in the journey, added directly: how they arrived is not what these tests are about.
  async function join(journeyId, holder) {
    await pool.query("INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,'member',$3)", [journeyId, holder.id, clock.now]);
  }
  async function moment(holder, journeyId, title = 'The walk along the canal') {
    return platform.createMoment(holder.id, journeyId, { kind: 'memory', title, detail: '', occurredOn: '2026-10-01', visibility: 'shared-now', moneyCents: null, moneyCurrency: '', locations: [] });
  }
  const capacity = async (journeyId) => {
    const client = await pool.connect();
    try {
      return await platform.capacityFor(client, journeyId);
    } finally {
      client.release();
    }
  };
  const entitlements = async (journeyId) => (await pool.query(
    'SELECT source,environment,source_record_id,state,quantity,effective_at,expires_at FROM billing_entitlements WHERE journey_id=$1 ORDER BY effective_at,source_record_id',
    [journeyId],
  )).rows;
  const apple = (holder, jws, extra = {}) => app.inject({
    method: 'POST', url: '/api/v1/billing/store-purchases/apple',
    headers: { authorization: `Bearer ${holder.token}`, 'x-together-client': 'app' },
    payload: { signedTransaction: jws, ...extra },
  });
  const googleRoute = (holder, payload) => app.inject({
    method: 'POST', url: '/api/v1/billing/store-purchases/google',
    headers: { authorization: `Bearer ${holder.token}`, 'x-together-client': 'app' },
    payload,
  });
  const signed = (payload, options) => signTransaction(chain, transactionPayload(payload), options);
  // What Apple's servers send afterwards (#273): no account, no origin, only the signed payload.
  const notify = (signedPayload) => app.inject({ method: 'POST', url: '/api/v1/billing/store-notifications/apple', payload: { signedPayload } });
  const notification = (fields, options) => signNotification(chain, fields, options);
  const notes = async () => (await pool.query('SELECT * FROM billing_store_notifications ORDER BY received_at,notification_id')).rows;
  // What Pub/Sub pushes for Google Play (#273): a DeveloperNotification inside a message, with the
  // OIDC token Pub/Sub signs for our push subscription.
  const pushedBy = (claims = {}) => `Bearer ${pushToken(keys.current(), claims, { now: clock.now.getTime() })}`;
  const play = (fields, { messageId, authorization = pushedBy(), packageName = 'com.togetherledger.ledger' } = {}) => app.inject({
    method: 'POST', url: '/api/v1/billing/store-notifications/google',
    headers: authorization === null ? {} : { authorization },
    payload: pushBody({ version: '1.0', packageName, eventTimeMillis: String(clock.now.getTime()), ...fields }, { messageId }),
  });
  return { pool, platform, store, google, keys, logged, clock, configure, person, journey, identity, join, moment, capacity, entitlements, apple, googleRoute, signed, chain, notify, notification, notes, play, pushedBy };
}

async function googleRecord(name, ids, overrides = {}) {
  const record = { ...await fixture(name), ...overrides };
  if (record.externalAccountIdentifiers) {
    record.externalAccountIdentifiers = { obfuscatedExternalAccountId: ids.obfuscatedAccountId, obfuscatedExternalProfileId: ids.obfuscatedProfileId };
  } else {
    record.obfuscatedExternalAccountId = ids.obfuscatedAccountId;
    record.obfuscatedExternalProfileId = ids.obfuscatedProfileId;
  }
  return record;
}

// --- Apple ---------------------------------------------------------------------------------------

test('a verified App Store pass makes room once, and sending it again grants nothing more', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const alex = await h.person('alex-joins');
  await h.join(ours.id, alex);
  assert.equal((await h.capacity(ours.id)).canInvite, false, 'two people fill a free journey');

  const { appAccountToken } = await h.identity(sam, ours.id);
  const jws = h.signed({ appAccountToken });
  const first = await h.apple(sam, jws);
  assert.equal(first.statusCode, 201, first.body);
  const granted = first.json().data;
  assert.equal(granted.granted, true);
  assert.equal(granted.kind, 'pass');
  assert.equal(granted.environment, 'sandbox');
  assert.equal(granted.room.people, 51);
  assert.equal(granted.room.from, h.clock.now.toISOString(), 'a pass starts when it is honoured');
  assert.equal(granted.room.until, new Date(h.clock.now.getTime() + 7 * DAY).toISOString(), 'a week pass lasts seven days');
  assert.equal((await h.capacity(ours.id)).canInvite, true, 'the journey now has room');

  const again = await h.apple(sam, jws);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().data.granted, false);
  assert.deepEqual(again.json().data.room, granted.room);
  const rows = await h.entitlements(ours.id);
  assert.equal(rows.length, 1, 'one transaction, one grant');
  assert.equal(rows[0].source, 'apple');
  assert.equal(rows[0].quantity, 49, 'room for 51 is 49 beyond the included two');
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM billing_store_purchases')).rows[0].n, 1);

  // Two sent at the same moment are tested against real Postgres (tests/postgres-integration.test.js),
  // whose unique index is what decides that race; pg-mem does not run transactions concurrently.
});

test('a forged or tampered transaction is refused, and nothing is written', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const genuine = h.signed({ appAccountToken });
  const [head, , signature] = genuine.split('.');
  const bigger = Buffer.from(JSON.stringify(transactionPayload({ appAccountToken, productId: 'room_101_month_pass' }))).toString('base64url');

  const attempts = {
    'a payload changed after signing': `${head}.${bigger}.${signature}`,
    'a chain that ends at someone else’s root': signTransaction(appleChain(), transactionPayload({ appAccountToken })),
    'a leaf that is not an App Store signing certificate': signTransaction(appleChain({ leafMarker: null }), transactionPayload({ appAccountToken })),
    'an unsigned token': `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${bigger}.`,
    'a token with no chain': signTransaction(h.chain, transactionPayload({ appAccountToken }), { header: { x5c: [] } }),
    'not a token at all': 'not-a-signed-transaction',
    'a header that is null': `${Buffer.from('null').toString('base64url')}.${bigger}.${signature}`,
    'a payload that is a list': `${head}.${Buffer.from('[1]').toString('base64url')}.${signature}`,
  };
  for (const [what, jws] of Object.entries(attempts)) {
    const answer = await h.apple(sam, jws);
    assert.equal(answer.statusCode, 400, what);
    assert.equal(answer.json().error.code, 'store_purchase_unverified', what);
    assert.equal(answer.json().error.details.retryable, false, what);
  }
  // A leaf from a chain we trust, but one that lacks Apple's marker, is the same refusal.
  const markerless = appleChain({ leafMarker: null });
  const trusting = new AppleTransactionVerifier({ rootCertificates: [...h.store.apple.roots, ...loadConfig({ APPLE_ROOT_CERTIFICATES: markerless.rootBase64 }).appleRootCertificates] });
  assert.throws(() => trusting.verify(signTransaction(markerless, transactionPayload({ appAccountToken }))), /not an App Store signing certificate/);
  assert.equal((await h.entitlements(ours.id)).length, 0);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM billing_store_purchases')).rows[0].n, 0);
  assert.ok(h.logged.every((line) => line.code === 'store_purchase_unverified'));
});

test('a sandbox purchase never becomes live capacity, and a live one never becomes test capacity', async (t) => {
  const live = await harness(t, { environment: 'live' });
  const sam = await live.person('sam-buyer');
  const ours = await live.journey(sam);
  const { appAccountToken } = await live.identity(sam, ours.id);
  const sandbox = await live.apple(sam, live.signed({ appAccountToken, environment: 'Sandbox' }));
  assert.equal(sandbox.statusCode, 409);
  assert.equal(sandbox.json().error.code, 'store_environment_mismatch');
  assert.match(sandbox.json().error.message, /test purchase/);
  assert.equal((await live.entitlements(ours.id)).length, 0);
  const real = await live.apple(sam, live.signed({ appAccountToken, environment: 'Production' }));
  assert.equal(real.statusCode, 201, real.body);
  assert.equal(real.json().data.environment, 'live');

  const test = await harness(t, { environment: 'sandbox' });
  const ana = await test.person('ana-buyer');
  const hers = await test.journey(ana);
  const token = (await test.identity(ana, hers.id)).appAccountToken;
  const production = await test.apple(ana, test.signed({ appAccountToken: token, environment: 'Production' }));
  assert.equal(production.json().error.code, 'store_environment_mismatch');
  assert.equal((await test.entitlements(hers.id)).length, 0);
});

test('on a live service, a sandbox purchase counts only for an allowed tester, and only for what they paid for', async (t) => {
  const h = await harness(t, { environment: 'live' });
  const sam = await h.person('app-review-sam');
  const alex = await h.person('alex-joins');
  const lee = await h.person('lee-other');
  h.configure({ STORE_SANDBOX_ACCOUNT_IDS: ` ${sam.id.toUpperCase()} ` });
  assert.deepEqual(h.store.config.storeSandboxAccountIds, [sam.id]);
  const samsJourney = await h.journey(sam);
  await h.join(samsJourney.id, alex);
  const samsIds = await h.identity(sam, samsJourney.id);
  const leesJourney = await h.journey(lee);
  await h.join(leesJourney.id, alex);
  const leesIds = await h.identity(lee, leesJourney.id);

  // The tester's sandbox pass is honoured, recorded as sandbox, and makes room.
  const pass = await h.apple(sam, h.signed({ appAccountToken: samsIds.appAccountToken, environment: 'Sandbox' }));
  assert.equal(pass.statusCode, 201, pass.body);
  assert.equal(pass.json().data.environment, 'sandbox');
  assert.equal((await h.entitlements(samsJourney.id))[0].environment, 'sandbox');
  assert.equal((await h.capacity(samsJourney.id)).canInvite, true);

  // Anyone else's sandbox purchase is refused exactly as before, and logged.
  const refused = await h.apple(lee, h.signed({ appAccountToken: leesIds.appAccountToken, environment: 'Sandbox', transactionId: 'lee-sandbox' }));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, 'store_environment_mismatch');
  assert.equal((await h.entitlements(leesJourney.id)).length, 0);
  assert.ok(h.logged.some((line) => line.code === 'store_environment_mismatch' && line.transactionId === 'lee-sandbox'));
  // Signing in as the tester changes nothing about someone else's purchase.
  const borrowed = await h.apple(sam, h.signed({ appAccountToken: leesIds.appAccountToken, environment: 'Sandbox', transactionId: 'lee-sandbox' }));
  assert.equal(borrowed.json().error.code, 'store_purchase_other_account');

  // A sandbox row paid for by anyone not on the list is never read as room, whoever's journey it is in.
  await h.pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,created_at,updated_at)
     VALUES ('88888888-8888-4888-8888-888888888888',$1,$2,'additional-journey-capacity','apple','sandbox','slipped-in','active',49,$3,$4,$3,$3,$3)`,
    [lee.id, leesJourney.id, h.clock.now, new Date(h.clock.now.getTime() + 7 * DAY)],
  );
  assert.equal((await h.capacity(leesJourney.id)).canInvite, false);

  // A tester's sandbox extra photo can be spent; real purchases still work as ever.
  const walk = await h.moment(sam, samsJourney.id);
  const photo = await h.apple(sam, h.signed({ appAccountToken: samsIds.appAccountToken, environment: 'Sandbox', transactionId: 'sam-photo', productId: 'extra_photo', type: 'Consumable' }), { momentId: walk.id });
  assert.equal(photo.statusCode, 201, photo.body);
  const [slotId] = photo.json().data.extra.slotIds;
  assert.deepEqual(await h.platform.imageSlots(sam.id, samsJourney.id, walk.id), [{ id: slotId, state: 'active' }]);
  const bytes = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  await h.platform.uploadMomentImage(sam.id, samsJourney.id, walk.id, 'image/jpeg', bytes);
  await h.platform.uploadMomentImage(sam.id, samsJourney.id, walk.id, 'image/jpeg', bytes, slotId);
  const real = await h.apple(lee, h.signed({ appAccountToken: leesIds.appAccountToken, environment: 'Production', transactionId: 'lee-real' }));
  assert.equal(real.statusCode, 201, real.body);
  assert.equal(real.json().data.environment, 'live');

  // Google: a licence tester's purchase by the tester is granted and acknowledged; anyone else's is
  // refused and never acknowledged.
  h.google.record('tok-sam-test', await googleRecord('product-pass', samsIds));
  h.google.record('tok-lee-test', await googleRecord('product-pass', leesIds));
  const samsGoogle = await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'tok-sam-test' });
  assert.equal(samsGoogle.statusCode, 201, samsGoogle.body);
  assert.equal(samsGoogle.json().data.environment, 'sandbox');
  assert.equal(samsGoogle.json().data.acknowledgement, 'done');
  const leesGoogle = await h.googleRoute(lee, { productId: 'room_101_week_pass', purchaseToken: 'tok-lee-test' });
  assert.equal(leesGoogle.json().error.code, 'store_environment_mismatch');
  assert.deepEqual(h.google.acknowledgements(), [['consume', 'room_101_week_pass', 'tok-sam-test']]);
});

test('a purchase that names no account of ours is refused and logged, and so is one for someone else', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);

  for (const token of [undefined, '00000000-0000-4000-8000-000000000000']) {
    const answer = await h.apple(sam, h.signed({ appAccountToken: token }));
    assert.equal(answer.statusCode, 409);
    assert.equal(answer.json().error.code, 'store_purchase_unlinked');
    assert.match(answer.json().error.message, /reportaproblem\.apple\.com/, 'they were charged, so they are told where a refund comes from');
  }
  assert.equal(h.logged.filter((line) => line.code === 'store_purchase_unlinked').length, 2);
  assert.ok(h.logged.every((line) => line.transactionId === '2000000900000001'), 'the log names the transaction, to find it again');

  // Sam's purchase, sent by someone else's phone: refused, and nothing moves.
  const lee = await h.person('lee-other');
  const elsewhere = await h.apple(lee, h.signed({ appAccountToken }));
  assert.equal(elsewhere.json().error.code, 'store_purchase_other_account');
  assert.equal((await h.entitlements(ours.id)).length, 0);
  assert.ok(h.logged.some((line) => line.code === 'store_purchase_other_account'));
});

test('only what Together Ledger sells, for this app, unrefunded and the buyer’s own, is honoured', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const cases = [
    [{ bundleId: 'com.example.other' }, 400, 'store_purchase_wrong_app'],
    [{ productId: 'room_1000_lifetime' }, 400, 'store_product_unknown'],
    [{ productId: 'room_51_monthly', type: 'Non-Renewing Subscription' }, 400, 'store_product_unknown'],
    [{ revocationDate: PURCHASED + 60_000 }, 409, 'store_purchase_refunded'],
    [{ inAppOwnershipType: 'FAMILY_SHARED' }, 409, 'store_purchase_family_shared'],
    [{ productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: PURCHASED - DAY }, 409, 'store_subscription_ended'],
  ];
  for (const [change, status, code] of cases) {
    const answer = await h.apple(sam, h.signed({ appAccountToken, ...change }));
    assert.equal(answer.statusCode, status, JSON.stringify(change));
    assert.equal(answer.json().error.code, code, JSON.stringify(change));
  }
  assert.equal((await h.entitlements(ours.id)).length, 0);
});

test('a pass bought while another is running starts when that one ends', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const now = h.clock.now.getTime();

  const week = await h.apple(sam, h.signed({ appAccountToken, transactionId: 't-week-1' }));
  const second = await h.apple(sam, h.signed({ appAccountToken, transactionId: 't-week-2' }));
  assert.equal(second.json().data.room.from, week.json().data.room.until, 'the second week follows the first');
  assert.equal(second.json().data.room.until, new Date(now + 14 * DAY).toISOString());

  // A month bought now follows both weeks, and runs a calendar month from there.
  const month = await h.apple(sam, h.signed({ appAccountToken, transactionId: 't-month', productId: 'room_51_month_pass' }));
  assert.equal(month.json().data.room.from, new Date(now + 14 * DAY).toISOString());
  assert.equal(month.json().data.room.until, passEnd(storeProduct('room_51_month_pass'), new Date(now + 14 * DAY)).toISOString());

  // Room for 101 is why someone buys it: it starts now, over the smaller passes.
  const bigger = await h.apple(sam, h.signed({ appAccountToken, transactionId: 't-big', productId: 'room_101_week_pass' }));
  assert.equal(bigger.json().data.room.from, h.clock.now.toISOString());
  const held = await h.pool.query(
    `SELECT quantity FROM billing_entitlements WHERE journey_id=$1 AND state='active' AND effective_at<=$2 AND expires_at>$2 ORDER BY quantity DESC`,
    [ours.id, h.clock.now],
  );
  assert.deepEqual(held.rows.map((row) => row.quantity), [99, 49]);

  // Six days on, the 101 pass still holds everyone; on day fifteen the month pass has taken over
  // from the weeks, and a pass waiting to start never counted early.
  const people = [];
  for (let index = 0; index < 60; index += 1) people.push(await h.person(`journeyer-${index}`));
  for (const person of people) await h.join(ours.id, person);
  h.clock.now = new Date(now + 6 * DAY);
  const during = await h.capacity(ours.id);
  assert.equal(during.restingMemberIds.length, 0, 'the 101 pass still holds all 61');
  h.clock.now = new Date(now + 15 * DAY);
  const after = await h.capacity(ours.id);
  assert.equal(after.restingMemberIds.length, 61 - 51, 'the month pass has started and holds 51; nobody is removed, ten rest');
  await h.pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,created_at,updated_at)
     VALUES ('99999999-9999-4999-8999-999999999999',$1,$2,'additional-journey-capacity','promotion','sandbox','later',$3,99,$4,$5,$6,$6,$6)`,
    [sam.id, ours.id, 'active', new Date(now + 20 * DAY), new Date(now + 30 * DAY), h.clock.now],
  );
  assert.equal((await h.capacity(ours.id)).restingMemberIds.length, 10, 'room that starts later holds nobody yet');
  h.clock.now = new Date(now + 21 * DAY);
  assert.equal((await h.capacity(ours.id)).restingMemberIds.length, 0);
});

test('a pass that runs out gives a grace, and a pass bought during it starts at once', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-lapsed');
  const ours = await h.journey(sam);
  const alex = await h.person('alex-lapsed');
  const kit = await h.person('kit-lapsed');
  await h.join(ours.id, alex);
  await h.join(ours.id, kit);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const now = h.clock.now.getTime();
  await h.apple(sam, h.signed({ appAccountToken, transactionId: 't-lapse-1' }));

  // The week ran out two days ago: 7 days of grace from its end, as for a failed payment.
  h.clock.now = new Date(now + 9 * DAY);
  const waiting = await h.capacity(ours.id);
  assert.equal(waiting.grace?.endsAt, new Date(now + 14 * DAY).toISOString());
  assert.deepEqual(waiting.restingMemberIds, []);

  // The ended week is not running, so a new one does not queue behind it. (A phone's access key
  // lasts 30 minutes, so after nine days it signs in again.)
  const signedIn = { ...sam, token: (await h.platform.issueTokens(sam.id)).token };
  const again = await h.apple(signedIn, h.signed({ appAccountToken, transactionId: 't-lapse-2' }));
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json().data.room.from, h.clock.now.toISOString());
  assert.equal((await h.capacity(ours.id)).grace, null);
});

test('a month pass from the 31st ends on the last day of the next month', () => {
  const month = storeProduct('room_101_month_pass');
  assert.equal(passEnd(month, new Date('2027-01-31T09:30:00Z')).toISOString(), '2027-02-28T09:30:00.000Z');
  assert.equal(passEnd(month, new Date('2028-01-31T09:30:00Z')).toISOString(), '2028-02-29T09:30:00.000Z');
  assert.equal(passEnd(month, new Date('2026-12-15T00:00:00Z')).toISOString(), '2027-01-15T00:00:00.000Z');
  assert.equal(passEnd(storeProduct('room_51_week_pass'), new Date('2026-10-08T12:00:00Z'), 2).toISOString(), '2026-10-22T12:00:00.000Z');
});

test('a subscription resubscribed or upgraded from another journey moves its room there, and the journey it left gets its grace', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const alex = await h.person('alex-joins');
  const ana = await h.person('ana-joins');
  const first = await h.journey(sam, 'First');
  const second = await h.journey(sam, 'Second');
  for (const journey of [first, second]) {
    await h.join(journey.id, alex);
    await h.join(journey.id, ana);
  }
  const firstToken = (await h.identity(sam, first.id)).appAccountToken;
  const secondToken = (await h.identity(sam, second.id)).appAccountToken;
  const monthly = (appAccountToken, transactionId, expiresDate, productId = 'room_51_monthly', transactionReason = 'PURCHASE') => h.signed({
    appAccountToken, transactionId, originalTransactionId: 'sub-moving', productId, type: 'Auto-Renewable Subscription', expiresDate, transactionReason,
  });
  const events = async (journeyId) => (await h.pool.query("SELECT action,summary,after_value FROM journey_events WHERE journey_id=$1 AND action LIKE 'paid_room%' ORDER BY sequence", [journeyId])).rows;

  assert.equal((await h.apple(sam, monthly(firstToken, 'move-1', Date.parse('2026-11-08T12:00:00Z')))).statusCode, 201);
  assert.equal((await h.capacity(first.id)).restingMemberIds.length, 0);

  // Upgraded from the second journey: the room goes there, at its new size.
  const upgraded = await h.apple(sam, monthly(secondToken, 'move-2', Date.parse('2026-11-09T12:00:00Z'), 'room_101_monthly'));
  assert.equal(upgraded.statusCode, 201, upgraded.body);
  assert.equal(upgraded.json().data.journeyId, second.id);
  assert.equal(upgraded.json().data.room.people, 101);
  const subscription = await h.pool.query("SELECT journey_id,payer_user_id,state,quantity FROM billing_entitlements WHERE source_record_id='sub-moving'");
  assert.deepEqual(subscription.rows, [{ journey_id: second.id, payer_user_id: sam.id, state: 'active', quantity: 99 }]);
  assert.equal((await h.capacity(second.id)).restingMemberIds.length, 0);

  // The first journey keeps its room through the usual grace, with invitations waiting, and then rests.
  const grace = await h.pool.query("SELECT state,quantity,expires_at,reason FROM billing_entitlements WHERE journey_id=$1 AND state='grace'", [first.id]);
  assert.equal(grace.rowCount, 1);
  assert.equal(grace.rows[0].quantity, 49);
  assert.equal(grace.rows[0].reason, 'store_subscription_moved');
  assert.equal(new Date(grace.rows[0].expires_at).toISOString(), new Date(h.clock.now.getTime() + 7 * DAY).toISOString());
  const during = await h.capacity(first.id);
  assert.deepEqual([during.restingMemberIds.length, during.canInvite], [0, false]);
  h.clock.now = new Date(h.clock.now.getTime() + 7 * DAY + 60_000);
  assert.equal((await h.capacity(first.id)).restingMemberIds.length, 1, 'after grace, one of three rests; nobody is removed');
  sam.token = (await h.platform.issueTokens(sam.id)).token;

  // Both journeys' records say what happened.
  const left = await events(first.id);
  assert.deepEqual(left.map((event) => event.action), ['paid_room_moved_out']);
  assert.match(left[0].summary, /grace/);
  assert.deepEqual((await events(second.id)).map((event) => event.action), ['paid_room_moved_in']);

  // The older transaction, from the first journey, arriving late takes nothing back.
  const late = await h.apple(sam, monthly(firstToken, 'move-1b', Date.parse('2026-11-08T12:00:00Z'), 'room_51_monthly', 'RENEWAL'));
  assert.ok([200, 201].includes(late.statusCode), late.body);
  assert.equal((await h.pool.query("SELECT journey_id FROM billing_entitlements WHERE source_record_id='sub-moving'")).rows[0].journey_id, second.id);

  // Lapsed, then resubscribed from the first journey: the room comes back there. The second
  // journey's room had already ended, so there is no grace to give, only the record.
  h.clock.now = new Date(Date.parse('2026-11-20T12:00:00Z'));
  sam.token = (await h.platform.issueTokens(sam.id)).token;
  const back = await h.apple(sam, monthly(firstToken, 'move-3', Date.parse('2026-12-20T12:00:00Z')));
  assert.equal(back.statusCode, 201, back.body);
  assert.equal(back.json().data.journeyId, first.id);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM billing_entitlements WHERE journey_id=$1 AND state='grace'", [second.id])).rows[0].n, 0);
  assert.equal((await events(second.id)).at(-1).summary, 'Lapsed paid room renewed for another journey');
});

test('a lapsed subscription that moves to another journey leaves the first one the grace it had left', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-lapsed-mover');
  const alex = await h.person('alex-lapsed-mover');
  const ana = await h.person('ana-lapsed-mover');
  const first = await h.journey(sam, 'First');
  const second = await h.journey(sam, 'Second');
  for (const journey of [first, second]) {
    await h.join(journey.id, alex);
    await h.join(journey.id, ana);
  }
  const firstToken = (await h.identity(sam, first.id)).appAccountToken;
  const secondToken = (await h.identity(sam, second.id)).appAccountToken;
  const monthly = (appAccountToken, transactionId, expiresDate) => h.signed({
    appAccountToken, transactionId, originalTransactionId: 'sub-lapsed-moving', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate,
  });
  assert.equal((await h.apple(sam, monthly(firstToken, 'lapsed-1', Date.parse('2026-11-08T12:00:00Z')))).statusCode, 201);

  // Not renewed: two days past its end the first journey is in its 7 days, and the payer asks
  // for another week, so its grace runs to Nov 22.
  h.clock.now = new Date('2026-11-10T12:00:00Z');
  assert.equal((await h.capacity(first.id)).grace?.endsAt, '2026-11-15T12:00:00.000Z');
  await h.platform.requestMoreGrace(sam.id, first.id);
  assert.equal((await h.capacity(first.id)).grace?.endsAt, '2026-11-22T12:00:00.000Z');

  // Resubscribed from the second journey. The room goes there; the first keeps the time it had
  // left (owner, Oct 8, 2026), not a fresh 7 days and not nothing.
  sam.token = (await h.platform.issueTokens(sam.id)).token;
  const moved = await h.apple(sam, monthly(secondToken, 'lapsed-2', Date.parse('2026-12-10T12:00:00Z')));
  assert.equal(moved.statusCode, 201, moved.body);
  assert.equal(moved.json().data.journeyId, second.id);
  const left = await h.capacity(first.id);
  assert.equal(left.grace?.endsAt, '2026-11-22T12:00:00.000Z', 'the banner stays, with the same end');
  assert.deepEqual(left.restingMemberIds, [], 'nobody rests early');
  assert.equal((await h.capacity(second.id)).grace, null);
  const record = (await h.pool.query("SELECT after_value FROM journey_events WHERE journey_id=$1 AND action='paid_room_moved_out'", [first.id])).rows;
  assert.equal(record[0].after_value.graceUntil, '2026-11-22T12:00:00.000Z');

  h.clock.now = new Date('2026-11-22T12:00:00Z');
  assert.equal((await h.capacity(first.id)).restingMemberIds.length, 1, 'then one of three rests; nobody is removed');
});

test('a renewal extends the subscription whoever holds the journey now; buying it again checks', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const alex = await h.person('alex-joins');
  const ours = await h.journey(sam);
  await h.join(ours.id, alex);
  const ids = await h.identity(sam, ours.id);
  const monthly = (transactionId, expiresDate, transactionReason) => h.signed({
    appAccountToken: ids.appAccountToken, transactionId, originalTransactionId: 'sub-renewing', productId: 'room_51_monthly',
    type: 'Auto-Renewable Subscription', expiresDate, transactionReason,
  });
  assert.equal((await h.apple(sam, monthly('renew-1', Date.parse('2026-11-08T12:00:00Z'), 'PURCHASE'))).statusCode, 201);
  h.google.record('tok-renewing', await googleRecord('subscription-active', ids));
  assert.equal((await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'tok-renewing' })).statusCode, 201);

  // Sam hands the journey to Alex, and keeps paying.
  await h.platform.transferOwnership(sam.id, ours.id, alex.id);

  const renewed = await h.apple(sam, monthly('renew-2', Date.parse('2026-12-08T12:00:00Z'), 'RENEWAL'));
  assert.equal(renewed.statusCode, 201, renewed.body);
  assert.equal(renewed.json().data.room.until, '2026-12-08T12:00:00.000Z');
  // Google's renewal keeps its token, and is the same.
  const googleRenewal = await googleRecord('subscription-active', ids);
  googleRenewal.lineItems = [{ ...googleRenewal.lineItems[0], expiryTime: '2026-12-08T12:00:00.000Z' }];
  h.google.record('tok-renewing', googleRenewal);
  const googleRenewed = await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'tok-renewing' });
  assert.equal(googleRenewed.statusCode, 200, googleRenewed.body);
  assert.equal(googleRenewed.json().data.room.until, '2026-12-08T12:00:00.000Z');

  // Buying it again (an upgrade, a resubscription) is a purchase, and Sam no longer holds the journey.
  const rebought = await h.apple(sam, h.signed({
    appAccountToken: ids.appAccountToken, transactionId: 'renew-3', originalTransactionId: 'sub-renewing', productId: 'room_101_monthly',
    type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2027-01-08T12:00:00Z'), transactionReason: 'PURCHASE',
  }));
  assert.equal(rebought.json().error.code, 'store_purchase_not_owner');
  // A "renewal" of a subscription never granted here is a first purchase, and checked as one.
  const stranger = await h.apple(sam, h.signed({
    appAccountToken: ids.appAccountToken, transactionId: 'renew-4', originalTransactionId: 'sub-unknown', productId: 'room_51_monthly',
    type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL',
  }));
  assert.equal(stranger.json().error.code, 'store_purchase_not_owner');
});

test('the web billing page shows only the web’s own entitlement', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  await h.apple(sam, h.signed({ appAccountToken }));
  await h.apple(sam, h.signed({ appAccountToken, transactionId: 'queued-week' }));
  const web = new StripeBillingService({ pool: h.pool, config: h.store.config, stripe: {}, now: () => h.clock.now });
  assert.equal((await web.status(sam.id, ours.id)).entitlement, null);
});

test('a monthly subscription is one entitlement that only moves forward as it renews', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const monthly = (transactionId, expiresDate, productId = 'room_51_monthly') => h.signed({
    appAccountToken, transactionId, originalTransactionId: 'sub-original', productId, type: 'Auto-Renewable Subscription', expiresDate,
  });
  const firstEnd = Date.parse('2026-11-08T12:00:00Z');
  const first = await h.apple(sam, monthly('sub-1', firstEnd));
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().data.room.until, new Date(firstEnd).toISOString());

  const renewedEnd = Date.parse('2026-12-08T12:00:00Z');
  const renewal = await h.apple(sam, monthly('sub-2', renewedEnd, 'room_101_monthly'));
  assert.equal(renewal.statusCode, 201, renewal.body);
  assert.equal(renewal.json().data.room.people, 101, 'an upgrade is the same subscription at a new size');
  assert.equal(renewal.json().data.room.until, new Date(renewedEnd).toISOString());

  // The first renewal's transaction arriving late shortens nothing.
  const late = await h.apple(sam, monthly('sub-1', firstEnd));
  assert.equal(late.statusCode, 200);
  const rows = await h.entitlements(ours.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_record_id, 'sub-original');
  assert.equal(new Date(rows[0].expires_at).toISOString(), new Date(renewedEnd).toISOString());
  assert.equal(rows[0].quantity, 99);
});

test('only the person who holds the journey makes room in it; anyone in it can buy an extra', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const alex = await h.person('alex-joins');
  const ours = await h.journey(sam);
  await h.join(ours.id, alex);
  const { appAccountToken } = await h.identity(alex, ours.id);
  const room = await h.apple(alex, h.signed({ appAccountToken }));
  assert.equal(room.json().error.code, 'store_purchase_not_owner');
  assert.equal((await h.entitlements(ours.id)).length, 0);

  const walk = await h.moment(sam, ours.id);
  const photo = await h.apple(alex, h.signed({ appAccountToken, transactionId: 'alex-photo', productId: 'extra_photo', type: 'Consumable' }), { momentId: walk.id });
  assert.equal(photo.statusCode, 201, photo.body);
});

test('an extra photo is room for one more photo on its moment, for good', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const walk = await h.moment(sam, ours.id);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const photo = (extra) => h.apple(sam, h.signed({ appAccountToken, transactionId: 'photo-1', productId: 'extra_photo', type: 'Consumable' }), extra);

  const unplaced = await photo({});
  assert.equal(unplaced.statusCode, 400);
  assert.equal(unplaced.json().error.code, 'store_extra_needs_moment');
  assert.equal(unplaced.json().error.details.retryable, true, 'the phone keeps the purchase and asks which moment');
  const gone = await photo({ momentId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(gone.json().error.code, 'store_extra_moment_missing');

  const answer = await photo({ momentId: walk.id });
  assert.equal(answer.statusCode, 201, answer.body);
  const { extra } = answer.json().data;
  assert.equal(extra.kind, 'photo');
  assert.equal(extra.momentId, walk.id);
  assert.equal(extra.slotIds.length, 1);
  assert.deepEqual(await h.platform.imageSlots(sam.id, ours.id, walk.id), [{ id: extra.slotIds[0], state: 'active' }]);

  const bytes = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  await h.platform.uploadMomentImage(sam.id, ours.id, walk.id, 'image/jpeg', bytes);
  await assert.rejects(h.platform.uploadMomentImage(sam.id, ours.id, walk.id, 'image/jpeg', bytes), (error) => error.code === 'included_image_already_used');
  await h.platform.uploadMomentImage(sam.id, ours.id, walk.id, 'image/jpeg', bytes, extra.slotIds[0]);
  await assert.rejects(h.platform.uploadMomentImage(sam.id, ours.id, walk.id, 'image/jpeg', bytes, extra.slotIds[0]), (error) => error.code === 'image_payment_required', 'one purchase, one photo');
  await assert.rejects(h.platform.uploadMomentImage(sam.id, ours.id, walk.id, 'image/jpeg', bytes, 'not-a-slot'), (error) => error.code === 'image_payment_required');

  // Sending it again, even naming another moment, moves nothing.
  const other = await h.moment(sam, ours.id, 'Another evening');
  const again = await photo({ momentId: other.id });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().data.extra.momentId, walk.id);
});

test('an extra place counts as a paid place on its moment', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const walk = await h.moment(sam, ours.id);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const web = new StripeBillingService({ pool: h.pool, config: h.store.config, stripe: {} });
  await assert.rejects(web.assertLocationCapacity(sam.id, ours.id, walk.id, 2), (error) => error.code === 'location_payment_required');
  const place = await h.apple(sam, h.signed({ appAccountToken, transactionId: 'place-1', productId: 'extra_place', type: 'Consumable' }), { momentId: walk.id });
  assert.equal(place.statusCode, 201, place.body);
  assert.equal(place.json().data.extra.kind, 'place');
  await web.assertLocationCapacity(sam.id, ours.id, walk.id, 2);
});

test('an account with a store pass can still be deleted, and the record of the purchase stays', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  assert.equal((await h.apple(sam, h.signed({ appAccountToken }))).statusCode, 201);
  await h.platform.deleteAccount(sam.id, 'a long enough password');
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM journeys WHERE id=$1', [ours.id])).rows[0].n, 0);
  const kept = await h.pool.query('SELECT journey_id,product_id FROM billing_store_purchases');
  assert.deepEqual(kept.rows, [{ journey_id: ours.id, product_id: 'room_51_week_pass' }]);
});

// --- Google --------------------------------------------------------------------------------------

test('a Google Play subscription is checked with Google, granted, then acknowledged', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  h.google.record('token-sub-1', await googleRecord('subscription-active', ids));

  const answer = await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'token-sub-1' });
  assert.equal(answer.statusCode, 201, answer.body);
  const data = answer.json().data;
  assert.equal(data.store, 'google');
  assert.equal(data.room.people, 51);
  assert.equal(data.room.until, '2026-11-08T12:00:00.000Z');
  assert.equal(data.acknowledgement, 'done');
  assert.deepEqual(h.google.acknowledgements(), [['acknowledge', 'room_51_monthly', 'token-sub-1']]);
  const row = (await h.pool.query('SELECT acknowledgement,acknowledged_at,acknowledge_by FROM billing_store_purchases')).rows[0];
  assert.equal(row.acknowledgement, 'done');
  assert.equal(new Date(row.acknowledge_by).toISOString(), '2026-10-11T12:00:00.000Z', 'three days from the purchase');

  const again = await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'token-sub-1' });
  assert.equal(again.statusCode, 200);
  assert.equal(h.google.acknowledgements().length, 1, 'acknowledged once');
  assert.equal((await h.entitlements(ours.id)).length, 1);
});

test('a Google pass is consumed once granted; if Google cannot be reached, it is retried until it is', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  h.google.record('token-pass-1', await googleRecord('product-pass', ids));
  h.google.failNext.push(new GooglePlayError('unavailable', 503));

  const answer = await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'token-pass-1' });
  assert.equal(answer.statusCode, 201, answer.body);
  assert.equal(answer.json().data.room.people, 101, 'room is granted even while Google is unreachable');
  assert.equal(answer.json().data.acknowledgement, 'pending');
  let row = (await h.pool.query('SELECT * FROM billing_store_purchases')).rows[0];
  assert.equal(row.acknowledgement, 'pending');
  assert.equal(row.acknowledge_attempts, 1);
  assert.equal(row.last_acknowledge_error, 'unavailable 503');
  assert.ok(h.logged.some((line) => line.message === 'google acknowledgement failed, will retry'));

  // Not yet due: nothing is tried.
  assert.deepEqual(await h.store.acknowledgePending(), { acknowledged: 0, retrying: 0 });
  h.clock.now = new Date(h.clock.now.getTime() + 2 * 60 * 1000);
  assert.deepEqual(await h.store.acknowledgePending(), { acknowledged: 1, retrying: 0 });
  row = (await h.pool.query('SELECT * FROM billing_store_purchases')).rows[0];
  assert.equal(row.acknowledgement, 'done');
  assert.deepEqual(h.google.acknowledgements().map(([call]) => call), ['consume', 'consume'], 'a pass is consumed, which acknowledges it and lets it be bought again');
  assert.deepEqual(await h.store.acknowledgePending(), { acknowledged: 0, retrying: 0 });
});

test('a purchase Google has already been told about is not told twice, and a missed window is logged loudly', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);

  // The phone consumed it before telling us: we grant it, and there is nothing left to acknowledge.
  h.google.record('token-consumed', await googleRecord('product-pass', ids, { consumptionState: 1, acknowledgementState: 1 }));
  const consumed = await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'token-consumed' });
  assert.equal(consumed.statusCode, 201, consumed.body);
  assert.equal(consumed.json().data.acknowledgement, 'done');
  assert.equal(h.google.acknowledgements().length, 0);

  // Google says no to acknowledging, and the purchase is still not acknowledged three days on.
  h.google.record('token-late', await googleRecord('product-pass', ids, { orderId: 'GPA.3300-0000-0000-00009' }));
  h.google.failNext.push(new GooglePlayError('unavailable', 500));
  await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'token-late' });
  h.clock.now = new Date(PURCHASED + 3 * DAY + 60_000);
  h.google.failNext.push(new GooglePlayError('unavailable', 500));
  assert.deepEqual(await h.store.acknowledgePending(), { acknowledged: 0, retrying: 1 });
  assert.ok(h.logged.some((line) => line.level === 'error' && line.message === 'google acknowledgement window missed'));
});

test('verification succeeds but our write fails: nothing is acknowledged, and sending it again grants it', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  h.google.record('token-pass-2', await googleRecord('product-pass', ids));
  const query = h.pool.query.bind(h.pool);
  const connect = h.pool.connect.bind(h.pool);
  let broken = true;
  h.pool.connect = async () => {
    const client = await connect();
    const clientQuery = client.query.bind(client);
    client.query = (text, ...rest) => {
      // pg-mem does not roll a transaction back, so the failure here is the grant's first write.
      // A failure midway, and the rollback that undoes it, is tested on real Postgres
      // (tests/postgres-integration.test.js).
      if (broken && typeof text === 'string' && text.includes('INSERT INTO billing_store_purchases')) throw new Error('the database went away');
      return clientQuery(text, ...rest);
    };
    return client;
  };
  t.after(() => { h.pool.connect = connect; h.pool.query = query; });

  const failed = await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'token-pass-2' });
  assert.equal(failed.statusCode, 500);
  assert.equal(h.google.acknowledgements().length, 0, 'Google is never told about a grant that did not happen');
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM billing_store_purchases')).rows[0].n, 0, 'nothing was recorded');

  broken = false;
  const retried = await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'token-pass-2' });
  assert.equal(retried.statusCode, 201, retried.body);
  assert.equal(retried.json().data.acknowledgement, 'done');
  assert.equal(h.google.acknowledgements().length, 1);
});

test('Google purchases that are pending, unknown, mismatched or for testing are refused', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  const other = await h.journey(sam, 'Another');
  const otherIds = await h.identity(sam, other.id);
  const lee = await h.person('lee-other');
  const leeIds = await h.identity(lee, await h.journey(lee).then((journey) => journey.id));

  h.google.record('token-pending', await googleRecord('subscription-pending', ids));
  h.google.record('tok-pend-pass', await googleRecord('product-pass', ids, { purchaseState: 2 }));
  h.google.record('token-canceled', await googleRecord('product-pass', ids, { purchaseState: 1 }));
  h.google.record('token-mixed', await googleRecord('product-pass', { obfuscatedAccountId: leeIds.obfuscatedAccountId, obfuscatedProfileId: ids.obfuscatedProfileId }));
  h.google.record('tok-no-account', await googleRecord('product-pass', { obfuscatedProfileId: ids.obfuscatedProfileId }));
  h.google.record('tok-wrong-prod', await googleRecord('subscription-active', ids));

  const cases = [
    [{ productId: 'room_51_monthly', purchaseToken: 'token-pending' }, 'store_purchase_pending', true],
    [{ productId: 'room_101_week_pass', purchaseToken: 'tok-pend-pass' }, 'store_purchase_pending', true],
    [{ productId: 'room_101_week_pass', purchaseToken: 'token-canceled' }, 'store_purchase_canceled', false],
    [{ productId: 'room_101_week_pass', purchaseToken: 'token-mixed' }, 'store_purchase_unlinked', false],
    [{ productId: 'room_101_week_pass', purchaseToken: 'tok-no-account' }, 'store_purchase_unlinked', false],
    [{ productId: 'room_101_monthly', purchaseToken: 'tok-wrong-prod' }, 'store_purchase_unverified', false],
    [{ productId: 'room_101_week_pass', purchaseToken: 'tok-never-seen' }, 'store_purchase_unverified', false],
    [{ productId: 'room_101_week_pass', purchaseToken: 'token-pending', packageName: 'com.example.other' }, 'store_purchase_wrong_app', false],
    [{ productId: 'gems_1000', purchaseToken: 'token-pending' }, 'store_product_unknown', false],
    [{ productId: 'room_101_week_pass', purchaseToken: 'has spaces' }, 'store_purchase_unverified', false],
  ];
  for (const [payload, code, retryable] of cases) {
    const answer = await h.googleRoute(sam, payload);
    assert.equal(answer.json().error?.code, code, JSON.stringify(payload));
    assert.equal(answer.json().error.details.retryable, retryable, JSON.stringify(payload));
  }
  assert.equal(h.google.acknowledgements().length, 0, 'nothing refused is acknowledged');
  assert.equal((await h.entitlements(ours.id)).length + (await h.entitlements(other.id)).length, 0);
  assert.ok(otherIds.obfuscatedProfileId !== ids.obfuscatedProfileId);

  const live = await harness(t, { environment: 'live' });
  const ana = await live.person('ana-buyer');
  const hers = await live.journey(ana);
  live.google.record('token-test', await googleRecord('product-pass', await live.identity(ana, hers.id)));
  const tester = await live.googleRoute(ana, { productId: 'room_101_week_pass', purchaseToken: 'token-test' });
  assert.equal(tester.json().error.code, 'store_environment_mismatch');
  assert.equal(live.google.acknowledgements().length, 0);
});

test('a Google upgrade ends the room of the subscription it replaces', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  h.google.record('token-51', await googleRecord('subscription-active', ids));
  const upgraded = await googleRecord('subscription-active', ids, { linkedPurchaseToken: 'token-51' });
  upgraded.lineItems = [{ ...upgraded.lineItems[0], productId: 'room_101_monthly' }];
  h.google.record('token-101', upgraded);
  assert.equal((await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'token-51' })).statusCode, 201);
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_monthly', purchaseToken: 'token-101' })).statusCode, 201);
  const rows = await h.pool.query('SELECT source_record_id,state,quantity FROM billing_entitlements WHERE journey_id=$1 ORDER BY source_record_id', [ours.id]);
  assert.deepEqual(rows.rows, [
    { source_record_id: 'token-101', state: 'active', quantity: 99 },
    { source_record_id: 'token-51', state: 'expired', quantity: 49 },
  ]);
  // Sending the old token again, while Google still reports it active, never brings it back.
  assert.equal((await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'token-51' })).statusCode, 200);
  const again = await h.pool.query("SELECT state,reason FROM billing_entitlements WHERE source_record_id='token-51'");
  assert.deepEqual(again.rows, [{ state: 'expired', reason: 'store_subscription_replaced' }]);
});

test('a deferred Google downgrade runs the paid-for size to its end, and a replaced subscription never comes back', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  const big = await googleRecord('subscription-active', ids);
  big.lineItems = [{ ...big.lineItems[0], productId: 'room_101_monthly', expiryTime: '2026-11-08T12:00:00.000Z' }];
  h.google.record('tok-101', big);
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_monthly', purchaseToken: 'tok-101' })).statusCode, 201);

  // Downgraded with DEFERRED replacement: the 51 starts when the paid-for 101 period ends.
  const small = await googleRecord('subscription-active', ids, { linkedPurchaseToken: 'tok-101', startTime: '2026-11-08T12:00:00.000Z' });
  small.lineItems = [{ ...small.lineItems[0], productId: 'room_51_monthly', expiryTime: '2026-12-08T12:00:00.000Z' }];
  h.google.record('tok-51', small);
  assert.equal((await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'tok-51' })).statusCode, 201);
  const rows = async () => (await h.pool.query('SELECT source_record_id,state,quantity,effective_at,expires_at,reason FROM billing_entitlements WHERE journey_id=$1 ORDER BY source_record_id', [ours.id])).rows
    .map((row) => ({ ...row, effective_at: new Date(row.effective_at).toISOString(), expires_at: new Date(row.expires_at).toISOString() }));
  assert.deepEqual(await rows(), [
    { source_record_id: 'tok-101', state: 'active', quantity: 99, effective_at: '2026-10-08T12:00:00.000Z', expires_at: '2026-11-08T12:00:00.000Z', reason: 'store_subscription_replaced' },
    { source_record_id: 'tok-51', state: 'active', quantity: 49, effective_at: '2026-11-08T12:00:00.000Z', expires_at: '2026-12-08T12:00:00.000Z', reason: null },
  ]);
  const held = async () => (await h.pool.query(
    `SELECT quantity FROM billing_entitlements WHERE journey_id=$1 AND state IN ('active','grace') AND effective_at<=$2 AND expires_at>$2 ORDER BY quantity DESC LIMIT 1`,
    [ours.id, h.clock.now],
  )).rows[0]?.quantity;
  assert.equal(await held(), 99, 'the 101 room runs to the end of what was paid for');

  // Google still reports the old token active, and later than before: it stays replaced.
  big.lineItems = [{ ...big.lineItems[0], expiryTime: '2026-12-08T12:00:00.000Z' }];
  h.google.record('tok-101', big);
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_monthly', purchaseToken: 'tok-101' })).statusCode, 200);
  assert.deepEqual((await rows())[0].expires_at, '2026-11-08T12:00:00.000Z');
  assert.equal((await rows())[0].reason, 'store_subscription_replaced');

  h.clock.now = new Date('2026-11-09T12:00:00Z');
  assert.equal(await held(), 49);
  sam.token = (await h.platform.issueTokens(sam.id)).token;

  // A replaced token we had never seen is recorded as replaced, and sending it later grants nothing.
  const after = await googleRecord('subscription-active', ids, { linkedPurchaseToken: 'tok-never-sent', startTime: '2026-11-09T12:00:00.000Z' });
  after.lineItems = [{ ...after.lineItems[0], expiryTime: '2026-12-09T12:00:00.000Z' }];
  h.google.record('tok-after', after);
  assert.equal((await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'tok-after' })).statusCode, 201);
  const unseen = await googleRecord('subscription-active', ids);
  unseen.lineItems = [{ ...unseen.lineItems[0], expiryTime: '2026-12-09T12:00:00.000Z' }];
  h.google.record('tok-never-sent', unseen);
  await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'tok-never-sent' });
  const tombstone = await h.pool.query("SELECT state,quantity,reason FROM billing_entitlements WHERE source_record_id='tok-never-sent'");
  assert.deepEqual(tombstone.rows, [{ state: 'expired', quantity: 0, reason: 'store_subscription_replaced' }]);
});

test('a deferred Google replacement from another journey leaves the old one the usual grace when its period ends', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-deferred');
  const alex = await h.person('alex-deferred');
  const ana = await h.person('ana-deferred');
  const first = await h.journey(sam, 'First');
  const second = await h.journey(sam, 'Second');
  for (const journey of [first, second]) {
    await h.join(journey.id, alex);
    await h.join(journey.id, ana);
  }
  const big = await googleRecord('subscription-active', await h.identity(sam, first.id));
  big.lineItems = [{ ...big.lineItems[0], productId: 'room_101_monthly', expiryTime: '2026-11-08T12:00:00.000Z' }];
  h.google.record('tok-first-101', big);
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_monthly', purchaseToken: 'tok-first-101' })).statusCode, 201);

  // Downgraded from the second journey, deferred: the 51 starts there when the 101 period ends.
  const small = await googleRecord('subscription-active', await h.identity(sam, second.id), { linkedPurchaseToken: 'tok-first-101', startTime: '2026-11-08T12:00:00.000Z' });
  small.lineItems = [{ ...small.lineItems[0], productId: 'room_51_monthly', expiryTime: '2026-12-08T12:00:00.000Z' }];
  h.google.record('tok-second-51', small);
  assert.equal((await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: 'tok-second-51' })).statusCode, 201);
  assert.equal((await h.capacity(first.id)).grace, null, 'the first journey keeps its paid room until the period ends');

  // When the old room ends on the first journey, it has the normal 7 days, then rests.
  h.clock.now = new Date('2026-11-09T12:00:00Z');
  const waiting = await h.capacity(first.id);
  assert.equal(waiting.grace?.endsAt, '2026-11-15T12:00:00.000Z');
  assert.deepEqual(waiting.restingMemberIds, []);
  assert.equal((await h.capacity(second.id)).grace, null, 'the second journey has its new room');
  h.clock.now = new Date('2026-11-15T12:00:00Z');
  assert.equal((await h.capacity(first.id)).restingMemberIds.length, 1);
});

test('one acknowledgement that fails in an unexpected way never holds up the rest', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  h.google.record('tok-first', await googleRecord('product-pass', ids));
  h.google.record('tok-second', await googleRecord('product-pass', ids, { orderId: 'GPA.3300-0000-0000-00010' }));
  h.google.failNext.push(new GooglePlayError('unavailable', 503), new GooglePlayError('unavailable', 503));
  await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'tok-first' });
  await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'tok-second' });
  h.clock.now = new Date(h.clock.now.getTime() + 10 * 60 * 1000);
  // The first row's call blows up with something that is not a Google answer at all.
  h.google.failNext.push(new TypeError('Unexpected token < in JSON'));
  assert.deepEqual(await h.store.acknowledgePending(), { acknowledged: 1, retrying: 1 });
  const rows = (await h.pool.query('SELECT transaction_id,acknowledgement,last_acknowledge_error,next_acknowledge_at FROM billing_store_purchases ORDER BY created_at,transaction_id')).rows;
  const byToken = Object.fromEntries(rows.map((row) => [row.transaction_id, row]));
  assert.equal(byToken['tok-second'].acknowledgement, 'done');
  assert.equal(byToken['tok-first'].acknowledgement, 'pending');
  assert.equal(byToken['tok-first'].last_acknowledge_error, 'TypeError');
  assert.ok(new Date(byToken['tok-first'].next_acknowledge_at) > h.clock.now, 'it waits its turn again, rather than blocking the queue');
});

test('a store that is not configured says so, and asks for the purchase again later', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-buyer');
  const quiet = new StorePurchaseService({ pool: h.pool, config: h.store.config });
  await assert.rejects(quiet.verifyGoogle(sam.id, { productId: 'room_51_monthly', purchaseToken: 'x' }), (error) => error.code === 'store_unavailable' && error.details.retryable === true);
  await assert.rejects(quiet.verifyApple(sam.id, { signedTransaction: 'x' }), (error) => error.code === 'store_unavailable');
  assert.deepEqual(await quiet.acknowledgePending(), { acknowledged: 0, retrying: 0 });
});

// --- What Apple says afterwards (#273) -----------------------------------------------------------

const refundedAt = Date.parse('2026-10-10T12:00:00Z');

test('Apple’s TEST notification is answered and changes nothing', async (t) => {
  const h = await harness(t);
  const answer = await h.notify(h.notification({ notificationType: 'TEST', notificationUUID: 'test-1' }));
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual(answer.json(), { data: { received: true } });
  const [note] = await h.notes();
  assert.equal(note.outcome, 'test');
  assert.equal(note.environment, 'sandbox');
  assert.equal(note.purchase_id, null);
  assert.equal((await h.pool.query('SELECT count(*)::int AS count FROM billing_entitlements')).rows[0].count, 0);
});

test('a refunded App Store pass ends there: the usual grace, then the people beyond two rest, and nobody is removed', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-refund');
  const ours = await h.journey(sam);
  const alex = await h.person('alex-refund');
  const kit = await h.person('kit-refund');
  await h.join(ours.id, alex);
  await h.join(ours.id, kit);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const pass = { appAccountToken, transactionId: 'pass-refunded' };
  const jws = h.signed(pass);
  assert.equal((await h.apple(sam, jws)).statusCode, 201);

  const refund = h.notification({ notificationType: 'REFUND', notificationUUID: 'refund-1', transaction: { ...pass, revocationDate: refundedAt, revocationReason: 0, signedDate: refundedAt } });
  const answer = await h.notify(refund);
  assert.equal(answer.statusCode, 200, answer.body);
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), new Date(refundedAt).toISOString(), 'the room ends when Apple refunded it');
  assert.equal(room.state, 'active', 'and goes through the same grace as a pass that runs out');
  const [note] = await h.notes();
  assert.equal(note.outcome, 'refunded');
  assert.equal(note.notification_type, 'REFUND');
  assert.equal(note.transaction_ref, 'pass-refunded');
  const purchase = (await h.pool.query('SELECT id,revoked_at,revocation FROM billing_store_purchases WHERE transaction_id=$1', ['pass-refunded'])).rows[0];
  assert.equal(note.purchase_id, purchase.id);
  assert.equal(purchase.revocation, 'refunded');
  assert.equal(JSON.stringify(note).includes(appAccountToken), false, 'the log keeps no value of ours from the payload');

  // Two days after the refund: waiting, with five days of grace left. Nobody rests yet.
  h.clock.now = new Date(refundedAt + 2 * DAY);
  const waiting = await h.capacity(ours.id);
  assert.equal(waiting.grace?.endsAt, new Date(refundedAt + 7 * DAY).toISOString());
  assert.equal(waiting.canInvite, false);
  assert.deepEqual(waiting.restingMemberIds, []);

  // After the grace, one of the three rests. All three are still in the journey.
  h.clock.now = new Date(refundedAt + 8 * DAY);
  const after = await h.capacity(ours.id);
  assert.equal(after.grace, null);
  assert.equal(after.restingMemberIds.length, 1);
  assert.equal(after.peopleHere, 3);

  // StoreKit can hand the phone a copy signed before the refund. It grants nothing.
  const signedIn = { ...sam, token: (await h.platform.issueTokens(sam.id)).token };
  const again = await h.apple(signedIn, jws);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().data.granted, false);
  assert.equal((await h.capacity(ours.id)).restingMemberIds.length, 1);
});

test('a notification received twice changes nothing the second time', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-replay');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const monthly = { appAccountToken, transactionId: 'sub-replay-1', originalTransactionId: 'sub-replay', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-11-08T12:00:00Z') };
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);
  const renewal = { ...monthly, transactionId: 'sub-replay-2', purchaseDate: Date.parse('2026-11-08T12:00:00Z'), expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  const renewed = h.notification({ notificationType: 'DID_RENEW', notificationUUID: 'renew-replayed', transaction: renewal });
  assert.equal((await h.notify(renewed)).statusCode, 200);
  const once = await h.entitlements(ours.id);

  // The refund of that renewal arrives, then Apple delivers the renewal again. The second delivery
  // finds its row and moves nothing back.
  const refund = h.notification({ notificationType: 'REFUND', notificationUUID: 'refund-replayed', transaction: { ...renewal, revocationDate: refundedAt } });
  assert.equal((await h.notify(refund)).statusCode, 200);
  const afterRefund = await h.entitlements(ours.id);
  const answer = await h.notify(renewed);
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual(await h.entitlements(ours.id), afterRefund);
  assert.notDeepEqual(afterRefund, once);
  const notes = await h.notes();
  assert.equal(notes.length, 2);
  assert.ok(h.logged.some((line) => line.message === 'store notification received again'));
  // And a refund received twice is as harmless.
  assert.equal((await h.notify(refund)).statusCode, 200);
  assert.deepEqual(await h.entitlements(ours.id), afterRefund);
});

test('a notification that is forged, tampered with or for another app is refused, and nothing is written', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-forged');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const pass = { appAccountToken, transactionId: 'pass-forged' };
  assert.equal((await h.apple(sam, h.signed(pass))).statusCode, 201);
  const before = await h.entitlements(ours.id);
  const refund = { notificationType: 'REFUND', transaction: { ...pass, revocationDate: refundedAt } };

  // Signed by a chain this server was never given.
  const elsewhere = appleChain({ rootName: 'Someone Else Root CA' });
  const forged = await h.notify(signNotification(elsewhere, { ...refund, notificationUUID: 'forged-1' }));
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.json().error.code, 'store_notification_unverified');

  // A real notification with its payload changed after signing.
  const [head, , signature] = h.notification({ ...refund, notificationUUID: 'tampered-1' }).split('.');
  const altered = Buffer.from(JSON.stringify({ notificationType: 'REFUND', notificationUUID: 'tampered-1', data: { bundleId: 'com.togetherledger.ledger', environment: 'Sandbox' }, signedDate: refundedAt })).toString('base64url');
  const tampered = await h.notify(`${head}.${altered}.${signature}`);
  assert.equal(tampered.json().error.code, 'store_notification_unverified');

  // A genuine notification carrying a transaction signed somewhere else.
  const inner = h.notification({ ...refund, notificationUUID: 'inner-1' });
  const decoded = JSON.parse(Buffer.from(inner.split('.')[1], 'base64url').toString());
  decoded.data.signedTransactionInfo = signTransaction(elsewhere, transactionPayload({ ...pass, revocationDate: refundedAt }));
  const repacked = signTransaction(h.chain, decoded);
  assert.equal((await h.notify(repacked)).json().error.code, 'store_notification_unverified');

  // Nothing at all.
  assert.equal((await h.notify(undefined)).json().error.code, 'store_notification_unverified');

  // Another app's notification, and our notification carrying another app's transaction.
  const otherApp = await h.notify(h.notification({ ...refund, notificationUUID: 'other-app-1', bundleId: 'com.example.other' }));
  assert.equal(otherApp.statusCode, 400);
  assert.equal(otherApp.json().error.code, 'store_notification_wrong_app');
  const otherTransaction = await h.notify(h.notification({ ...refund, notificationUUID: 'other-app-2', transaction: { ...refund.transaction, bundleId: 'com.example.other' } }));
  assert.equal(otherTransaction.json().error.code, 'store_notification_wrong_app');

  assert.deepEqual(await h.entitlements(ours.id), before);
  assert.deepEqual(await h.notes(), []);
  assert.ok(h.logged.some((line) => line.message === 'store notification refused' && line.code === 'store_notification_wrong_app'));
});

test('a notification about a purchase we never granted is logged, changes nothing, and goes after 30 days', async (t) => {
  const h = await harness(t);
  const stranger = { appAccountToken: crypto.randomUUID(), transactionId: 'never-sent', revocationDate: refundedAt };
  const answer = await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'unknown-1', transaction: stranger }));
  assert.equal(answer.statusCode, 200, answer.body);
  const [note] = await h.notes();
  assert.equal(note.outcome, 'unknown_purchase');
  assert.equal(note.purchase_id, null);
  assert.equal(note.transaction_ref, 'never-sent');

  h.clock.now = new Date(h.clock.now.getTime() + 31 * DAY);
  await h.notify(h.notification({ notificationType: 'TEST', notificationUUID: 'test-later' }));
  assert.deepEqual((await h.notes()).map((row) => row.notification_id), ['test-later']);
});

test('Apple’s renewal extends the subscription without the phone, and the phone sending it later grants nothing more', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-renews');
  const ours = await h.journey(sam);
  const other = await h.journey(sam, 'Theirs');
  const ids = await h.identity(sam, ours.id);
  const monthly = { appAccountToken: ids.appAccountToken, transactionId: 'sub-renew-1', originalTransactionId: 'sub-renew', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-11-08T12:00:00Z') };
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);

  const renewal = { ...monthly, transactionId: 'sub-renew-2', purchaseDate: Date.parse('2026-11-08T12:00:00Z'), expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  assert.equal((await h.notify(h.notification({ notificationType: 'DID_RENEW', notificationUUID: 'renew-1', transaction: renewal }))).statusCode, 200);
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), '2026-12-08T12:00:00.000Z');
  const recorded = (await h.pool.query('SELECT journey_id,payer_user_id,entitlement_record_id FROM billing_store_purchases WHERE transaction_id=$1', ['sub-renew-2'])).rows[0];
  assert.deepEqual(recorded, { journey_id: ours.id, payer_user_id: sam.id, entitlement_record_id: 'sub-renew' });
  assert.equal((await h.notes())[0].outcome, 'renewed');

  const sent = await h.apple(sam, h.signed(renewal));
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().data.granted, false);
  assert.equal(sent.json().data.room.until, '2026-12-08T12:00:00.000Z');

  // A renewal naming another journey would be a move, and moves are made only when the phone
  // sends the purchase, with its checks.
  const otherToken = (await h.identity(sam, other.id)).appAccountToken;
  const elsewhere = { ...renewal, appAccountToken: otherToken, transactionId: 'sub-renew-3', purchaseDate: Date.parse('2026-12-08T12:00:00Z'), expiresDate: Date.parse('2027-01-08T12:00:00Z') };
  assert.equal((await h.notify(h.notification({ notificationType: 'DID_RENEW', notificationUUID: 'renew-2', transaction: elsewhere }))).statusCode, 200);
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-12-08T12:00:00.000Z');
  assert.deepEqual(await h.entitlements(other.id), []);
  assert.equal((await h.notes()).find((note) => note.notification_id === 'renew-2').outcome, 'unchanged');
});

test('a refund of the latest period ends the subscription there; a refund of a period since paid again changes nothing', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-sub-refund');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const monthly = { appAccountToken, transactionId: 'sub-r-1', originalTransactionId: 'sub-r', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-11-08T12:00:00Z') };
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);
  const second = { ...monthly, transactionId: 'sub-r-2', purchaseDate: Date.parse('2026-11-08T12:00:00Z'), expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  await h.notify(h.notification({ notificationType: 'DID_RENEW', notificationUUID: 'sub-r-renew', transaction: second }));

  // October's period, refunded after November's was paid: the room still runs to December.
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'sub-r-refund-old', transaction: { ...monthly, revocationDate: Date.parse('2026-11-10T00:00:00Z') } }));
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-12-08T12:00:00.000Z');
  assert.equal((await h.notes()).find((note) => note.notification_id === 'sub-r-refund-old').outcome, 'unchanged');

  // November's period, refunded: the room ends at the refund, and the usual grace follows.
  const refundOfLatest = Date.parse('2026-11-12T00:00:00Z');
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'sub-r-refund-new', transaction: { ...second, revocationDate: refundOfLatest } }));
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), new Date(refundOfLatest).toISOString());
  h.clock.now = new Date(refundOfLatest + DAY);
  assert.equal((await h.capacity(ours.id)).grace?.endsAt, new Date(refundOfLatest + 7 * DAY).toISOString());

  // A later renewal is a new payment, and the room runs again.
  const third = { ...monthly, transactionId: 'sub-r-3', purchaseDate: Date.parse('2026-12-08T12:00:00Z'), expiresDate: Date.parse('2027-01-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  await h.notify(h.notification({ notificationType: 'DID_RENEW', notificationUUID: 'sub-r-renew-3', transaction: third }));
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2027-01-08T12:00:00.000Z');
});

test('a refunded renewal the phone never sent is recorded, so sending it later grants nothing', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-unseen');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const monthly = { appAccountToken, transactionId: 'sub-u-1', originalTransactionId: 'sub-u', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-11-08T12:00:00Z') };
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);
  const unseen = { ...monthly, transactionId: 'sub-u-2', purchaseDate: Date.parse('2026-11-08T12:00:00Z'), expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'sub-u-refund', transaction: { ...unseen, revocationDate: Date.parse('2026-11-09T00:00:00Z') } }));
  const recorded = (await h.pool.query('SELECT id,revocation FROM billing_store_purchases WHERE transaction_id=$1', ['sub-u-2'])).rows[0];
  assert.equal(recorded.revocation, 'refunded');
  assert.equal((await h.notes())[0].purchase_id, recorded.id);
  // The October period had already ended at the refund, so it ends at its own date.
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-11-08T12:00:00.000Z');

  h.clock.now = new Date(Date.parse('2026-11-09T00:00:00Z'));
  const signedIn = { ...sam, token: (await h.platform.issueTokens(sam.id)).token };
  const sent = await h.apple(signedIn, h.signed(unseen));
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().data.granted, false);
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-11-08T12:00:00.000Z');
});

test('REVOKE ends room the way a refund does, and a pass that had not started never starts', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-revoked');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const running = { appAccountToken, transactionId: 'week-running' };
  const queued = { appAccountToken, transactionId: 'week-queued' };
  await h.apple(sam, h.signed(running));
  await h.apple(sam, h.signed(queued));
  const revokedAt = h.clock.now.getTime() + DAY;
  await h.notify(h.notification({ notificationType: 'REVOKE', notificationUUID: 'revoke-queued', transaction: { ...queued, revocationDate: revokedAt } }));
  const rows = await h.entitlements(ours.id);
  const queuedRow = rows.find((row) => row.source_record_id === 'week-queued');
  assert.equal(queuedRow.state, 'expired', 'the queued week never starts');
  assert.equal(rows.find((row) => row.source_record_id === 'week-running').state, 'active', 'the running week is untouched');
  assert.equal((await h.notes())[0].outcome, 'revoked');

  await h.notify(h.notification({ notificationType: 'REVOKE', notificationUUID: 'revoke-running', transaction: { ...running, revocationDate: revokedAt } }));
  const runningRow = (await h.entitlements(ours.id)).find((row) => row.source_record_id === 'week-running');
  assert.equal(new Date(runningRow.expires_at).toISOString(), new Date(revokedAt).toISOString());
  assert.equal(runningRow.state, 'active');
});

test('EXPIRED, DID_FAIL_TO_RENEW and GRACE_PERIOD_EXPIRED leave the room to end on its own date, then the usual grace', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-lapses');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const end = Date.parse('2026-11-08T12:00:00Z');
  const monthly = { appAccountToken, transactionId: 'sub-l-1', originalTransactionId: 'sub-l', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: end };
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);
  const before = await h.entitlements(ours.id);
  const kinds = [['DID_FAIL_TO_RENEW', null], ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD'], ['GRACE_PERIOD_EXPIRED', null], ['EXPIRED', 'BILLING_RETRY'], ['EXPIRED', 'VOLUNTARY']];
  for (const [notificationType, subtype] of kinds) {
    const answer = await h.notify(h.notification({ notificationType, subtype, notificationUUID: `${notificationType}-${subtype}`, transaction: monthly }));
    assert.equal(answer.statusCode, 200, answer.body);
  }
  assert.deepEqual(await h.entitlements(ours.id), before);
  const notes = await h.notes();
  assert.deepEqual(notes.map((note) => note.outcome), kinds.map(() => 'lapsed'));
  assert.deepEqual(notes.map((note) => note.subtype).sort(), ['BILLING_RETRY', 'GRACE_PERIOD', 'VOLUNTARY', null, null].sort());

  h.clock.now = new Date(end + DAY);
  assert.equal((await h.capacity(ours.id)).grace?.endsAt, new Date(end + 7 * DAY).toISOString());
});

test('a refunded extra photo never takes away a photo already added; what it had not been used for is withdrawn', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-extra-refund');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const held = await h.moment(sam, ours.id);
  // Two extra photos in one purchase. One is used, one is not yet.
  const photo = { appAccountToken, transactionId: 'photo-refunded', productId: 'extra_photo', type: 'Consumable', quantity: 2 };
  const bought = await h.apple(sam, h.signed(photo), { momentId: held.id });
  assert.equal(bought.statusCode, 201, bought.body);
  const [used, unused] = bought.json().data.extra.slotIds;
  const bytes = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  await h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes);
  await h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes, used);
  const photos = async () => (await h.pool.query('SELECT id,paid_slot_id FROM moment_images WHERE moment_id=$1 AND deleted_at IS NULL ORDER BY created_at,id', [held.id])).rows;
  const before = await photos();
  assert.equal(before.length, 2);

  const answer = await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'photo-refund', transaction: { ...photo, revocationDate: refundedAt } }));
  assert.equal(answer.statusCode, 200, answer.body);
  const [note] = await h.notes();
  assert.equal(note.outcome, 'refunded');
  assert.ok(note.purchase_id);
  assert.deepEqual(await photos(), before, 'both photos are still on the moment');
  const slots = Object.fromEntries((await h.pool.query('SELECT id,state,used_at FROM moment_image_slots WHERE store_purchase_id=$1', [note.purchase_id])).rows.map((row) => [row.id, row]));
  assert.equal(slots[used].state, 'active', 'the slot a photo used stays');
  assert.ok(slots[used].used_at);
  assert.equal(slots[unused].state, 'canceled', 'the one not used yet is withdrawn');
  await assert.rejects(h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes, unused), (error) => error.code === 'image_payment_required', 'the refund leaves nothing new to add');
  assert.equal((await h.pool.query('SELECT revocation FROM billing_store_purchases WHERE id=$1', [note.purchase_id])).rows[0].revocation, 'refunded');
  assert.ok(h.logged.some((line) => line.message === 'store notification' && line.outcome === 'refunded' && line.kept === 1 && line.withdrawn === 1));

  // Deleting the photo the refunded slot paid for gives nothing back.
  const paidPhoto = before.find((row) => row.paid_slot_id === used);
  await h.platform.deleteMomentImage(sam.id, ours.id, held.id, paidPhoto.id);
  await assert.rejects(h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes, used), (error) => error.code === 'image_payment_required');

  // The phone sending a copy signed before the refund grants nothing.
  const again = await h.apple({ ...sam, token: (await h.platform.issueTokens(sam.id)).token }, h.signed(photo), { momentId: held.id });
  assert.equal(again.json().data.granted, false);
  assert.equal((await h.pool.query("SELECT count(*)::int AS count FROM moment_image_slots WHERE state='active' AND used_at IS NULL")).rows[0].count, 0);

  // The same refund under another notification changes nothing more.
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'photo-refund-again', transaction: { ...photo, revocationDate: refundedAt } }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'photo-refund-again').outcome, 'unchanged');
});

test('a refunded extra place never takes away a place already added; only places the moment doesn’t need are withdrawn', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-place-refund');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const held = await h.moment(sam, ours.id);
  const web = new StripeBillingService({ pool: h.pool, config: h.store.config, stripe: {} });
  const twoPlaces = { appAccountToken, transactionId: 'places-refunded', productId: 'extra_place', type: 'Consumable', quantity: 2 };
  const onePlace = { appAccountToken, transactionId: 'place-kept', productId: 'extra_place', type: 'Consumable' };
  assert.equal((await h.apple(sam, h.signed(twoPlaces), { momentId: held.id })).statusCode, 201);
  // The moment holds three places: its free one and two paid for by the first purchase.
  const places = [{ name: 'The canal' }, { name: 'The bridge' }, { name: 'The lock' }];
  await h.pool.query('UPDATE journey_moments SET locations=$1 WHERE id=$2', [JSON.stringify(places), held.id]);
  await web.assertLocationCapacity(sam.id, ours.id, held.id, 3);

  // Then a later place is bought, not used yet, and the first purchase is refunded. The moment
  // needs two paid places; the later one covers one, so one of the refunded two stays.
  assert.equal((await h.apple(sam, h.signed(onePlace), { momentId: held.id })).statusCode, 201);
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'places-refund', transaction: { ...twoPlaces, revocationDate: refundedAt } }));
  const [note] = await h.notes();
  assert.equal(note.outcome, 'refunded');
  const states = (await h.pool.query('SELECT state FROM moment_location_slots WHERE store_purchase_id=$1 ORDER BY state', [note.purchase_id])).rows.map((row) => row.state);
  assert.deepEqual(states, ['active', 'canceled']);
  assert.deepEqual((await h.pool.query('SELECT locations FROM journey_moments WHERE id=$1', [held.id])).rows[0].locations, places, 'every place is still on the moment');
  await web.assertLocationCapacity(sam.id, ours.id, held.id, 3);
  await assert.rejects(web.assertLocationCapacity(sam.id, ours.id, held.id, 4), (error) => error.code === 'location_payment_required', 'and it can hold no more than it held');

  // The later purchase refunded too: the kept slot is counted first, and the three places need both,
  // so nothing more is withdrawn.
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'place-kept-refund', transaction: { ...onePlace, revocationDate: refundedAt } }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'place-kept-refund').outcome, 'refunded');
  await web.assertLocationCapacity(sam.id, ours.id, held.id, 3);

  // A refund of a place its moment doesn't need is withdrawn whole: this moment holds only its
  // free place.
  const quiet = await h.moment(sam, ours.id, 'A quiet morning');
  const spare = { appAccountToken, transactionId: 'place-spare', productId: 'extra_place', type: 'Consumable' };
  assert.equal((await h.apple(sam, h.signed(spare), { momentId: quiet.id })).statusCode, 201);
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'place-spare-refund', transaction: { ...spare, revocationDate: refundedAt } }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'place-spare-refund').outcome, 'refunded');
  assert.equal((await h.pool.query("SELECT count(*)::int AS count FROM moment_location_slots WHERE moment_id=$1 AND state='active'", [quiet.id])).rows[0].count, 0);
  await assert.rejects(web.assertLocationCapacity(sam.id, ours.id, quiet.id, 2), (error) => error.code === 'location_payment_required');
});

test('other notifications are logged and left alone, and a service without Apple asks Apple to send again later', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-other-kinds');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const pass = { appAccountToken, transactionId: 'pass-other-kinds' };
  await h.apple(sam, h.signed(pass));
  const before = await h.entitlements(ours.id);
  const answer = await h.notify(h.notification({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED', notificationUUID: 'renewal-status-1', transaction: pass }));
  assert.equal(answer.statusCode, 200);
  assert.equal((await h.notes())[0].outcome, 'not_acted_on');
  assert.deepEqual(await h.entitlements(ours.id), before);

  const quiet = new StorePurchaseService({ pool: h.pool, config: h.store.config });
  await assert.rejects(quiet.handleAppleNotification({ signedPayload: 'x' }), (error) => error.code === 'store_unavailable' && error.status === 503);
});

test('Apple’s billing grace period never extends the room: our grace is the only grace (owner, Oct 8 and 9, 2026)', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-billing-grace');
  const ours = await h.journey(sam);
  const alex = await h.person('alex-billing-grace');
  const kit = await h.person('kit-billing-grace');
  await h.join(ours.id, alex);
  await h.join(ours.id, kit);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const end = Date.parse('2026-11-08T12:00:00Z');
  const monthly = { appAccountToken, transactionId: 'sub-bg-1', originalTransactionId: 'sub-bg', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: end };
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);
  const before = await h.entitlements(ours.id);

  // Billing Grace Period stays off in App Store Connect. If Apple's grace arrives anyway, with an
  // end sixteen days after the paid one, it is a lapse like any other.
  const answer = await h.notify(h.notification({
    notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', notificationUUID: 'billing-grace-1', transaction: monthly,
    renewalInfo: { originalTransactionId: 'sub-bg', autoRenewProductId: 'room_51_monthly', productId: 'room_51_monthly', autoRenewStatus: 1, isInBillingRetryPeriod: true, gracePeriodExpiresDate: end + 16 * DAY },
  }));
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal((await h.notes())[0].outcome, 'lapsed');
  assert.deepEqual(await h.entitlements(ours.id), before, 'the room still ends on the date paid for');

  // Our seven days run from that date, and when they are over the people beyond two rest.
  h.clock.now = new Date(end + DAY);
  assert.equal((await h.capacity(ours.id)).grace?.endsAt, new Date(end + 7 * DAY).toISOString());
  h.clock.now = new Date(end + 8 * DAY);
  const after = await h.capacity(ours.id);
  assert.equal(after.grace, null);
  assert.equal(after.restingMemberIds.length, 1);
  assert.equal(after.peopleHere, 3, 'nobody is removed');
});

test('no notification writes into the journey’s History: a refund is the payer’s own matter (owner, Oct 9, 2026)', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-no-history');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const pass = { appAccountToken, transactionId: 'pass-no-history' };
  const monthly = { appAccountToken, transactionId: 'sub-nh-1', originalTransactionId: 'sub-nh', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-11-08T12:00:00Z') };
  assert.equal((await h.apple(sam, h.signed(pass))).statusCode, 201);
  assert.equal((await h.apple(sam, h.signed(monthly))).statusCode, 201);
  const held = await h.moment(sam, ours.id);
  const photo = { appAccountToken, transactionId: 'photo-no-history', productId: 'extra_photo', type: 'Consumable' };
  assert.equal((await h.apple(sam, h.signed(photo), { momentId: held.id })).statusCode, 201);
  const history = async () => (await h.pool.query('SELECT id,action FROM journey_events WHERE journey_id=$1 ORDER BY id', [ours.id])).rows;
  const before = await history();

  const renewal = { ...monthly, transactionId: 'sub-nh-2', purchaseDate: Date.parse('2026-11-08T12:00:00Z'), expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  const sent = [
    ['DID_RENEW', null, renewal],
    ['REFUND', null, { ...renewal, revocationDate: refundedAt }],
    ['REFUND_REVERSED', null, renewal],
    ['REVOKE', null, { ...pass, revocationDate: refundedAt }],
    ['REFUND', 'extra', { ...photo, revocationDate: refundedAt }],
    ['REFUND_REVERSED', 'extra', photo],
    ['EXPIRED', 'VOLUNTARY', monthly],
    ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD', monthly],
    ['GRACE_PERIOD_EXPIRED', null, monthly],
    ['CONSUMPTION_REQUEST', null, pass],
    ['TEST', null, null],
  ];
  for (const [notificationType, subtype, transaction] of sent) {
    const answer = await h.notify(h.notification({ notificationType, subtype: subtype === 'extra' ? null : subtype, notificationUUID: `no-history-${notificationType}-${subtype}`, transaction }));
    assert.equal(answer.statusCode, 200, answer.body);
  }
  assert.deepEqual((await h.notes()).map((note) => note.outcome).sort(),
    ['lapsed', 'lapsed', 'lapsed', 'not_acted_on', 'refunded', 'refunded', 'reinstated', 'reinstated', 'renewed', 'revoked', 'test']);
  assert.deepEqual(await history(), before, 'the journey’s record is exactly as it was');
});

test('a reversed refund brings the room back as a renewal would, and a reversal arriving twice changes nothing more (owner, Oct 9, 2026)', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-reversed');
  const ours = await h.journey(sam);
  await h.join(ours.id, await h.person('alex-reversed'));
  await h.join(ours.id, await h.person('kit-reversed'));
  const { appAccountToken } = await h.identity(sam, ours.id);
  // A month pass, refunded two days in.
  const pass = { appAccountToken, transactionId: 'pass-reversed', productId: 'room_51_month_pass' };
  assert.equal((await h.apple(sam, h.signed(pass))).statusCode, 201);
  const [granted] = await h.entitlements(ours.id);
  const refundedOn = Date.parse('2026-10-10T12:00:00Z');
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'reversed-refund', transaction: { ...pass, revocationDate: refundedOn }, signedDate: refundedOn }));
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), new Date(refundedOn).toISOString());

  // Ten days later the grace is over and one of the three rests.
  h.clock.now = new Date(refundedOn + 10 * DAY);
  assert.equal((await h.capacity(ours.id)).restingMemberIds.length, 1);

  const reversed = h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'reversed-1', transaction: pass, signedDate: refundedOn + 10 * DAY });
  const answer = await h.notify(reversed);
  assert.equal(answer.statusCode, 200, answer.body);
  const note = (await h.notes()).find((row) => row.notification_id === 'reversed-1');
  assert.equal(note.outcome, 'reinstated');
  assert.equal(note.notification_type, 'REFUND_REVERSED');
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), new Date(granted.expires_at).toISOString(), 'the room runs to the end it was granted');
  assert.equal(room.state, 'active');
  assert.equal((await h.pool.query('SELECT reason FROM billing_entitlements WHERE journey_id=$1', [ours.id])).rows[0].reason, null);
  const capacity = await h.capacity(ours.id);
  assert.deepEqual(capacity.restingMemberIds, [], 'nobody rests any more');
  assert.equal(capacity.grace, null);
  const purchase = (await h.pool.query('SELECT revoked_at,revocation FROM billing_store_purchases WHERE transaction_id=$1', ['pass-reversed'])).rows[0];
  assert.deepEqual(purchase, { revoked_at: null, revocation: null }, 'the purchase stands again');

  // Apple sending the same reversal again changes nothing...
  const twice = await h.notify(reversed);
  assert.equal(twice.statusCode, 200);
  assert.equal((await h.notes()).filter((row) => row.notification_type === 'REFUND_REVERSED').length, 1);
  // ...and nor does a second reversal of the same refund under another notification.
  const another = await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'reversed-2', transaction: pass, signedDate: refundedOn + 11 * DAY }));
  assert.equal(another.statusCode, 200);
  assert.equal((await h.notes()).find((row) => row.notification_id === 'reversed-2').outcome, 'unchanged');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), new Date(granted.expires_at).toISOString());

  // A refund after that is a new refund, and ends the room again.
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'refunded-again', transaction: { ...pass, revocationDate: refundedOn + 12 * DAY }, signedDate: refundedOn + 12 * DAY }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'refunded-again').outcome, 'refunded');
});

test('a reversed refund of a pass that had not started starts it when it would have; of a subscription, runs it to its period’s end', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-reversed-queue');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const first = { appAccountToken, transactionId: 'pass-running' };
  const queued = { appAccountToken, transactionId: 'pass-queued' };
  assert.equal((await h.apple(sam, h.signed(first))).statusCode, 201);
  assert.equal((await h.apple(sam, h.signed(queued))).statusCode, 201);
  const before = (await h.entitlements(ours.id)).find((row) => row.source_record_id === 'pass-queued');
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'queued-refund', transaction: { ...queued, revocationDate: refundedAt } }));
  assert.equal((await h.entitlements(ours.id)).find((row) => row.source_record_id === 'pass-queued').state, 'expired');
  await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'queued-reversed', transaction: queued }));
  const after = (await h.entitlements(ours.id)).find((row) => row.source_record_id === 'pass-queued');
  assert.equal(after.state, 'active');
  assert.equal(new Date(after.effective_at).toISOString(), new Date(before.effective_at).toISOString());
  assert.equal(new Date(after.expires_at).toISOString(), new Date(before.expires_at).toISOString());

  const monthly = { appAccountToken, transactionId: 'sub-rr-1', originalTransactionId: 'sub-rr', productId: 'room_51_monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.parse('2026-11-08T12:00:00Z') };
  const other = await h.journey(sam, 'Another');
  const otherIdentity = await h.identity(sam, other.id);
  const monthlyThere = { ...monthly, appAccountToken: otherIdentity.appAccountToken };
  assert.equal((await h.apple(sam, h.signed(monthlyThere))).statusCode, 201);
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'sub-refund', transaction: { ...monthlyThere, revocationDate: refundedAt } }));
  assert.equal(new Date((await h.entitlements(other.id))[0].expires_at).toISOString(), new Date(refundedAt).toISOString());
  await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'sub-reversed', transaction: monthlyThere }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'sub-reversed').outcome, 'reinstated');
  assert.equal(new Date((await h.entitlements(other.id))[0].expires_at).toISOString(), '2026-11-08T12:00:00.000Z');

  // The next month is paid. A refund of the first month then changes nothing, and nor does its reversal.
  const renewal = { ...monthlyThere, transactionId: 'sub-rr-2', purchaseDate: Date.parse('2026-11-08T12:00:00Z'), expiresDate: Date.parse('2026-12-08T12:00:00Z'), transactionReason: 'RENEWAL' };
  await h.notify(h.notification({ notificationType: 'DID_RENEW', notificationUUID: 'sub-renewed', transaction: renewal }));
  const renewed = await h.entitlements(other.id);
  assert.equal(new Date(renewed[0].expires_at).toISOString(), '2026-12-08T12:00:00.000Z');
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'sub-old-refund', transaction: { ...monthlyThere, revocationDate: refundedAt } }));
  await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'sub-old-reversed', transaction: monthlyThere }));
  assert.deepEqual((await h.notes()).filter((row) => row.notification_id.startsWith('sub-old')).map((row) => row.outcome).sort(), ['unchanged', 'unchanged']);
  assert.deepEqual(await h.entitlements(other.id), renewed);
});

test('a reversal that arrives before its refund keeps the room; a revocation is not reversed by REFUND_REVERSED', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-reversed-order');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const pass = { appAccountToken, transactionId: 'pass-out-of-order' };
  assert.equal((await h.apple(sam, h.signed(pass))).statusCode, 201);
  const before = await h.entitlements(ours.id);
  // Apple signed the refund first and the reversal a day later, but the reversal arrives first.
  await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'early-reversal', transaction: pass, signedDate: refundedAt + DAY }));
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'late-refund', transaction: { ...pass, revocationDate: refundedAt }, signedDate: refundedAt }));
  assert.deepEqual((await h.notes()).map((row) => [row.notification_id, row.outcome]).sort(), [['early-reversal', 'unchanged'], ['late-refund', 'unchanged']]);
  assert.deepEqual(await h.entitlements(ours.id), before);
  assert.equal((await h.pool.query('SELECT revocation FROM billing_store_purchases WHERE transaction_id=$1', ['pass-out-of-order'])).rows[0].revocation, null);

  const revoked = { appAccountToken, transactionId: 'pass-revoked-not-reversed' };
  assert.equal((await h.apple(sam, h.signed(revoked))).statusCode, 201);
  await h.notify(h.notification({ notificationType: 'REVOKE', notificationUUID: 'revoke-1', transaction: { ...revoked, revocationDate: refundedAt } }));
  const ended = (await h.entitlements(ours.id)).find((row) => row.source_record_id === 'pass-revoked-not-reversed');
  await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'revoke-reversed', transaction: revoked }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'revoke-reversed').outcome, 'unchanged');
  assert.deepEqual((await h.entitlements(ours.id)).find((row) => row.source_record_id === 'pass-revoked-not-reversed'), ended);
});

test('a reversed refund of an extra gives back what the refund withdrew', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-extra-reversed');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const held = await h.moment(sam, ours.id);
  const photo = { appAccountToken, transactionId: 'photo-reversed', productId: 'extra_photo', type: 'Consumable' };
  const [slot] = (await h.apple(sam, h.signed(photo), { momentId: held.id })).json().data.extra.slotIds;
  await h.notify(h.notification({ notificationType: 'REFUND', notificationUUID: 'photo-refund-r', transaction: { ...photo, revocationDate: refundedAt } }));
  assert.deepEqual(await h.platform.imageSlots(sam.id, ours.id, held.id), [{ id: slot, state: 'canceled' }]);
  await h.notify(h.notification({ notificationType: 'REFUND_REVERSED', notificationUUID: 'photo-reversed-1', transaction: photo }));
  assert.equal((await h.notes()).find((row) => row.notification_id === 'photo-reversed-1').outcome, 'reinstated');
  assert.deepEqual(await h.platform.imageSlots(sam.id, ours.id, held.id), [{ id: slot, state: 'active' }]);
  const bytes = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  await h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes);
  await h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes, slot);
});

test('Apple’s CONSUMPTION_REQUEST is logged and never answered: nothing about how the app was used is sent', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-consumption');
  const ours = await h.journey(sam);
  const { appAccountToken } = await h.identity(sam, ours.id);
  const pass = { appAccountToken, transactionId: 'pass-consumption' };
  assert.equal((await h.apple(sam, h.signed(pass))).statusCode, 201);
  const before = await h.entitlements(ours.id);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no call should leave the server'); };
  try {
    const answer = await h.notify(h.notification({ notificationType: 'CONSUMPTION_REQUEST', subtype: null, notificationUUID: 'consumption-1', transaction: pass }));
    assert.equal(answer.statusCode, 200, answer.body);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [], 'the server makes no call to Apple');
  const [note] = await h.notes();
  assert.equal(note.outcome, 'not_acted_on');
  assert.equal(note.notification_type, 'CONSUMPTION_REQUEST');
  assert.deepEqual(await h.entitlements(ours.id), before);
});

// --- What Google says afterwards (#273) ----------------------------------------------------------

const RENEWED = 2;
const RECOVERED = 1;
const CANCELED = 3;
const PURCHASED_TYPE = 4;
const ON_HOLD = 5;
const IN_GRACE = 6;
const REVOKED = 12;
const EXPIRED = 13;
const subscriptionNote = (notificationType, purchaseToken) => ({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken } });
const voidedNote = (purchaseToken, { orderId = 'GPA.3300-0000-0000-00002', productType = 2, refundType = 1 } = {}) => ({ voidedPurchaseNotification: { purchaseToken, orderId, productType, refundType } });
const fingerprintOf = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16);

// A journey with a Google subscription the phone sent, and two more people in it.
async function googleSubscriber(h, name, token = `tok-${name}`) {
  const sam = await h.person(`sam-${name}`);
  const ours = await h.journey(sam);
  await h.join(ours.id, await h.person(`alex-${name}`));
  await h.join(ours.id, await h.person(`kit-${name}`));
  const ids = await h.identity(sam, ours.id);
  h.google.record(token, await googleRecord('subscription-active', ids));
  const granted = await h.googleRoute(sam, { productId: 'room_51_monthly', purchaseToken: token });
  assert.equal(granted.statusCode, 201, granted.body);
  return { sam, ours, ids, token };
}

const googleAnswer = async (ids, fields) => {
  const record = await googleRecord('subscription-active', ids);
  const { line = {}, ...rest } = fields;
  return { ...record, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', lineItems: [{ ...record.lineItems[0], ...line }], ...rest };
};

test('Google’s test notification is answered and changes nothing', async (t) => {
  const h = await harness(t);
  const answer = await h.play({ testNotification: { version: '1.0' } }, { messageId: '2000000000000001' });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual(answer.json(), { data: { received: true } });
  const [note] = await h.notes();
  assert.equal(note.store, 'google');
  assert.equal(note.notification_id, '2000000000000001');
  assert.equal(note.notification_type, 'TEST');
  assert.equal(note.outcome, 'test');
  assert.equal(note.purchase_id, null);
  assert.deepEqual(h.google.calls, [], 'nothing is asked of Google');
  assert.equal((await h.pool.query('SELECT count(*)::int AS count FROM billing_entitlements')).rows[0].count, 0);
});

test('a push without our subscription’s token is refused, and nothing is read or written', async (t) => {
  const h = await harness(t);
  const { ours, token } = await googleSubscriber(h, 'unauthenticated');
  h.google.calls.length = 0;
  const before = await h.entitlements(ours.id);
  const other = h.keys.rotate({ publish: false });
  const attempts = {
    'no token': null,
    'not a token': 'Bearer nonsense',
    'a token Google never signed': `Bearer ${pushToken({ ...other, kid: h.keys.current().kid }, {}, { now: h.clock.now.getTime() })}`,
    'another audience': h.pushedBy({ aud: 'https://example.test/push' }),
    'another service account': h.pushedBy({ email: 'someone@else.iam.gserviceaccount.com' }),
    'an expired token': `Bearer ${pushToken(h.keys.current(), {}, { now: h.clock.now.getTime() - 3 * 60 * 60 * 1000 })}`,
  };
  let n = 0;
  for (const [what, authorization] of Object.entries(attempts)) {
    n += 1;
    const answer = await h.play(subscriptionNote(REVOKED, token), { messageId: `300000000000000${n}`, authorization });
    assert.equal(answer.statusCode, 401, what);
    assert.equal(answer.json().error.code, 'store_notification_unauthenticated', what);
  }
  assert.deepEqual(await h.notes(), []);
  assert.deepEqual(h.google.calls, []);
  assert.deepEqual(await h.entitlements(ours.id), before);
  assert.ok(h.logged.some((line) => line.message === 'store notification refused' && line.reason === 'wrong audience'));
  assert.equal(JSON.stringify(h.logged).includes(h.pushedBy().slice(7, 40)), false, 'no token is ever logged');

  // A service with no push settings refuses everything, even a genuine push, and Pub/Sub keeps it.
  const unset = new StorePurchaseService({ pool: h.pool, config: h.store.config, google: h.google });
  await assert.rejects(unset.handleGoogleNotification({ authorization: h.pushedBy(), body: pushBody({ packageName: 'com.togetherledger.ledger', testNotification: {} }) }),
    (error) => error.code === 'store_unavailable' && error.status === 503);
  assert.deepEqual(await h.notes(), []);
});

test('another app’s notification, or one that can’t be read, is refused, and nothing is read or written', async (t) => {
  const h = await harness(t);
  const { ours, token } = await googleSubscriber(h, 'other-app');
  h.google.calls.length = 0;
  const before = await h.entitlements(ours.id);
  const otherApp = await h.play(subscriptionNote(REVOKED, token), { messageId: '4000000000000001', packageName: 'com.example.other' });
  assert.equal(otherApp.statusCode, 400, otherApp.body);
  assert.equal(otherApp.json().error.code, 'store_notification_wrong_app');
  const unreadable = await h.store.handleGoogleNotification({ authorization: h.pushedBy(), body: { message: { data: 'not base64 json', messageId: '4000000000000002' } } }).catch((error) => error);
  assert.equal(unreadable.code, 'store_notification_unverified');
  assert.equal(unreadable.status, 400);
  assert.deepEqual(await h.notes(), []);
  assert.deepEqual(h.google.calls, []);
  assert.deepEqual(await h.entitlements(ours.id), before);
});

test('a notification about a purchase we never granted is logged and changes nothing, without asking Google', async (t) => {
  const h = await harness(t);
  const answer = await h.play(subscriptionNote(RENEWED, 'tok-never-sent'), { messageId: '5000000000000001' });
  assert.equal(answer.statusCode, 200, answer.body);
  const [note] = await h.notes();
  assert.equal(note.outcome, 'unknown_purchase');
  assert.equal(note.notification_type, 'SUBSCRIPTION_RENEWED');
  assert.equal(note.purchase_id, null);
  assert.equal(note.transaction_ref, fingerprintOf('tok-never-sent'), 'a hash of the purchase token, never the token');
  assert.deepEqual(h.google.calls, []);
});

test('Google’s renewal extends the subscription without the phone, and is applied once however often it arrives', async (t) => {
  const h = await harness(t);
  const { sam, ours, ids, token } = await googleSubscriber(h, 'renewal');
  const renewedUntil = '2026-12-08T12:00:00.000Z';
  h.clock.now = new Date('2026-11-08T12:30:00Z');
  h.google.record(token, await googleAnswer(ids, { line: { expiryTime: renewedUntil, latestSuccessfulOrderId: 'GPA.3300-0000-0000-00001..0' } }));
  h.google.calls.length = 0;

  const answer = await h.play(subscriptionNote(RENEWED, token), { messageId: '6000000000000001' });
  assert.equal(answer.statusCode, 200, answer.body);
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), renewedUntil, 'the room runs to Google’s new end');
  assert.deepEqual(h.google.calls, [['getSubscription', token]], 'read again from Google, never taken from the message');
  const [note] = await h.notes();
  assert.equal(note.outcome, 'renewed');
  const purchase = (await h.pool.query('SELECT id,expires_at FROM billing_store_purchases WHERE transaction_id=$1', [token])).rows[0];
  assert.equal(note.purchase_id, purchase.id);
  assert.equal(new Date(purchase.expires_at).toISOString(), renewedUntil);

  // Pub/Sub delivers it again: nothing changes, and Google isn't asked twice.
  const again = await h.play(subscriptionNote(RENEWED, token), { messageId: '6000000000000001' });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await h.notes()).length, 1);
  assert.equal(h.google.calls.length, 1);
  assert.ok(h.logged.some((line) => line.message === 'store notification received again' && line.store === 'google'));

  // The phone never sends it, and nobody rests when the first month would have ended.
  h.clock.now = new Date('2026-11-20T12:00:00Z');
  const capacity = await h.capacity(ours.id);
  assert.equal(capacity.grace, null);
  assert.deepEqual(capacity.restingMemberIds, []);
  // When it does, it grants nothing more.
  const sent = await h.googleRoute({ ...sam, token: (await h.platform.issueTokens(sam.id)).token }, { productId: 'room_51_monthly', purchaseToken: token });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().data.granted, false);
  assert.equal(sent.json().data.room.until, renewedUntil);

  // Paid again after account hold or a pause is a renewal too.
  h.google.record(token, await googleAnswer(ids, { line: { expiryTime: '2027-01-08T12:00:00.000Z' } }));
  await h.play(subscriptionNote(RECOVERED, token), { messageId: '6000000000000002' });
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2027-01-08T12:00:00.000Z');
  assert.equal((await h.notes()).find((row) => row.notification_id === '6000000000000002').outcome, 'renewed');
});

test('cancelling, expiring, account hold and Google’s grace period leave the room to end on its own date: our grace is the only grace', async (t) => {
  const h = await harness(t);
  const { sam, ours, ids, token } = await googleSubscriber(h, 'lapses');
  const end = Date.parse('2026-11-08T12:00:00Z');
  const before = await h.entitlements(ours.id);
  // In Google's grace period, the expiry Google gives is the end of its grace, sixteen days on.
  const googleGraceEnd = '2026-11-24T12:00:00.000Z';
  h.clock.now = new Date(end + 60 * 60 * 1000);
  const kinds = [
    [CANCELED, 'SUBSCRIPTION_STATE_CANCELED', '2026-11-08T12:00:00.000Z'],
    [IN_GRACE, 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', googleGraceEnd],
    [ON_HOLD, 'SUBSCRIPTION_STATE_ON_HOLD', '2026-11-08T12:00:00.000Z'],
    [EXPIRED, 'SUBSCRIPTION_STATE_EXPIRED', '2026-11-08T12:00:00.000Z'],
  ];
  let n = 0;
  for (const [type, subscriptionState, expiryTime] of kinds) {
    n += 1;
    h.google.record(token, await googleAnswer(ids, { subscriptionState, line: { expiryTime } }));
    const answer = await h.play(subscriptionNote(type, token), { messageId: `700000000000000${n}` });
    assert.equal(answer.statusCode, 200, answer.body);
    assert.deepEqual(await h.entitlements(ours.id), before, `type ${type} writes nothing`);
  }
  assert.deepEqual((await h.notes()).map((note) => [note.notification_type, note.outcome]), [
    ['SUBSCRIPTION_CANCELED', 'lapsed'], ['SUBSCRIPTION_IN_GRACE_PERIOD', 'lapsed'], ['SUBSCRIPTION_ON_HOLD', 'lapsed'], ['SUBSCRIPTION_EXPIRED', 'lapsed'],
  ]);

  // A renewal notification while Google says the subscription is in its grace is not a renewal,
  // and neither is the phone sending the purchase then.
  h.google.record(token, await googleAnswer(ids, { subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', line: { expiryTime: googleGraceEnd } }));
  await h.play(subscriptionNote(RENEWED, token), { messageId: '7000000000000009' });
  assert.equal((await h.notes()).find((row) => row.notification_id === '7000000000000009').outcome, 'unchanged');
  const sent = await h.googleRoute({ ...sam, token: (await h.platform.issueTokens(sam.id)).token }, { productId: 'room_51_monthly', purchaseToken: token });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().data.room.until, new Date(end).toISOString(), 'Google’s grace never extends the room');
  assert.deepEqual(await h.entitlements(ours.id), before);

  // Our seven days run from the paid-for end; after them the people beyond two rest. Nobody is removed.
  h.clock.now = new Date(end + 2 * DAY);
  assert.equal((await h.capacity(ours.id)).grace?.endsAt, new Date(end + 7 * DAY).toISOString());
  h.clock.now = new Date(end + 8 * DAY);
  const after = await h.capacity(ours.id);
  assert.equal(after.restingMemberIds.length, 1);
  assert.equal(after.peopleHere, 3);
});

test('a revoked Google subscription Google still calls running is asked for again, logged once, and ends when Google ended it once Google confirms it', async (t) => {
  const h = await harness(t);
  const { ours, ids, token } = await googleSubscriber(h, 'revoked');
  const revokedAt = '2026-10-10T12:00:00.000Z';
  h.clock.now = new Date('2026-10-10T12:05:00Z');

  // Google still says it is running: nothing changes, and Pub/Sub is asked to send it again
  // (owner, Oct 9, 2026, decision 78).
  h.google.record(token, await googleAnswer(ids, {}));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const early = await h.play(subscriptionNote(REVOKED, token), { messageId: '8000000000000001' });
    assert.equal(early.statusCode, 503, early.body);
    assert.equal(early.json().error.code, 'store_notification_not_confirmed');
    assert.equal(early.json().error.details.retryable, true);
  }
  const [waiting] = await h.notes();
  assert.equal((await h.notes()).length, 1, 'one row for the message, however often it comes');
  assert.equal(waiting.outcome, 'waiting');
  assert.ok(waiting.purchase_id);
  assert.equal(h.logged.filter((line) => line.message === 'google has not listed a refund yet').length, 1, 'logged on the first delivery, not on every retry');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-11-08T12:00:00.000Z');

  // Google now says it has ended. The next delivery of the same message is applied.
  h.google.record(token, await googleAnswer(ids, { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', line: { expiryTime: revokedAt } }));
  const answer = await h.play(subscriptionNote(REVOKED, token), { messageId: '8000000000000001' });
  assert.equal(answer.statusCode, 200, answer.body);
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), revokedAt);
  assert.equal(room.state, 'active', 'and goes through the same grace as any lapse');
  const notes = await h.notes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].outcome, 'revoked');
  const purchase = (await h.pool.query('SELECT revoked_at,revocation FROM billing_store_purchases WHERE transaction_id=$1', [token])).rows[0];
  assert.equal(purchase.revocation, 'revoked');
  assert.equal(new Date(purchase.revoked_at).toISOString(), revokedAt);

  // Settled now: one more delivery is a replay, and Google isn't asked again.
  h.google.calls.length = 0;
  const replay = await h.play(subscriptionNote(REVOKED, token), { messageId: '8000000000000001' });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(h.google.calls, []);
});

test('a voided Google pass ends there: the usual grace, then the people beyond two rest, and nobody is removed', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-voided');
  const ours = await h.journey(sam);
  await h.join(ours.id, await h.person('alex-voided'));
  await h.join(ours.id, await h.person('kit-voided'));
  const ids = await h.identity(sam, ours.id);
  h.google.record('tok-voided-pass', await googleRecord('product-pass', ids));
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'tok-voided-pass' })).statusCode, 201);
  const before = await h.entitlements(ours.id);
  const voidedAt = Date.parse('2026-10-10T12:00:00Z');
  h.clock.now = new Date(voidedAt + 10 * 60 * 1000);
  h.google.calls.length = 0;

  // Google's list doesn't have it yet: nothing changes, and Pub/Sub is asked to send it again.
  const early = await h.play(voidedNote('tok-voided-pass'), { messageId: '9000000000000001' });
  assert.equal(early.statusCode, 503, early.body);
  assert.equal(early.json().error.code, 'store_notification_not_confirmed');
  assert.equal((await h.notes())[0].outcome, 'waiting');
  assert.deepEqual(await h.entitlements(ours.id), before);

  h.google.voided = [{ kind: 'androidpublisher#voidedPurchase', purchaseToken: 'tok-voided-pass', orderId: 'GPA.3300-0000-0000-00002', voidedTimeMillis: String(voidedAt), voidedSource: 0, voidedReason: 1 }];
  const answer = await h.play(voidedNote('tok-voided-pass'), { messageId: '9000000000000001' });
  assert.equal(answer.statusCode, 200, answer.body);
  const [room] = await h.entitlements(ours.id);
  assert.equal(new Date(room.expires_at).toISOString(), new Date(voidedAt).toISOString(), 'the room ends when Google voided it');
  assert.equal((await h.notes()).length, 1, 'the waiting row is the one settled');
  const note = (await h.notes())[0];
  assert.equal(note.outcome, 'refunded');
  assert.equal(note.notification_type, 'VOIDED_PURCHASE');
  assert.equal(note.subtype, 'FULL_REFUND');
  assert.ok(h.google.calls.every(([call, since]) => call === 'voided' && since === voidedAt + 10 * 60 * 1000 - DAY), 'listed from a day before Google said it happened');
  assert.equal(JSON.stringify(note).includes(ids.obfuscatedProfileId), false, 'the log keeps no value of ours');

  h.clock.now = new Date(voidedAt + 2 * DAY);
  assert.equal((await h.capacity(ours.id)).grace?.endsAt, new Date(voidedAt + 7 * DAY).toISOString());
  h.clock.now = new Date(voidedAt + 8 * DAY);
  const after = await h.capacity(ours.id);
  assert.equal(after.restingMemberIds.length, 1);
  assert.equal(after.peopleHere, 3);

  // The phone sending the purchase again grants nothing.
  const sent = await h.googleRoute({ ...sam, token: (await h.platform.issueTokens(sam.id)).token }, { productId: 'room_101_week_pass', purchaseToken: 'tok-voided-pass' });
  assert.equal(sent.json().data.granted, false);
  assert.equal((await h.capacity(ours.id)).restingMemberIds.length, 1);
});

test('a voided Google renewal ends the subscription there; a void of a period since paid again changes nothing; a later renewal counts', async (t) => {
  const h = await harness(t);
  const { ours, ids, token } = await googleSubscriber(h, 'voided-sub');
  h.clock.now = new Date('2026-11-08T12:30:00Z');
  const renewal = await googleAnswer(ids, { line: { expiryTime: '2026-12-08T12:00:00.000Z', latestSuccessfulOrderId: 'GPA.3300-0000-0000-00001..0' } });
  h.google.record(token, renewal);
  await h.play(subscriptionNote(RENEWED, token), { messageId: '9100000000000001' });

  // The first month is refunded, after the second was paid for: nothing changes.
  const refundedAt = Date.parse('2026-11-10T12:00:00Z');
  h.clock.now = new Date(refundedAt + 60 * 1000);
  h.google.voided = [{ purchaseToken: token, orderId: 'GPA.3300-0000-0000-00001', voidedTimeMillis: String(refundedAt) }];
  await h.play(voidedNote(token, { orderId: 'GPA.3300-0000-0000-00001', productType: 1 }), { messageId: '9100000000000002' });
  assert.equal((await h.notes()).find((row) => row.notification_id === '9100000000000002').outcome, 'unchanged');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-12-08T12:00:00.000Z');

  // The month being paid for is refunded: the room ends at the refund.
  h.google.voided.push({ purchaseToken: token, orderId: 'GPA.3300-0000-0000-00001..0', voidedTimeMillis: String(refundedAt) });
  await h.play(voidedNote(token, { orderId: 'GPA.3300-0000-0000-00001..0', productType: 1 }), { messageId: '9100000000000003' });
  assert.equal((await h.notes()).find((row) => row.notification_id === '9100000000000003').outcome, 'refunded');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), new Date(refundedAt).toISOString());

  // A refund without revocation leaves Google calling the period active. A renewal notice that only
  // names that refunded period brings nothing back...
  await h.play(subscriptionNote(RENEWED, token), { messageId: '9100000000000004' });
  assert.equal((await h.notes()).find((row) => row.notification_id === '9100000000000004').outcome, 'unchanged');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), new Date(refundedAt).toISOString());
  // ...and a period paid after it does.
  h.clock.now = new Date('2026-12-08T12:30:00Z');
  h.google.record(token, await googleAnswer(ids, { line: { expiryTime: '2027-01-08T12:00:00.000Z', latestSuccessfulOrderId: 'GPA.3300-0000-0000-00001..1' } }));
  await h.play(subscriptionNote(RENEWED, token), { messageId: '9100000000000005' });
  assert.equal((await h.notes()).find((row) => row.notification_id === '9100000000000005').outcome, 'renewed');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2027-01-08T12:00:00.000Z');
});

test('a voided Google extra keeps what was added and withdraws the rest once Google lists it; a partial refund and other kinds are left alone without asking Google', async (t) => {
  const h = await harness(t);
  const sam = await h.person('sam-google-extra');
  const ours = await h.journey(sam);
  const held = await h.moment(sam, ours.id);
  const ids = await h.identity(sam, ours.id);
  h.google.record('tok-photo', await googleRecord('product-pass', ids, { productId: 'extra_photo', orderId: 'GPA.3300-0000-0000-00011', quantity: 2 }));
  h.google.record('tok-place', await googleRecord('product-pass', ids, { productId: 'extra_place', orderId: 'GPA.3300-0000-0000-00012' }));
  h.google.record('tok-pass', await googleRecord('product-pass', ids, { quantity: 3 }));
  const photo = await h.googleRoute(sam, { productId: 'extra_photo', purchaseToken: 'tok-photo', momentId: held.id });
  assert.equal(photo.statusCode, 201, photo.body);
  const [used, unused] = photo.json().data.extra.slotIds;
  assert.equal((await h.googleRoute(sam, { productId: 'extra_place', purchaseToken: 'tok-place', momentId: held.id })).statusCode, 201);
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'tok-pass' })).statusCode, 201);
  const bytes = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  await h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes);
  await h.platform.uploadMomentImage(sam.id, ours.id, held.id, 'image/jpeg', bytes, used);
  const before = await h.entitlements(ours.id);
  const voidedAt = h.clock.now.getTime();
  h.google.calls.length = 0;

  // Not listed yet: asked for again, nothing withdrawn.
  const early = await h.play(voidedNote('tok-photo'), { messageId: '9200000000000001' });
  assert.equal(early.statusCode, 503, early.body);
  assert.equal((await h.pool.query("SELECT count(*)::int AS count FROM moment_image_slots WHERE state='active'")).rows[0].count, 2);

  h.google.voided = [
    { purchaseToken: 'tok-photo', orderId: 'GPA.3300-0000-0000-00011', voidedTimeMillis: String(voidedAt) },
    { purchaseToken: 'tok-place', orderId: 'GPA.3300-0000-0000-00012', voidedTimeMillis: String(voidedAt) },
  ];
  assert.equal((await h.play(voidedNote('tok-photo'), { messageId: '9200000000000001' })).statusCode, 200);
  assert.equal((await h.play(voidedNote('tok-place'), { messageId: '9200000000000002' })).statusCode, 200);
  await h.play(voidedNote('tok-pass', { refundType: 2 }), { messageId: '9200000000000003' });
  await h.play(subscriptionNote(PURCHASED_TYPE, 'tok-pass'), { messageId: '9200000000000004' });
  await h.play({ oneTimeProductNotification: { version: '1.0', notificationType: 1, purchaseToken: 'tok-pass', sku: 'room_101_week_pass' } }, { messageId: '9200000000000005' });
  await h.play(subscriptionNote(99, 'tok-pass'), { messageId: '9200000000000006' });
  assert.deepEqual((await h.notes()).map((note) => [note.notification_type, note.subtype, note.outcome]), [
    ['VOIDED_PURCHASE', 'FULL_REFUND', 'refunded'],
    ['VOIDED_PURCHASE', 'FULL_REFUND', 'refunded'],
    ['VOIDED_PURCHASE', 'QUANTITY_BASED_PARTIAL_REFUND', 'not_acted_on'],
    ['SUBSCRIPTION_PURCHASED', null, 'not_acted_on'],
    ['ONE_TIME_PRODUCT_PURCHASED', null, 'not_acted_on'],
    ['SUBSCRIPTION_99', null, 'not_acted_on'],
  ]);
  assert.ok(h.google.calls.every(([call]) => call === 'voided'), 'only the refunds of extras were read again');
  assert.equal(h.google.calls.length, 3);
  assert.deepEqual(await h.entitlements(ours.id), before, 'a partial refund leaves the pass running (owner, Oct 9, 2026)');
  const slots = Object.fromEntries((await h.pool.query('SELECT id,state FROM moment_image_slots')).rows.map((row) => [row.id, row.state]));
  assert.deepEqual(slots, { [used]: 'active', [unused]: 'canceled' }, 'the photo added stays; the slot not used is withdrawn');
  assert.equal((await h.pool.query("SELECT count(*)::int AS count FROM moment_images WHERE moment_id=$1 AND deleted_at IS NULL", [held.id])).rows[0].count, 2);
  assert.equal((await h.pool.query("SELECT count(*)::int AS count FROM moment_location_slots WHERE state='active'")).rows[0].count, 0, 'a place the moment never used is withdrawn');
  assert.deepEqual((await h.pool.query('SELECT product_id,revocation FROM billing_store_purchases WHERE revoked_at IS NOT NULL ORDER BY product_id')).rows,
    [{ product_id: 'extra_photo', revocation: 'refunded' }, { product_id: 'extra_place', revocation: 'refunded' }]);
});

test('when Google can’t be reached, Pub/Sub is asked to send again, and the next delivery is applied', async (t) => {
  const h = await harness(t);
  const { ours, ids, token } = await googleSubscriber(h, 'unreachable');
  h.google.record(token, await googleAnswer(ids, { line: { expiryTime: '2026-12-08T12:00:00.000Z' } }));
  h.google.unreachable = true;
  const failed = await h.play(subscriptionNote(RENEWED, token), { messageId: '9300000000000001' });
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.json().error.code, 'store_unavailable');
  assert.deepEqual(await h.notes(), [], 'nothing is logged, so the next delivery is not taken for a replay');

  h.google.unreachable = false;
  const delivered = await h.play(subscriptionNote(RENEWED, token), { messageId: '9300000000000001' });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.equal((await h.notes())[0].outcome, 'renewed');
  assert.equal(new Date((await h.entitlements(ours.id))[0].expires_at).toISOString(), '2026-12-08T12:00:00.000Z');

  // A service whose Play Developer API isn't configured can't read anything again, so it asks for later too.
  const noApi = new StorePurchaseService({ pool: h.pool, config: h.store.config, googlePush: h.store.googlePush });
  await assert.rejects(noApi.handleGoogleNotification({ authorization: h.pushedBy(), body: pushBody({ packageName: 'com.togetherledger.ledger', ...subscriptionNote(EXPIRED, token) }, { messageId: '9300000000000002' }) }),
    (error) => error.code === 'store_unavailable');
});

test('no Google notification writes into the journey’s History', async (t) => {
  const h = await harness(t);
  const { ours, ids, token } = await googleSubscriber(h, 'google-no-history');
  const history = async () => (await h.pool.query('SELECT id,action FROM journey_events WHERE journey_id=$1 ORDER BY id', [ours.id])).rows;
  const before = await history();
  h.clock.now = new Date('2026-11-08T12:30:00Z');
  h.google.record(token, await googleAnswer(ids, { line: { expiryTime: '2026-12-08T12:00:00.000Z' } }));
  await h.play(subscriptionNote(RENEWED, token), { messageId: '9400000000000001' });
  await h.play(subscriptionNote(CANCELED, token), { messageId: '9400000000000002' });
  h.google.voided = [{ purchaseToken: token, orderId: 'GPA.3300-0000-0000-00001', voidedTimeMillis: String(h.clock.now.getTime()) }];
  await h.play(voidedNote(token, { orderId: 'GPA.3300-0000-0000-00001', productType: 1 }), { messageId: '9400000000000003' });
  h.google.record(token, await googleAnswer(ids, { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', line: { expiryTime: h.clock.now.toISOString() } }));
  await h.play(subscriptionNote(REVOKED, token), { messageId: '9400000000000004' });
  await h.play({ testNotification: { version: '1.0' } }, { messageId: '9400000000000005' });
  assert.deepEqual((await h.notes()).map((note) => note.outcome), ['renewed', 'lapsed', 'refunded', 'revoked', 'test']);
  assert.deepEqual(await history(), before, 'the journey’s record is exactly as it was');
});

// --- When refunds spike (#273) -------------------------------------------------------------------

test('refunds and revocations reaching the threshold within the window write one error line, from config', async (t) => {
  const h = await harness(t);
  h.configure({ STORE_REFUND_ALERT_THRESHOLD: '3', STORE_REFUND_ALERT_WINDOW_HOURS: '24' });
  const alerts = () => h.logged.filter((line) => line.message === 'store refunds spiking');
  const refund = (id, { environment = 'Sandbox', type = 'REFUND' } = {}) => h.notify(h.notification({
    notificationType: type, notificationUUID: id, environment, transaction: { transactionId: `never-granted-${id}`, revocationDate: refundedAt },
  }));

  // Two refunds, a renewal, and a test: under the threshold, and the renewal and test don't count.
  assert.equal((await refund('spike-1')).statusCode, 200);
  assert.equal((await refund('spike-2', { type: 'REVOKE' })).statusCode, 200);
  await refund('spike-renewal', { type: 'DID_RENEW' });
  await h.notify(h.notification({ notificationType: 'TEST', notificationUUID: 'spike-test' }));
  assert.deepEqual(alerts(), []);

  // A third, from Google, reaches it: one error line, the kind the error count after a release and
  // any alert on '"level":"error"' already catch. It names counts only.
  assert.equal((await h.play(voidedNote('tok-never-granted'), { messageId: '9500000000000001' })).statusCode, 200);
  assert.equal(alerts().length, 1);
  assert.deepEqual(alerts()[0], {
    level: 'error', message: 'store refunds spiking', count: 3, apple: 2, google: 1, threshold: 3, windowHours: 24,
    since: new Date(h.clock.now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  });

  // More within the window don't repeat it.
  await refund('spike-3');
  await refund('spike-3');
  assert.equal(alerts().length, 1);

  // A day later the window has moved on. Refunds from the other environment don't count here; two
  // more of this one's don't reach the threshold, and a third does, once more.
  h.clock.now = new Date(h.clock.now.getTime() + 25 * 60 * 60 * 1000);
  await refund('later-live-1', { environment: 'Production' });
  await refund('later-live-2', { environment: 'Production' });
  await refund('later-1');
  await refund('later-2');
  assert.equal(alerts().length, 1);
  await refund('later-3');
  assert.equal(alerts().length, 2);
  assert.equal(alerts()[1].count, 3);
});

test('a Google refund retried while Google doesn’t list it counts once toward the alert', async (t) => {
  const h = await harness(t);
  h.configure({ STORE_REFUND_ALERT_THRESHOLD: '2', STORE_REFUND_ALERT_WINDOW_HOURS: '1' });
  const sam = await h.person('sam-spike-retry');
  const ours = await h.journey(sam);
  const ids = await h.identity(sam, ours.id);
  h.google.record('tok-spike-pass', await googleRecord('product-pass', ids));
  assert.equal((await h.googleRoute(sam, { productId: 'room_101_week_pass', purchaseToken: 'tok-spike-pass' })).statusCode, 201);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await h.play(voidedNote('tok-spike-pass'), { messageId: '9600000000000001' })).statusCode, 503);
  }
  assert.equal(h.logged.filter((line) => line.message === 'store refunds spiking').length, 0, 'four deliveries of one message are one refund');
  await h.play(voidedNote('tok-other'), { messageId: '9600000000000002' });
  assert.equal(h.logged.filter((line) => line.message === 'store refunds spiking').length, 1);
});
