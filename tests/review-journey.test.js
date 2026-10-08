import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { REVIEW_JOURNEY_NAME, REVIEW_USERNAMES, seedReviewJourney } from '../server/review-journey.js';

// The sample journey an app reviewer signs in to (#260). Synthetic addresses only.
const reviewerEmail = 'review-sam@example.test';
const partnerEmail = 'review-alex@example.test';
const password = 'a sample password for review';
const now = () => new Date('2026-10-05T12:00:00.000Z');

// The same migrations, in the same order, as tests/platform-api.test.js.
const MIGRATIONS = [
  '001_platform', '003_private_usernames', '004_shared_moments', '005_make-shared-journeys-more-humane', '006_expand-shared-moment-vocabulary',
  '007_person_specific_moment_visibility', '008_stripe_web_billing', '009_reserve-group-places', '011_hold-one-image-with-each-moment',
  '012_bill-additional-moment-images', '013_name-moment-image-attachments', '014_hold-places-with-shared-moments', '016_make-extra-image-payments-one-time',
  '017_keep-one-removed-photo-per-moment', '018_allow-ninety-nine-paid-journey-places', '019_let-moments-carry-their-own-atmosphere',
  '020_let-entitlements-hold-ninety-nine-places', '021_let-unpaid-capacity-rest-without-losing-history', '022_agree-together-before-adding-someone',
  '023_let-a-phone-carry-its-own-key', '024_let-google-and-apple-open-an-account', '025_revoke-sign-in-with-apple-when-an-account-is-deleted',
  '026_remember-a-refused-apple-deletion', '031_let-a-lost-renewal-reply-be-asked-again', '032_let-an-invitation-last-fourteen-days',
];

async function database() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) await pool.query(await readFile(new URL(`../server/migrations/${name}.sql`, import.meta.url), 'utf8'));
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://127.0.0.1:4174', SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const platform = new PlatformService({ pool, config, mailer: new MemoryMailer(), now });
  return { pool, config, platform };
}

const seed = ({ pool, config }) => seedReviewJourney({ pool, config, reviewerEmail, partnerEmail, password, now });

async function liveSampleAccounts(pool) {
  return (await pool.query('SELECT id,username,email_verified_at FROM users WHERE email_normalized IN ($1,$2) AND deleted_at IS NULL ORDER BY username', [reviewerEmail, partnerEmail])).rows;
}

test('a reviewer signs in alone to a journey already shared, with moments in all three visibilities', async (t) => {
  const db = await database();
  t.after(() => db.pool.end());
  const made = await seed(db);
  assert.deepEqual(made.moments, { 'shared-now': 5, private: 2, 'share-later': 2 });
  assert.equal(made.rebuilt, false);

  // The credentials are an ordinary email and password, which do not expire.
  const signedIn = await db.platform.login({ identifier: reviewerEmail, password }, { issueSession: false });
  assert.equal(signedIn.user.id, made.reviewer.id);
  assert.ok(signedIn.user.emailVerified, 'verified, so nothing waits on a link the reviewer cannot open');
  const alsoPartner = await db.platform.login({ identifier: partnerEmail, password }, { issueSession: false });
  assert.equal(alsoPartner.user.id, made.partner.id, 'the second account can be signed in to as well');

  const journeys = await db.platform.listJourneys(made.reviewer.id);
  assert.deepEqual(journeys.map((journey) => journey.name), [REVIEW_JOURNEY_NAME], 'one journey, already there');
  const asReviewer = await db.platform.snapshot(made.reviewer.id, made.journeyId);
  assert.deepEqual(asReviewer.members.map((member) => member.displayName).sort(), ['Alex (sample)', 'Sam (sample)']);
  assert.ok(asReviewer.members.every((member) => /\(sample\)$/.test(member.displayName)), 'plainly sample data');

  // Each person sees the shared moments, and only their own private and waiting ones.
  const titles = (snapshot, visibility) => snapshot.moments.filter((moment) => moment.visibility === visibility).map((moment) => moment.title).sort();
  assert.equal(titles(asReviewer, 'shared-now').length, 5);
  assert.deepEqual(titles(asReviewer, 'private'), ['Tired more than angry']);
  assert.deepEqual(titles(asReviewer, 'share-later'), ['What I want to say about Sunday']);
  const asPartner = await db.platform.snapshot(made.partner.id, made.journeyId);
  assert.deepEqual(titles(asPartner, 'private'), ['Nervous about the visit']);
  assert.deepEqual(titles(asPartner, 'share-later'), ['A note for our anniversary']);
  assert.deepEqual(asReviewer.concerns.map((concern) => concern.status).sort(), ['open', 'resolved'], 'history and conversations have something in them');
  assert.ok(asReviewer.events.some((event) => event.action === 'member_joined'), 'the partner joined the way anyone does');
});

