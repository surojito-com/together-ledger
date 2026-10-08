import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { PlatformError } from './platform.js';
import { AppleTransactionVerifier, AppleVerificationError } from './store-apple.js';
import { GooglePlayDeveloperApi, GooglePlayError } from './store-google.js';
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
// Not here: server notifications, refunds and revocations (#273), restoring on a new phone (#275).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURCHASE_TOKEN = /^[A-Za-z0-9._:-]{1,2048}$/;
const STORE = { apple: 'Apple', google: 'Google Play' };
const DAY_MS = 24 * 60 * 60 * 1000;
// Google refunds what is not acknowledged within three days of the purchase.
const ACKNOWLEDGE_WINDOW_MS = 3 * DAY_MS;
// Waits between acknowledgement attempts. The longest stays well inside the three days.
const ACKNOWLEDGE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000];
const MAX_QUANTITY = 10;

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
  constructor({ pool, config, apple = null, google = null, now = () => new Date(), log = null }) {
    this.pool = pool;
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
    this.assertEnvironment('apple', environment, refused);
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
    this.assertEnvironment('google', purchase.environment, refused);
    const result = await this.grant(userId, { ...purchase, logRef }, body);
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

  // A deployment honours one environment's purchases, and never the other's (#272).
  assertEnvironment(store, environment, refused) {
    if (environment === this.config.storeEnvironment) return;
    if (this.config.storeEnvironment === 'live') {
      throw refused(409, 'store_environment_mismatch', `This was a test purchase, and test purchases don’t add anything to Together Ledger. ${STORE[store]} doesn’t charge for them.`);
    }
    throw refused(409, 'store_environment_mismatch', 'This is Together Ledger’s test service, which only takes test purchases, so nothing was added here.');
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
      const seen = await client.query('SELECT * FROM billing_store_purchases WHERE store=$1 AND environment=$2 AND transaction_id=$3', [store, environment, purchase.transactionId]);
      if (seen.rowCount) return this.replay(client, seen.rows[0], purchase);

      await this.lockJourney(client, owner.journeyId);
      const membership = await client.query(
        'SELECT jm.role FROM journey_members jm JOIN journeys j ON j.id=jm.journey_id WHERE jm.journey_id=$1 AND jm.user_id=$2',
        [owner.journeyId, userId],
      );
      if (!membership.rowCount) {
        this.log('warn', 'store purchase refused', { store, code: 'store_purchase_journey_gone', productId: purchase.productId, ...purchase.logRef });
        throw refuse(409, 'store_purchase_journey_gone', `The journey this was bought for has ended, or you’re no longer in it, so nothing could be added. ${refundHint(store)}`);
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
        if (!moment.rowCount) throw refuse(409, 'store_extra_moment_missing', `That moment isn’t there any more. Choose another moment for this ${product.extra}; nothing has been lost.`, true);
      }

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
      this.log('info', 'store purchase granted', { store, environment, productId: purchase.productId, ...purchase.logRef });
      return this.describe(client, saved.rows[0], true);
    });
  }

  // The same transaction again. Nothing more is granted. A subscription's latest verified expiry is
  // still kept, since that is the store's word on how far it now runs, not a second grant.
  async replay(client, row, purchase) {
    if (row.kind === 'subscription') await this.grantSubscription(client, row, purchase);
    const saved = await client.query('SELECT * FROM billing_store_purchases WHERE id=$1', [row.id]);
    return this.describe(client, saved.rows[0], false);
  }

  async writeEntitlement(client, row, { recordId, quantity, effectiveAt, expiresAt, onlyForward }) {
    const now = this.now();
    await client.query(
      `INSERT INTO billing_entitlements
       (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,provider_event_created_at,reason,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,NULL,$11,$11)
       ON CONFLICT (source,environment,source_record_id,capability) DO UPDATE
       SET quantity=EXCLUDED.quantity,state=EXCLUDED.state,expires_at=EXCLUDED.expires_at,last_verified_at=EXCLUDED.last_verified_at,
           provider_event_created_at=EXCLUDED.provider_event_created_at,reason=NULL,updated_at=EXCLUDED.updated_at
       WHERE ${onlyForward ? 'billing_entitlements.expires_at IS NULL OR EXCLUDED.expires_at >= billing_entitlements.expires_at' : 'false'}`,
      [randomUUID(), row.payer_user_id, row.journey_id, ROOM_CAPABILITY, row.store, row.environment, recordId, quantity, effectiveAt, expiresAt, now, row.purchased_at],
    );
    await client.query(
      'UPDATE billing_store_purchases SET effective_at=COALESCE(effective_at,$1),expires_at=$2,entitlement_record_id=$3,updated_at=$4 WHERE id=$5',
      [effectiveAt, expiresAt, recordId, now, row.id],
    );
  }

  // A monthly subscription is one entitlement for its whole life, keyed by the store's id for the
  // subscription rather than for this payment, and it only ever moves forward: an older renewal
  // arriving late never shortens it. An upgrade from 51 to 101 is the same subscription at a new
  // size (Apple keeps the originalTransactionId).
  async grantSubscription(client, row, purchase) {
    await this.writeEntitlement(client, row, {
      recordId: purchase.originalTransactionId,
      quantity: roomFor(purchase.product),
      effectiveAt: purchase.purchasedAt,
      expiresAt: purchase.expiresAt,
      onlyForward: true,
    });
    // On Google an upgrade or downgrade is a new purchase token naming the one it replaces, which
    // Google ends; its room ends here too, rather than lingering to its old expiry.
    if (purchase.replacesToken) {
      await client.query(
        `UPDATE billing_entitlements SET state='expired',expires_at=$1,reason='store_subscription_replaced',updated_at=$1
         WHERE source='google' AND environment=$2 AND source_record_id=$3 AND capability=$4 AND state IN ('active','grace')`,
        [this.now(), row.environment, purchase.replacesToken, ROOM_CAPABILITY],
      );
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
    await this.writeEntitlement(client, row, {
      recordId: purchase.transactionId,
      quantity: room,
      effectiveAt: start,
      expiresAt: passEnd(purchase.product, start, purchase.quantity),
      onlyForward: false,
    });
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
      if (!(error instanceof GooglePlayError)) throw error;
      // Google refuses to acknowledge twice. If it already has it (the phone did, or an earlier
      // attempt landed but its answer did not), it is done.
      if (await this.alreadyAcknowledged(row)) return done();
      const attempts = Number(row.acknowledge_attempts) + 1;
      const now = this.now();
      const wait = ACKNOWLEDGE_BACKOFF_MS[Math.min(attempts - 1, ACKNOWLEDGE_BACKOFF_MS.length - 1)];
      await this.pool.query(
        `UPDATE billing_store_purchases SET acknowledge_attempts=$1,next_acknowledge_at=$2,last_acknowledge_error=$3,updated_at=$4 WHERE id=$5`,
        [attempts, new Date(now.getTime() + wait), `${error.kind}${error.status ? ` ${error.status}` : ''}`, now, row.id],
      );
      const late = row.acknowledge_by && new Date(row.acknowledge_by) <= now;
      this.log(late ? 'error' : 'warn', late ? 'google acknowledgement window missed' : 'google acknowledgement failed, will retry', {
        purchaseId: row.id, productId: row.product_id, attempts, error: error.kind,
      });
      return false;
    }
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
      if (await this.acknowledge(row)) tally.acknowledged += 1;
      else tally.retrying += 1;
    }
    return tally;
  }
}

export function createStorePurchaseService({ pool, config, fetch = globalThis.fetch, log }) {
  const apple = config.appleRootCertificates.length ? new AppleTransactionVerifier({ rootCertificates: config.appleRootCertificates }) : null;
  const google = config.googlePlayServiceAccount
    ? new GooglePlayDeveloperApi({ serviceAccount: config.googlePlayServiceAccount, packageName: config.GOOGLE_PLAY_PACKAGE_NAME, fetch })
    : null;
  return new StorePurchaseService({ pool, config, apple, google, log });
}
