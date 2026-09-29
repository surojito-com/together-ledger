import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4174),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:4174'),
  APP_ORIGINS: z.string().default(''),
  API_ORIGIN: z.string().url().or(z.literal('')).default(''),
  ACCOUNT_ORIGIN: z.string().url().or(z.literal('')).default(''),
  DATABASE_URL: z.string().min(1).default('postgres://together@127.0.0.1:5432/together_ledger'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  SESSION_SECRET: z.string().min(32).default('development-session-secret-change-me-0001'),
  AUDIT_HMAC_KEY: z.string().min(32).default('development-audit-secret-change-me-00001'),
  SESSION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  TOKEN_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Together Ledger <no-reply@together-ledger.com>'),
  MAIL_FROM_INVITATION: z.string().default(''),
  MAIL_FROM_VERIFICATION: z.string().default(''),
  MAIL_FROM_RECOVERY: z.string().default(''),
  JOURNEY_CAPACITY_MODE: z.enum(['two-person', 'test-groups', 'billing']).default('two-person'),
  BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
  BILLING_PORTAL_ENABLED: z.enum(['true', 'false']).default('false'),
  STRIPE_ENVIRONMENT: z.enum(['test', 'live']).default('test'),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_ADDITIONAL_PERSON_PRICE_ID: z.string().default(''),
  STRIPE_ADDITIONAL_IMAGE_PRICE_ID: z.string().default(''),
  MOMENT_IMAGE_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
  STRIPE_ADDITIONAL_LOCATION_PRICE_ID: z.string().default(''),
  MOMENT_LOCATION_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().default(''),
  STRIPE_TAX_ENABLED: z.enum(['true', 'false']).default('false'),
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
});

function assertStripeConfiguration(config) {
  if (config.BILLING_PORTAL_ENABLED === 'true' && config.BILLING_ENABLED !== 'true') {
    throw new Error('Stripe Customer Portal requires Stripe billing to be enabled.');
  }
  if (config.BILLING_ENABLED !== 'true') return;
  if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe billing requires a secret key and webhook signing secret.');
  }
  if (!config.STRIPE_ADDITIONAL_PERSON_PRICE_ID) {
    throw new Error('Stripe billing requires the allow-listed additional-person Price ID.');
  }
  const testKey = /^(?:sk|rk)_test_/.test(config.STRIPE_SECRET_KEY);
  const liveKey = /^(?:sk|rk)_live_/.test(config.STRIPE_SECRET_KEY);
  if (config.STRIPE_ENVIRONMENT === 'test' && !testKey) {
    throw new Error('Test Stripe billing accepts test-mode keys only.');
  }
  if (config.STRIPE_ENVIRONMENT === 'live' && !liveKey) {
    throw new Error('Live Stripe billing accepts live-mode keys only.');
  }
  if (!config.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    throw new Error('Stripe billing requires a webhook signing secret.');
  }
  if (!config.STRIPE_ADDITIONAL_PERSON_PRICE_ID.startsWith('price_')) throw new Error('Stripe billing Price IDs must begin with price_.');
  if (config.MOMENT_IMAGE_BILLING_ENABLED === 'true' && (!config.STRIPE_ADDITIONAL_IMAGE_PRICE_ID.startsWith('price_') || config.STRIPE_ENVIRONMENT !== 'test')) throw new Error('Additional moment images require an allow-listed test Stripe Price ID.');
  if (config.MOMENT_LOCATION_BILLING_ENABLED === 'true' && (!config.STRIPE_ADDITIONAL_LOCATION_PRICE_ID.startsWith('price_') || config.STRIPE_ENVIRONMENT !== 'test')) throw new Error('Additional moment places require an allow-listed test Stripe Price ID.');
  if (config.BILLING_PORTAL_ENABLED === 'true' && !config.STRIPE_PORTAL_CONFIGURATION_ID.startsWith('bpc_')) {
    throw new Error('Stripe Customer Portal requires an allow-listed configuration ID beginning with bpc_.');
  }
}

export function loadConfig(overrides = {}) {
  const config = ConfigSchema.parse({ ...process.env, ...overrides });
  assertStripeConfiguration(config);
  if (config.NODE_ENV === 'production' && config.JOURNEY_CAPACITY_MODE === 'test-groups') {
    throw new Error('Synthetic group capacity cannot be enabled in production.');
  }
  if (config.JOURNEY_CAPACITY_MODE === 'billing' && config.BILLING_ENABLED !== 'true') {
    throw new Error('Billing-backed journey capacity requires Stripe billing to be enabled.');
  }
  if (config.MOMENT_IMAGE_BILLING_ENABLED === 'true' && config.BILLING_ENABLED !== 'true') {
    throw new Error('Additional moment image billing requires Stripe billing to be enabled.');
  }
  if (config.MOMENT_LOCATION_BILLING_ENABLED === 'true' && config.BILLING_ENABLED !== 'true') throw new Error('Additional moment place billing requires Stripe billing to be enabled.');
  if (config.NODE_ENV === 'production') {
    if (!config.PUBLIC_ORIGIN.startsWith('https://')) throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
    if (!config.API_ORIGIN.startsWith('https://')) throw new Error('Production API_ORIGIN must use HTTPS.');
    if (!config.ACCOUNT_ORIGIN.startsWith('https://')) throw new Error('Production ACCOUNT_ORIGIN must use HTTPS.');
    if (config.COOKIE_SECURE !== 'true') throw new Error('Production cookies must be secure.');
    if (config.SESSION_SECRET.startsWith('development-') || config.AUDIT_HMAC_KEY.startsWith('development-')) throw new Error('Production secrets must not use development defaults.');
    if (!config.SMTP_URL) throw new Error('Production SMTP delivery must be configured.');
  }
  const appOrigins = [...new Set(config.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean))];
  return {
    ...config,
    appOrigins,
    databaseSsl: config.DATABASE_SSL === 'true',
    cookieSecure: config.COOKIE_SECURE === 'true',
    trustProxy: config.TRUST_PROXY === 'true',
    journeyCapacityMode: config.JOURNEY_CAPACITY_MODE,
    billingEnabled: config.BILLING_ENABLED === 'true',
    billingPortalEnabled: config.BILLING_PORTAL_ENABLED === 'true',
    stripeEnvironment: config.STRIPE_ENVIRONMENT,
    stripeTaxEnabled: config.STRIPE_TAX_ENABLED === 'true',
    billingGraceDays: config.BILLING_GRACE_DAYS,
    momentImageBillingEnabled: config.MOMENT_IMAGE_BILLING_ENABLED === 'true',
    momentLocationBillingEnabled: config.MOMENT_LOCATION_BILLING_ENABLED === 'true',
  };
}
