import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import Stripe from 'stripe';
import { buildApp } from '../server/app.js';
import { STRIPE_API_VERSION, StripeBillingService } from '../server/billing.js';
import { loadConfig } from '../server/config.js';

const userId = '11111111-1111-4111-8111-111111111111';
const journeyId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-07T19:00:00.000Z');

function billingConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://together-ledger.example.test',
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
    BILLING_ENABLED: 'true',
    BILLING_PORTAL_ENABLED: 'true',
    STRIPE_ENVIRONMENT: 'test',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_additional_person_test',
    STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_test_approved',
    ...overrides,
  });
}

async function billingPool() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({
    name: 'char_length',
    args: ['text'],
    returns: 'integer',
    implementation: (value) => value.length,
  });
  memory.public.registerFunction({
    name: 'jsonb_array_length',
    args: ['jsonb'],
    returns: 'integer',
    implementation: (value) => Array.isArray(value) ? value.length : 0,
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  for (const migration of ['001_platform.sql', '003_private_usernames.sql', '004_shared_moments.sql', '005_make-shared-journeys-more-humane.sql', '006_expand-shared-moment-vocabulary.sql', '007_person_specific_moment_visibility.sql', '008_stripe_web_billing.sql', '010_stripe_reconciliation_runs.sql', '011_hold-one-image-with-each-moment.sql', '012_bill-additional-moment-images.sql', '013_name-moment-image-attachments.sql', '014_hold-places-with-shared-moments.sql', '015_bill-additional-moment-places.sql', '016_make-extra-image-payments-one-time.sql', '017_keep-one-removed-photo-per-moment.sql', '018_allow-ninety-nine-paid-journey-places.sql', '020_let-entitlements-hold-ninety-nine-places.sql', '021_let-unpaid-capacity-rest-without-losing-history.sql', '022_agree-together-before-adding-someone.sql']) {
    await pool.query(await readFile(new URL(`../server/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await pool.query(
    `INSERT INTO users (id,email_normalized,username,display_name,password_hash,email_verified_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [userId, 'member@example.test', 'member-one', 'member-one', 'not-used-in-this-test', now],
  );
  await pool.query(
    `INSERT INTO journeys (id,owner_user_id,name,location,start_date,end_date,budget_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,$7)`,
    [journeyId, userId, 'A wider circle', 'Together', '2026-09-01', '2026-09-30', now],
  );
  await pool.query(
    `INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,'owner',$3)`,
    [journeyId, userId, now],
  );
  return pool;
}

function fakeStripe({
  listedCustomers = [],
  listedSubscriptions = [],
  listedInvoices = [],
  portalConfiguration = {
    id: 'bpc_test_approved',
    active: true,
    livemode: false,
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_update: { enabled: false, default_allowed_updates: [] },
      subscription_pause: { enabled: false },
    },
  },
} = {}) {
  const calls = { customers: [], checkouts: [], portalConfigurations: [], portals: [] };
  return {
    calls,
    prices: {
      async retrieve(id) {
        assert.ok(['price_additional_person_test', 'price_additional_location_test', 'price_additional_image_test'].includes(id));
        if (id === 'price_additional_image_test') return { id, active: true, livemode: false, type: 'one_time', currency: 'usd', unit_amount: 100 };
        return { id, active: true, livemode: false, type: 'recurring', currency: 'usd', unit_amount: 100, recurring: { interval: 'month', usage_type: 'licensed' } };
      },
    },
    customers: {
      async create(input, options) {
        calls.customers.push({ input, options });
        return { id: 'cus_test_member' };
      },
      async list() {
        return { data: listedCustomers, has_more: false };
      },
    },
    subscriptions: {
      async list() {
        return { data: listedSubscriptions, has_more: false };
      },
    },
    invoices: {
      async list() {
        return { data: listedInvoices, has_more: false };
      },
    },
    checkout: {
      sessions: {
        async create(input, options) {
          calls.checkouts.push({ input, options });
          return { id: 'cs_test_membership', url: 'https://checkout.stripe.com/c/pay/test', status: 'open' };
        },
      },
    },
    billingPortal: {
      configurations: {
        async retrieve(id) {
          calls.portalConfigurations.push(id);
          return portalConfiguration;
        },
      },
      sessions: {
        async create(input) {
          calls.portals.push(input);
          return { id: 'bps_test_membership', url: 'https://billing.stripe.com/p/session/test' };
        },
      },
    },
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        assert.ok(Buffer.isBuffer(rawBody));
        assert.equal(signature, 'valid-signature');
        assert.equal(secret, 'whsec_fake');
        return JSON.parse(rawBody.toString('utf8'));
      },
    },
  };
}

test('billing configuration refuses keys from the wrong Stripe environment', () => {
  assert.throws(
    () => billingConfig({ STRIPE_SECRET_KEY: 'sk_live_fake' }),
    /Test Stripe billing accepts test-mode keys only/,
  );
  assert.throws(
    () => billingConfig({ STRIPE_ENVIRONMENT: 'live', STRIPE_SECRET_KEY: 'sk_test_fake' }),
    /Live Stripe billing accepts live-mode keys only/,
  );
});

test('checkout creates one journey-scoped monthly subscription with a fixed quantity', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const stripe = fakeStripe();
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe, now: () => now });
  const requestId = '33333333-3333-4333-8333-333333333333';

  const checkout = await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly', paidCapacity: 1, requestId,
  });
  assert.equal(checkout.url, 'https://checkout.stripe.com/c/pay/test');
  assert.equal(checkout.environment, 'test');
  assert.equal(stripe.calls.checkouts[0].input.line_items[0].price, 'price_additional_person_test');
  assert.equal(stripe.calls.checkouts[0].input.line_items[0].quantity, 1);
  assert.equal(stripe.calls.checkouts[0].input.line_items[0].adjustable_quantity, undefined);
  assert.equal(stripe.calls.checkouts[0].input.mode, 'subscription');
  assert.equal(stripe.calls.checkouts[0].input.metadata.together_user_id, userId);
  assert.equal(stripe.calls.checkouts[0].input.metadata.together_journey_id, journeyId);
  assert.equal(stripe.calls.checkouts[0].input.metadata.together_paid_capacity, '1');
  assert.match(stripe.calls.checkouts[0].options.idempotencyKey, new RegExp(requestId));
  await assert.rejects(
    billing.createCheckoutSession(userId, journeyId, { offerId: 'price_from_browser', paidCapacity: 1, requestId }),
    (error) => error.code === 'invalid_billing_offer',
  );
  await assert.rejects(
    billing.createCheckoutSession(userId, journeyId, { offerId: 'additional-person-monthly', paidCapacity: 100, requestId }),
    (error) => error.code === 'invalid_paid_capacity',
  );
  const largerCheckout = await billing.createCheckoutSession(userId, journeyId, { offerId: 'additional-person-monthly', paidCapacity: 99, requestId: '34333333-3333-4333-8333-333333333333' });
  assert.equal(largerCheckout.environment, 'test');
  assert.equal(stripe.calls.checkouts[1].input.line_items[0].quantity, 99);

  const status = await billing.status(userId, journeyId);
  assert.equal(status.enabled, true);
  assert.equal(status.environment, 'test');
  assert.equal(status.journey.name, 'A wider circle');
  assert.equal(status.portalEnabled, false);
  assert.deepEqual(status.offers, [{
    id: 'additional-person-monthly', label: 'Another person', cadence: 'month', currency: 'USD', unitAmount: 100,
  }]);
  assert.equal(JSON.stringify(status).includes('price_additional_person_test'), false);
});

