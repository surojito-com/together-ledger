// Every account email should lead back to the home the person started from.
//
// The deployment that serves https://app.together-ledger.com keeps a separate
// ACCOUNT_ORIGIN as a safe fallback for trusted non-browser jobs. These checks
// hold the two apart on purpose: a person who begins at the app home must
// receive links on the app home, never on the fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { SmtpMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const appOrigin = 'https://app.together-ledger.com';
const apiOrigin = 'https://api.together-ledger.com';
const fallbackOrigin = 'https://together-ledger.com';
const password = 'correct horse battery staple';

const MIGRATIONS = [
  '001_platform.sql',
  '003_private_usernames.sql',
  '004_shared_moments.sql',
  '005_make-shared-journeys-more-humane.sql',
  '006_expand-shared-moment-vocabulary.sql',
  '007_person_specific_moment_visibility.sql',
  '008_stripe_web_billing.sql',
  '009_reserve-group-places.sql',
  '011_hold-one-image-with-each-moment.sql',
  '012_bill-additional-moment-images.sql',
  '013_name-moment-image-attachments.sql',
  '014_hold-places-with-shared-moments.sql',
  '016_make-extra-image-payments-one-time.sql',
  '017_keep-one-removed-photo-per-moment.sql',
  '018_allow-ninety-nine-paid-journey-places.sql',
  '019_let-moments-carry-their-own-atmosphere.sql',
  '020_let-entitlements-hold-ninety-nine-places.sql',
  '021_let-unpaid-capacity-rest-without-losing-history.sql',
  '022_agree-together-before-adding-someone.sql',
  '023_let-a-phone-carry-its-own-key.sql',
  '024_let-google-and-apple-open-an-account.sql',
  '025_revoke-sign-in-with-apple-when-an-account-is-deleted.sql',
  '026_remember-a-refused-apple-deletion.sql',
  '031_let-a-lost-renewal-reply-be-asked-again.sql',
  '032_let-an-invitation-last-fourteen-days.sql',
];

async function appAtItsOwnHome() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  for (const migration of MIGRATIONS) {
    await pool.query(await readFile(new URL(`../server/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const sent = [];
  const mailer = new SmtpMailer({
    transport: { sendMail: async (message) => { sent.push(message); return { accepted: [message.to] }; } },
    from: 'Together Ledger <no-reply@together-ledger.com>',
    invitationFrom: 'Together Ledger - 010 Journey Invite <journey-invitation@together-ledger.com>',
    verificationFrom: 'Together Ledger - 020 Email Verification <account-verification@together-ledger.com>',
    recoveryFrom: 'Together Ledger - 030 Password Reset <account-recovery@together-ledger.com>',
    accountOrigin: fallbackOrigin,
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: appOrigin,
    API_ORIGIN: apiOrigin,
    ACCOUNT_ORIGIN: fallbackOrigin,
    APP_ORIGINS: '',
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  const platform = new PlatformService({ pool, config, mailer, now: () => new Date('2026-09-14T12:00:00.000Z') });
  const app = await buildApp({ platform, config });
  return { app, pool, sent };
}

// Every account email carries a plain-text part and a designed HTML part, and
// both are read, so a link that drifts in only one of them cannot pass
// unnoticed. A message missing either part fails here rather than being
// quietly checked on the one part it has.
function linksIn(message, key) {
  const found = [];
  for (const [name, part] of [['text', message.text], ['HTML', message.html]]) {
    assert.ok(part, `the ${key} message has no ${name} part`);
    const inThisPart = [];
    for (const candidate of part.match(/https?:\/\/[^\s"'<>]+/g) || []) {
      let url;
      try { url = new URL(candidate.replace(/&amp;/g, '&')); } catch { continue; }
      if (url.searchParams.has(key)) inThisPart.push(url);
    }
    assert.ok(inThisPart.length >= 1, `a part of the ${key} message carries no ${key} link`);
    found.push(...inThisPart);
  }
  assert.ok(found.length >= 1, `the ${key} message carries no ${key} link at all`);
  return found;
}

function assertReturnsToAppHome(message, key) {
  for (const url of linksIn(message, key)) {
    assert.equal(url.origin, appOrigin, `a ${key} link pointed at ${url.origin}`);
    assert.ok(url.searchParams.get(key).length >= 20, `the ${key} link carried no usable token`);
  }
  return linksIn(message, key)[0].searchParams.get(key);
}

const lastOf = (sent, sender) => sent.findLast((message) => message.from.includes(sender));

test('TC-10870, TC-10910 and TC-10930: account links return to the home that began the action', async (t) => {
  const { app, pool, sent } = await appAtItsOwnHome();
  t.after(async () => { await app.close(); await pool.end(); });

  const registration = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin: appOrigin },
    payload: { email: 'owner@synthetic.test', username: 'synthetic-owner', password },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const owner = { cookie: registration.headers['set-cookie'].split(';')[0], csrf: registration.json().data.csrfToken };

  const verificationToken = assertReturnsToAppHome(lastOf(sent, 'account-verification@'), 'verify');
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: { origin: appOrigin }, payload: { token: verificationToken } });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().data.user.emailVerified, true);

  const headers = { origin: appOrigin, cookie: owner.cookie, 'x-together-csrf': owner.csrf };
  const journey = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers,
    payload: { name: 'A place to return to', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(journey.statusCode, 201, journey.body);

  const invitation = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.json().data.journey.id}/invitations`, headers,
    payload: { email: 'invited@synthetic.test' },
  });
  assert.equal(invitation.statusCode, 202, invitation.body);
  assertReturnsToAppHome(lastOf(sent, 'journey-invitation@'), 'invite');

  const recovery = await app.inject({
    method: 'POST', url: '/api/v1/recovery/request', headers: { origin: appOrigin },
    payload: { email: 'owner@synthetic.test' },
  });
  assert.equal(recovery.statusCode, 202, recovery.body);
  const recoveryToken = assertReturnsToAppHome(lastOf(sent, 'account-recovery@'), 'recovery');

  const restored = await app.inject({
    method: 'POST', url: '/api/v1/recovery/confirm', headers: { origin: appOrigin },
    payload: { token: recoveryToken, password: `${password} again` },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  const signedIn = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin: appOrigin },
    payload: { identifier: 'synthetic-owner', password: `${password} again` },
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
});

test('TC-10875: the fallback account origin never replaces the home a person began at', async (t) => {
  const { app, pool, sent } = await appAtItsOwnHome();
  t.after(async () => { await app.close(); await pool.end(); });

  const fromTheApp = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin: appOrigin },
    payload: { email: 'from-app@synthetic.test', username: 'from-app', password },
  });
  assert.equal(fromTheApp.statusCode, 201, fromTheApp.body);
  assertReturnsToAppHome(lastOf(sent, 'account-verification@'), 'verify');

  const fromTheApi = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin: apiOrigin },
    payload: { email: 'from-api@synthetic.test', username: 'from-api', password },
  });
  assert.equal(fromTheApi.statusCode, 201, fromTheApi.body);
  for (const url of linksIn(lastOf(sent, 'account-verification@'), 'verify')) {
    assert.equal(url.origin, apiOrigin, 'a direct API client should be answered at its own origin');
  }

  const messagesSoFar = sent.length;
  const fromElsewhere = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://look-alike.example' },
    payload: { email: 'from-elsewhere@synthetic.test', username: 'from-elsewhere', password },
  });
  assert.equal(fromElsewhere.statusCode, 403);
  assert.equal(sent.length, messagesSoFar, 'an unknown origin must not cause any account email to be sent');
});
