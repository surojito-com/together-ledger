import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

// TL-P-02 (#269): every store purchase carries a value of ours that ties it to an account and a
// journey. Synthetic data only.
const MIGRATIONS = [
  '001_platform', '003_private_usernames', '004_shared_moments', '005_make-shared-journeys-more-humane', '006_expand-shared-moment-vocabulary',
  '007_person_specific_moment_visibility', '008_stripe_web_billing', '009_reserve-group-places', '011_hold-one-image-with-each-moment',
  '012_bill-additional-moment-images', '013_name-moment-image-attachments', '014_hold-places-with-shared-moments', '016_make-extra-image-payments-one-time',
  '017_keep-one-removed-photo-per-moment', '018_allow-ninety-nine-paid-journey-places', '019_let-moments-carry-their-own-atmosphere',
  '020_let-entitlements-hold-ninety-nine-places', '021_let-unpaid-capacity-rest-without-losing-history', '022_agree-together-before-adding-someone',
  '023_let-a-phone-carry-its-own-key', '024_let-google-and-apple-open-an-account', '025_revoke-sign-in-with-apple-when-an-account-is-deleted',
  '026_remember-a-refused-apple-deletion', '027_tie-every-store-purchase-to-an-account',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const origin = 'http://127.0.0.1:4174';

async function service(t) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) await pool.query(await readFile(new URL(`../server/migrations/${name}.sql`, import.meta.url), 'utf8'));
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const app = await buildApp({ platform, config });
  t.after(async () => { await app.close(); await pool.end(); });

  async function person(name, { verified = true } = {}) {
    const email = `${name}@example.test`;
    const { user } = await platform.register({ email, username: name, password: 'a long enough password' }, origin, { issueSession: false });
    if (verified) await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
    const { token } = await platform.issueTokens(user.id);
    return { id: user.id, email, token };
  }
  const journey = (owner, name = 'Ours') => platform.createJourney(owner.id, { name, location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const ask = (holder, journeyId) => app.inject({
    method: 'POST',
    url: `/api/v1/journeys/${journeyId}/billing/store-identity`,
    headers: holder ? { authorization: `Bearer ${holder.token}`, 'x-together-client': 'app' } : { 'x-together-client': 'app' },
    payload: {},
  });
  const signedOutBrowser = (journeyId) => app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/billing/store-identity`, headers: { origin }, payload: {} });
  return { pool, platform, mailer, person, journey, ask, signedOutBrowser };
}

test('a purchase carries values that name the account and the journey, and never the ids themselves', async (t) => {
  const { person, journey, ask } = await service(t);
  const sam = await person('sam-buyer');
  const ours = await journey(sam);
  const answer = await ask(sam, ours.id);
  assert.equal(answer.statusCode, 200, answer.body);
  const values = answer.json().data;
  assert.deepEqual(Object.keys(values).sort(), ['appAccountToken', 'obfuscatedAccountId', 'obfuscatedProfileId']);
  for (const value of Object.values(values)) assert.match(value, UUID);
  assert.equal(values.appAccountToken, values.obfuscatedProfileId, 'Apple and Google carry the same journey value');
  assert.notEqual(values.obfuscatedAccountId, values.appAccountToken);
  for (const value of Object.values(values)) {
    assert.notEqual(value, sam.id, 'the account id itself never travels to a store');
    assert.notEqual(value, ours.id, 'nor the journey id');
  }
});

test('the values are the same every time, on every device, so a restore lands in the same place', async (t) => {
  const { platform, person, journey, ask } = await service(t);
  const sam = await person('sam-buyer');
  const ours = await journey(sam);
  const first = (await ask(sam, ours.id)).json().data;
  const otherPhone = { ...sam, token: (await platform.issueTokens(sam.id)).token };
  assert.deepEqual((await ask(otherPhone, ours.id)).json().data, first, 'a second phone signed in to the same account gets the same values');
  assert.deepEqual((await ask(sam, ours.id)).json().data, first, 'asking again creates nothing new');

  const another = await journey(sam, 'Another');
  const second = (await ask(sam, another.id)).json().data;
  assert.equal(second.obfuscatedAccountId, first.obfuscatedAccountId, 'one account, one account value');
  assert.notEqual(second.appAccountToken, first.appAccountToken, 'each journey its own journey value');
});

test('two people in one journey are told apart, because who paid matters as much as for what', async (t) => {
  const { platform, mailer, person, journey, ask } = await service(t);
  const sam = await person('sam-buyer');
  const alex = await person('alex-buyer');
  const ours = await journey(sam);
  await platform.proposeInvitation(sam.id, ours.id, alex.email, '', origin);
  await platform.acceptInvitation(alex.id, mailer.messages.findLast((message) => message.type === 'invitation').token);
  const forSam = (await ask(sam, ours.id)).json().data;
  const forAlex = (await ask(alex, ours.id)).json().data;
  assert.notEqual(forAlex.obfuscatedAccountId, forSam.obfuscatedAccountId);
  assert.notEqual(forAlex.appAccountToken, forSam.appAccountToken);
});

test('nothing is bought signed out, unverified, or for a journey the person is not in (decided on #269)', async (t) => {
  const { person, journey, ask, signedOutBrowser } = await service(t);
  const sam = await person('sam-buyer');
  const ours = await journey(sam);
  const signedOut = await ask(null, ours.id);
  assert.equal(signedOut.statusCode, 403, 'a phone with no token is refused before anything else');
  assert.equal(signedOut.json().data, undefined, 'and is given no values');
  const browser = await signedOutBrowser(ours.id);
  assert.equal(browser.statusCode, 401, 'a browser with no session is asked to sign in');
  const unverified = await person('new-buyer', { verified: false });
  const theirs = await journey(unverified);
  const refused = await ask(unverified, theirs.id);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().error.code, 'email_unverified');
  const stranger = await person('stranger-buyer');
  const outside = await ask(stranger, ours.id);
  assert.equal(outside.statusCode, 403, outside.body);
});

test('what a value meant outlives the journey, and never stops anyone deleting it', async (t) => {
  const { pool, platform, person, journey, ask } = await service(t);
  const sam = await person('sam-buyer');
  const ours = await journey(sam);
  const values = (await ask(sam, ours.id)).json().data;
  assert.equal(await platform.eraseAccount(sam.id), true, 'deleting the account, and with it the journey, is not blocked');
  assert.equal((await pool.query('SELECT 1 FROM journeys WHERE id=$1', [ours.id])).rowCount, 0);
  const kept = await pool.query('SELECT user_id,journey_id FROM billing_store_journeys WHERE journey_token=$1', [values.appAccountToken]);
  assert.deepEqual(kept.rows[0], { user_id: sam.id, journey_id: ours.id }, 'a refund that arrives later can still be read');
});