test('a test-only additional place stays pending until its verified webhook arrives', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const momentId = '12121212-1212-4121-8121-121212121212';
  await pool.query(
    `INSERT INTO journey_moments (id,journey_id,kind,kind_label,occurred_on,title,detail,visibility,money_cents,money_currency,locations,created_by_user_id,updated_by_user_id)
     VALUES ($1,$2,'memory','',$3,$4,'','shared-now',NULL,'USD','[]'::jsonb,$5,$5)`,
    [momentId, journeyId, '2026-09-07', 'A remembered place', userId],
  );
  const stripe = fakeStripe();
  const billing = new StripeBillingService({
    pool,
    config: billingConfig({ MOMENT_LOCATION_BILLING_ENABLED: 'true', STRIPE_ADDITIONAL_LOCATION_PRICE_ID: 'price_additional_location_test' }),
    stripe,
    now: () => now,
  });

  const checkout = await billing.createLocationCheckoutSession(userId, journeyId, momentId, { requestId: '13131313-1313-4131-8131-131313131313' });
  const slot = await pool.query('SELECT id,state,provider_session_id FROM moment_location_slots');
  assert.equal(checkout.environment, 'test');
  assert.equal(slot.rows[0].state, 'pending');
  assert.equal(slot.rows[0].provider_session_id, checkout.id);
  assert.equal(stripe.calls.checkouts[0].input.line_items[0].price, 'price_additional_location_test');
  assert.equal(stripe.calls.checkouts[0].input.metadata.together_offer_id, 'additional-moment-location-monthly');
  await assert.rejects(
    billing.assertLocationCapacity(userId, journeyId, momentId, 2),
    (error) => error.code === 'location_payment_required',
  );

  const event = {
    id: 'evt_test_location_subscription', type: 'customer.subscription.updated', created: 1788807600, livemode: false,
    data: { object: { id: 'sub_test_location', status: 'active', metadata: { together_offer_id: 'additional-moment-location-monthly', together_location_slot_id: slot.rows[0].id } } },
  };
  await billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'valid-signature');
  const activated = await pool.query('SELECT state,provider_subscription_id FROM moment_location_slots WHERE id=$1', [slot.rows[0].id]);
  assert.deepEqual(activated.rows[0], { state: 'active', provider_subscription_id: 'sub_test_location' });
  await billing.assertLocationCapacity(userId, journeyId, momentId, 2);
  await assert.rejects(
    billing.handleWebhook(Buffer.from(JSON.stringify({ ...event, id: 'evt_live_location_subscription', livemode: true })), 'valid-signature'),
    (error) => error.code === 'stripe_environment_mismatch',
  );
});

