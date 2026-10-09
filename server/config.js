import { z } from 'zod';
import { parseRootCertificates } from './store-apple.js';
import { parseServiceAccount } from './store-google.js';

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
  // How long an invitation's link lasts once everyone has agreed (owner, Oct 8, 2026, #347). It is
  // its own setting: verification and recovery links stay short (TOKEN_MINUTES). A longer window
  // lets nobody else in, because only the invited email, signed in and verified, can accept it.
  INVITATION_DAYS: z.coerce.number().int().min(1).max(30).default(14),
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
  // Who a Google or Apple ID token may be issued to (its `aud`), comma-separated. These are
  // public identifiers, not secrets (#214, #215). Apple's are the phone's App ID and the web's
  // Services ID. Google's wait for Together Ledger's own OAuth clients; empty turns Google
  // sign-in off rather than accepting a token for someone else's app.
  GOOGLE_CLIENT_IDS: z.string().default(''),
  // The web's own Google OAuth client (#216), the one Google Identity Services is initialised
  // with on the account dialog. It is accepted as an audience too, so it need not be repeated in
  // GOOGLE_CLIENT_IDS. Empty keeps both buttons off the web; the phones' IDs never stand in for
  // it, because the server cannot tell which of several IDs is the web's.
  GOOGLE_WEB_CLIENT_ID: z.string().default(''),
  APPLE_CLIENT_IDS: z.string().default('com.togetherledger.ledger,com.togetherledger.ledger.web'),
  // Sign in with Apple's REST API (#218, server/apple.js): exchanging a sign-in's code for a
  // refresh token, and revoking it when the account is deleted. The Team ID, the key's ID and the
  // web's Return URL are public. The .p8 key (one line is fine) and the key that encrypts Apple's
  // refresh tokens (32 random bytes, base64) are secrets, kept in Secrets Manager like the rest.
  APPLE_TEAM_ID: z.string().default('769MBW6826'),
  APPLE_SIGN_IN_KEY_ID: z.string().default('985BDXJP8S'),
  APPLE_SIGN_IN_PRIVATE_KEY: z.string().default(''),
  APPLE_TOKEN_ENCRYPTION_KEY: z.string().default(''),
  // The web's Services ID and the Return URL Sign in with Apple JS is initialised with. A code the
  // web asked for is exchanged with both; a code from the phone with neither.
  APPLE_SERVICES_ID: z.string().default('com.togetherledger.ledger.web'),
  APPLE_WEB_REDIRECT_URI: z.string().default('https://app.together-ledger.com/'),
  // Store purchases, checked on this server (#272, docs/STORE_PURCHASES.md). Each store is off
  // until its trust is configured, and a purchase from it is then refused as unavailable rather
  // than believed. APPLE_ROOT_CERTIFICATES is Apple Root CA - G3 as base64 DER or PEM, downloaded
  // from apple.com and checked by the owner; GOOGLE_PLAY_SERVICE_ACCOUNT is the Play service
  // account's key JSON, a secret kept with the others. The bundle and package are public.
  // Which purchases this deployment honours: 'sandbox' (App Store sandbox, Google licence testers)
  // or 'live' (real money). Only ever one, so a test purchase can never become live capacity.
  STORE_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
  // On a live service, the accounts whose sandbox purchases still count, comma-separated account
  // ids: App Review's sample account (#260) and the owner's own test accounts. App Review buys in
  // the sandbox against the production app, so without this its purchases would be refused.
  // Recorded as sandbox, and read only for these accounts. Ignored on a sandbox service.
  STORE_SANDBOX_ACCOUNT_IDS: z.string().default(''),
  APPLE_ROOT_CERTIFICATES: z.string().default(''),
  APPLE_BUNDLE_ID: z.string().default('com.togetherledger.ledger'),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().default('com.togetherledger.ledger'),
  GOOGLE_PLAY_SERVICE_ACCOUNT: z.string().default(''),
  // Google Play's Real-time developer notifications (#273), pushed by Pub/Sub to
  // /api/v1/billing/store-notifications/google with an OIDC token. The token must be for this
  // audience (the push subscription's Audience setting) and name this service account (the one
  // the push subscription authenticates as). Either one empty, and the endpoint accepts nothing.
  GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE: z.string().default(''),
  GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
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
  const appleRootCertificates = parseRootCertificates(config.APPLE_ROOT_CERTIFICATES);
  const googlePlayServiceAccount = parseServiceAccount(config.GOOGLE_PLAY_SERVICE_ACCOUNT);
  const storeEnvironment = config.STORE_ENVIRONMENT;
  const storeSandboxAccountIds = [...new Set(config.STORE_SANDBOX_ACCOUNT_IDS.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (storeSandboxAccountIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error('STORE_SANDBOX_ACCOUNT_IDS must be account ids (UUIDs), comma-separated.');
  }
  const storePurchasesConfigured = appleRootCertificates.length > 0 || Boolean(googlePlayServiceAccount);
  const googlePlayNotifications = {
    audience: config.GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE.trim(),
    serviceAccountEmail: config.GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL.trim().toLowerCase(),
  };
  if (googlePlayNotifications.serviceAccountEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(googlePlayNotifications.serviceAccountEmail)) {
    throw new Error('GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL must be the email of the service account the push subscription authenticates as.');
  }
  if (config.STRIPE_ENVIRONMENT === 'live' && storeEnvironment === 'sandbox') {
    throw new Error('A service that takes live web payments must honour live store purchases only (STORE_ENVIRONMENT=live).');
  }
  if (config.NODE_ENV === 'production' && config.JOURNEY_CAPACITY_MODE === 'test-groups') {
    throw new Error('Synthetic group capacity cannot be enabled in production.');
  }
  // Capacity can be paid for on the web, in a store, or both (#267); either is enough to read it.
  if (config.JOURNEY_CAPACITY_MODE === 'billing' && config.BILLING_ENABLED !== 'true' && !storePurchasesConfigured) {
    throw new Error('Billing-backed journey capacity requires Stripe billing to be enabled, or store purchases to be checked here.');
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
  const listOf = (value) => [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  return {
    ...config,
    appOrigins,
    googleClientIds: listOf([config.GOOGLE_CLIENT_IDS, config.GOOGLE_WEB_CLIENT_ID].join(',')),
    appleClientIds: listOf(config.APPLE_CLIENT_IDS),
    databaseSsl: config.DATABASE_SSL === 'true',
    cookieSecure: config.COOKIE_SECURE === 'true',
    trustProxy: config.TRUST_PROXY === 'true',
    journeyCapacityMode: config.JOURNEY_CAPACITY_MODE,
    billingEnabled: config.BILLING_ENABLED === 'true',
    billingPortalEnabled: config.BILLING_PORTAL_ENABLED === 'true',
    stripeEnvironment: config.STRIPE_ENVIRONMENT,
    storeEnvironment,
    // Every environment an entitlement or a paid slot is read from here: the web's and the stores'.
    // 'sandbox' only where STORE_ENVIRONMENT says so, never beside live web payments, and on a live
    // service only for the listed testers' own purchases (server/billing-environments.js).
    billingEnvironments: [...new Set([config.STRIPE_ENVIRONMENT, storeEnvironment])],
    appleRootCertificates,
    googlePlayServiceAccount,
    googlePlayNotifications,
    storePurchasesConfigured,
    storeSandboxAccountIds,
    stripeTaxEnabled: config.STRIPE_TAX_ENABLED === 'true',
    billingGraceDays: config.BILLING_GRACE_DAYS,
    invitationDays: config.INVITATION_DAYS,
    momentImageBillingEnabled: config.MOMENT_IMAGE_BILLING_ENABLED === 'true',
    momentLocationBillingEnabled: config.MOMENT_LOCATION_BILLING_ENABLED === 'true',
  };
}
