import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { paidEnvironments } from './billing-environments.js';
import { withTransaction } from './db.js';
import { PlatformError } from './platform.js';

export const STRIPE_API_VERSION = '2026-02-25.clover';
const CAPABILITY = 'additional-journey-capacity';
const OFFER_ID = 'additional-person-monthly';
const IMAGE_OFFER_ID = 'additional-moment-image-once';
const LEGACY_IMAGE_OFFER_ID = 'additional-moment-image-monthly';
const LOCATION_OFFER_ID = 'additional-moment-location-monthly';
const UNIT_AMOUNT = 100;
const CURRENCY = 'USD';
const MAX_PAID_CAPACITY = 99;
const ACTIVE_STATES = new Set(['active', 'trialing']);
const GRACE_STATES = new Set(['past_due', 'unpaid', 'paused']);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unixDate(value) {
  return Number.isFinite(Number(value)) ? new Date(Number(value) * 1000) : null;
}

function objectId(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

function subscriptionPeriod(subscription) {
  const item = subscription.items?.data?.[0];
  return {
    start: unixDate(subscription.current_period_start ?? item?.current_period_start),
    end: unixDate(subscription.current_period_end ?? item?.current_period_end),
  };
}

function invoiceSubscriptionId(invoice) {
  return objectId(invoice.subscription)
    || objectId(invoice.parent?.subscription_details?.subscription)
    || null;
}

function invoicePeriod(invoice) {
  const lines = invoice.lines?.data || [];
  const periodEnds = lines.map((line) => Number(line.period?.end)).filter(Number.isFinite);
  return periodEnds.length ? unixDate(Math.max(...periodEnds)) : null;
}

function errorMessage(error) {
  return String(error?.message || error?.name || 'Webhook processing failed.').slice(0, 500);
}

async function listStripeObjects(listPage, params = {}) {
  const objects = [];
  let startingAfter;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await listPage({ ...params, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const data = Array.isArray(page?.data) ? page.data : [];
    objects.push(...data);
    if (!page?.has_more) return objects;
    if (!data.length || !data[data.length - 1]?.id) throw new Error('Stripe pagination did not provide a safe continuation cursor.');
    startingAfter = data[data.length - 1].id;
  }
  throw new Error('Stripe reconciliation exceeded its bounded pagination limit.');
}

export class DisabledBillingService {
  async status() {
    return { enabled: false, portalEnabled: false, environment: 'test', offers: [], entitlement: null, subscription: null, invoices: [] };
  }

  async createCheckoutSession() {
    throw new PlatformError(503, 'billing_unavailable', 'Membership billing is not available yet.');
  }

  async createPortalSession() {
    throw new PlatformError(503, 'billing_portal_unavailable', 'Billing settings are not available yet.');
  }

  async createImageCheckoutSession() { throw new PlatformError(503, 'billing_unavailable', 'Additional image billing is not available yet.'); }
  async createLocationCheckoutSession() { throw new PlatformError(503, 'billing_unavailable', 'Additional place billing is not available yet.'); }
  async assertLocationCapacity() { throw new PlatformError(409, 'location_payment_required', 'Another place needs an active monthly place add-on.'); }

  async assertAccountDeletable() {}

  async handleWebhook() {
    throw new PlatformError(503, 'billing_unavailable', 'Membership billing is not available yet.');
  }

  async reconcile() {
    throw new PlatformError(503, 'billing_unavailable', 'Membership billing reconciliation is not available.');
  }
}

export class StripeBillingService {
  constructor({ pool, config, stripe, now = () => new Date() }) {
    this.pool = pool;
    this.config = config;
    this.stripe = stripe;
    this.now = now;
    this.environment = config.stripeEnvironment;
    this.offer = {
      id: OFFER_ID,
      label: 'Another person',
      cadence: 'month',
      currency: CURRENCY,
      unitAmount: UNIT_AMOUNT,
      priceId: config.STRIPE_ADDITIONAL_PERSON_PRICE_ID,
    };
  }

  publicOffers() {
    const { priceId: _priceId, ...offer } = this.offer;
    return [offer];
  }

  async requireJourneyOwner(userId, journeyId) {
    if (!REQUEST_ID.test(String(journeyId || ''))) {
      throw new PlatformError(404, 'not_found', 'The requested journey was not found.');
    }
    const result = await this.pool.query(
      `SELECT u.id,u.email_normalized,u.email_verified_at,j.id AS journey_id,j.name AS journey_name
       FROM users u
       JOIN journey_members jm ON jm.user_id=u.id AND jm.role='owner'
       JOIN journeys j ON j.id=jm.journey_id
       WHERE u.id=$1 AND j.id=$2 AND u.deleted_at IS NULL`,
      [userId, journeyId],
    );
    if (!result.rowCount) throw new PlatformError(403, 'forbidden', 'Only the journey owner can manage its paid capacity.');
    if (!result.rows[0].email_verified_at) {
      throw new PlatformError(403, 'billing_email_unverified', 'Verify your email before adding another person.');
    }
    return result.rows[0];
  }

  async assertOfferPrice() {
    const price = await this.stripe.prices.retrieve(this.offer.priceId);
    const expectedLiveMode = this.environment === 'live';
    const valid = price.active
      && price.type === 'recurring'
      && Boolean(price.livemode) === expectedLiveMode
      && price.currency === CURRENCY.toLowerCase()
      && price.unit_amount === UNIT_AMOUNT
      && price.recurring?.interval === 'month'
      && price.recurring?.usage_type === 'licensed';
    if (!valid) {
      throw new PlatformError(503, 'billing_price_mismatch', 'The test price does not match the approved $1 monthly additional-person offer.');
    }
  }

  async assertPortalConfiguration() {
    const configuration = await this.stripe.billingPortal.configurations.retrieve(
      this.config.STRIPE_PORTAL_CONFIGURATION_ID,
    );
    const features = configuration.features || {};
    const valid = configuration.active
      && Boolean(configuration.livemode) === (this.environment === 'live')
      && features.invoice_history?.enabled === true
      && features.payment_method_update?.enabled === true
      && features.subscription_cancel?.enabled === true
      && features.subscription_cancel?.mode === 'at_period_end'
      && features.subscription_cancel?.proration_behavior === 'none'
      && features.subscription_update?.enabled === false
      && (features.subscription_update?.default_allowed_updates || []).length === 0
      && (!features.subscription_pause || features.subscription_pause.enabled === false)
      && (!features.customer_update || (
        features.customer_update.enabled === false
        && (features.customer_update.allowed_updates || []).length === 0
      ))
      && configuration.login_page?.enabled !== true;
    if (!valid) {
      throw new PlatformError(503, 'billing_portal_policy_mismatch', 'Billing settings do not match the approved journey policy.');
    }
  }

  async customerFor(user) {
    const existing = await this.pool.query(
      `SELECT provider_customer_id FROM billing_customers
       WHERE user_id=$1 AND provider='stripe' AND environment=$2`,
      [user.id, this.environment],
    );
    if (existing.rowCount) return existing.rows[0].provider_customer_id;

    const customer = await this.stripe.customers.create({
      email: user.email_normalized,
      metadata: { together_user_id: user.id, together_environment: this.environment },
    }, { idempotencyKey: `together-customer-${this.environment}-${user.id}` });
    const inserted = await this.pool.query(
      `INSERT INTO billing_customers (id,user_id,provider,environment,provider_customer_id,created_at,updated_at)
       VALUES ($1,$2,'stripe',$3,$4,$5,$5)
       ON CONFLICT (user_id,provider,environment) DO UPDATE
       SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=EXCLUDED.updated_at
       RETURNING provider_customer_id`,
      [randomUUID(), user.id, this.environment, customer.id, this.now()],
    );
    return inserted.rows[0].provider_customer_id;
  }

  async createCheckoutSession(userId, journeyId, { offerId, paidCapacity = 1, requestId }) {
    if (offerId !== OFFER_ID) throw new PlatformError(400, 'invalid_billing_offer', 'Choose the available additional-person option.');
    if (!REQUEST_ID.test(String(requestId || ''))) {
      throw new PlatformError(400, 'invalid_request_id', 'Refresh the page before trying checkout again.');
    }
    const quantity = Number(paidCapacity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PAID_CAPACITY) {
      throw new PlatformError(400, 'invalid_paid_capacity', 'Choose between 1 and 99 additional places.');
    }
    const user = await this.requireJourneyOwner(userId, journeyId);
    const existingSubscription = await this.pool.query(
      `SELECT 1 FROM billing_subscriptions
       WHERE journey_id=$1 AND environment=$2 AND status NOT IN ('canceled','incomplete_expired')
       LIMIT 1`,
      [journeyId, this.environment],
    );
    if (existingSubscription.rowCount) {
      throw new PlatformError(409, 'billing_subscription_exists', 'Use billing settings to manage the paid capacity already linked to this journey.');
    }
    await this.assertOfferPrice();
    const customerId = await this.customerFor(user);
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: journeyId,
      line_items: [{
        price: this.offer.priceId,
        quantity,
      }],
      success_url: `${this.config.PUBLIC_ORIGIN}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.config.PUBLIC_ORIGIN}/?billing=canceled`,
      customer_update: { address: 'auto', name: 'auto' },
      automatic_tax: { enabled: this.config.stripeTaxEnabled },
      metadata: {
        together_user_id: user.id,
        together_journey_id: journeyId,
        together_offer_id: OFFER_ID,
        together_paid_capacity: String(quantity),
        together_environment: this.environment,
      },
      subscription_data: {
        metadata: {
          together_user_id: user.id,
          together_journey_id: journeyId,
          together_offer_id: OFFER_ID,
          together_paid_capacity: String(quantity),
          together_environment: this.environment,
        },
      },
    }, { idempotencyKey: `together-checkout-${this.environment}-${journeyId}-${requestId}` });
    await this.pool.query(
      `INSERT INTO billing_checkout_sessions
       (provider_session_id,environment,payer_user_id,journey_id,offer_id,paid_capacity,mode,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7,$8,$8)
       ON CONFLICT (environment,provider_session_id) DO UPDATE
       SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [session.id, this.environment, user.id, journeyId, OFFER_ID, quantity, session.status || 'open', this.now()],
    );
    return { id: session.id, url: session.url, environment: this.environment, journeyId };
  }

  async createImageCheckoutSession(userId, journeyId, momentId, { requestId }) {
    if (!this.config.momentImageBillingEnabled) throw new PlatformError(503, 'billing_unavailable', 'Additional image billing is not available yet.');
    if (!REQUEST_ID.test(String(requestId || '')) || !REQUEST_ID.test(String(momentId || ''))) throw new PlatformError(400, 'invalid_request_id', 'Refresh the page before trying checkout again.');
    const member = await this.pool.query(`SELECT u.id,u.email_normalized,u.email_verified_at FROM users u JOIN journey_members jm ON jm.user_id=u.id WHERE u.id=$1 AND jm.journey_id=$2 AND u.deleted_at IS NULL`, [userId, journeyId]);
    if (!member.rowCount) throw new PlatformError(403, 'forbidden', 'Only a journey member can add an image.');
    if (!member.rows[0].email_verified_at) throw new PlatformError(403, 'billing_email_unverified', 'Verify your email before adding another image.');
    const moment = await this.pool.query(`SELECT id FROM journey_moments WHERE id=$1 AND journey_id=$2 AND (visibility='shared-now' OR created_by_user_id=$3)`, [momentId, journeyId, userId]);
    if (!moment.rowCount) throw new PlatformError(404, 'not_found', 'The requested moment was not found.');
    const price = await this.stripe.prices.retrieve(this.config.STRIPE_ADDITIONAL_IMAGE_PRICE_ID);
    if (!price.active || price.type !== 'one_time' || price.livemode || price.currency !== 'usd' || price.unit_amount !== 100 || this.environment !== 'test') throw new PlatformError(503, 'billing_price_mismatch', 'The image price must be an active test $1 one-time Stripe price.');
    const slotId = randomUUID();
    const customerId = await this.customerFor(member.rows[0]);
    const metadata = { together_offer_id: IMAGE_OFFER_ID, together_image_slot_id: slotId, together_user_id: userId, together_journey_id: journeyId, together_moment_id: momentId, together_environment: this.environment };
    const session = await this.stripe.checkout.sessions.create({ mode: 'payment', customer: customerId, line_items: [{ price: price.id, quantity: 1 }], success_url: `${this.config.PUBLIC_ORIGIN}/?image=success&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${this.config.PUBLIC_ORIGIN}/?image=canceled`, metadata, payment_intent_data: { metadata } }, { idempotencyKey: `together-image-checkout-${this.environment}-${slotId}-${requestId}` });
    await this.pool.query(`INSERT INTO moment_image_slots (id,journey_id,moment_id,payer_user_id,environment,provider_session_id,state,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7)`, [slotId, journeyId, momentId, userId, this.environment, session.id, this.now()]);
    return { url: session.url, id: session.id };
  }

  async createLocationCheckoutSession(userId, journeyId, momentId, { requestId }) {
    if (!this.config.momentLocationBillingEnabled) throw new PlatformError(503, 'billing_unavailable', 'Additional place billing is not available yet.');
    if (!REQUEST_ID.test(String(requestId || '')) || !REQUEST_ID.test(String(momentId || ''))) throw new PlatformError(400, 'invalid_request_id', 'Refresh the page before trying checkout again.');
    const member = await this.pool.query(`SELECT u.id,u.email_normalized,u.email_verified_at FROM users u JOIN journey_members jm ON jm.user_id=u.id WHERE u.id=$1 AND jm.journey_id=$2 AND u.deleted_at IS NULL`, [userId, journeyId]);
    if (!member.rowCount || !member.rows[0].email_verified_at) throw new PlatformError(403, 'billing_email_unverified', 'Verify your email before adding another place.');
    const moment = await this.pool.query(`SELECT id FROM journey_moments WHERE id=$1 AND journey_id=$2 AND (visibility='shared-now' OR created_by_user_id=$3)`, [momentId, journeyId, userId]);
    if (!moment.rowCount) throw new PlatformError(404, 'not_found', 'The requested moment was not found.');
    const price = await this.stripe.prices.retrieve(this.config.STRIPE_ADDITIONAL_LOCATION_PRICE_ID);
    if (!price.active || price.type !== 'recurring' || price.livemode || price.currency !== 'usd' || price.unit_amount !== 100 || price.recurring?.interval !== 'month') throw new PlatformError(503, 'billing_price_mismatch', 'The place price must be an active test $1 monthly Stripe price.');
    const slotId = randomUUID(); const customerId = await this.customerFor(member.rows[0]);
    const metadata = { together_offer_id: LOCATION_OFFER_ID, together_location_slot_id: slotId, together_user_id: userId, together_journey_id: journeyId, together_moment_id: momentId, together_environment: this.environment };
    const session = await this.stripe.checkout.sessions.create({ mode: 'subscription', customer: customerId, line_items: [{ price: price.id, quantity: 1 }], success_url: `${this.config.PUBLIC_ORIGIN}/?location=success&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${this.config.PUBLIC_ORIGIN}/?location=canceled`, metadata, subscription_data: { metadata } }, { idempotencyKey: `together-location-checkout-${this.environment}-${slotId}-${requestId}` });
    await this.pool.query(`INSERT INTO moment_location_slots (id,journey_id,moment_id,payer_user_id,environment,provider_session_id,state,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7)`, [slotId, journeyId, momentId, userId, this.environment, session.id, this.now()]);
    return { url: session.url, id: session.id, environment: this.environment };
  }

  // A place bought in a store (#272) counts the same as one paid for here.
  async assertLocationCapacity(userId, journeyId, momentId, locationCount) {
    const paid = paidEnvironments(this.config, { environment: 'mls.environment', payer: 'mls.payer_user_id', from: 4 });
    const slots = await this.pool.query(`SELECT m.location_billing_baseline,count(mls.id)::int AS count FROM journey_moments m LEFT JOIN moment_location_slots mls ON mls.moment_id=m.id AND mls.payer_user_id=$3 AND ${paid.sql} AND mls.state IN ('active','grace') WHERE m.id=$1 AND m.journey_id=$2 GROUP BY m.location_billing_baseline`, [momentId, journeyId, userId, ...paid.params]);
    const required = Math.max(0, Number(locationCount) - Number(slots.rows[0]?.location_billing_baseline || 1));
    if (!slots.rowCount || Number(slots.rows[0].count) < required) throw new PlatformError(409, 'location_payment_required', 'Another place needs an active monthly place add-on.');
  }

  async createPortalSession(userId, journeyId) {
    if (!this.config.billingPortalEnabled) {
      throw new PlatformError(503, 'billing_portal_unavailable', 'Billing settings are not available yet.');
    }
    await this.requireJourneyOwner(userId, journeyId);
    const result = await this.pool.query(
      `SELECT bs.provider_customer_id
       FROM billing_subscriptions bs
       JOIN billing_customers bc ON bc.user_id=bs.payer_user_id
         AND bc.provider='stripe' AND bc.environment=bs.environment
         AND bc.provider_customer_id=bs.provider_customer_id
       WHERE bs.journey_id=$1 AND bs.payer_user_id=$2 AND bs.environment=$3
         AND bs.offer_id=$4 AND bs.status NOT IN ('canceled','incomplete_expired')
       ORDER BY bs.updated_at DESC LIMIT 1`,
      [journeyId, userId, this.environment, OFFER_ID],
    );
    if (!result.rowCount) {
      throw new PlatformError(409, 'billing_subscription_missing', 'This journey has no active web billing relationship to manage.');
    }
    await this.assertPortalConfiguration();
    const session = await this.stripe.billingPortal.sessions.create({
      customer: result.rows[0].provider_customer_id,
      configuration: this.config.STRIPE_PORTAL_CONFIGURATION_ID,
      return_url: `${this.config.PUBLIC_ORIGIN}/?billing=portal`,
    });
    return { url: session.url, environment: this.environment, journeyId };
  }

  async assertAccountDeletable(userId) {
    const subscription = await this.pool.query(
      `SELECT 1 FROM billing_subscriptions bs
       JOIN journeys j ON j.id=bs.journey_id
       WHERE (bs.payer_user_id=$1 OR j.owner_user_id=$1) AND bs.environment=$2
         AND bs.status NOT IN ('canceled','incomplete_expired')
       LIMIT 1`,
      [userId, this.environment],
    );
    if (subscription.rowCount) {
      throw new PlatformError(409, 'billing_subscription_active', 'End paid journey capacity in billing settings and wait for it to finish before deleting this account.');
    }
  }

  async status(userId, journeyId) {
    const owner = await this.requireJourneyOwner(userId, journeyId);
    const [entitlements, subscriptions, invoices] = await Promise.all([
      this.pool.query(
        `SELECT capability,source,state,quantity,effective_at,expires_at,last_verified_at,reason
         FROM billing_entitlements WHERE journey_id=$1 AND environment=$2 ORDER BY updated_at DESC`,
        [journeyId, this.environment],
      ),
      this.pool.query(
        `SELECT offer_id,paid_capacity,status,current_period_start,current_period_end,cancel_at_period_end,canceled_at,updated_at
         FROM billing_subscriptions WHERE journey_id=$1 AND environment=$2 ORDER BY updated_at DESC LIMIT 1`,
        [journeyId, this.environment],
      ),
      this.pool.query(
        `SELECT provider_invoice_id,status,amount_due,amount_paid,currency,hosted_invoice_url,invoice_pdf_url,created_at
         FROM billing_invoices WHERE journey_id=$1 AND environment=$2 ORDER BY created_at DESC LIMIT 12`,
        [journeyId, this.environment],
      ),
    ]);
    const entitlement = entitlements.rows.find((row) => ['active', 'grace'].includes(row.state)) || entitlements.rows[0] || null;
    const now = this.now();
    const normalizedEntitlement = entitlement ? {
      capability: entitlement.capability,
      source: entitlement.source,
      state: entitlement.expires_at && new Date(entitlement.expires_at) <= now ? 'expired' : entitlement.state,
      effectiveAt: entitlement.effective_at,
      expiresAt: entitlement.expires_at,
      lastVerifiedAt: entitlement.last_verified_at,
      reason: entitlement.reason,
      quantity: entitlement.quantity,
    } : null;
    const subscription = subscriptions.rows[0];
    return {
      enabled: true,
      portalEnabled: Boolean(this.config.billingPortalEnabled && subscription
        && !['canceled', 'incomplete_expired'].includes(subscription.status)),
      environment: this.environment,
      journey: { id: journeyId, name: owner.journey_name },
      offers: this.publicOffers(),
      entitlement: normalizedEntitlement,
      subscription: subscription ? {
        offerId: subscription.offer_id,
        paidCapacity: subscription.paid_capacity,
        status: subscription.status,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at,
        updatedAt: subscription.updated_at,
      } : null,
      invoices: invoices.rows.map((invoice) => ({
        id: invoice.provider_invoice_id,
        status: invoice.status,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdfUrl: invoice.invoice_pdf_url,
        createdAt: invoice.created_at,
      })),
    };
  }

  async entitlementSnapshot(subscriptionId) {
    const result = await this.pool.query(
      `SELECT state,quantity,effective_at,expires_at,reason
       FROM billing_entitlements
       WHERE source='stripe' AND environment=$1 AND source_record_id=$2 AND capability=$3`,
      [this.environment, subscriptionId, CAPABILITY],
    );
    const row = result.rows[0];
    return row ? {
      state: row.state,
      quantity: Number(row.quantity),
      effectiveAt: row.effective_at ? new Date(row.effective_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      reason: row.reason || null,
    } : null;
  }

  async reconcile({ trigger = 'manual' } = {}) {
    if (!['manual', 'scheduled'].includes(trigger)) throw new PlatformError(400, 'invalid_reconciliation_trigger', 'Choose a supported reconciliation trigger.');
    const runId = randomUUID();
    const startedAt = this.now();
    const expectedLiveMode = this.environment === 'live';
    let lockClient;
    let lockHeld = false;
    if (this.config.NODE_ENV !== 'test') {
      lockClient = await this.pool.connect();
      const lock = await lockClient.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [`stripe-billing-reconciliation-${this.environment}`],
      );
      lockHeld = Boolean(lock.rows[0]?.locked);
      if (!lockHeld) {
        lockClient.release();
        throw new PlatformError(409, 'billing_reconciliation_in_progress', 'Another billing reconciliation is already running.');
      }
    }

    const summary = {
      environment: this.environment,
      trigger,
      customersScanned: 0,
      subscriptionsScanned: 0,
      invoicesScanned: 0,
      entitlementDriftRepaired: 0,
      duplicateCustomers: 0,
      webhookFailures: 0,
    };
    try {
      await this.pool.query(
        `INSERT INTO billing_reconciliation_runs
         (id,provider,environment,run_trigger,processing_state,started_at)
         VALUES ($1,'stripe',$2,$3,'running',$4)`,
        [runId, this.environment, trigger, startedAt],
      );
      await this.assertOfferPrice();

      const taggedCustomers = await listStripeObjects(
        (params) => this.stripe.customers.list(params),
      );
      const customerCounts = new Map();
      for (const customer of taggedCustomers) {
        if (customer.deleted || Boolean(customer.livemode) !== expectedLiveMode) continue;
        const taggedEnvironment = customer.metadata?.together_environment;
        const taggedUserId = customer.metadata?.together_user_id;
        if (taggedEnvironment !== this.environment || !REQUEST_ID.test(String(taggedUserId || ''))) continue;
        customerCounts.set(taggedUserId, (customerCounts.get(taggedUserId) || 0) + 1);
      }
      summary.duplicateCustomers = [...customerCounts.values()].reduce((count, value) => count + Math.max(0, value - 1), 0);

      const localCustomers = await this.pool.query(
        `SELECT provider_customer_id FROM billing_customers
         WHERE provider='stripe' AND environment=$1 ORDER BY created_at,provider_customer_id`,
        [this.environment],
      );
      summary.customersScanned = localCustomers.rowCount;
      for (const row of localCustomers.rows) {
        const subscriptions = await listStripeObjects(
          (params) => this.stripe.subscriptions.list(params),
          { customer: row.provider_customer_id, status: 'all' },
        );
        for (const subscription of subscriptions) {
          if (subscription.metadata?.together_offer_id !== OFFER_ID) continue;
          if (Boolean(subscription.livemode) !== expectedLiveMode) throw new Error('Stripe reconciliation received a subscription from the wrong environment.');
          summary.subscriptionsScanned += 1;
          const before = await this.entitlementSnapshot(subscription.id);
          await withTransaction(this.pool, (client) => this.processSubscription(client, subscription, this.now()));
          const after = await this.entitlementSnapshot(subscription.id);
          if (JSON.stringify(before) !== JSON.stringify(after)) summary.entitlementDriftRepaired += 1;
        }

        const invoices = await listStripeObjects(
          (params) => this.stripe.invoices.list(params),
          { customer: row.provider_customer_id },
        );
        for (const invoice of invoices) {
          if (Boolean(invoice.livemode) !== expectedLiveMode) throw new Error('Stripe reconciliation received an invoice from the wrong environment.');
          const subscriptionId = invoiceSubscriptionId(invoice);
          if (!subscriptionId) continue;
          summary.invoicesScanned += 1;
          await withTransaction(this.pool, (client) => this.processInvoice(client, invoice, 'invoice.reconciled', this.now()));
        }
      }

      const failures = await this.pool.query(
        `SELECT count(*)::int AS count FROM billing_webhook_events
         WHERE environment=$1 AND processing_state='failed'`,
        [this.environment],
      );
      summary.webhookFailures = Number(failures.rows[0]?.count || 0);
      await this.pool.query(
        `UPDATE billing_reconciliation_runs
         SET processing_state='succeeded',completed_at=$1,customers_scanned=$2,subscriptions_scanned=$3,
             invoices_scanned=$4,entitlement_drift_repaired=$5,duplicate_customers=$6,webhook_failures=$7
         WHERE id=$8`,
        [this.now(), summary.customersScanned, summary.subscriptionsScanned, summary.invoicesScanned,
          summary.entitlementDriftRepaired, summary.duplicateCustomers, summary.webhookFailures, runId],
      );
      return summary;
    } catch (error) {
      await this.pool.query(
        `UPDATE billing_reconciliation_runs SET processing_state='failed',completed_at=$1,last_error=$2 WHERE id=$3`,
        [this.now(), errorMessage(error), runId],
      ).catch(() => {});
      throw error;
    } finally {
      if (lockHeld) await lockClient.query(
        'SELECT pg_advisory_unlock(hashtextextended($1,0))',
        [`stripe-billing-reconciliation-${this.environment}`],
      ).catch(() => {});
      lockClient?.release();
    }
  }

  async handleWebhook(rawBody, signature) {
    if (!signature) throw new PlatformError(400, 'stripe_signature_missing', 'The Stripe signature is missing.');
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.config.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new PlatformError(400, 'stripe_signature_invalid', 'The Stripe signature is invalid.');
    }
    const expectedLiveMode = this.environment === 'live';
    if (Boolean(event.livemode) !== expectedLiveMode) {
      throw new PlatformError(400, 'stripe_environment_mismatch', `This endpoint accepts Stripe ${this.environment}-mode events only.`);
    }

    const existing = await this.pool.query(
      `SELECT processing_state,received_at FROM billing_webhook_events
       WHERE environment=$1 AND provider_event_id=$2`,
      [this.environment, event.id],
    );
    if (existing.rows.length) {
      const retry = await this.pool.query(
        `UPDATE billing_webhook_events SET processing_state='processing',attempts=attempts+1,last_error=NULL
         WHERE environment=$1 AND provider_event_id=$2
           AND (processing_state='failed' OR (processing_state='processing' AND received_at < $3))
         RETURNING provider_event_id`,
        [this.environment, event.id, new Date(this.now().getTime() - 5 * 60 * 1000)],
      );
      if (!retry.rowCount) return { received: true, duplicate: true };
    } else {
      const inserted = await this.pool.query(
        `INSERT INTO billing_webhook_events
         (provider_event_id,environment,event_type,provider_created_at,processing_state,attempts,received_at)
         VALUES ($1,$2,$3,$4,'processing',1,$5)
         ON CONFLICT (environment,provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
        [event.id, this.environment, event.type, unixDate(event.created), this.now()],
      );
      if (!inserted.rows.length) return { received: true, duplicate: true };
    }

    try {
      await withTransaction(this.pool, async (client) => {
        await this.processEvent(client, event);
        await client.query(
          `UPDATE billing_webhook_events SET processing_state='processed',processed_at=$1,last_error=NULL
           WHERE environment=$2 AND provider_event_id=$3`,
          [this.now(), this.environment, event.id],
        );
      });
      return { received: true, duplicate: false };
    } catch (error) {
      await this.pool.query(
        `UPDATE billing_webhook_events SET processing_state='failed',last_error=$1
         WHERE environment=$2 AND provider_event_id=$3`,
        [errorMessage(error), this.environment, event.id],
      );
      throw error;
    }
  }

  async billingContextFor(client, object, subscriptionId = null) {
    const metadata = {
      ...(object.parent?.subscription_details?.metadata || {}),
      ...(object.metadata || {}),
    };
    let payerUserId = metadata.together_user_id;
    let journeyId = metadata.together_journey_id || (object.object === 'checkout.session' ? object.client_reference_id : null);
    let paidCapacity = Number(metadata.together_paid_capacity);

    if (subscriptionId) {
      const subscription = await client.query(
        `SELECT payer_user_id,journey_id,paid_capacity FROM billing_subscriptions
         WHERE environment=$1 AND provider_subscription_id=$2`,
        [this.environment, subscriptionId],
      );
      payerUserId ||= subscription.rows[0]?.payer_user_id;
      journeyId ||= subscription.rows[0]?.journey_id;
      if (!Number.isInteger(paidCapacity)) paidCapacity = Number(subscription.rows[0]?.paid_capacity);
    }

    const customerId = objectId(object.customer);
    let customerUserId = null;
    if (customerId) {
      const customer = await client.query(
        `SELECT user_id FROM billing_customers
         WHERE provider='stripe' AND environment=$1 AND provider_customer_id=$2`,
        [this.environment, customerId],
      );
      customerUserId = customer.rows[0]?.user_id || null;
      if (!REQUEST_ID.test(String(payerUserId || ''))) payerUserId = customerUserId;
    }
    if (!REQUEST_ID.test(String(payerUserId || '')) || !REQUEST_ID.test(String(journeyId || ''))) return null;
    if (customerId && customerUserId !== payerUserId) return null;
    const records = await client.query(
      `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL) AS user_exists,
              EXISTS(SELECT 1 FROM journeys WHERE id=$2) AS journey_exists,
              EXISTS(SELECT 1 FROM journey_members WHERE journey_id=$2 AND user_id=$1 AND role='owner') AS owner_exists`,
      [payerUserId, journeyId],
    );
    if (!records.rows[0]?.user_exists || !records.rows[0]?.journey_exists || !records.rows[0]?.owner_exists) return null;
    return { payerUserId, journeyId, paidCapacity };
  }

  assertSubscriptionOffer(subscription) {
    const items = subscription.items?.data || [];
    const valid = subscription.metadata?.together_offer_id === OFFER_ID
      && items.length === 1
      && objectId(items[0]?.price) === this.offer.priceId;
    if (!valid) throw new Error('Stripe subscription does not match the approved Together Ledger offer.');
  }

  paidCapacityFor(subscription, fallback) {
    const quantity = Number(subscription.items?.data?.[0]?.quantity ?? fallback);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PAID_CAPACITY) {
      throw new Error('Stripe subscription quantity does not match the approved additional-capacity offer.');
    }
    return quantity;
  }

  entitlementState(subscription) {
    if (ACTIVE_STATES.has(subscription.status)) return 'active';
    if (GRACE_STATES.has(subscription.status)) return 'grace';
    if (subscription.status === 'incomplete') return 'pending';
    return 'expired';
  }

  async upsertEntitlement(client, { payerUserId, journeyId, sourceRecordId, state, quantity, eventCreatedAt, effectiveAt = null, expiresAt = null, reason = null }) {
    return client.query(
      `INSERT INTO billing_entitlements
       (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,provider_event_created_at,reason,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'stripe',$5,$6,$7,$8,$9,$10,$11,$12,$13,$11,$11)
       ON CONFLICT (source,environment,source_record_id,capability) DO UPDATE
       SET payer_user_id=EXCLUDED.payer_user_id,journey_id=EXCLUDED.journey_id,state=EXCLUDED.state,quantity=EXCLUDED.quantity,
           effective_at=COALESCE(EXCLUDED.effective_at,billing_entitlements.effective_at),
           expires_at=COALESCE(EXCLUDED.expires_at,billing_entitlements.expires_at),last_verified_at=EXCLUDED.last_verified_at,
           provider_event_created_at=EXCLUDED.provider_event_created_at,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at
       WHERE billing_entitlements.provider_event_created_at IS NULL
          OR EXCLUDED.provider_event_created_at >= billing_entitlements.provider_event_created_at`,
      [randomUUID(), payerUserId, journeyId, CAPABILITY, this.environment, sourceRecordId, state, quantity,
        effectiveAt, expiresAt, this.now(), eventCreatedAt, reason],
    );
  }

  async processCheckout(client, session) {
    if (session.metadata?.together_offer_id === IMAGE_OFFER_ID) {
      const slotId = session.metadata?.together_image_slot_id;
      const paymentId = objectId(session.payment_intent);
      if (session.mode !== 'payment' || session.payment_status !== 'paid' || !REQUEST_ID.test(String(slotId || '')) || !paymentId) return;
      await client.query(`UPDATE moment_image_slots SET provider_payment_id=$1,state='active',updated_at=$2 WHERE id=$3 AND environment=$4 AND provider_session_id=$5 AND state='pending'`, [paymentId, this.now(), slotId, this.environment, session.id]);
      return;
    }
    if (session.mode !== 'subscription' || session.metadata?.together_offer_id !== OFFER_ID) return;
    const context = await this.billingContextFor(client, session);
    if (!context) return;
    const paidCapacity = Number(context.paidCapacity);
    if (!Number.isInteger(paidCapacity) || paidCapacity < 1 || paidCapacity > MAX_PAID_CAPACITY) return;
    await client.query(
      `INSERT INTO billing_checkout_sessions
       (provider_session_id,environment,payer_user_id,journey_id,offer_id,paid_capacity,mode,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (environment,provider_session_id) DO UPDATE
       SET paid_capacity=EXCLUDED.paid_capacity,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [session.id, this.environment, context.payerUserId, context.journeyId, OFFER_ID, paidCapacity,
        session.mode || 'subscription', session.status || session.payment_status || 'complete', this.now()],
    );
  }

  async processSubscription(client, subscription, eventCreatedAt) {
    if (subscription.metadata?.together_offer_id === LEGACY_IMAGE_OFFER_ID) {
      const slotId = subscription.metadata?.together_image_slot_id;
      if (!REQUEST_ID.test(String(slotId || ''))) return;
      const state = ACTIVE_STATES.has(subscription.status) ? 'active' : GRACE_STATES.has(subscription.status) ? 'grace' : ['canceled', 'incomplete_expired'].includes(subscription.status) ? 'canceled' : 'pending';
      await client.query(`UPDATE moment_image_slots SET provider_subscription_id=$1,state=$2,updated_at=$3 WHERE id=$4 AND environment=$5`, [subscription.id, state, this.now(), slotId, this.environment]);
      return;
    }
    if (subscription.metadata?.together_offer_id === LOCATION_OFFER_ID) {
      const slotId = subscription.metadata?.together_location_slot_id;
      if (!REQUEST_ID.test(String(slotId || ''))) return;
      const state = ACTIVE_STATES.has(subscription.status) ? 'active' : GRACE_STATES.has(subscription.status) ? 'grace' : ['canceled', 'incomplete_expired'].includes(subscription.status) ? 'canceled' : 'pending';
      await client.query(`UPDATE moment_location_slots SET provider_subscription_id=$1,state=$2,updated_at=$3 WHERE id=$4 AND environment=$5`, [subscription.id, state, this.now(), slotId, this.environment]);
      return;
    }
    this.assertSubscriptionOffer(subscription);
    const context = await this.billingContextFor(client, subscription, subscription.id);
    if (!context) return;
    const customerId = objectId(subscription.customer);
    const paidCapacity = this.paidCapacityFor(subscription, context.paidCapacity);
    const period = subscriptionPeriod(subscription);
    const state = this.entitlementState(subscription);
    let graceExpiry = null;
    if (state === 'grace') {
      const existingEntitlement = await client.query(
        `SELECT state,expires_at FROM billing_entitlements
         WHERE source='stripe' AND environment=$1 AND source_record_id=$2 AND capability=$3`,
        [this.environment, subscription.id, CAPABILITY],
      );
      graceExpiry = existingEntitlement.rows[0]?.state === 'grace' && existingEntitlement.rows[0]?.expires_at
        ? new Date(existingEntitlement.rows[0].expires_at)
        : new Date(this.now().getTime() + this.config.billingGraceDays * 24 * 60 * 60 * 1000);
    }
    const expiresAt = state === 'expired' ? (unixDate(subscription.canceled_at) || this.now()) : graceExpiry || period.end;
    const savedSubscription = await client.query(
      `INSERT INTO billing_subscriptions
       (provider_subscription_id,environment,payer_user_id,journey_id,provider_customer_id,offer_id,paid_capacity,status,current_period_start,current_period_end,cancel_at_period_end,canceled_at,latest_invoice_id,provider_event_created_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       ON CONFLICT (environment,provider_subscription_id) DO UPDATE
       SET payer_user_id=EXCLUDED.payer_user_id,journey_id=EXCLUDED.journey_id,provider_customer_id=EXCLUDED.provider_customer_id,
           offer_id=EXCLUDED.offer_id,paid_capacity=EXCLUDED.paid_capacity,status=EXCLUDED.status,current_period_start=EXCLUDED.current_period_start,
           current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=EXCLUDED.cancel_at_period_end,
           canceled_at=EXCLUDED.canceled_at,latest_invoice_id=EXCLUDED.latest_invoice_id,
           provider_event_created_at=EXCLUDED.provider_event_created_at,updated_at=EXCLUDED.updated_at
       WHERE billing_subscriptions.provider_event_created_at IS NULL
          OR EXCLUDED.provider_event_created_at >= billing_subscriptions.provider_event_created_at
       RETURNING paid_capacity,status`,
      [subscription.id, this.environment, context.payerUserId, context.journeyId, customerId, OFFER_ID, paidCapacity,
        subscription.status, period.start, period.end,
        Boolean(subscription.cancel_at_period_end), unixDate(subscription.canceled_at), objectId(subscription.latest_invoice), eventCreatedAt, this.now()],
    );
    if (!savedSubscription.rowCount) return;
    await this.upsertEntitlement(client, {
      payerUserId: context.payerUserId,
      journeyId: context.journeyId,
      sourceRecordId: subscription.id,
      state,
      quantity: paidCapacity,
      eventCreatedAt,
      effectiveAt: period.start || unixDate(subscription.created),
      expiresAt,
      reason: state === 'grace' ? 'subscription_payment_recovery' : state === 'expired' ? `subscription_${subscription.status}` : null,
    });
  }

  async processInvoice(client, invoice, eventType, eventCreatedAt) {
    const subscriptionId = invoiceSubscriptionId(invoice);
    const context = await this.billingContextFor(client, invoice, subscriptionId);
    if (!context) return;
    const storedSubscription = subscriptionId ? await client.query(
      `SELECT paid_capacity,status FROM billing_subscriptions
       WHERE environment=$1 AND provider_subscription_id=$2`,
      [this.environment, subscriptionId],
    ) : { rows: [] };
    const paidCapacity = Number(storedSubscription.rows[0]?.paid_capacity ?? context.paidCapacity);
    if (!Number.isInteger(paidCapacity) || paidCapacity < 1 || paidCapacity > MAX_PAID_CAPACITY) return;
    const savedInvoice = await client.query(
      `INSERT INTO billing_invoices
       (provider_invoice_id,environment,payer_user_id,journey_id,provider_subscription_id,status,amount_due,amount_paid,currency,hosted_invoice_url,invoice_pdf_url,provider_event_created_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (environment,provider_invoice_id) DO UPDATE
       SET status=EXCLUDED.status,amount_due=EXCLUDED.amount_due,amount_paid=EXCLUDED.amount_paid,
           hosted_invoice_url=EXCLUDED.hosted_invoice_url,invoice_pdf_url=EXCLUDED.invoice_pdf_url,
           provider_event_created_at=EXCLUDED.provider_event_created_at,updated_at=EXCLUDED.updated_at
       WHERE billing_invoices.provider_event_created_at IS NULL
          OR EXCLUDED.provider_event_created_at >= billing_invoices.provider_event_created_at
       RETURNING provider_invoice_id`,
      [invoice.id, this.environment, context.payerUserId, context.journeyId, subscriptionId, invoice.status || 'unknown', Number(invoice.amount_due) || 0,
        Number(invoice.amount_paid) || 0, String(invoice.currency || '').toUpperCase(), invoice.hosted_invoice_url || null,
        invoice.invoice_pdf || null, eventCreatedAt, unixDate(invoice.created) || this.now(), this.now()],
    );
    if (!savedInvoice.rowCount || !subscriptionId || !storedSubscription.rows.length) return;
    const subscriptionStatus = storedSubscription.rows[0]?.status;
    if (subscriptionStatus && !ACTIVE_STATES.has(subscriptionStatus) && !GRACE_STATES.has(subscriptionStatus) && subscriptionStatus !== 'incomplete') return;
    if (eventType === 'invoice.paid') {
      await this.upsertEntitlement(client, {
        payerUserId: context.payerUserId,
        journeyId: context.journeyId,
        sourceRecordId: subscriptionId,
        state: 'active',
        quantity: paidCapacity,
        eventCreatedAt,
        effectiveAt: unixDate(invoice.period_start),
        expiresAt: invoicePeriod(invoice) || unixDate(invoice.period_end),
      });
    }
    if (eventType === 'invoice.payment_failed') {
      await this.upsertEntitlement(client, {
        payerUserId: context.payerUserId,
        journeyId: context.journeyId,
        sourceRecordId: subscriptionId,
        state: 'grace',
        quantity: paidCapacity,
        eventCreatedAt,
        expiresAt: new Date(this.now().getTime() + this.config.billingGraceDays * 24 * 60 * 60 * 1000),
        reason: 'invoice_payment_failed',
      });
    }
  }

  async processEvent(client, event) {
    const object = event.data?.object || {};
    const eventCreatedAt = unixDate(event.created) || this.now();
    if (event.type.startsWith('checkout.session.')) return this.processCheckout(client, object);
    if (event.type.startsWith('customer.subscription.')) return this.processSubscription(client, object, eventCreatedAt);
    if (event.type.startsWith('invoice.')) return this.processInvoice(client, object, event.type, eventCreatedAt);
  }
}

export function createBillingService({ pool, config, stripe }) {
  if (!config.billingEnabled) return new DisabledBillingService();
  const client = stripe || new Stripe(config.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: 'Together Ledger', version: '0.3.0', url: 'https://together-ledger.com' },
  });
  return new StripeBillingService({ pool, config, stripe: client });
}