test('a test-only extra photo becomes one consumable credit after its paid checkout webhook', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const momentId = '14141414-1414-4141-8141-141414141414';
  await pool.query(
    `INSERT INTO journey_moments (id,journey_id,kind,kind_label,occurred_on,title,detail,visibility,money_cents,money_currency,locations,created_by_user_id,updated_by_user_id)
     VALUES ($1,$2,'memory','',$3,$4,'','shared-now',NULL,'USD','[]'::jsonb,$5,$5)`,
    [momentId, journeyId, '2026-09-07', 'A second photo', userId],
  );
  const stripe = fakeStripe();
  const billing = new StripeBillingService({
    pool,
    config: billingConfig({ MOMENT_IMAGE_BILLING_ENABLED: 'true', STRIPE_ADDITIONAL_IMAGE_PRICE_ID: 'price_additional_image_test' }),
    stripe,
    now: () => now,
  });

  const checkout = await billing.createImageCheckoutSession(userId, journeyId, momentId, { requestId: '15151515-1515-4151-8151-151515151515' });
  assert.equal(stripe.calls.checkouts[0].input.mode, 'payment');
  assert.equal(stripe.calls.checkouts[0].input.line_items[0].price, 'price_additional_image_test');
  assert.equal(stripe.calls.checkouts[0].input.subscription_data, undefined);
  const slot = await pool.query('SELECT id,state FROM moment_image_slots');
  assert.equal(slot.rows[0].state, 'pending');
  await assert.rejects(
    billing.assertImageSlot(userId, journeyId, momentId, slot.rows[0].id),
    (error) => error.code === 'image_payment_required',
  );

  await billing.handleWebhook(Buffer.from(JSON.stringify({
    id: 'evt_test_image_payment', type: 'checkout.session.completed', created: 1788807600, livemode: false,
    data: { object: { id: checkout.id, mode: 'payment', payment_status: 'paid', payment_intent: 'pi_test_image_payment', metadata: { together_offer_id: 'additional-moment-image-once', together_image_slot_id: slot.rows[0].id } } },
  })), 'valid-signature');
  const activated = await pool.query('SELECT state,provider_payment_id,used_at FROM moment_image_slots WHERE id=$1', [slot.rows[0].id]);
  assert.deepEqual(activated.rows[0], { state: 'active', provider_payment_id: 'pi_test_image_payment', used_at: null });
  await billing.assertImageSlot(userId, journeyId, momentId, slot.rows[0].id);
});

