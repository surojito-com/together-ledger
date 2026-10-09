import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('synthetic group capacity cannot be enabled in production', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    JOURNEY_CAPACITY_MODE: 'test-groups',
  }), /Synthetic group capacity cannot be enabled in production/);
});

test('billing-backed capacity cannot run while billing is disabled', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'development',
    JOURNEY_CAPACITY_MODE: 'billing',
    BILLING_ENABLED: 'false',
  }), /Billing-backed journey capacity requires Stripe billing to be enabled/);
});

test('additional moment places are test-mode only and require billing', () => {
  assert.throws(() => loadConfig({ MOMENT_LOCATION_BILLING_ENABLED: 'true' }), /requires Stripe billing/);
  assert.throws(() => loadConfig({ BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_test', MOMENT_LOCATION_BILLING_ENABLED: 'true', STRIPE_ADDITIONAL_LOCATION_PRICE_ID: 'price_location_test', STRIPE_ENVIRONMENT: 'live' }), /test Stripe Price ID/);
});

test('two-person capacity remains the default', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.journeyCapacityMode, 'two-person');
  assert.equal(config.billingEnabled, false);
  assert.equal(config.billingPortalEnabled, false);
});

test('Customer Portal cannot be enabled without billing and an allow-listed configuration', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'test',
    BILLING_PORTAL_ENABLED: 'true',
  }), /Customer Portal requires Stripe billing to be enabled/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'test',
    BILLING_ENABLED: 'true',
    BILLING_PORTAL_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_test',
  }), /allow-listed configuration ID beginning with bpc_/);
});

test('dual-host app origins are parsed and deduplicated', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGINS: ' https://app.together-ledger.com,https://legacy.example,https://app.together-ledger.com ',
  });
  assert.deepEqual(config.appOrigins, ['https://app.together-ledger.com', 'https://legacy.example']);
});

test('the store refund alert has a threshold and a window in config, never zero (#273)', () => {
  assert.deepEqual(loadConfig({ NODE_ENV: 'test' }).storeRefundAlert, { threshold: 5, windowHours: 24 });
  assert.deepEqual(loadConfig({ NODE_ENV: 'test', STORE_REFUND_ALERT_THRESHOLD: '12', STORE_REFUND_ALERT_WINDOW_HOURS: '6' }).storeRefundAlert, { threshold: 12, windowHours: 6 });
  assert.throws(() => loadConfig({ NODE_ENV: 'test', STORE_REFUND_ALERT_THRESHOLD: '0' }));
  assert.throws(() => loadConfig({ NODE_ENV: 'test', STORE_REFUND_ALERT_WINDOW_HOURS: '0' }));
  assert.throws(() => loadConfig({ NODE_ENV: 'test', STORE_REFUND_ALERT_THRESHOLD: 'several' }));
});