test('running it again rebuilds the journey from nothing, and leaves exactly one of everything', async (t) => {
  const db = await database();
  t.after(() => db.pool.end());
  const first = await seed(db);
  const second = await seed(db);
  assert.equal(second.rebuilt, true);
  assert.notEqual(second.journeyId, first.journeyId);
  const live = await liveSampleAccounts(db.pool);
  assert.deepEqual(live.map((row) => row.username), [REVIEW_USERNAMES.partner, REVIEW_USERNAMES.reviewer]);
  assert.ok(live.every((row) => row.email_verified_at));
  assert.equal((await db.pool.query('SELECT 1 FROM journeys WHERE id=$1', [first.journeyId])).rowCount, 0, 'the earlier journey went with its last member');
  assert.equal((await db.platform.listJourneys(second.reviewer.id)).length, 1);
  assert.equal((await db.platform.login({ identifier: reviewerEmail, password }, { issueSession: false })).user.id, second.reviewer.id);
});

test('it never deletes an account that is not one of the two sample accounts', async (t) => {
  const db = await database();
  t.after(() => db.pool.end());
  // Someone's real account happens to hold the address given for the reviewer.
  await db.platform.register({ email: reviewerEmail, username: 'someone-real', password: 'their own long password' }, 'http://127.0.0.1:4174', { issueSession: false });
  await assert.rejects(seed(db), { code: 'review_journey_refused' });
  const still = await db.pool.query('SELECT username FROM users WHERE email_normalized=$1 AND deleted_at IS NULL', [reviewerEmail]);
  assert.deepEqual(still.rows.map((row) => row.username), ['someone-real'], 'untouched');
  assert.equal((await liveSampleAccounts(db.pool)).length, 1, 'and no sample account was made beside it');
});

test('it changes nothing once someone else is in a sample journey', async (t) => {
  const db = await database();
  t.after(() => db.pool.end());
  const made = await seed(db);
  const { user: stranger } = await db.platform.register({ email: 'someone@example.test', username: 'someone-else', password: 'their own long password' }, 'http://127.0.0.1:4174', { issueSession: false });
  await db.pool.query(`INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'member')`, [made.journeyId, stranger.id]);
  await assert.rejects(seed(db), { code: 'review_journey_refused', message: /shares a journey with someone else/ });
  assert.equal((await liveSampleAccounts(db.pool)).length, 2, 'neither sample account was deleted');
  assert.equal((await db.platform.snapshot(stranger.id, made.journeyId)).journey.name, REVIEW_JOURNEY_NAME, 'and the journey is still there for the person in it');
});

test('it needs two different addresses and a real password, and says so', async (t) => {
  const db = await database();
  t.after(() => db.pool.end());
  await assert.rejects(seedReviewJourney({ ...db, reviewerEmail, partnerEmail: reviewerEmail, password, now }), { code: 'review_journey_refused' });
  await assert.rejects(seedReviewJourney({ ...db, reviewerEmail, partnerEmail, password: 'short', now }), { code: 'review_journey_refused' });
  await assert.rejects(seedReviewJourney({ ...db, reviewerEmail: '', partnerEmail, password, now }), { code: 'review_journey_refused' });
  assert.equal((await liveSampleAccounts(db.pool)).length, 0);
});

test('the command ships in the image, prints no password, and the notes carry no credential', async () => {
  const command = await readFile(new URL('../server/seed-review-journey.js', import.meta.url), 'utf8');
  assert.match(command, /process\.env\.REVIEW_PASSWORD/);
  assert.doesNotMatch(command, /stdout\.write\([^)]*password/i);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['check:server'], /node --check server\/review-journey\.js && node --check server\/seed-review-journey\.js/);
  const notes = await readFile(new URL('../docs/APP_REVIEW.md', import.meta.url), 'utf8');
  assert.match(notes, /node server\/seed-review-journey\.js/);
  assert.doesNotMatch(notes, /REVIEW_PASSWORD=(?!…|\.\.\.|<)\S/, 'the password lives in the env file and the store form, never here');
});

test('a rebuild says exactly which sandbox testers to set, since the reviewer\u2019s account id changes (#272)', async (t) => {
  const db = await database();
  t.after(() => db.pool.end());
  const first = await seed(db);
  assert.equal(first.storeSandboxAccountIds, `STORE_SANDBOX_ACCOUNT_IDS=${first.reviewer.id}`);

  // The owner's own test account stays on the list; the deleted reviewer comes off it.
  const { user: owner } = await db.platform.register({ email: 'owner-tester@example.test', username: 'owner-tester', password: 'a long enough password' }, 'http://127.0.0.1:4174', { issueSession: false });
  db.config.storeSandboxAccountIds = [first.reviewer.id, owner.id];
  const second = await seed(db);
  assert.notEqual(second.reviewer.id, first.reviewer.id);
  assert.equal(second.storeSandboxAccountIds, `STORE_SANDBOX_ACCOUNT_IDS=${owner.id},${second.reviewer.id}`);
});