test('test-mode webhooks grant access once and reject live events', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const stripe = fakeStripe();
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe, now: () => now });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 1,
    requestId: '44444444-4444-4444-8444-444444444444',
  });

  const subscriptionEvent = {
    id: 'evt_test_subscription',
    type: 'customer.subscription.updated',
    created: 1788807600,
    livemode: false,
    data: {
      object: {
        id: 'sub_test_membership',
        customer: 'cus_test_member',
        status: 'active',
        created: 1788807600,
        current_period_start: 1788807600,
        current_period_end: 1791399600,
        cancel_at_period_end: false,
        metadata: {
          together_user_id: userId,
          together_journey_id: journeyId,
          together_offer_id: 'additional-person-monthly',
          together_paid_capacity: '1',
        },
        items: { data: [{ quantity: 1, price: { id: 'price_additional_person_test' } }] },
      },
    },
  };
  const first = await billing.handleWebhook(Buffer.from(JSON.stringify(subscriptionEvent)), 'valid-signature');
  const duplicate = await billing.handleWebhook(Buffer.from(JSON.stringify(subscriptionEvent)), 'valid-signature');
  assert.deepEqual(first, { received: true, duplicate: false });
  assert.deepEqual(duplicate, { received: true, duplicate: true });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_webhook_events')).rows[0].count, 1);
  const status = await billing.status(userId, journeyId);
  assert.equal(status.entitlement.state, 'active');
  assert.equal(status.entitlement.source, 'stripe');
  assert.equal(status.entitlement.quantity, 1);
  assert.equal(status.subscription.offerId, 'additional-person-monthly');
  assert.equal(status.subscription.paidCapacity, 1);
  assert.equal(status.portalEnabled, true);

  const portal = await billing.createPortalSession(userId, journeyId);
  assert.equal(portal.url, 'https://billing.stripe.com/p/session/test');
  assert.deepEqual(stripe.calls.portalConfigurations, ['bpc_test_approved']);
  assert.deepEqual(stripe.calls.portals, [{
    customer: 'cus_test_member',
    configuration: 'bpc_test_approved',
    return_url: 'https://together-ledger.example.test/?billing=portal',
  }]);
  await assert.rejects(
    billing.createPortalSession('99999999-9999-4999-8999-999999999999', journeyId),
    (error) => error.code === 'forbidden',
  );
  const broadPortal = new StripeBillingService({
    pool,
    config: billingConfig(),
    stripe: fakeStripe({
      portalConfiguration: {
        id: 'bpc_test_approved',
        active: true,
        livemode: false,
        features: {
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
          subscription_update: { enabled: true, default_allowed_updates: ['quantity'] },
        },
      },
    }),
    now: () => now,
  });
  await assert.rejects(
    broadPortal.createPortalSession(userId, journeyId),
    (error) => error.code === 'billing_portal_policy_mismatch',
  );
  await assert.rejects(
    billing.createCheckoutSession(userId, journeyId, {
      offerId: 'additional-person-monthly',
      paidCapacity: 1,
      requestId: '55555555-5555-4555-8555-555555555555',
    }),
    (error) => error.code === 'billing_subscription_exists',
  );
  await assert.rejects(
    billing.assertAccountDeletable(userId),
    (error) => error.code === 'billing_subscription_active',
  );

  const liveEvent = { ...subscriptionEvent, id: 'evt_live_wrong_place', livemode: true };
  await assert.rejects(
    billing.handleWebhook(Buffer.from(JSON.stringify(liveEvent)), 'valid-signature'),
    (error) => error.code === 'stripe_environment_mismatch',
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM billing_webhook_events WHERE provider_event_id='evt_live_wrong_place'")).rows[0].count, 0);
});

test('webhooks reject subscriptions outside the approved owner, customer, and price boundary', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe: fakeStripe(), now: () => now });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 1,
    requestId: '66666666-6666-4666-8666-666666666666',
  });
  const event = {
    id: 'evt_wrong_price',
    type: 'customer.subscription.created',
    created: 1788807600,
    livemode: false,
    data: {
      object: {
        id: 'sub_wrong_price',
        customer: 'cus_test_member',
        status: 'active',
        metadata: {
          together_user_id: userId,
          together_journey_id: journeyId,
          together_offer_id: 'additional-person-monthly',
          together_paid_capacity: '1',
        },
        items: { data: [{ quantity: 1, price: { id: 'price_not_approved' } }] },
      },
    },
  };
  await assert.rejects(
    billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'valid-signature'),
    /does not match the approved Together Ledger offer/,
  );
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_subscriptions')).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_entitlements')).rows[0].count, 0);
});

