import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { PlatformError } from './platform.js';
import { AppleTransactionVerifier, AppleVerificationError } from './store-apple.js';
import { GooglePlayDeveloperApi, GooglePlayError, GooglePushError, GooglePushVerifier } from './store-google.js';
import { INCLUDED_PEOPLE, ROOM_CAPABILITY, appleTypeFor, passEnd, roomFor, storeProduct } from './store-products.js';

// Turning a store purchase into capacity (TL-P-05, #272). The phone sends what Apple or Google
// gave it; nothing it says is believed until the store's own signature (Apple) or the store itself
// (Google) has confirmed it. Then the purchase is tied back to an account and a journey through the
// values the phone was given before it started (#269, docs/STORE_PURCHASES.md), and only a
// purchase that resolves to the person asking, in a journey they are still in, becomes anything.
//
// What a purchase becomes:
//   - A monthly subscription: one billing_entitlements row for the subscription, moved forward as
//     it renews (Apple's originalTransactionId, Google's purchase token).
//   - A pass: its own entitlement row, 7 days or a month long by its product ID. Bought while
//     another pass of at least its size is running for the journey, it starts when that one ends.
//   - An extra photo or place: a paid slot on the moment, the same slot a web payment makes, which
//     never lapses.
//
// The same store transaction twice grants once (the unique row in billing_store_purchases).
//
// The case designed for explicitly (#272): the store has the person's money, and our write fails.
// Nothing is acknowledged that was not written, so the purchase stays open with the store: Apple
// keeps redelivering an unfinished transaction to the phone on every launch, and Google keeps
// returning an unacknowledged one, and the phone sends it again. The phone finishes (Apple) only
// once this answers with success, and Google is acknowledged here only after the grant commits.
// The worst case is that Google refunds a purchase we never managed to record, never that someone
// pays and keeps nothing. Reconciling the stores against this table is TL-P-10 (#277).
//
// What the stores say afterwards (#273): a renewal, a refund, a revocation, a lapse. Each is logged
// in billing_store_notifications and applied through applyStoreEvent, the one place a store's
// later word changes a journey's room, whichever store it came from. Apple's App Store Server
// Notifications (handleAppleNotification) and Google Play's Real-time developer notifications
// (handleGoogleNotification) both come here. What a refunded extra does is not decided yet.
//
// Not here: restoring on a new phone (#275).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURCHASE_TOKEN = /^[A-Za-z0-9._:-]{1,2048}$/;
const STORE = { apple: 'Apple', google: 'Google Play' };
const DAY_MS = 24 * 60 * 60 * 1000;
// Google refunds what is not acknowledged within three days of the purchase.
const ACKNOWLEDGE_WINDOW_MS = 3 * DAY_MS;
// Waits between acknowledgement attempts. The longest stays well inside the three days.
const ACKNOWLEDGE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000];
const MAX_QUANTITY = 10;
// The reason on a subscription's room once a newer purchase has replaced it (Google's
// linkedPurchaseToken). Such a row is never made active again, whatever is sent later.
const REPLACED = 'store_subscription_replaced';
// The reason on the grace a journey is given when its subscription's room moves to another.
const MOVED = 'store_subscription_moved';
// The reason on room the store has refunded or revoked. It rests the usual way: grace from the
// refund, then the people beyond two rest.
const REFUNDED = { refunded: 'store_refunded', revoked: 'store_revoked' };
// A notification about no purchase we hold explains nothing, and goes after this long.
const UNLINKED_NOTIFICATION_DAYS = 30;
// A notification carries its transaction (and Apple's renewal information) inside it, each a
// signed JWS with its own chain, so it is longer than a transaction on its own.
const MAX_NOTIFICATION_LENGTH = 60 * 1024;
const NOTIFICATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// What each App Store notification means for a journey's room. DID_FAIL_TO_RENEW, with or without
// Apple's GRACE_PERIOD subtype, is a lapse: the room runs to the date already paid for, and our
// own grace starts there, as for a failed web payment. Our grace is the only grace (owner, Oct 8
// and 9, 2026), so Apple's gracePeriodExpiresDate is never read. Anything not named here is logged
// as not_acted_on and left alone, among them:
//   REFUND_REVERSED      should bring the room back; not built yet (#273)
//   CONSUMPTION_REQUEST  never answered: it would send Apple how a person used the app, which the
//                        privacy policy doesn't say we share (owner, Oct 9, 2026)
// No notification writes a journey History entry: a refund is the payer's own matter, and the
// others see only the grace and the rest that follow, as for any lapse (owner, Oct 9, 2026).
const APPLE_EVENTS = Object.freeze({
  DID_RENEW: 'renewed',
  REFUND: 'refunded',
  REVOKE: 'revoked',
  EXPIRED: 'lapsed',
  DID_FAIL_TO_RENEW: 'lapsed',
  GRACE_PERIOD_EXPIRED: 'lapsed',
});

// Google Play's subscription notifications, by notificationType, as the log names them.
const GOOGLE_SUBSCRIPTION_TYPES = Object.freeze({
  1: 'SUBSCRIPTION_RECOVERED', 2: 'SUBSCRIPTION_RENEWED', 3: 'SUBSCRIPTION_CANCELED', 4: 'SUBSCRIPTION_PURCHASED',
  5: 'SUBSCRIPTION_ON_HOLD', 6: 'SUBSCRIPTION_IN_GRACE_PERIOD', 7: 'SUBSCRIPTION_RESTARTED', 8: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED',
  9: 'SUBSCRIPTION_DEFERRED', 10: 'SUBSCRIPTION_PAUSED', 11: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED', 12: 'SUBSCRIPTION_REVOKED',
  13: 'SUBSCRIPTION_EXPIRED', 17: 'SUBSCRIPTION_ITEMS_CHANGED', 18: 'SUBSCRIPTION_CANCELLATION_SCHEDULED',
  19: 'SUBSCRIPTION_PRICE_CHANGE_UPDATED', 20: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED', 22: 'SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED',
});
const GOOGLE_ONE_TIME_TYPES = Object.freeze({ 1: 'ONE_TIME_PRODUCT_PURCHASED', 2: 'ONE_TIME_PRODUCT_CANCELED' });
const GOOGLE_REFUND_TYPES = Object.freeze({ 1: 'FULL_REFUND', 2: 'QUANTITY_BASED_PARTIAL_REFUND' });
// What each Google Play notification means for a journey's room, the same events as Apple's. A
// renewal is SUBSCRIPTION_RENEWED, or SUBSCRIPTION_RECOVERED: paid again after account hold or a
// pause, which is a new paid period like any renewal. Cancelling, expiring, account hold and
// Google's grace period are all lapses: the room runs to the date already paid for, and our own
// grace starts there. Our grace is the only grace (owner, Oct 8 and 9, 2026), so the end Google
// gives a subscription in its grace period is never read. A voided purchase is a refund. Anything
// not named here is logged as not_acted_on and left alone. No notification writes History.
const GOOGLE_EVENTS = Object.freeze({
  SUBSCRIPTION_RENEWED: 'renewed',
  SUBSCRIPTION_RECOVERED: 'renewed',
  SUBSCRIPTION_CANCELED: 'lapsed',
  SUBSCRIPTION_EXPIRED: 'lapsed',
  SUBSCRIPTION_ON_HOLD: 'lapsed',
  SUBSCRIPTION_IN_GRACE_PERIOD: 'lapsed',
  SUBSCRIPTION_REVOKED: 'revoked',
  VOIDED_PURCHASE: 'refunded',
});
// Google lists voided purchases by when it voided them, looking back at most 30 days. A notification
// is looked for from a day before Google says it happened.
const VOIDED_LOOKBACK_MS = DAY_MS;
const VOIDED_MAX_LOOKBACK_MS = 29 * DAY_MS;

// Every refusal says whether trying again could change it. A phone finishes a transaction only on
// success, so `retryable: true` is the phone's cue to keep it and send it again later.
function refuse(status, code, message, retryable = false) {
  return new PlatformError(status, code, message, { retryable });
}

function unavailable(store) {
  return refuse(503, 'store_unavailable', `Purchases from ${STORE[store]} can't be checked right now. Your purchase is safe with ${STORE[store]}, and it will be added when Together Ledger can check it.`, true);
}

function refundHint(store) {
  return store === 'apple' ? 'If you were charged, Apple can refund it at reportaproblem.apple.com.' : 'If you were charged, Google Play can refund it from your order history.';
}

