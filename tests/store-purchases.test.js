import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { StripeBillingService } from '../server/billing.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { AppleTransactionVerifier } from '../server/store-apple.js';
import { GooglePlayError } from '../server/store-google.js';
import { passEnd, storeProduct } from '../server/store-products.js';
import { StorePurchaseService } from '../server/store-purchases.js';
import { appleChain, signTransaction, transactionPayload } from './support/apple-signing.js';

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
  '028_turn-a-store-purchase-into-capacity',
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
  }

  record(token, response) {
    this.purchases.set(token, response);
  }

  lookUp(token) {
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
    await pool.query(await readFile(new URL(`../server/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }

  const chain = appleChain();
  const settings = {
    NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    JOURNEY_CAPACITY_MODE: 'billing', STORE_ENVIRONMENT: environment, APPLE_ROOT_CERTIFICATES: chain.rootBase64,
  };
  const config = loadConfig(settings);
  // Account ids exist only once people register, so a test sets the ones that depend on them
  // afterwards, through the same parsing the server uses.
  const configure = (overrides) => Object.assign(config, loadConfig({ ...settings, ...overrides }));
  const clock = { now };
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => clock.now });
  const google = new RecordedGooglePlay();
  const logged = [];
  const store = new StorePurchaseService({
    pool, config, now: () => clock.now, google, history: (client, event) => platform.appendEvent(client, event),
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
  return { pool, platform, store, google, logged, clock, configure, person, journey, identity, join, moment, capacity, entitlements, apple, googleRoute, signed, chain };
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