test('webhooks project the approved 1-99 paid capacity from the subscription quantity', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe: fakeStripe(), now: () => now });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 99,
    requestId: '99999999-9999-4999-8999-999999999999',
  });
  const subscriptionEvent = (id, quantity) => ({
    id,
    type: 'customer.subscription.created',
    created: 1788807600,
    livemode: false,
    data: {
      object: {
        id: 'sub_wide_capacity',
        customer: 'cus_test_member',
        status: 'active',
        current_period_start: 1788807600,
        current_period_end: 1791399600,
        cancel_at_period_end: false,
        metadata: {
          together_user_id: userId,
          together_journey_id: journeyId,
          together_offer_id: 'additional-person-monthly',
          together_paid_capacity: '99',
        },
        items: { data: [{ quantity, price: { id: 'price_additional_person_test' } }] },
      },
    },
  });

  await billing.handleWebhook(Buffer.from(JSON.stringify(subscriptionEvent('evt_wide_capacity_active', 99))), 'valid-signature');
  const entitlement = (await pool.query(
    `SELECT state,quantity FROM billing_entitlements WHERE source_record_id='sub_wide_capacity'`,
  )).rows[0];
  assert.deepEqual(entitlement, { state: 'active', quantity: 99 });

  await assert.rejects(
    billing.handleWebhook(Buffer.from(JSON.stringify(subscriptionEvent('evt_wide_capacity_over_max', 100))), 'valid-signature'),
    /does not match the approved additional-capacity offer/,
  );
});

test('an invoice cannot grant capacity before its approved subscription is known', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe: fakeStripe(), now: () => now });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 1,
    requestId: '77777777-7777-4777-8777-777777777777',
  });
  const event = {
    id: 'evt_invoice_before_subscription',
    type: 'invoice.paid',
    created: 1788807600,
    livemode: false,
    data: {
      object: {
        id: 'in_before_subscription',
        object: 'invoice',
        customer: 'cus_test_member',
        status: 'paid',
        amount_due: 100,
        amount_paid: 100,
        currency: 'usd',
        parent: {
          subscription_details: {
            subscription: 'sub_not_yet_known',
            metadata: {
              together_user_id: userId,
              together_journey_id: journeyId,
              together_paid_capacity: '1',
            },
          },
        },
      },
    },
  };
  await billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'valid-signature');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_invoices')).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_entitlements')).rows[0].count, 0);
});

test('delayed invoice events cannot restore stale payment state or paid capacity', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe: fakeStripe(), now: () => now });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 1,
    requestId: '88888888-8888-4888-8888-888888888888',
  });
  const base = Math.floor(now.getTime() / 1000);
  const subscription = (id, created, status, quantity) => ({
    id,
    type: 'customer.subscription.updated',
    created,
    livemode: false,
    data: {
      object: {
        id: 'sub_test_ordering',
        customer: 'cus_test_member',
        status,
        created: base,
        current_period_start: base,
        current_period_end: base + 2_592_000,
        cancel_at_period_end: false,
        metadata: {
          together_user_id: userId,
          together_journey_id: journeyId,
          together_offer_id: 'additional-person-monthly',
          together_paid_capacity: '1',
        },
        items: { data: [{ quantity, price: { id: 'price_additional_person_test' } }] },
      },
    },
  });
  const invoice = (id, created, type, status = 'paid') => ({
    id,
    type,
    created,
    livemode: false,
    data: {
      object: {
        id: `in_${id}`,
        object: 'invoice',
        customer: 'cus_test_member',
        status,
        created,
        amount_due: 400,
        amount_paid: status === 'paid' ? 400 : 0,
        currency: 'usd',
        parent: {
          subscription_details: {
            subscription: 'sub_test_ordering',
            metadata: {
              together_user_id: userId,
              together_journey_id: journeyId,
              together_paid_capacity: '2',
            },
          },
        },
        lines: { data: [{ period: { end: base + 2_592_000 } }] },
      },
    },
  });
  const deliver = (event) => billing.handleWebhook(Buffer.from(JSON.stringify(event)), 'valid-signature');

  await deliver(subscription('evt_subscription_initial', base + 10, 'active', 1));
  await deliver(subscription('evt_subscription_current', base + 30, 'active', 1));
  await deliver(invoice('evt_invoice_paid_delayed', base + 20, 'invoice.paid'));

  let entitlement = (await pool.query(
    `SELECT state,quantity FROM billing_entitlements
     WHERE source_record_id='sub_test_ordering'`,
  )).rows[0];
  assert.deepEqual(entitlement, { state: 'active', quantity: 1 });

  await deliver(invoice('evt_invoice_paid_current', base + 40, 'invoice.paid'));
  entitlement = (await pool.query(
    `SELECT state,quantity FROM billing_entitlements
     WHERE source_record_id='sub_test_ordering'`,
  )).rows[0];
  assert.deepEqual(entitlement, { state: 'active', quantity: 1 });

  await deliver(invoice('evt_invoice_failure_delayed', base + 35, 'invoice.payment_failed', 'open'));
  entitlement = (await pool.query(
    `SELECT state,quantity FROM billing_entitlements
     WHERE source_record_id='sub_test_ordering'`,
  )).rows[0];
  assert.deepEqual(entitlement, { state: 'active', quantity: 1 });

  await deliver(subscription('evt_subscription_canceled', base + 50, 'canceled', 1));
  await deliver(invoice('evt_invoice_paid_after_cancellation', base + 60, 'invoice.paid'));
  entitlement = (await pool.query(
    `SELECT state,quantity FROM billing_entitlements
     WHERE source_record_id='sub_test_ordering'`,
  )).rows[0];
  assert.deepEqual(entitlement, { state: 'expired', quantity: 1 });
});