function dateFrom(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// A Google purchase token is a credential for looking the purchase up, so the log carries a short
// hash of it, enough to match two log lines, never the token.
function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export class StorePurchaseService {
  // `history` writes an event into a journey's own record (PlatformService.appendEvent): paid room
  // moving between journeys is something both journeys' people should be able to see.
  constructor({ pool, config, apple = null, google = null, googlePush = null, history = null, now = () => new Date(), log = null }) {
    this.pool = pool;
    this.googlePush = googlePush;
    this.history = history;
    this.config = config;
    this.apple = apple;
    this.google = google;
    this.now = now;
    this.log = log || ((level, message, fields) => process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`));
  }

  // --- Apple ---------------------------------------------------------------------------------

  async verifyApple(userId, body = {}) {
    if (!this.apple) throw unavailable('apple');
    let payload;
    try {
      payload = this.apple.verify(body.signedTransaction);
    } catch (error) {
      if (!(error instanceof AppleVerificationError)) throw error;
      this.log('warn', 'store purchase refused', { store: 'apple', code: 'store_purchase_unverified', reason: error.reason });
      throw refuse(400, 'store_purchase_unverified', 'This purchase could not be confirmed with Apple, so nothing was added to Together Ledger.');
    }
    const refused = (status, code, message, retryable = false) => {
      this.log('warn', 'store purchase refused', { store: 'apple', code, productId: String(payload.productId || ''), transactionId: String(payload.transactionId || '') });
      return refuse(status, code, message, retryable);
    };
    if (payload.bundleId !== this.config.APPLE_BUNDLE_ID) throw refused(400, 'store_purchase_wrong_app', 'This purchase was made for a different app, so it adds nothing to Together Ledger.');
    const product = storeProduct(payload.productId);
    if (!product || payload.type !== appleTypeFor(product)) throw refused(400, 'store_product_unknown', 'Together Ledger doesn’t sell this, so nothing was added.');
    const environment = { Production: 'live', Sandbox: 'sandbox' }[payload.environment] || 'testing';
    const testerOnly = this.assertEnvironment('apple', environment, refused);
    if (payload.revocationDate) throw refused(409, 'store_purchase_refunded', 'Apple has refunded or revoked this purchase, so it adds nothing.');
    // Family Sharing is off for every product (the Book, "Settings to leave alone"): room belongs
    // to the journey of the person who paid.
    if (payload.inAppOwnershipType && payload.inAppOwnershipType !== 'PURCHASED') throw refused(409, 'store_purchase_family_shared', 'A purchase shared through Family Sharing doesn’t add room. Room belongs to the journey of the person who bought it.');
    const quantity = Number(payload.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY || (product.kind === 'subscription' && quantity !== 1)) {
      throw refused(400, 'store_purchase_quantity', `This purchase was for a quantity Together Ledger doesn’t sell, so nothing was added. ${refundHint('apple')}`);
    }
    const purchasedAt = dateFrom(payload.purchaseDate);
    const expiresAt = product.kind === 'subscription' ? dateFrom(payload.expiresDate) : null;
    if (!purchasedAt || !payload.transactionId || (product.kind === 'subscription' && !expiresAt)) throw refused(400, 'store_purchase_unverified', 'This purchase could not be confirmed with Apple, so nothing was added to Together Ledger.');
    if (expiresAt && expiresAt <= this.now()) throw refused(409, 'store_subscription_ended', `This subscription ended on ${expiresAt.toISOString().slice(0, 10)}, so it doesn’t add room now.`);
    return this.grant(userId, {
      store: 'apple',
      environment,
      testerOnly,
      // Apple marks each automatic renewal; a renewal has a new transactionId, so this is how it is
      // told apart from a first purchase, a resubscription or an upgrade ('PURCHASE').
      renewal: payload.transactionReason === 'RENEWAL',
      transactionId: String(payload.transactionId),
      originalTransactionId: String(payload.originalTransactionId || payload.transactionId),
      productId: payload.productId,
      product,
      quantity,
      purchasedAt,
      expiresAt,
      journeyToken: payload.appAccountToken,
      accountToken: null,
      acknowledgement: 'not-needed',
      logRef: { transactionId: String(payload.transactionId) },
    }, body);
  }

  // --- Google --------------------------------------------------------------------------------

  async verifyGoogle(userId, body = {}) {
    if (!this.google) throw unavailable('google');
    const product = storeProduct(body.productId);
    if (!product) throw refuse(400, 'store_product_unknown', 'Together Ledger doesn’t sell this, so nothing was added.');
    if (typeof body.purchaseToken !== 'string' || !PURCHASE_TOKEN.test(body.purchaseToken)) throw refuse(400, 'store_purchase_unverified', 'Google Play doesn’t recognise this purchase, so nothing was added to Together Ledger.');
    if (body.packageName !== undefined && body.packageName !== this.config.GOOGLE_PLAY_PACKAGE_NAME) throw refuse(400, 'store_purchase_wrong_app', 'This purchase was made for a different app, so it adds nothing to Together Ledger.');
    const token = body.purchaseToken;
    const logRef = { purchase: fingerprint(token) };
    const refused = (status, code, message, retryable = false) => {
      this.log('warn', 'store purchase refused', { store: 'google', code, productId: body.productId, ...logRef });
      return refuse(status, code, message, retryable);
    };
    let record;
    try {
      record = product.kind === 'subscription'
        ? await this.google.subscriptionPurchase(token)
        : await this.google.productPurchase(body.productId, token);
    } catch (error) {
      if (!(error instanceof GooglePlayError)) throw error;
      if (error.kind === 'not-found') throw refused(400, 'store_purchase_unverified', 'Google Play doesn’t recognise this purchase, so nothing was added to Together Ledger.');
      // Google refusing our credentials is our configuration, never the person's purchase.
      if (error.kind === 'refused') this.log('error', 'google play refused our credentials', { status: error.status });
      throw unavailable('google');
    }
    const purchase = product.kind === 'subscription'
      ? this.googleSubscription(record, body.productId, product, token, refused)
      : this.googleProduct(record, body.productId, product, token, refused);
    const testerOnly = this.assertEnvironment('google', purchase.environment, refused);
    const result = await this.grant(userId, { ...purchase, testerOnly, logRef }, body);
    if (result.acknowledgement === 'pending') {
      const row = await this.pool.query('SELECT * FROM billing_store_purchases WHERE id=$1', [result.purchaseId]);
      result.acknowledgement = await this.acknowledge(row.rows[0]) ? 'done' : 'pending';
    }
    return result;
  }

  googleSubscription(record, productId, product, token, refused) {
    const item = (record.lineItems || []).find((line) => line.productId === productId);
    if (!item) throw refused(400, 'store_purchase_unverified', 'Google Play doesn’t recognise this purchase, so nothing was added to Together Ledger.');
    const state = record.subscriptionState;
    if (state === 'SUBSCRIPTION_STATE_PENDING') throw refused(409, 'store_purchase_pending', 'Google Play is still waiting for this payment. Room is added once Google confirms it.', true);
    // CANCELED means it will not renew; it still runs to its end.
    if (!['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'].includes(state)) {
      throw refused(409, 'store_subscription_ended', 'Google Play says this subscription isn’t active, so it doesn’t add room now.');
    }
    const expiresAt = dateFrom(item.expiryTime);
    if (!expiresAt) throw refused(400, 'store_purchase_unverified', 'Google Play doesn’t recognise this purchase, so nothing was added to Together Ledger.');
    if (expiresAt <= this.now()) throw refused(409, 'store_subscription_ended', `This subscription ended on ${expiresAt.toISOString().slice(0, 10)}, so it doesn’t add room now.`);
    const ids = record.externalAccountIdentifiers || {};
    return {
      store: 'google',
      environment: record.testPurchase ? 'sandbox' : 'live',
      transactionId: token,
      originalTransactionId: token,
      productId,
      product,
      quantity: 1,
      purchasedAt: dateFrom(record.startTime) || this.now(),
      expiresAt,
      journeyToken: ids.obfuscatedExternalProfileId,
      accountToken: ids.obfuscatedExternalAccountId,
      acknowledgement: record.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' ? 'done' : 'pending',
      replacesToken: record.linkedPurchaseToken || null,
      // In Google's grace period, expiryTime is the end of Google's grace, not of a period paid for.
      // Our grace is the only grace (owner, Oct 8 and 9, 2026), so it never extends the room.
      inStoreGrace: state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    };
  }

  googleProduct(record, productId, product, token, refused) {
    if (record.purchaseState === 2) throw refused(409, 'store_purchase_pending', 'Google Play is still waiting for this payment. It’s added once Google confirms it.', true);
    if (record.purchaseState !== 0) throw refused(409, 'store_purchase_canceled', 'Google Play canceled this purchase, so it adds nothing.');
    const quantity = Number(record.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw refused(400, 'store_purchase_quantity', `This purchase was for a quantity Together Ledger doesn’t sell, so nothing was added. ${refundHint('google')}`);
    }
    return {
      store: 'google',
      // purchaseType is set only outside the normal flow; 0 is a licence tester's test purchase.
      environment: record.purchaseType === 0 ? 'sandbox' : 'live',
      transactionId: token,
      originalTransactionId: token,
      productId,
      product,
      quantity,
      purchasedAt: dateFrom(record.purchaseTimeMillis) || this.now(),
      expiresAt: null,
      journeyToken: record.obfuscatedExternalProfileId,
      accountToken: record.obfuscatedExternalAccountId,
      // Consuming acknowledges too. One already consumed needs nothing more from us.
      acknowledgement: record.consumptionState === 1 ? 'done' : 'pending',
    };
  }

  // A deployment honours one environment's purchases, and never the other's (#272). The one
  // exception is a live service's sandbox testers (STORE_SANDBOX_ACCOUNT_IDS): App Review buys in
  // the sandbox against the production app. Whether this purchase is one of theirs is known only
  // once its account value resolves, so this answers "only for a tester" and grant() decides.
  assertEnvironment(store, environment, refused) {
    if (environment === this.config.storeEnvironment) return false;
    if (this.config.storeEnvironment === 'live') {
      if (environment === 'sandbox' && this.config.storeSandboxAccountIds?.length) return true;
      throw this.testPurchaseRefused(store, refused);
    }
    throw refused(409, 'store_environment_mismatch', 'This is Together Ledger’s test service, which only takes test purchases, so nothing was added here.');
  }

  testPurchaseRefused(store, refused) {
    return refused(409, 'store_environment_mismatch', `This was a test purchase, and test purchases don’t add anything to Together Ledger. ${STORE[store]} doesn’t charge for them.`);
  }

  // --- Granting ------------------------------------------------------------------------------

  async lockJourney(client, journeyId) {
    if (this.config.NODE_ENV !== 'test') await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [journeyId]);
  }

  // Who the purchase belongs to, from the values it carried (#269). Each refusal here is logged:
  // a verified purchase nobody can be found for is money taken that we cannot honour.
  async ownerOf(client, userId, purchase) {
    const { store } = purchase;
    const unlinked = (reason) => {
      this.log('warn', 'store purchase refused', { store, code: 'store_purchase_unlinked', reason, productId: purchase.productId, ...purchase.logRef });
      return refuse(409, 'store_purchase_unlinked', `This purchase isn’t linked to a Together Ledger account, so nothing could be added. ${refundHint(store)}`);
    };
    const journeyToken = String(purchase.journeyToken || '').toLowerCase();
    if (!UUID.test(journeyToken)) throw unlinked('no account token');
    const found = await client.query(
      `SELECT sj.user_id,sj.journey_id,u.deleted_at FROM billing_store_journeys sj JOIN users u ON u.id=sj.user_id WHERE sj.journey_token=$1`,
      [journeyToken],
    );
    if (!found.rowCount) throw unlinked('a token we never issued');
    const owner = found.rows[0];
    if (store === 'google') {
      // Google carries both values. They must name the same person.
      const accountToken = String(purchase.accountToken || '').toLowerCase();
      const account = UUID.test(accountToken) ? await client.query('SELECT user_id FROM billing_store_accounts WHERE account_token=$1', [accountToken]) : { rowCount: 0, rows: [] };
      if (!account.rowCount || account.rows[0].user_id !== owner.user_id) throw unlinked('account and journey values disagree');
    }
    if (owner.deleted_at) {
      this.log('warn', 'store purchase refused', { store, code: 'store_purchase_account_deleted', productId: purchase.productId, ...purchase.logRef });
      throw refuse(409, 'store_purchase_account_deleted', `This purchase belongs to a Together Ledger account that has been deleted, so nothing could be added. ${refundHint(store)}`);
    }
    // A phone that changed hands, or a purchase restored under another Apple ID or Google
    // account. Capacity is never moved silently (#275).
    if (owner.user_id !== userId) {
      this.log('warn', 'store purchase refused', { store, code: 'store_purchase_other_account', productId: purchase.productId, ...purchase.logRef });
      throw refuse(409, 'store_purchase_other_account', 'This purchase belongs to a different Together Ledger account. Sign in to that account to use it; nothing has been moved.');
    }
    return { userId: owner.user_id, journeyId: owner.journey_id };
  }

  async grant(userId, purchase, body) {
    const { store, environment, product } = purchase;
    const momentId = body.momentId ?? null;
    return withTransaction(this.pool, async (client) => {
      const owner = await this.ownerOf(client, userId, purchase);
      if (purchase.testerOnly && !this.config.storeSandboxAccountIds.includes(owner.userId)) {
        throw this.testPurchaseRefused(store, (status, code, message) => {
          this.log('warn', 'store purchase refused', { store, code, productId: purchase.productId, ...purchase.logRef });
          return refuse(status, code, message);
        });
      }
      const seen = await client.query('SELECT * FROM billing_store_purchases WHERE store=$1 AND environment=$2 AND transaction_id=$3', [store, environment, purchase.transactionId]);
      if (seen.rowCount) return this.replay(client, seen.rows[0], purchase);

      await this.lockJourney(client, owner.journeyId);
      // A renewal of a subscription already granted for this journey extends it, whoever holds the
      // journey now: the person is still paying, and refusing it would leave them paying for
      // nothing. Ownership is checked when a subscription is first bought, resubscribed or moved.
      // Google's renewals keep their purchase token, so they arrive as a replay and are the same.
      const renewal = product.kind === 'subscription' && await this.isRenewal(client, purchase, owner.journeyId);
      if (!renewal) await this.assertMayBuy(client, purchase, owner, userId, momentId);

      const now = this.now();
      const inserted = await client.query(
        `INSERT INTO billing_store_purchases
         (id,store,environment,transaction_id,original_transaction_id,product_id,kind,payer_user_id,journey_id,moment_id,quantity,purchased_at,
          acknowledgement,acknowledge_by,next_acknowledge_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         ON CONFLICT (store,environment,transaction_id) DO NOTHING
         RETURNING *`,
        [randomUUID(), store, environment, purchase.transactionId, purchase.originalTransactionId, purchase.productId, product.kind, userId,
          owner.journeyId, product.kind === 'extra' ? momentId : null, purchase.quantity, purchase.purchasedAt, purchase.acknowledgement,
          purchase.acknowledgement === 'pending' ? new Date(purchase.purchasedAt.getTime() + ACKNOWLEDGE_WINDOW_MS) : null,
          purchase.acknowledgement === 'pending' ? now : null, now],
      );
      // Sent twice at once: the other request wrote it first, and this one grants nothing.
      if (!inserted.rowCount) {
        const raced = await client.query('SELECT * FROM billing_store_purchases WHERE store=$1 AND environment=$2 AND transaction_id=$3', [store, environment, purchase.transactionId]);
        return this.describe(client, raced.rows[0], false);
      }
      const row = inserted.rows[0];
      if (product.kind === 'subscription') await this.grantSubscription(client, row, purchase);
      if (product.kind === 'pass') await this.grantPass(client, row, purchase);
      if (product.kind === 'extra') await this.grantExtra(client, row, purchase);
      const saved = await client.query('SELECT * FROM billing_store_purchases WHERE id=$1', [row.id]);
      this.log('info', 'store purchase granted', { store, environment, productId: purchase.productId, renewal, ...purchase.logRef });
      return this.describe(client, saved.rows[0], true);
    });
  }

  // Whether the person may buy this, for this journey, now: still in it; holding it, for room;
  // able to see the moment, for an extra. Each refusal about the journey is logged.
  async assertMayBuy(client, purchase, owner, userId, momentId) {
    const { store, product } = purchase;
    const membership = await client.query(
      'SELECT jm.role FROM journey_members jm JOIN journeys j ON j.id=jm.journey_id WHERE jm.journey_id=$1 AND jm.user_id=$2',
      [owner.journeyId, userId],
    );
    if (!membership.rowCount) {
      this.log('warn', 'store purchase refused', { store, code: 'store_purchase_journey_gone', productId: purchase.productId, ...purchase.logRef });
      throw refuse(409, 'store_purchase_journey_gone', `The journey this was bought for has ended, or you\u2019re no longer in it, so nothing could be added. ${refundHint(store)}`);
    }
    // One person pays for a journey, and owning a journey means paying for it (4.7). Extras are
    // anyone's to buy, for a moment they can see, as on the web.
    if (product.kind !== 'extra' && membership.rows[0].role !== 'owner') {
      this.log('warn', 'store purchase refused', { store, code: 'store_purchase_not_owner', productId: purchase.productId, ...purchase.logRef });
      throw refuse(409, 'store_purchase_not_owner', `Only the person who holds this journey can make room in it, so nothing was added. ${refundHint(store)}`);
    }
    if (product.kind === 'extra') {
      if (!UUID.test(String(momentId || ''))) throw refuse(400, 'store_extra_needs_moment', `Choose the moment this ${product.extra} is for. Nothing has been lost.`, true);
      const moment = await client.query(
        `SELECT id FROM journey_moments WHERE id=$1 AND journey_id=$2 AND (visibility='shared-now' OR created_by_user_id=$3)`,
        [momentId, owner.journeyId, userId],
      );
      if (!moment.rowCount) throw refuse(409, 'store_extra_moment_missing', `That moment isn\u2019t there any more. Choose another moment for this ${product.extra}; nothing has been lost.`, true);
    }
  }

  // A renewal is Apple's word that this continues a subscription, for a subscription already
  // granted here, to this same journey, and not one a newer purchase has replaced.
  async isRenewal(client, purchase, journeyId) {
    if (!purchase.renewal) return false;
    const held = await this.entitlementFor(client, purchase.store, purchase.environment, purchase.originalTransactionId);
    return Boolean(held && held.journey_id === journeyId && held.reason !== REPLACED);
  }

  async entitlementFor(client, store, environment, recordId) {
    const found = await client.query(
      'SELECT * FROM billing_entitlements WHERE source=$1 AND environment=$2 AND source_record_id=$3 AND capability=$4',
      [store, environment, recordId, ROOM_CAPABILITY],
    );
    return found.rows[0] || null;
  }

  // The same transaction again. Nothing more is granted. A subscription's latest verified expiry is
  // still kept, since that is the store's word on how far it now runs, not a second grant.
  // A transaction the store has since refunded extends nothing, even when a phone sends a copy
  // signed before the refund.
  async replay(client, row, purchase) {
    if (row.kind === 'subscription' && !row.revoked_at && !purchase.inStoreGrace) await this.grantSubscription(client, row, purchase);
    const saved = await client.query('SELECT * FROM billing_store_purchases WHERE id=$1', [row.id]);
    return this.describe(client, saved.rows[0], false);
  }

  // The purchase row names the entitlement it wrote, and what it granted.
  async linkPurchase(client, row, { recordId, effectiveAt, expiresAt }) {
    await client.query(
      'UPDATE billing_store_purchases SET effective_at=COALESCE(effective_at,$1),expires_at=$2,entitlement_record_id=$3,updated_at=$4 WHERE id=$5',
      [effectiveAt, expiresAt, recordId, this.now(), row.id],
    );
  }

  async insertEntitlement(client, { payerUserId, journeyId, store, environment, recordId, state = 'active', quantity, effectiveAt, expiresAt, eventAt, reason = null }) {
    const now = this.now();
    await client.query(
      `INSERT INTO billing_entitlements
       (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,provider_event_created_at,reason,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$12,$12)`,
      [randomUUID(), payerUserId, journeyId, ROOM_CAPABILITY, store, environment, recordId, state, quantity, effectiveAt, expiresAt, now, eventAt, reason],
    );
  }

  // A monthly subscription is one entitlement for its whole life, keyed by the store's id for the
  // subscription rather than for this payment (Apple's originalTransactionId, Google's purchase
  // token), and it only ever moves forward: an older renewal arriving late never shortens it or
  // takes it anywhere. An upgrade from 51 to 101 is the same subscription at a new size.
  //
  // Apple keeps the originalTransactionId when someone resubscribes or upgrades, and they may do it
  // from another journey. The room follows the journey they have just paid from (owner, Oct 8,
  // 2026): the entitlement moves there, both journeys' records say so, and the journey it left goes
  // into the usual grace rather than losing its room at once.
  async grantSubscription(client, row, purchase) {
    const recordId = purchase.originalTransactionId;
    const held = await this.entitlementFor(client, row.store, row.environment, recordId);
    const link = { recordId, effectiveAt: purchase.purchasedAt, expiresAt: purchase.expiresAt };
    const room = roomFor(purchase.product);
    if (!held) {
      await this.insertEntitlement(client, {
        payerUserId: row.payer_user_id, journeyId: row.journey_id, store: row.store, environment: row.environment, recordId,
        quantity: room, effectiveAt: purchase.purchasedAt, expiresAt: purchase.expiresAt, eventAt: row.purchased_at,
      });
    } else {
      const moving = held.journey_id !== row.journey_id;
      const heldUntil = held.expires_at ? new Date(held.expires_at) : null;
      // A replaced subscription never comes back; anything not newer than what is held changes
      // nothing; and moving to another journey takes a strictly newer payment.
      const newer = !heldUntil || purchase.expiresAt > heldUntil || (!moving && purchase.expiresAt >= heldUntil);
      if (held.reason !== REPLACED && newer) {
        const now = this.now();
        await client.query(
          `UPDATE billing_entitlements SET payer_user_id=$1,journey_id=$2,state='active',quantity=$3,effective_at=$4,expires_at=$5,
             last_verified_at=$6,provider_event_created_at=$7,reason=NULL,updated_at=$6
           WHERE id=$8`,
          [row.payer_user_id, row.journey_id, room, moving ? purchase.purchasedAt : held.effective_at, purchase.expiresAt, now, row.purchased_at, held.id],
        );
        if (moving) await this.moveRoom(client, held, row, room);
      }
    }
    await this.linkPurchase(client, row, link);
    if (purchase.replacesToken) await this.endReplaced(client, row, purchase);
  }

  // How long the journey paid room is leaving keeps it. Room still running gives the usual grace
  // (BILLING_GRACE_DAYS) from now. Room that had already lapsed but is still inside its grace
  // (its end plus the 7 days, plus any week the payer asked for, as paymentFor in platform.js
  // reads it) keeps exactly the time it had left (owner, Oct 8, 2026), so the banner doesn't
  // vanish and nobody rests early. Past that, or for a replaced subscription, nothing.
  async graceLeftBehind(client, held, now) {
    if (!['active', 'grace'].includes(held.state)) return null;
    const end = held.expires_at ? new Date(held.expires_at) : null;
    if (held.state === 'active' && (!end || end > now)) return new Date(now.getTime() + this.config.billingGraceDays * DAY_MS);
    if (held.reason === REPLACED) return null;
    const automaticEnd = held.state === 'active' ? new Date(end.getTime() + this.config.billingGraceDays * DAY_MS) : end;
    const asked = await client.query('SELECT grace_basis,grace_until FROM journey_grace_requests WHERE journey_id=$1', [held.journey_id]);
    let until = automaticEnd;
    for (const request of asked.rows) {
      const askedUntil = new Date(request.grace_until);
      if (new Date(request.grace_basis).getTime() === automaticEnd.getTime() && askedUntil > until) until = askedUntil;
    }
    return until > now ? until : null;
  }

  // Paid room left `held.journey_id` for `row.journey_id`. The journey it left keeps a grace
  // (graceLeftBehind), and both journeys' records say what happened, without naming the other
  // journey to people who may not be in it.
  async moveRoom(client, held, row, room) {
    if (!this.history) throw new Error('Moving paid room between journeys needs the journeys\u2019 history.');
    const now = this.now();
    const from = held.journey_id;
    const graceUntil = await this.graceLeftBehind(client, held, now);
    const leftJourney = await client.query('SELECT 1 FROM journeys WHERE id=$1', [from]);
    if (graceUntil && leftJourney.rowCount) {
      await this.insertEntitlement(client, {
        payerUserId: held.payer_user_id, journeyId: from, store: held.source, environment: held.environment,
        recordId: `${held.source_record_id}:moved:${row.id}`, state: 'grace', quantity: Number(held.quantity),
        effectiveAt: now, expiresAt: graceUntil, eventAt: row.purchased_at, reason: MOVED,
      });
    }
    if (leftJourney.rowCount) {
      await this.history(client, {
        journeyId: from, actorUserId: row.payer_user_id, action: 'paid_room_moved_out', entityType: 'journey', entityId: from,
        summary: graceUntil ? 'Paid room moved to another journey; this journey has its days of grace' : 'Lapsed paid room renewed for another journey',
        before: { people: Number(held.quantity) + INCLUDED_PEOPLE },
        after: graceUntil ? { graceUntil: graceUntil.toISOString() } : null,
      });
    }
    await this.history(client, {
      journeyId: row.journey_id, actorUserId: row.payer_user_id, action: 'paid_room_moved_in', entityType: 'journey', entityId: row.journey_id,
      summary: 'Paid room moved here from another journey',
      after: { people: room + INCLUDED_PEOPLE },
    });
  }

  // Google names, on an upgrade, downgrade or resubscription, the purchase token it replaces. That
  // subscription's room ends when the new one starts, which for a deferred downgrade is the end of
  // the period already paid for, not now; and it is marked replaced, so sending the old token again,
  // while Google still reports it active, never brings it back. A token we never saw is recorded as
  // replaced too, for the same reason.
  async endReplaced(client, row, purchase) {
    const startsAt = purchase.purchasedAt;
    const old = await this.entitlementFor(client, 'google', row.environment, purchase.replacesToken);
    const now = this.now();
    if (!old) {
      await this.insertEntitlement(client, {
        payerUserId: row.payer_user_id, journeyId: row.journey_id, store: 'google', environment: row.environment, recordId: purchase.replacesToken,
        state: 'expired', quantity: 0, effectiveAt: startsAt, expiresAt: startsAt, eventAt: row.purchased_at, reason: REPLACED,
      });
      return;
    }
    if (old.reason === REPLACED) return;
    const oldEnd = old.expires_at ? new Date(old.expires_at) : null;
    const ends = oldEnd && oldEnd < startsAt ? oldEnd : startsAt;
    await client.query(
      `UPDATE billing_entitlements SET expires_at=$1,state=$2,reason=$3,updated_at=$4 WHERE id=$5`,
      [ends, ends <= now ? 'expired' : old.state, REPLACED, now, old.id],
    );
    if (old.journey_id !== row.journey_id && ends <= now) await this.moveRoom(client, old, row, roomFor(purchase.product));
    // A deferred replacement from another journey: the old room runs on there until the period
    // already paid for ends. Marked replaced, it gets no grace of its own, so the old journey is
    // given the usual one, starting at that end (owner, Oct 8, 2026), and told so now.
    if (old.journey_id !== row.journey_id && ends > now) await this.graceAfterDeferredReplacement(client, old, row, ends);
  }

  async graceAfterDeferredReplacement(client, old, row, ends) {
    const leftJourney = await client.query('SELECT 1 FROM journeys WHERE id=$1', [old.journey_id]);
    if (!leftJourney.rowCount) return;
    const graceUntil = new Date(ends.getTime() + this.config.billingGraceDays * DAY_MS);
    await this.insertEntitlement(client, {
      payerUserId: old.payer_user_id, journeyId: old.journey_id, store: old.source, environment: old.environment,
      recordId: `${old.source_record_id}:replaced:${row.id}`, state: 'grace', quantity: Number(old.quantity),
      effectiveAt: ends, expiresAt: graceUntil, eventAt: row.purchased_at, reason: MOVED,
    });
    if (this.history) {
      await this.history(client, {
        journeyId: old.journey_id, actorUserId: row.payer_user_id, action: 'paid_room_moved_out', entityType: 'journey', entityId: old.journey_id,
        summary: 'Paid room moves to another journey when this period ends; this journey then has its days of grace',
        before: { people: Number(old.quantity) + INCLUDED_PEOPLE },
        after: { roomUntil: ends.toISOString(), graceUntil: graceUntil.toISOString() },
      });
    }
  }

  // A pass starts now, or, when the journey already has a pass running that holds at least as many
  // people, when the last of those ends: buying a week while a week is running adds a week, it does
  // not waste one. A bigger pass bought during a smaller one starts now, because making room for
  // more people is why it was bought; the smaller one runs on beneath it. Passes from either store
  // count, since the room is the journey's, not the phone's.
  async grantPass(client, row, purchase) {
    const now = this.now();
    const room = roomFor(purchase.product);
    const running = await client.query(
      `SELECT e.expires_at FROM billing_entitlements e
       JOIN billing_store_purchases p ON p.store=e.source AND p.environment=e.environment AND p.entitlement_record_id=e.source_record_id
       WHERE e.journey_id=$1 AND e.capability=$2 AND e.environment=$3 AND p.kind='pass'
         AND e.state IN ('active','grace') AND e.quantity>=$4 AND e.expires_at>$5`,
      [row.journey_id, ROOM_CAPABILITY, row.environment, room, now],
    );
    const start = running.rows.reduce((latest, { expires_at: end }) => (new Date(end) > latest ? new Date(end) : latest), now);
    const end = passEnd(purchase.product, start, purchase.quantity);
    await this.insertEntitlement(client, {
      payerUserId: row.payer_user_id, journeyId: row.journey_id, store: row.store, environment: row.environment, recordId: purchase.transactionId,
      quantity: room, effectiveAt: start, expiresAt: end, eventAt: row.purchased_at,
    });
    await this.linkPurchase(client, row, { recordId: purchase.transactionId, effectiveAt: start, expiresAt: end });
  }

  // An extra is the moment's for good: an active slot that never lapses, one per unit bought.
  async grantExtra(client, row, purchase) {
    const table = purchase.product.extra === 'photo' ? 'moment_image_slots' : 'moment_location_slots';
    const now = this.now();
    for (let unit = 0; unit < purchase.quantity; unit += 1) {
      await client.query(
        `INSERT INTO ${table} (id,journey_id,moment_id,payer_user_id,environment,state,store_purchase_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$7)`,
        [randomUUID(), row.journey_id, row.moment_id, row.payer_user_id, row.environment, row.id, now],
      );
    }
    await client.query('UPDATE billing_store_purchases SET effective_at=$1,updated_at=$1 WHERE id=$2', [now, row.id]);
  }

  // What the phone is told: whether this request granted anything, and what the purchase holds now.
  async describe(client, row, granted) {
    const product = storeProduct(row.product_id);
    const answer = {
      purchaseId: row.id,
      granted,
      store: row.store,
      environment: row.environment,
      productId: row.product_id,
      kind: row.kind,
      journeyId: row.journey_id,
      acknowledgement: row.acknowledgement,
    };
    if (row.kind === 'extra') {
      const table = product.extra === 'photo' ? 'moment_image_slots' : 'moment_location_slots';
      const slots = await client.query(`SELECT id FROM ${table} WHERE store_purchase_id=$1 ORDER BY created_at,id`, [row.id]);
      return { ...answer, extra: { kind: product.extra, momentId: row.moment_id, slotIds: slots.rows.map((slot) => slot.id) } };
    }
    const entitlement = await client.query(
      'SELECT quantity,state,effective_at,expires_at FROM billing_entitlements WHERE source=$1 AND environment=$2 AND source_record_id=$3 AND capability=$4',
      [row.store, row.environment, row.entitlement_record_id, ROOM_CAPABILITY],
    );
    const held = entitlement.rows[0];
    return {
      ...answer,
      room: held ? { people: Number(held.quantity) + INCLUDED_PEOPLE, state: held.state, from: iso(held.effective_at), until: iso(held.expires_at) } : null,
    };
  }

  // --- What the stores say afterwards (#273) ---------------------------------------------------

  // The one way a store's later word changes a journey's room, for Apple and Google alike. It finds
  // the room by the store's own id for it (`recordId`: Apple's originalTransactionId for a
  // subscription or transactionId for a pass, Google's purchase token) and never invents a new
  // path for it: room the store has ended goes through the grace and rest decided on #203, exactly
  // like a pass that runs out. Nobody is removed. Extras never come here.
  //
  //   renewed   `endsAt` is the store's new end. The room only ever moves forward, and a
  //             subscription another one replaced never comes back.
  //   lapsed    Nothing to write: the room ends on the date already paid for, and paymentFor
  //             reads it as grace from there.
  //   refunded, revoked
  //             The room ends at `at` (when the store refunded it), or at its own end if that came
  //             first; paymentFor then reads the usual grace from that end. A pass that had not
  //             started yet never starts. With `periodEnd` (the refunded period's end), a refund of
  //             a period that has since been paid again changes nothing.
  //
  // Answers with what it did: renewed, lapsed, refunded, revoked or unchanged.
  async applyStoreEvent(client, { store, environment, recordId, event, at = null, endsAt = null, periodEnd = null, people = null }) {
    if (!['renewed', 'lapsed', 'refunded', 'revoked'].includes(event)) throw new Error(`Unknown store event ${event}.`);
    const first = await this.entitlementFor(client, store, environment, recordId);
    if (!first) return { effect: 'unchanged', journeyId: null };
    await this.lockJourney(client, first.journey_id);
    const held = await this.entitlementFor(client, store, environment, recordId);
    if (!held) return { effect: 'unchanged', journeyId: null };
    const now = this.now();
    const end = held.expires_at ? new Date(held.expires_at) : null;
    const unchanged = { effect: 'unchanged', journeyId: held.journey_id };
    if (event === 'lapsed') return { effect: held.reason === REPLACED ? 'unchanged' : 'lapsed', journeyId: held.journey_id };
    if (event === 'renewed') {
      if (held.reason === REPLACED || !endsAt || (end && endsAt <= end)) return unchanged;
      await client.query(
        `UPDATE billing_entitlements SET state='active',quantity=$1,expires_at=$2,reason=NULL,last_verified_at=$3,provider_event_created_at=$4,updated_at=$3 WHERE id=$5`,
        [people ? people - INCLUDED_PEOPLE : Number(held.quantity), endsAt, now, at || now, held.id],
      );
      return { effect: 'renewed', journeyId: held.journey_id };
    }
    // Refunded or revoked.
    if (!['active', 'grace'].includes(held.state)) return unchanged;
    if (periodEnd && end && end > periodEnd) return unchanged;
    const when = at || now;
    const startsAt = held.effective_at ? new Date(held.effective_at) : null;
    if (startsAt && startsAt > when) {
      await client.query(
        `UPDATE billing_entitlements SET state='expired',expires_at=$1,reason=$2,last_verified_at=$3,updated_at=$3 WHERE id=$4`,
        [startsAt, REFUNDED[event], now, held.id],
      );
      return { effect: event, journeyId: held.journey_id };
    }
    const ends = end && end < when ? end : when;
    await client.query(
      'UPDATE billing_entitlements SET expires_at=$1,reason=$2,last_verified_at=$3,updated_at=$3 WHERE id=$4',
      [ends, REFUNDED[event], now, held.id],
    );
    return { effect: event, journeyId: held.journey_id };
  }

  // A purchase the store has since refunded or revoked. Marked once, never cleared.
  async markRevoked(client, row, at, revocation) {
    await client.query(
      'UPDATE billing_store_purchases SET revoked_at=COALESCE(revoked_at,$1),revocation=COALESCE(revocation,$2),updated_at=$3 WHERE id=$4',
      [at, revocation, this.now(), row.id],
    );
  }

  // A notification, logged once. Answers with the new row, or null when this notification was
  // received before: the store sending again until it hears success, which then changes nothing.
  async noteNotification(client, { store, notificationId, environment, type, subtype, transactionRef, signedAt }) {
    const now = this.now();
    await client.query(
      'DELETE FROM billing_store_notifications WHERE purchase_id IS NULL AND received_at<$1',
      [new Date(now.getTime() - UNLINKED_NOTIFICATION_DAYS * DAY_MS)],
    );
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO billing_store_notifications (id,store,notification_id,environment,notification_type,subtype,transaction_ref,signed_at,received_at,outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'received')
       ON CONFLICT (store,notification_id) DO NOTHING
       RETURNING *`,
      [id, store, notificationId, environment, type, subtype, transactionRef, signedAt, now],
    );
    // Only the row this request wrote counts as new.
    return inserted.rows[0]?.id === id ? inserted.rows[0] : null;
  }

  async settleNotification(client, id, { outcome, purchaseId = null }) {
    await client.query('UPDATE billing_store_notifications SET outcome=$1,purchase_id=$2 WHERE id=$3', [outcome, purchaseId, id]);
  }

  // The purchase a notification names: its own transaction, or, for a subscription period we were
  // never sent, the latest one we hold of the same subscription.
  async purchaseNamed(client, store, environment, transactionId, originalTransactionId) {
    const own = await client.query('SELECT * FROM billing_store_purchases WHERE store=$1 AND environment=$2 AND transaction_id=$3', [store, environment, transactionId]);
    if (own.rowCount) return { row: own.rows[0], own: true };
    if (!originalTransactionId) return null;
    const same = await client.query(
      `SELECT * FROM billing_store_purchases WHERE store=$1 AND environment=$2 AND original_transaction_id=$3 AND kind='subscription'
       ORDER BY purchased_at DESC, created_at DESC LIMIT 1`,
      [store, environment, originalTransactionId],
    );
    return same.rowCount ? { row: same.rows[0], own: false } : null;
  }

  // A subscription transaction we first hear of from the store, not the phone: a renewal, or a
  // refunded period. It is recorded against the subscription's journey and payer, so the phone
  // sending it later finds it and grants nothing more.
  async recordStoreTransaction(client, base, { transactionId, productId, purchasedAt, expiresAt, revokedAt = null, revocation = null }) {
    const now = this.now();
    await client.query(
      `INSERT INTO billing_store_purchases
       (id,store,environment,transaction_id,original_transaction_id,product_id,kind,payer_user_id,journey_id,quantity,purchased_at,
        effective_at,expires_at,entitlement_record_id,acknowledgement,revoked_at,revocation,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7,$8,1,$9,$9,$10,$11,'not-needed',$12,$13,$14,$14)
       ON CONFLICT (store,environment,transaction_id) DO NOTHING`,
      [randomUUID(), base.store, base.environment, transactionId, base.original_transaction_id, productId, base.payer_user_id, base.journey_id,
        purchasedAt, expiresAt, base.entitlement_record_id, revokedAt, revocation, now],
    );
    const saved = await client.query('SELECT * FROM billing_store_purchases WHERE store=$1 AND environment=$2 AND transaction_id=$3', [base.store, base.environment, transactionId]);
    return saved.rows[0];
  }

  // App Store Server Notifications, version 2. Apple POSTs { signedPayload } and sends again until
  // it hears a 200. The signed payload is the only credential, checked exactly as a purchase is
  // (store-apple.js), and so is the transaction inside it.
  async handleAppleNotification(body = {}) {
    if (!this.apple) throw unavailable('apple');
    const verify = (jws) => {
      try {
        return this.apple.verify(jws, { maxLength: MAX_NOTIFICATION_LENGTH });
      } catch (error) {
        if (!(error instanceof AppleVerificationError)) throw error;
        this.log('warn', 'store notification refused', { store: 'apple', code: 'store_notification_unverified', reason: error.reason });
        throw refuse(400, 'store_notification_unverified', 'This notification could not be verified with Apple, so nothing was changed.');
      }
    };
    const payload = verify(body.signedPayload);
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const type = String(payload.notificationType || '').slice(0, 64);
    const wrongApp = () => {
      this.log('warn', 'store notification refused', { store: 'apple', code: 'store_notification_wrong_app', type });
      return refuse(400, 'store_notification_wrong_app', 'This notification is for a different app, so nothing was changed.');
    };
    if (data.bundleId !== this.config.APPLE_BUNDLE_ID) throw wrongApp();
    const notificationId = String(payload.notificationUUID || '');
    if (!NOTIFICATION_ID.test(notificationId) || !type) throw refuse(400, 'store_notification_unverified', 'This notification could not be verified with Apple, so nothing was changed.');
    const transaction = typeof data.signedTransactionInfo === 'string' ? verify(data.signedTransactionInfo) : null;
    if (transaction && transaction.bundleId !== this.config.APPLE_BUNDLE_ID) throw wrongApp();
    const environment = { Production: 'live', Sandbox: 'sandbox' }[data.environment] || null;
    const subtype = payload.subtype ? String(payload.subtype).slice(0, 64) : null;
    const transactionRef = transaction?.transactionId ? String(transaction.transactionId) : null;

    return withTransaction(this.pool, async (client) => {
      const note = await this.noteNotification(client, {
        store: 'apple', notificationId, environment, type, subtype, transactionRef, signedAt: dateFrom(payload.signedDate),
      });
      if (!note) {
        this.log('info', 'store notification received again', { store: 'apple', type, notificationId });
        return { outcome: 'already-received' };
      }
      const result = await this.appleNotificationEffect(client, { type, environment, transaction });
      await this.settleNotification(client, note.id, result);
      this.log('info', 'store notification', { store: 'apple', type, subtype, environment, outcome: result.outcome, transactionId: transactionRef });
      return { outcome: result.outcome };
    });
  }

  async appleNotificationEffect(client, { type, environment, transaction }) {
    if (type === 'TEST') return { outcome: 'test' };
    if (!transaction || !environment || !transaction.transactionId) return { outcome: Object.hasOwn(APPLE_EVENTS, type) ? 'unknown_purchase' : 'not_acted_on' };
    const transactionId = String(transaction.transactionId);
    const originalTransactionId = transaction.originalTransactionId ? String(transaction.originalTransactionId) : null;
    const named = await this.purchaseNamed(client, 'apple', environment, transactionId, originalTransactionId);
    if (!named) return { outcome: 'unknown_purchase' };
    const purchase = named.row;
    const event = Object.hasOwn(APPLE_EVENTS, type) ? APPLE_EVENTS[type] : null;
    if (!event) return { outcome: 'not_acted_on', purchaseId: purchase.id };
    // What a refunded extra photo or place does is not decided yet: noted, nothing changed.
    if (purchase.kind === 'extra') return { outcome: 'extra_noted', purchaseId: purchase.id };
    // Family Sharing is off for every product, so a shared copy never made room to take back.
    if (transaction.inAppOwnershipType && transaction.inAppOwnershipType !== 'PURCHASED') return { outcome: 'unchanged', purchaseId: purchase.id };
    const product = storeProduct(transaction.productId);
    const subscription = purchase.kind === 'subscription';
    const store = { store: 'apple', environment, recordId: purchase.entitlement_record_id };

    if (event === 'refunded' || event === 'revoked') {
      const at = dateFrom(transaction.revocationDate) || this.now();
      let row = purchase;
      if (named.own) {
        await this.markRevoked(client, purchase, at, event);
      } else if (product?.kind === 'subscription') {
        row = await this.recordStoreTransaction(client, purchase, {
          transactionId, productId: transaction.productId, purchasedAt: dateFrom(transaction.purchaseDate) || at,
          expiresAt: dateFrom(transaction.expiresDate), revokedAt: at, revocation: event,
        });
      }
      const applied = await this.applyStoreEvent(client, { ...store, event, at, periodEnd: subscription ? dateFrom(transaction.expiresDate) : null });
      return { outcome: applied.effect, purchaseId: row.id };
    }

    if (event === 'renewed') {
      const endsAt = dateFrom(transaction.expiresDate);
      if (!subscription || product?.kind !== 'subscription' || !endsAt || transaction.revocationDate || (named.own && purchase.revoked_at)) {
        return { outcome: 'unchanged', purchaseId: purchase.id };
      }
      let row = purchase;
      if (!named.own) {
        // A renewal continues the subscription in the journey it already serves. One that names
        // another journey is a move, and moves are only made when a phone sends the purchase.
        const held = await this.entitlementFor(client, 'apple', environment, purchase.entitlement_record_id);
        const token = String(transaction.appAccountToken || '').toLowerCase();
        const paidFrom = UUID.test(token) ? await client.query('SELECT journey_id FROM billing_store_journeys WHERE journey_token=$1', [token]) : { rowCount: 0, rows: [] };
        if (!held || (paidFrom.rowCount && paidFrom.rows[0].journey_id !== held.journey_id)) return { outcome: 'unchanged', purchaseId: purchase.id };
        row = await this.recordStoreTransaction(client, { ...purchase, journey_id: held.journey_id, payer_user_id: held.payer_user_id }, {
          transactionId, productId: transaction.productId, purchasedAt: dateFrom(transaction.purchaseDate) || this.now(), expiresAt: endsAt,
        });
      }
      const applied = await this.applyStoreEvent(client, { ...store, event, endsAt, at: dateFrom(transaction.purchaseDate), people: product.people });
      return { outcome: applied.effect, purchaseId: row.id };
    }

    const applied = await this.applyStoreEvent(client, { ...store, event });
    return { outcome: applied.effect, purchaseId: purchase.id };
  }

  // Google Play's Real-time developer notifications, pushed by Pub/Sub, which sends again until it
  // hears a success. Each request must carry the OIDC token Pub/Sub signs for our push subscription
  // (store-google.js, GooglePushVerifier). The message itself says only that something changed,
  // so nothing is believed from it: each purchase is read again from the Play Developer API, and
  // only what Google says there changes a room.
  async handleGoogleNotification({ authorization, body = {} } = {}) {
    if (!this.googlePush) {
      this.log('warn', 'store notification refused', { store: 'google', code: 'store_unavailable', reason: 'not configured' });
      throw unavailable('google');
    }
    try {
      await this.googlePush.verify(authorization);
    } catch (error) {
      if (!(error instanceof GooglePushError)) throw error;
      if (error.kind === 'unavailable') {
        this.log('warn', 'store notification refused', { store: 'google', code: 'store_unavailable', reason: error.reason });
        throw unavailable('google');
      }
      this.log('warn', 'store notification refused', { store: 'google', code: 'store_notification_unauthenticated', reason: error.reason });
      throw refuse(401, 'store_notification_unauthenticated', 'This notification didn’t come from Together Ledger’s Google Play notifications, so nothing was changed.');
    }
    const read = this.readGoogleMessage(body);
    if (!read) {
      this.log('warn', 'store notification refused', { store: 'google', code: 'store_notification_unverified', reason: 'unreadable message' });
      throw refuse(400, 'store_notification_unverified', 'This notification couldn’t be read as one from Google Play, so nothing was changed.');
    }
    const { messageId, notification } = read;
    const { type, subtype, token, orderId } = this.googleNotificationKind(notification);
    if (notification.packageName !== this.config.GOOGLE_PLAY_PACKAGE_NAME) {
      this.log('warn', 'store notification refused', { store: 'google', code: 'store_notification_wrong_app', type });
      throw refuse(400, 'store_notification_wrong_app', 'This notification is for a different app, so nothing was changed.');
    }

    // Pub/Sub delivers at least once. A message already logged changes nothing, and costs no call
    // to Google.
    const seen = await this.pool.query("SELECT 1 FROM billing_store_notifications WHERE store='google' AND notification_id=$1", [messageId]);
    if (seen.rowCount) {
      this.log('info', 'store notification received again', { store: 'google', type, notificationId: messageId });
      return { outcome: 'already-received' };
    }
    const found = token ? await this.pool.query("SELECT * FROM billing_store_purchases WHERE store='google' AND transaction_id=$1 ORDER BY created_at LIMIT 1", [token]) : null;
    const purchase = found?.rows[0] || null;
    const event = Object.hasOwn(GOOGLE_EVENTS, type) ? GOOGLE_EVENTS[type] : null;
    const now = this.now();
    const told = dateFrom(notification.eventTimeMillis);
    const eventAt = told && told < now ? told : now;
    // Only a notification that could change a room is read again from Google: one about a room we
    // granted. An extra is only noted (16C decides what a refunded one does), and a
    // quantity-based partial refund is left alone.
    const partial = subtype === 'QUANTITY_BASED_PARTIAL_REFUND';
    const word = event && purchase && purchase.kind !== 'extra' && !partial
      ? await this.askGoogle(purchase, { type, eventAt })
      : null;

    return withTransaction(this.pool, async (client) => {
      const note = await this.noteNotification(client, {
        store: 'google', notificationId: messageId, environment: purchase?.environment || null, type, subtype,
        transactionRef: token ? fingerprint(token) : null, signedAt: told,
      });
      if (!note) {
        this.log('info', 'store notification received again', { store: 'google', type, notificationId: messageId });
        return { outcome: 'already-received' };
      }
      const result = await this.googleNotificationEffect(client, { type, event, partial, purchase, word, token, orderId, eventAt });
      await this.settleNotification(client, note.id, result);
      this.log('info', 'store notification', {
        store: 'google', type, subtype, environment: purchase?.environment || null, outcome: result.outcome, ...(token ? { purchase: fingerprint(token) } : {}),
      });
      return { outcome: result.outcome };
    });
  }

  // Pub/Sub's push body: { message: { data: <base64 DeveloperNotification>, messageId }, subscription }.
  readGoogleMessage(body) {
    const message = body && typeof body === 'object' ? body.message : null;
    if (!message || typeof message !== 'object') return null;
    const messageId = String(message.messageId || message.message_id || '');
    if (!NOTIFICATION_ID.test(messageId) || typeof message.data !== 'string' || message.data.length > MAX_NOTIFICATION_LENGTH) return null;
    let notification;
    try {
      notification = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
    } catch {
      return null;
    }
    if (!notification || typeof notification !== 'object' || Array.isArray(notification)) return null;
    return { messageId, notification };
  }

  // A DeveloperNotification carries exactly one kind of notification.
  googleNotificationKind(notification) {
    const tokenOf = (value) => (typeof value === 'string' && PURCHASE_TOKEN.test(value) ? value : null);
    const numbered = (names, prefix, value) => names[Number(value)] || `${prefix}_${Number.isInteger(Number(value)) ? Number(value) : 'UNKNOWN'}`;
    if (notification.testNotification) return { type: 'TEST', subtype: null, token: null };
    const subscription = notification.subscriptionNotification;
    if (subscription && typeof subscription === 'object') {
      return { type: numbered(GOOGLE_SUBSCRIPTION_TYPES, 'SUBSCRIPTION', subscription.notificationType), subtype: null, token: tokenOf(subscription.purchaseToken) };
    }
    const voided = notification.voidedPurchaseNotification;
    if (voided && typeof voided === 'object') {
      return {
        type: 'VOIDED_PURCHASE',
        // Older notifications carry no refundType; those were all full refunds.
        subtype: voided.refundType === undefined ? 'FULL_REFUND' : numbered(GOOGLE_REFUND_TYPES, 'REFUND', voided.refundType),
        token: tokenOf(voided.purchaseToken),
        orderId: typeof voided.orderId === 'string' ? voided.orderId.slice(0, 128) : null,
      };
    }
    const oneTime = notification.oneTimeProductNotification;
    if (oneTime && typeof oneTime === 'object') {
      return { type: numbered(GOOGLE_ONE_TIME_TYPES, 'ONE_TIME_PRODUCT', oneTime.notificationType), subtype: null, token: tokenOf(oneTime.purchaseToken) };
    }
    if (notification.pendingRefundReviewNotification) return { type: 'PENDING_REFUND_REVIEW', subtype: null, token: null };
    return { type: 'UNKNOWN', subtype: null, token: null };
  }

  // What Google says about the purchase now, through the Play Developer API. Google not knowing the
  // purchase is an answer (`missing`); Google being unreachable, or refusing our credentials, is
  // not, and Pub/Sub is asked to send the notification again later.
  async askGoogle(purchase, { type, eventAt }) {
    if (!this.google) {
      this.log('warn', 'store notification refused', { store: 'google', code: 'store_unavailable', reason: 'play developer api not configured' });
      throw unavailable('google');
    }
    const token = purchase.transaction_id;
    try {
      const word = {};
      if (purchase.kind === 'subscription') word.subscription = await this.google.subscriptionPurchase(token);
      if (type === 'VOIDED_PURCHASE') {
        const since = Math.max(eventAt.getTime() - VOIDED_LOOKBACK_MS, this.now().getTime() - VOIDED_MAX_LOOKBACK_MS);
        word.voided = (await this.google.voidedPurchases({ since })).filter((entry) => entry?.purchaseToken === token);
      }
      return word;
    } catch (error) {
      if (!(error instanceof GooglePlayError)) throw error;
      if (error.kind === 'not-found') return { missing: true };
      if (error.kind === 'refused') this.log('error', 'google play refused our credentials', { status: error.status });
      throw unavailable('google');
    }
  }

  async googleNotificationEffect(client, { type, event, partial, purchase, word, token, orderId, eventAt }) {
    if (type === 'TEST') return { outcome: 'test' };
    if (!purchase) return { outcome: event && token ? 'unknown_purchase' : 'not_acted_on' };
    const fresh = await client.query('SELECT * FROM billing_store_purchases WHERE id=$1', [purchase.id]);
    const row = fresh.rows[0];
    if (!row) return { outcome: 'unknown_purchase' };
    const purchaseId = row.id;
    if (!event || partial) return { outcome: 'not_acted_on', purchaseId };
    // What a refunded extra photo or place does is not decided yet (16C): noted, nothing changed.
    if (row.kind === 'extra') return { outcome: 'extra_noted', purchaseId };
    const notConfirmed = (reason) => {
      this.log('warn', 'google did not confirm a notification', { type, reason, purchase: fingerprint(token) });
      return { outcome: 'unchanged', purchaseId };
    };
    if (!word || word.missing) return notConfirmed('google does not know the purchase');
    if (!row.entitlement_record_id) return { outcome: 'unchanged', purchaseId };
    const room = { store: 'google', environment: row.environment, recordId: row.entitlement_record_id };

    if (event === 'refunded') {
      const voids = (word.voided || []).filter((entry) => row.kind !== 'subscription' || !orderId || entry.orderId === orderId);
      const voided = voids[0];
      if (!voided) return notConfirmed('not among the voided purchases');
      const at = dateFrom(voided.voidedTimeMillis) || eventAt;
      const refundedAt = at < this.now() ? at : this.now();
      if (row.kind === 'subscription') {
        // Each renewal is its own order under the same token. A refund of an order that has since
        // been paid again changes nothing, as for Apple.
        const line = this.googleLine(word.subscription, row.product_id);
        const latest = line?.latestSuccessfulOrderId || word.subscription?.latestOrderId || null;
        if (latest && voided.orderId && latest !== voided.orderId) return { outcome: 'unchanged', purchaseId };
      }
      await this.markRevoked(client, row, refundedAt, 'refunded');
      const applied = await this.applyStoreEvent(client, { ...room, event: 'refunded', at: refundedAt });
      return { outcome: applied.effect, purchaseId };
    }

    // Everything else is about a subscription.
    if (row.kind !== 'subscription') return { outcome: 'unchanged', purchaseId };
    const record = word.subscription || {};
    const line = this.googleLine(record, row.product_id);
    if (!line) return notConfirmed('no line for the product');
    if ((record.testPurchase ? 'sandbox' : 'live') !== row.environment) return notConfirmed('another environment');
    const state = record.subscriptionState;

    if (event === 'renewed') {
      // Only a subscription Google says is running has a new paid period. In Google's grace or
      // account hold, expiryTime is Google's grace, never ours to read.
      if (!['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED'].includes(state)) return notConfirmed(`state ${String(state).slice(0, 64)}`);
      const endsAt = dateFrom(line.expiryTime);
      if (!endsAt) return notConfirmed('no expiry');
      // Refunded or revoked: only a period after the one refunded counts.
      if (row.revoked_at && row.expires_at && endsAt <= new Date(row.expires_at)) return { outcome: 'unchanged', purchaseId };
      const applied = await this.applyStoreEvent(client, { ...room, event: 'renewed', endsAt, at: eventAt, people: storeProduct(row.product_id)?.people || null });
      if (applied.effect === 'renewed') {
        await client.query(
          'UPDATE billing_store_purchases SET expires_at=$1,updated_at=$2 WHERE id=$3 AND (expires_at IS NULL OR expires_at<$1)',
          [endsAt, this.now(), row.id],
        );
      }
      return { outcome: applied.effect, purchaseId };
    }

    if (event === 'revoked') {
      if (state !== 'SUBSCRIPTION_STATE_EXPIRED') return notConfirmed(`state ${String(state).slice(0, 64)}`);
      const ended = dateFrom(line.expiryTime);
      const at = ended && ended < eventAt ? ended : eventAt;
      await this.markRevoked(client, row, at, 'revoked');
      const applied = await this.applyStoreEvent(client, { ...room, event: 'revoked', at });
      return { outcome: applied.effect, purchaseId };
    }

    // A lapse: nothing to write. The room ends on the date already paid for.
    const applied = await this.applyStoreEvent(client, { ...room, event: 'lapsed' });
    return { outcome: applied.effect, purchaseId };
  }

  googleLine(record, productId) {
    const lines = Array.isArray(record?.lineItems) ? record.lineItems : [];
    return lines.find((line) => line.productId === productId) || null;
  }

  // --- Google acknowledgement ----------------------------------------------------------------

  // Tells Google the purchase was granted, so it is not refunded. Consuming a one-time product is
  // its acknowledgement, and lets the same pass or extra be bought again. Returns whether Google
  // now has it; a failure is left pending for acknowledgePending, with a growing wait.
  async acknowledge(row) {
    if (!row || row.store !== 'google' || row.acknowledgement !== 'pending') return row?.acknowledgement !== 'pending';
    const done = async () => {
      await this.pool.query(
        `UPDATE billing_store_purchases SET acknowledgement='done',acknowledged_at=$1,acknowledge_attempts=acknowledge_attempts+1,
           next_acknowledge_at=NULL,last_acknowledge_error=NULL,updated_at=$1 WHERE id=$2`,
        [this.now(), row.id],
      );
      return true;
    };
    try {
      if (row.kind === 'subscription') await this.google.acknowledgeSubscription(row.product_id, row.transaction_id);
      else await this.google.consumeProduct(row.product_id, row.transaction_id);
      return await done();
    } catch (error) {
      // Google refuses to acknowledge twice. If it already has it (the phone did, or an earlier
      // attempt landed but its answer did not), it is done.
      if (await this.alreadyAcknowledged(row)) return done();
      await this.backOff(row, error);
      return false;
    }
  }

  // Any failure, of whatever kind, puts this one row back in the queue with a longer wait, so it can
  // never hold up the rows behind it.
  async backOff(row, error) {
    const attempts = Number(row.acknowledge_attempts) + 1;
    const now = this.now();
    const wait = ACKNOWLEDGE_BACKOFF_MS[Math.min(attempts - 1, ACKNOWLEDGE_BACKOFF_MS.length - 1)];
    const kind = error instanceof GooglePlayError ? `${error.kind}${error.status ? ` ${error.status}` : ''}` : String(error?.name || 'error').slice(0, 100);
    await this.pool.query(
      `UPDATE billing_store_purchases SET acknowledge_attempts=$1,next_acknowledge_at=$2,last_acknowledge_error=$3,updated_at=$4 WHERE id=$5`,
      [attempts, new Date(now.getTime() + wait), kind, now, row.id],
    );
    const late = row.acknowledge_by && new Date(row.acknowledge_by) <= now;
    this.log(late ? 'error' : 'warn', late ? 'google acknowledgement window missed' : 'google acknowledgement failed, will retry', {
      purchaseId: row.id, productId: row.product_id, attempts, error: kind,
    });
  }

  async alreadyAcknowledged(row) {
    try {
      if (row.kind === 'subscription') {
        const record = await this.google.subscriptionPurchase(row.transaction_id);
        return record.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      }
      const record = await this.google.productPurchase(row.product_id, row.transaction_id);
      return record.consumptionState === 1;
    } catch {
      return false;
    }
  }

  // Run every few minutes by the server (server/start.js). Everything still pending whose wait is
  // over gets another attempt.
  async acknowledgePending({ limit = 25 } = {}) {
    const tally = { acknowledged: 0, retrying: 0 };
    if (!this.google) return tally;
    const due = await this.pool.query(
      `SELECT * FROM billing_store_purchases
       WHERE store='google' AND acknowledgement='pending' AND (next_acknowledge_at IS NULL OR next_acknowledge_at<=$1)
       ORDER BY created_at LIMIT $2`,
      [this.now(), limit],
    );
    for (const row of due.rows) {
      let acknowledged = false;
      try {
        acknowledged = await this.acknowledge(row);
      } catch (error) {
        await this.backOff(row, error).catch(() => {});
      }
      if (acknowledged) tally.acknowledged += 1;
      else tally.retrying += 1;
    }
    return tally;
  }
}

export function createStorePurchaseService({ pool, config, platform, fetch = globalThis.fetch, log }) {
  const apple = config.appleRootCertificates.length ? new AppleTransactionVerifier({ rootCertificates: config.appleRootCertificates }) : null;
  const google = config.googlePlayServiceAccount
    ? new GooglePlayDeveloperApi({ serviceAccount: config.googlePlayServiceAccount, packageName: config.GOOGLE_PLAY_PACKAGE_NAME, fetch })
    : null;
  const { audience, serviceAccountEmail } = config.googlePlayNotifications || {};
  const googlePush = audience && serviceAccountEmail ? new GooglePushVerifier({ audience, serviceAccountEmail, fetch }) : null;
  return new StorePurchaseService({ pool, config, apple, google, googlePush, log, history: (client, event) => platform.appendEvent(client, event) });
}