test('reconciliation repairs a missed lifecycle once and reports aggregate attention safely', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const base = Math.floor(now.getTime() / 1000);
  const metadata = {
    together_user_id: userId,
    together_journey_id: journeyId,
    together_offer_id: 'additional-person-monthly',
    together_paid_capacity: '1',
  };
  const stripe = fakeStripe({
    listedCustomers: [
      { id: 'cus_test_member', livemode: false, metadata: { together_user_id: userId, together_environment: 'test' } },
      { id: 'cus_test_duplicate', livemode: false, metadata: { together_user_id: userId, together_environment: 'test' } },
    ],
    listedSubscriptions: [{
      id: 'sub_missed_webhook',
      customer: 'cus_test_member',
      livemode: false,
      status: 'active',
      created: base,
      current_period_start: base,
      current_period_end: base + 2_592_000,
      cancel_at_period_end: false,
      metadata,
      items: { data: [{ quantity: 1, price: { id: 'price_additional_person_test' } }] },
    }],
    listedInvoices: [{
      id: 'in_missed_webhook',
      object: 'invoice',
      customer: 'cus_test_member',
      livemode: false,
      status: 'paid',
      created: base,
      amount_due: 100,
      amount_paid: 100,
      currency: 'usd',
      parent: { subscription_details: { subscription: 'sub_missed_webhook', metadata } },
      lines: { data: [{ period: { end: base + 2_592_000 } }] },
    }],
  });
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe, now: () => now });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 1,
    requestId: '99999999-9999-4999-8999-999999999999',
  });

  const first = await billing.reconcile();
  assert.deepEqual(first, {
    environment: 'test',
    trigger: 'manual',
    customersScanned: 1,
    subscriptionsScanned: 1,
    invoicesScanned: 1,
    entitlementDriftRepaired: 1,
    duplicateCustomers: 1,
    webhookFailures: 0,
  });
  const status = await billing.status(userId, journeyId);
  assert.equal(status.subscription.status, 'active');
  assert.equal(status.entitlement.state, 'active');
  assert.equal(status.entitlement.quantity, 1);
  assert.equal(status.invoices[0].status, 'paid');

  const second = await billing.reconcile({ trigger: 'scheduled' });
  assert.equal(second.entitlementDriftRepaired, 0);
  const runs = await pool.query(
    'SELECT run_trigger,processing_state,duplicate_customers FROM billing_reconciliation_runs ORDER BY run_trigger',
  );
  assert.deepEqual(runs.rows, [
    { run_trigger: 'manual', processing_state: 'succeeded', duplicate_customers: 1 },
    { run_trigger: 'scheduled', processing_state: 'succeeded', duplicate_customers: 1 },
  ]);
});

test('repeated reconciliation does not silently extend an existing payment grace window', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  let clock = new Date(now);
  const base = Math.floor(now.getTime() / 1000);
  const subscription = {
    id: 'sub_past_due_reconciliation',
    customer: 'cus_test_member',
    livemode: false,
    status: 'past_due',
    created: base,
    current_period_start: base,
    current_period_end: base + 2_592_000,
    cancel_at_period_end: false,
    metadata: {
      together_user_id: userId,
      together_journey_id: journeyId,
      together_offer_id: 'additional-person-monthly',
      together_paid_capacity: '1',
    },
    items: { data: [{ quantity: 1, price: { id: 'price_additional_person_test' } }] },
  };
  const stripe = fakeStripe({
    listedCustomers: [{ id: 'cus_test_member', livemode: false, metadata: { together_user_id: userId, together_environment: 'test' } }],
    listedSubscriptions: [subscription],
    listedInvoices: [{
      id: 'in_historical_paid_before_past_due',
      object: 'invoice',
      customer: 'cus_test_member',
      livemode: false,
      status: 'paid',
      created: base - 2_592_000,
      amount_due: 100,
      amount_paid: 100,
      currency: 'usd',
      parent: { subscription_details: { subscription: subscription.id, metadata: subscription.metadata } },
      lines: { data: [{ period: { end: base } }] },
    }],
  });
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe, now: () => clock });
  await billing.createCheckoutSession(userId, journeyId, {
    offerId: 'additional-person-monthly',
    paidCapacity: 1,
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  await billing.reconcile();
  const firstStatus = await billing.status(userId, journeyId);
  assert.equal(firstStatus.entitlement.state, 'grace');
  const firstExpiry = firstStatus.entitlement.expiresAt;
  clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
  await billing.reconcile();
  const secondExpiry = (await billing.status(userId, journeyId)).entitlement.expiresAt;
  assert.equal(new Date(secondExpiry).toISOString(), new Date(firstExpiry).toISOString());
});

test('the Stripe webhook route preserves the raw request body', async (t) => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1:4174',
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  let received;
  const billing = {
    async handleWebhook(rawBody, signature) {
      received = { rawBody, signature };
      return { received: true, duplicate: false };
    },
  };
  const app = await buildApp({ platform: {}, billing, config });
  t.after(async () => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/billing/webhooks/stripe',
    headers: { 'stripe-signature': 'test-signature', 'content-type': 'application/json' },
    payload: { id: 'evt_raw_body' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(Buffer.isBuffer(received.rawBody));
  assert.equal(received.signature, 'test-signature');
  assert.deepEqual(JSON.parse(received.rawBody.toString('utf8')), { id: 'evt_raw_body' });
});

test('the Portal route preserves the authenticated journey boundary', async (t) => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1:4174',
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  let received;
  const platform = {
    async session(token) {
      assert.equal(token, 'session-token');
      return { userId, csrfToken: 'csrf-token', user: { id: userId } };
    },
  };
  const billing = {
    async createPortalSession(receivedUserId, receivedJourneyId) {
      received = { receivedUserId, receivedJourneyId };
      return { url: 'https://billing.stripe.com/p/session/test', environment: 'test', journeyId: receivedJourneyId };
    },
  };
  const app = await buildApp({ platform, billing, config });
  t.after(async () => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/journeys/${journeyId}/billing/portal-sessions`,
    headers: {
      origin: 'http://127.0.0.1:4174',
      cookie: 'tl_session=session-token',
      'x-together-csrf': 'csrf-token',
    },
    payload: {},
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(received, { receivedUserId: userId, receivedJourneyId: journeyId });
});

test('the official Stripe SDK verifies the exact raw payload signature', async (t) => {
  const pool = await billingPool();
  t.after(async () => pool.end());
  const stripe = new Stripe('sk_test_fake', { apiVersion: STRIPE_API_VERSION });
  const billing = new StripeBillingService({ pool, config: billingConfig(), stripe, now: () => now });
  const payload = JSON.stringify({
    id: 'evt_signed_payload',
    object: 'event',
    type: 'ping.unhandled',
    created: Math.floor(now.getTime() / 1000),
    livemode: false,
    data: { object: {} },
  });
  const signatureTimestamp = Math.floor(Date.now() / 1000);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_fake',
    timestamp: signatureTimestamp,
  });
  const result = await billing.handleWebhook(Buffer.from(payload), signature);
  assert.deepEqual(result, { received: true, duplicate: false });
  await assert.rejects(
    billing.handleWebhook(Buffer.from(`${payload} `), signature),
    (error) => error.code === 'stripe_signature_invalid',
  );
});
