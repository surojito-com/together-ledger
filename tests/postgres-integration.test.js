import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool, runMigrations, withTransaction } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { StripeBillingService } from '../server/billing.js';
import { PlatformService } from '../server/platform.js';
import { AppleTransactionVerifier } from '../server/store-apple.js';
import { StorePurchaseService } from '../server/store-purchases.js';
import { appleChain, signNotification, signTransaction, transactionPayload } from './support/apple-signing.js';
import { PUSH_AUDIENCE, PUSH_EMAIL, googleKeys, pushBody, pushToken } from './support/google-push.js';
import { GooglePushVerifier } from '../server/store-google.js';
import { stripPhotoMetadata } from '../src/photo-metadata.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('real PostgreSQL enforces migrations, event immutability, and deletion purge', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({
    NODE_ENV: 'development',
    JOURNEY_CAPACITY_MODE: 'test-groups',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  const pool = createPool(config);
  t.after(async () => pool.end());
  const firstRun = await runMigrations(pool);
  assert.ok(firstRun.applied.includes('023_let-a-phone-carry-its-own-key.sql'));
  // Applying twice is how a deploy works: server/migrate.js moves the schema, then the server
  // starts and finds nothing left to do. The second run must say so rather than repeat itself.
  assert.deepEqual((await runMigrations(pool)).applied, []);

  const migrations = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(migrations.rows.map((row) => row.name), ['001_platform.sql', '002_append_only_events.sql', '003_private_usernames.sql', '004_shared_moments.sql', '005_make-shared-journeys-more-humane.sql', '006_expand-shared-moment-vocabulary.sql', '007_person_specific_moment_visibility.sql', '008_stripe_web_billing.sql', '009_reserve-group-places.sql', '010_stripe_reconciliation_runs.sql', '011_hold-one-image-with-each-moment.sql', '012_bill-additional-moment-images.sql', '013_name-moment-image-attachments.sql', '014_hold-places-with-shared-moments.sql', '015_bill-additional-moment-places.sql', '016_make-extra-image-payments-one-time.sql', '017_keep-one-removed-photo-per-moment.sql', '018_allow-ninety-nine-paid-journey-places.sql', '019_let-moments-carry-their-own-atmosphere.sql', '020_let-entitlements-hold-ninety-nine-places.sql', '021_let-unpaid-capacity-rest-without-losing-history.sql', '022_agree-together-before-adding-someone.sql', '023_let-a-phone-carry-its-own-key.sql', '024_let-google-and-apple-open-an-account.sql', '025_revoke-sign-in-with-apple-when-an-account-is-deleted.sql', '026_remember-a-refused-apple-deletion.sql', '027_tie-every-store-purchase-to-an-account.sql', '028_turn-a-store-purchase-into-capacity.sql', '029_rest-read-only-and-let-the-payer-ask-for-time.sql', '030_ask-for-six-weeks-a-year.sql', '031_let-a-lost-renewal-reply-be-asked-again.sql', '032_let-an-invitation-last-fourteen-days.sql', '033_let-a-moment-held-offline-arrive-once.sql', '034_hear-refunds-and-renewals-from-the-stores.sql', '035_hear-reversed-refunds-and-refunded-extras.sql']);

  const firstLockClient = await pool.connect();
  const secondLockClient = await pool.connect();
  try {
    const firstLock = await firstLockClient.query("SELECT pg_try_advisory_lock(hashtextextended('stripe-billing-reconciliation-test',0)) AS locked");
    const secondLock = await secondLockClient.query("SELECT pg_try_advisory_lock(hashtextextended('stripe-billing-reconciliation-test',0)) AS locked");
    assert.equal(firstLock.rows[0].locked, true);
    assert.equal(secondLock.rows[0].locked, false);
    await firstLockClient.query("SELECT pg_advisory_unlock(hashtextextended('stripe-billing-reconciliation-test',0))");
  } finally {
    firstLockClient.release();
    secondLockClient.release();
  }

  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const registration = await platform.register({ email: 'postgres@example.test', username: 'postgres-qa', password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.find((message) => message.type === 'verification').token);
  const journey = await platform.createJourney(registration.user.id, {
    name: 'Migration proof',
    location: 'Synthetic test',
    startDate: '2026-08-07',
    endDate: '2026-08-08',
    budgetCents: 10000,
  });

  const event = await pool.query('SELECT * FROM journey_events WHERE journey_id=$1', [journey.id]);
  assert.equal(event.rowCount, 1);
  await assert.rejects(
    pool.query("UPDATE journey_events SET summary='tampered' WHERE journey_id=$1", [journey.id]),
    /journey events are append-only/,
  );
  await assert.rejects(
    pool.query('DELETE FROM journey_events WHERE journey_id=$1', [journey.id]),
    /journey events are append-only/,
  );

  // pg-mem cannot prove transaction semantics, so the rule that a replayed refresh token retires
  // its family is checked here, against a real database: the revocation has to survive the
  // refusal that follows it rather than being rolled back with it.
  const issued = await platform.issueTokens(registration.user.id);
  assert.ok(await platform.tokenHolder(issued.token));
  const rotated = await platform.refreshTokens(issued.refreshToken);
  assert.ok(await platform.tokenHolder(rotated.token));
  await assert.rejects(platform.refreshTokens(issued.refreshToken), (error) => error.code === 'invalid_token');
  assert.equal(await platform.tokenHolder(rotated.token), null);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL', [registration.user.id])).rows[0].count, 0);

  // A renewal whose reply was lost (#353): asked again before anyone uses the pair it issued, the
  // spent token gets a fresh pair, and the lost one is retired with it, in the same transaction.
  const beforeLoss = await platform.issueTokens(registration.user.id);
  const lostPair = await platform.refreshTokens(beforeLoss.refreshToken);
  const retriedPair = await platform.refreshTokens(beforeLoss.refreshToken);
  assert.equal(await platform.tokenHolder(lostPair.token), null);
  assert.ok(await platform.tokenHolder(retriedPair.token));
  await assert.rejects(platform.refreshTokens(beforeLoss.refreshToken), (error) => error.code === 'invalid_token');
  assert.equal(await platform.tokenHolder(retriedPair.token), null);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL', [registration.user.id])).rows[0].count, 0);

  // A journey holds at most 101 (MAX_JOURNEY_CAPACITY). With one person here and 99 places held,
  // one place is left, and two people proposed at the same moment cannot both take it. Alone in
  // the journey, the owner has nobody to ask, so each proposal is an invitation as it is made
  // (consent-to-add, migration 022, replaced the old createInvitation).
  await pool.query(
    `INSERT INTO invitations (id,journey_id,invited_by_user_id,email_normalized,token_hash,expires_at)
     SELECT (
       substr(md5(series::text),1,8) || '-' || substr(md5(series::text),9,4) || '-' ||
       substr(md5(series::text),13,4) || '-' || substr(md5(series::text),17,4) || '-' ||
       substr(md5(series::text),21,12)
     )::uuid, $1, $2, 'reserved-' || series || '@example.test', md5('a-' || series) || md5('b-' || series), now() + interval '1 hour'
     FROM generate_series(1,99) AS series`,
    [journey.id, registration.user.id],
  );
  const concurrentInvitations = await Promise.allSettled([
    platform.proposeInvitation(registration.user.id, journey.id, 'boundary-a@example.test', '', 'http://127.0.0.1:4174'),
    platform.proposeInvitation(registration.user.id, journey.id, 'boundary-b@example.test', '', 'http://127.0.0.1:4174'),
  ]);
  assert.equal(concurrentInvitations.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedInvitation = concurrentInvitations.find((result) => result.status === 'rejected');
  assert.equal(rejectedInvitation.reason.code, 'journey_full');
  assert.equal(concurrentInvitations.find((result) => result.status === 'fulfilled').value.invitationSent, true);
  const capacity = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM journey_members WHERE journey_id=$1) AS members,
       (SELECT count(*)::int FROM invitations WHERE journey_id=$1 AND reservation_active=true AND expires_at>now()) AS reservations`,
    [journey.id],
  );
  assert.deepEqual(capacity.rows[0], { members: 1, reservations: 100 });

  await platform.deleteAccount(registration.user.id, 'correct horse battery staple');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journeys WHERE id=$1', [journey.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1', [journey.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM api_tokens WHERE user_id=$1', [registration.user.id])).rows[0].count, 0);
  const deleted = await pool.query('SELECT email_normalized,username,display_name,deleted_at FROM users WHERE id=$1', [registration.user.id]);
  assert.match(deleted.rows[0].email_normalized, /^deleted-/);
  assert.match(deleted.rows[0].username, /^deleted-/);
  assert.equal(deleted.rows[0].display_name, 'Deleted account');
  assert.ok(deleted.rows[0].deleted_at);
});

// pg-mem neither runs two transactions at once nor rolls one back, so the two cases a store purchase
// most depends on are proven here (#272): the same transaction sent twice at the same moment grants
// once, because the unique row decides it; and a grant that fails halfway leaves nothing behind for
// a retry to trip over, so the phone sending it again on its next launch is the way back.
test('real PostgreSQL grants a store purchase once, and a failed grant leaves nothing behind', { skip: !databaseUrl }, async (t) => {
  const chain = appleChain();
  const settings = {
    NODE_ENV: 'development',
    JOURNEY_CAPACITY_MODE: 'billing',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
    APPLE_ROOT_CERTIFICATES: chain.rootBase64,
  };
  const config = loadConfig(settings);
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const email = `store-${suffix}@example.test`;
  const { user } = await platform.register({ email, username: `store-${suffix}`, password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
  const journey = await platform.createJourney(user.id, { name: 'Store proof', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const { appAccountToken } = await platform.storePurchaseIdentity(user.id, journey.id);
  const store = new StorePurchaseService({ pool, config, history: (client, event) => platform.appendEvent(client, event), apple: new AppleTransactionVerifier({ rootCertificates: config.appleRootCertificates }), log: () => {} });
  const purchase = (transactionId) => signTransaction(chain, transactionPayload({ appAccountToken, transactionId, originalTransactionId: transactionId, purchaseDate: Date.now() }));

  const twice = purchase(`race-${suffix}`);
  const answers = await Promise.all([store.verifyApple(user.id, { signedTransaction: twice }), store.verifyApple(user.id, { signedTransaction: twice })]);
  assert.deepEqual(answers.map((answer) => answer.granted).sort(), [false, true]);
  const granted = await pool.query('SELECT count(*)::int AS count FROM billing_entitlements WHERE journey_id=$1', [journey.id]);
  assert.equal(granted.rows[0].count, 1);

  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    const { query, release } = client;
    client.query = (text, ...rest) => {
      if (typeof text === 'string' && text.includes('INSERT INTO billing_entitlements')) return Promise.reject(new Error('the write failed'));
      return query.call(client, text, ...rest);
    };
    // The pool hands this client out again, so it goes back as it came.
    client.release = (...args) => {
      client.query = query;
      client.release = release;
      return release.call(client, ...args);
    };
    return client;
  };
  const halfway = purchase(`halfway-${suffix}`);
  await assert.rejects(store.verifyApple(user.id, { signedTransaction: halfway }), /the write failed/);
  pool.connect = connect;
  const left = await pool.query('SELECT count(*)::int AS count FROM billing_store_purchases WHERE transaction_id=$1', [`halfway-${suffix}`]);
  assert.equal(left.rows[0].count, 0, 'the purchase row rolled back with the grant it was part of');
  const retried = await store.verifyApple(user.id, { signedTransaction: halfway });
  assert.equal(retried.granted, true);
  assert.equal(retried.room.people, 51);

  // A subscription upgraded from another journey moves there, with grace and history for the first.
  const other = await platform.createJourney(user.id, { name: 'Store proof, moved', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const otherToken = (await platform.storePurchaseIdentity(user.id, other.id)).appAccountToken;
  const monthly = (token, transactionId, productId, days) => signTransaction(chain, transactionPayload({
    appAccountToken: token, transactionId, originalTransactionId: `sub-${suffix}`, productId, type: 'Auto-Renewable Subscription',
    purchaseDate: Date.now(), expiresDate: Date.now() + days * 24 * 60 * 60 * 1000, transactionReason: 'PURCHASE',
  }));
  await store.verifyApple(user.id, { signedTransaction: monthly(appAccountToken, `sub-a-${suffix}`, 'room_51_monthly', 30) });
  const moved = await store.verifyApple(user.id, { signedTransaction: monthly(otherToken, `sub-b-${suffix}`, 'room_101_monthly', 31) });
  assert.equal(moved.journeyId, other.id);
  const graces = await pool.query("SELECT count(*)::int AS count FROM billing_entitlements WHERE journey_id=$1 AND state='grace'", [journey.id]);
  assert.equal(graces.rows[0].count, 1);
  const history = await pool.query("SELECT action FROM journey_events WHERE journey_id IN ($1,$2) AND action LIKE 'paid_room%' ORDER BY action", [journey.id, other.id]);
  assert.deepEqual(history.rows.map((row) => row.action), ['paid_room_moved_in', 'paid_room_moved_out']);

  // A slot can now be a sandbox one: the environment check migration 028 replaced, on real Postgres.
  const moment = await platform.createMoment(user.id, journey.id, { kind: 'memory', title: 'A photo more', detail: '', occurredOn: '2026-10-01', visibility: 'shared-now', moneyCents: null, moneyCurrency: '', locations: [] });
  const photo = signTransaction(chain, transactionPayload({ appAccountToken, transactionId: `photo-${suffix}`, productId: 'extra_photo', type: 'Consumable', purchaseDate: Date.now() }));
  const extra = await store.verifyApple(user.id, { signedTransaction: photo, momentId: moment.id });
  assert.equal(extra.extra.slotIds.length, 1);

  // A live service with a sandbox tester reads that tester's sandbox room and slots, through the
  // same queries, with the account ids as uuid parameters.
  const live = loadConfig({ ...settings, STORE_ENVIRONMENT: 'live', STORE_SANDBOX_ACCOUNT_IDS: user.id });
  const liveNobody = loadConfig({ ...settings, STORE_ENVIRONMENT: 'live', STORE_SANDBOX_ACCOUNT_IDS: '00000000-0000-4000-8000-000000000000' });
  for (const name of ['first', 'second']) {
    const { user: other } = await platform.register({ email: `store-${name}-${suffix}@example.test`, username: `store-${name}-${suffix}`, password: 'correct horse battery staple' });
    await pool.query("INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,'member',now())", [journey.id, other.id]);
  }
  const resting = async (serviceConfig) => {
    const client = await pool.connect();
    try {
      return (await new PlatformService({ pool, config: serviceConfig, mailer }).capacityFor(client, journey.id)).restingMemberIds.length;
    } finally {
      client.release();
    }
  };
  assert.equal(await resting(live), 0, 'the tester\u2019s sandbox room counts on a live service');
  assert.equal(await resting(liveNobody), 1, 'and on a live service nobody else\u2019s does');
  assert.equal((await new PlatformService({ pool, config: live, mailer }).imageSlots(user.id, journey.id, moment.id)).length, 1);
  assert.equal((await new PlatformService({ pool, config: liveNobody, mailer }).imageSlots(user.id, journey.id, moment.id)).length, 0, 'and nobody else\u2019s does');
  await pool.query('DELETE FROM journey_members WHERE journey_id=$1 AND user_id<>$2', [journey.id, user.id]);
  await platform.deleteAccount(user.id, 'correct horse battery staple');
});

// pg-mem cannot carry a binary bytea (every byte that is not UTF-8 comes back as U+FFFD), so a
// photo's round trip is proved here: what is stored and served is the photo without its location
// and camera details, byte for byte (#258).
test('real PostgreSQL stores and serves a photo without its location and camera details', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({
    NODE_ENV: 'development',
    JOURNEY_CAPACITY_MODE: 'test-groups',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const registration = await platform.register({ email: 'postgres-photo@example.test', username: 'postgres-photo', password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.find((message) => message.type === 'verification').token);
  const journey = await platform.createJourney(registration.user.id, { name: 'Photo proof', location: '', startDate: '2026-10-07', endDate: '2026-10-08', budgetCents: 0 });
  const moment = await platform.createMoment(registration.user.id, journey.id, { kind: 'memory', title: 'A photo from far away', detail: '', occurredOn: '2026-10-07', visibility: 'shared-now', moneyCents: null, moneyCurrency: '' });

  const photo = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  const uploaded = await platform.uploadMomentImage(registration.user.id, journey.id, moment.id, 'image/jpeg', photo, null, 'IMG_0042.jpg');
  const served = await platform.momentImage(registration.user.id, journey.id, moment.id, uploaded.id);
  assert.deepEqual(served.bytes, Buffer.from(stripPhotoMetadata(photo).bytes));
  for (const word of ['Kolkata', 'Fixture Camera Co', 'SN-FIXTURE-0042', 'ns.adobe.com/xap', 'MotionPhoto']) assert.equal(served.bytes.includes(word), false, word);

  await platform.deleteAccount(registration.user.id, 'correct horse battery staple');
});

// Migration 030 lowers the weeks a payer can ask for to six a year (owner, Oct 8, 2026). It must
// keep a seventh week already given under the old limit, and refuse one from here on.
test('real PostgreSQL keeps a seventh week already given and refuses a new one', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({ NODE_ENV: 'development', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const { readdir } = await import('node:fs/promises');
  const directory = new URL('../server/migrations/', import.meta.url);
  // Everything but 030, so migrations that come after it (031 onward) are already in place and
  // 030 is the only one left to apply.
  const allBut030 = (await readdir(directory)).filter((name) => name.endsWith('.sql') && !name.startsWith('030_')).sort();
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of allBut030) {
    await pool.query(await readFile(new URL(name, directory), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
  }

  const user = '11111111-1111-4111-8111-111111111111';
  const journey = '22222222-2222-4222-8222-222222222222';
  await pool.query("INSERT INTO users (id,email_normalized,username,display_name,password_hash) VALUES ($1,'weeks@example.test','weeks','Weeks','x')", [user]);
  await pool.query("INSERT INTO journeys (id,owner_user_id,name,budget_cents,start_date_status,end_date_status) VALUES ($1,$2,'Weeks',0,'unknown','forever')", [journey, user]);
  const ask = (id, number) => pool.query(
    `INSERT INTO journey_grace_requests (id,journey_id,requested_by_user_id,calendar_year,request_number,grace_basis,grace_until,requested_at)
     VALUES ($1,$2,$3,2026,$4,now(),now(),now())`,
    [id, journey, user, number],
  );
  await ask('33333333-3333-4333-8333-333333333337', 7);

  assert.deepEqual((await runMigrations(pool)).applied, ['030_ask-for-six-weeks-a-year.sql']);
  const kept = await pool.query('SELECT request_number FROM journey_grace_requests WHERE journey_id=$1', [journey]);
  assert.deepEqual(kept.rows.map((row) => row.request_number), [7], 'a week already given stays');
  await ask('33333333-3333-4333-8333-333333333336', 6);
  await assert.rejects(ask('33333333-3333-4333-8333-333333333338', 7), /journey_grace_requests_request_number_check/);
});

// Migration 032 (#347): an invitation already waiting keeps the expiry it was sent with, and
// whatever had already run out counts as noticed, so the first read after the release writes no
// lone "ran out" entry for something History never saw begin.
test('real PostgreSQL leaves waiting invitations as they are and marks what had run out as noticed', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({ NODE_ENV: 'development', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const { readdir } = await import('node:fs/promises');
  const directory = new URL('../server/migrations/', import.meta.url);
  const allBut032 = (await readdir(directory)).filter((name) => name.endsWith('.sql') && !name.startsWith('032_')).sort();
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of allBut032) {
    await pool.query(await readFile(new URL(name, directory), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
  }
  const user = '44444444-4444-4444-8444-444444444444';
  const joiner = '44444444-4444-4444-8444-444444444445';
  const journey = '55555555-5555-4555-8555-555555555555';
  await pool.query("INSERT INTO users (id,email_normalized,username,display_name,password_hash) VALUES ($1,'inviter@example.test','inviter','Inviter','x'),($2,'joined@example.test','joined','Joined','x')", [user, joiner]);
  await pool.query("INSERT INTO journeys (id,owner_user_id,name,budget_cents,start_date_status,end_date_status) VALUES ($1,$2,'Waiting',0,'unknown','forever')", [journey, user]);
  const invitation = (id, email, expires, accepted = false) => pool.query(
    `INSERT INTO invitations (id,journey_id,invited_by_user_id,email_normalized,token_hash,expires_at,accepted_at,reservation_active)
     VALUES ($1,$2,$3,$4,md5($4)||md5($7),now() + $5::interval,CASE WHEN $6 THEN now() END,NOT $6)`,
    [id, journey, user, email, expires, accepted, id],
  );
  await invitation('66666666-6666-4666-8666-666666666661', 'waiting@example.test', '20 minutes');
  await invitation('66666666-6666-4666-8666-666666666662', 'ran-out@example.test', '-1 hour');
  await invitation('66666666-6666-4666-8666-666666666663', 'joined@example.test', '-1 day', true);
  await pool.query(
    `INSERT INTO journey_invite_proposals (id,journey_id,proposed_by_user_id,email_normalized,status,created_at,expires_at,invitation_id) VALUES
     ('77777777-7777-4777-8777-777777777771',$1,$2,'open-still@example.test','open',now(),now() + interval '29 days',NULL),
     ('77777777-7777-4777-8777-777777777772',$1,$2,'open-past@example.test','open',now() - interval '31 days',now() - interval '1 day',NULL),
     ('77777777-7777-4777-8777-777777777773',$1,$2,'waiting@example.test','agreed',now(),now() + interval '29 days','66666666-6666-4666-8666-666666666661')`,
    [journey, user],
  );
  const expiryBefore = (await pool.query("SELECT expires_at FROM invitations WHERE id='66666666-6666-4666-8666-666666666661'")).rows[0].expires_at;

  assert.deepEqual((await runMigrations(pool)).applied, ['032_let-an-invitation-last-fourteen-days.sql']);
  const rows = Object.fromEntries((await pool.query('SELECT email_normalized,expires_at,lapse_recorded_at,proposal_id,accepted_by_user_id FROM invitations')).rows.map((row) => [row.email_normalized, row]));
  assert.equal(rows['waiting@example.test'].expires_at.getTime(), expiryBefore.getTime(), 'an invitation already waiting keeps its expiry');
  assert.equal(rows['waiting@example.test'].lapse_recorded_at, null);
  assert.equal(rows['waiting@example.test'].proposal_id, '77777777-7777-4777-8777-777777777773');
  assert.equal(rows['ran-out@example.test'].lapse_recorded_at.getTime(), rows['ran-out@example.test'].expires_at.getTime());
  assert.equal(rows['joined@example.test'].lapse_recorded_at, null);
  assert.equal(rows['joined@example.test'].accepted_by_user_id, joiner);
  const proposals = Object.fromEntries((await pool.query('SELECT email_normalized,status,closed_at,expires_at FROM journey_invite_proposals')).rows.map((row) => [row.email_normalized, row]));
  assert.equal(proposals['open-still@example.test'].status, 'open');
  assert.equal(proposals['open-past@example.test'].status, 'lapsed');
  assert.equal(proposals['open-past@example.test'].closed_at.getTime(), proposals['open-past@example.test'].expires_at.getTime());
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_events')).rows[0].count, 0, 'the migration writes nothing into any history');
});

// Running out is worked out when read; nothing runs at that moment (#348). The first request to
// notice writes the history entry, and two at once must not both write it. pg-mem runs one
// transaction at a time, so this can only be proved here.
test('real PostgreSQL writes an invitation’s running out exactly once, however many requests notice it together', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({ NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'test-groups', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  let clock = new Date();
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => clock });
  const suffix = Date.now().toString(36);
  const email = `lapse-${suffix}@example.test`;
  const { user } = await platform.register({ email, username: `lapse-${suffix}`, password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
  const journey = await platform.createJourney(user.id, { name: 'Running out', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  // Alone, nobody else is asked, so these go straight out. Each lasts 14 days.
  await platform.proposeInvitation(user.id, journey.id, `invited-a-${suffix}@example.test`, '', 'http://127.0.0.1:4174');
  await platform.proposeInvitation(user.id, journey.id, `invited-b-${suffix}@example.test`, '', 'http://127.0.0.1:4174');
  const sent = await pool.query('SELECT created_at,expires_at FROM invitations WHERE journey_id=$1 ORDER BY email_normalized', [journey.id]);
  assert.equal(sent.rowCount, 2);
  assert.ok(sent.rows.every((row) => row.expires_at - row.created_at === 14 * 24 * 60 * 60 * 1000));

  clock = new Date(clock.getTime() + 15 * 24 * 60 * 60 * 1000);
  // Ten readers at once, through the snapshot every screen reads.
  await Promise.all(Array.from({ length: 10 }, () => platform.snapshot(user.id, journey.id)));
  // And two transactions noticing at once without taking the journey lock first: the conditional
  // update alone decides which one writes.
  await Promise.all([1, 2].map(() => withTransaction(pool, (client) => platform.recordRunOuts(client, journey.id))));
  const lapsed = await pool.query("SELECT summary,after_value FROM journey_events WHERE journey_id=$1 AND action='invitation_lapsed' ORDER BY summary", [journey.id]);
  assert.equal(lapsed.rowCount, 2, 'one entry for each invitation, never two');
  assert.deepEqual(lapsed.rows.map((row) => row.after_value.expiredAt), sent.rows.map((row) => row.expires_at.toISOString()));
  assert.ok(lapsed.rows.every((row) => row.summary.includes('••') && !row.summary.includes(suffix)));
  const stored = JSON.stringify((await pool.query('SELECT * FROM journey_events WHERE journey_id=$1', [journey.id])).rows);
  assert.equal(stored.includes(`invited-a-${suffix}@example.test`), false);
  assert.equal(stored.includes(`invited-b-${suffix}@example.test`), false);
  assert.equal((await platform.snapshot(user.id, journey.id)).eventChainValid, true);
  await platform.deleteAccount(user.id, 'correct horse battery staple');
});

// #352: a phone that never heard back sends a held moment again, perhaps while the first send is
// still on its way. However many arrive together, the journey's lock and the key's primary key
// leave one moment, and every answer names it.
test('real PostgreSQL holds a moment once, however many sends of its key arrive together', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({ NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'test-groups', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const email = `held-${suffix}@example.test`;
  const { user } = await platform.register({ email, username: `held-${suffix}`, password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
  const journey = await platform.createJourney(user.id, { name: 'Held offline', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const moment = { kind: 'memory', kindLabel: '', occurredOn: '2026-08-01', title: 'Sent five times', detail: '', visibility: 'shared-now', theme: '', moneyCents: null, moneyCurrency: '', locations: [], idempotencyKey: `0f8c7c1e-5a3b-4c2d-9e10-${suffix.padStart(12, '0').slice(-12)}` };
  const answers = await Promise.all(Array.from({ length: 5 }, () => platform.holdMoment(user.id, journey.id, moment)));
  assert.equal(new Set(answers.map((answer) => answer.moment.id)).size, 1, 'every answer names the same moment');
  assert.equal(answers.filter((answer) => !answer.replayed).length, 1, 'exactly one of them held it');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_moments WHERE journey_id=$1', [journey.id])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1 AND action='moment_added'", [journey.id])).rows[0].count, 1);
  await platform.deleteAccount(user.id, 'correct horse battery staple');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM moment_hold_keys WHERE author_user_id=$1', [user.id])).rows[0].count, 0);
});

// #273: Apple sends a notification again until it hears a 200, and two deliveries can arrive
// together. The unique (store, notification_id) row decides: one is logged and applied, the
// other changes nothing. The log goes with the purchase it explains.
test('real PostgreSQL applies a store notification once, however many deliveries arrive together', { skip: !databaseUrl }, async (t) => {
  const chain = appleChain();
  const config = loadConfig({
    NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'billing', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    APPLE_ROOT_CERTIFICATES: chain.rootBase64,
  });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const email = `notified-${suffix}@example.test`;
  const { user } = await platform.register({ email, username: `notified-${suffix}`, password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
  const journey = await platform.createJourney(user.id, { name: 'Refunded', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const { appAccountToken } = await platform.storePurchaseIdentity(user.id, journey.id);
  const store = new StorePurchaseService({ pool, config, history: (client, event) => platform.appendEvent(client, event), apple: new AppleTransactionVerifier({ rootCertificates: config.appleRootCertificates }), log: () => {} });
  const pass = { appAccountToken, transactionId: `refunded-${suffix}`, originalTransactionId: `refunded-${suffix}`, purchaseDate: Date.now() };
  await store.verifyApple(user.id, { signedTransaction: signTransaction(chain, transactionPayload(pass)) });

  const refundedAt = Date.now() + 60 * 60 * 1000;
  const refund = signNotification(chain, { notificationType: 'REFUND', notificationUUID: `refund-${suffix}`, signedDate: Date.now(), transaction: { ...pass, revocationDate: refundedAt, signedDate: Date.now() } });
  const answers = await Promise.all(Array.from({ length: 4 }, () => store.handleAppleNotification({ signedPayload: refund })));
  assert.deepEqual(answers.map((answer) => answer.outcome).sort(), ['already-received', 'already-received', 'already-received', 'refunded']);
  const notes = await pool.query('SELECT outcome,purchase_id FROM billing_store_notifications WHERE notification_id=$1', [`refund-${suffix}`]);
  assert.equal(notes.rowCount, 1);
  assert.equal(notes.rows[0].outcome, 'refunded');
  const room = await pool.query('SELECT expires_at,reason FROM billing_entitlements WHERE source_record_id=$1', [pass.transactionId]);
  assert.equal(new Date(room.rows[0].expires_at).getTime(), refundedAt);
  assert.equal(room.rows[0].reason, 'store_refunded');
  // The revocation check migration 034 adds, as real Postgres enforces it.
  await assert.rejects(pool.query("UPDATE billing_store_purchases SET revocation='taken' WHERE id=$1", [notes.rows[0].purchase_id]), /billing_store_purchases_revocation_check/);

  // The log is kept no longer than the purchase record it explains.
  await pool.query('DELETE FROM billing_store_purchases WHERE id=$1', [notes.rows[0].purchase_id]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_store_notifications WHERE notification_id=$1', [`refund-${suffix}`])).rows[0].count, 0);
  await platform.deleteAccount(user.id, 'correct horse battery staple');
});

test('real PostgreSQL applies a Google notification once, however many deliveries arrive together', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({
    NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'billing', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    APPLE_ROOT_CERTIFICATES: appleChain().rootBase64,
    GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE: PUSH_AUDIENCE, GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL: PUSH_EMAIL,
  });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const email = `voided-${suffix}@example.test`;
  const { user } = await platform.register({ email, username: `voided-${suffix}`, password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
  const journey = await platform.createJourney(user.id, { name: 'Voided', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const ids = await platform.storePurchaseIdentity(user.id, journey.id);
  const token = `voided-${suffix}`;
  const voidedAt = Date.now() + 60 * 60 * 1000;
  // Google, answering with synthetic records (tests/fixtures/google-play).
  const google = {
    calls: 0,
    productPurchase: async () => ({ purchaseState: 0, consumptionState: 1, acknowledgementState: 1, purchaseType: 0, quantity: 1, purchaseTimeMillis: String(Date.now()), obfuscatedExternalAccountId: ids.obfuscatedAccountId, obfuscatedExternalProfileId: ids.obfuscatedProfileId }),
    voidedPurchases: async () => { google.calls += 1; return [{ purchaseToken: token, orderId: 'GPA.3300-0000-0000-00002', voidedTimeMillis: String(voidedAt) }]; },
  };
  const keys = googleKeys();
  const store = new StorePurchaseService({
    pool, config, google, history: (client, event) => platform.appendEvent(client, event), log: () => {},
    googlePush: new GooglePushVerifier({ ...config.googlePlayNotifications, fetch: keys.fetch }),
  });
  await store.verifyGoogle(user.id, { productId: 'room_51_week_pass', purchaseToken: token });

  const push = (notification, messageId) => store.handleGoogleNotification({
    authorization: `Bearer ${pushToken(keys.current())}`,
    body: pushBody({ version: '1.0', packageName: 'com.togetherledger.ledger', eventTimeMillis: String(Date.now()), ...notification }, { messageId }),
  });
  const messageId = `${Date.now()}1`;
  const voided = { voidedPurchaseNotification: { purchaseToken: token, orderId: 'GPA.3300-0000-0000-00002', productType: 2, refundType: 1 } };
  const sentAt = Date.now();
  const answers = await Promise.all(Array.from({ length: 4 }, () => push(voided, messageId)));
  const answeredAt = Date.now();
  assert.equal(answers.filter((answer) => answer.outcome === 'refunded').length, 1);
  assert.equal(answers.filter((answer) => answer.outcome === 'already-received').length, 3);
  const notes = await pool.query("SELECT outcome,environment,transaction_ref FROM billing_store_notifications WHERE store='google' AND notification_id=$1", [messageId]);
  assert.equal(notes.rowCount, 1);
  assert.equal(notes.rows[0].outcome, 'refunded');
  assert.equal(notes.rows[0].environment, 'sandbox');
  assert.notEqual(notes.rows[0].transaction_ref, token, 'a hash, never the token');
  const room = await pool.query('SELECT expires_at,reason FROM billing_entitlements WHERE source_record_id=$1', [token]);
  // Google's voidedTimeMillis is an hour ahead of this server's clock, so the room ends now, never later.
  const ended = new Date(room.rows[0].expires_at).getTime();
  assert.ok(ended >= sentAt && ended <= answeredAt, 'a void time ahead of us is taken as now');
  assert.equal(room.rows[0].reason, 'store_refunded');

  // Google's test notification names no purchase and no environment, and migration 034 as written takes it.
  const testId = `${Date.now()}2`;
  assert.equal((await push({ testNotification: { version: '1.0' } }, testId)).outcome, 'test');
  const test = await pool.query("SELECT outcome,environment FROM billing_store_notifications WHERE store='google' AND notification_id=$1", [testId]);
  assert.deepEqual(test.rows, [{ outcome: 'test', environment: null }]);
  await pool.query("DELETE FROM billing_store_notifications WHERE store='google' AND notification_id=$1", [testId]);
  await platform.deleteAccount(user.id, 'correct horse battery staple');
});

test('real PostgreSQL keeps one waiting row for a Google refund not listed yet, however many deliveries arrive together', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({
    NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'billing', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32),
    APPLE_ROOT_CERTIFICATES: appleChain().rootBase64,
    GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE: PUSH_AUDIENCE, GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL: PUSH_EMAIL,
  });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const email = `waiting-${suffix}@example.test`;
  const { user } = await platform.register({ email, username: `waiting-${suffix}`, password: 'correct horse battery staple' });
  await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
  const journey = await platform.createJourney(user.id, { name: 'Waiting', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const ids = await platform.storePurchaseIdentity(user.id, journey.id);
  const token = `waiting-${suffix}`;
  const voidedAt = Date.now();
  const google = {
    listed: false,
    productPurchase: async () => ({ purchaseState: 0, consumptionState: 1, acknowledgementState: 1, purchaseType: 0, quantity: 1, purchaseTimeMillis: String(Date.now()), obfuscatedExternalAccountId: ids.obfuscatedAccountId, obfuscatedExternalProfileId: ids.obfuscatedProfileId }),
    voidedPurchases: async () => (google.listed ? [{ purchaseToken: token, orderId: 'GPA.3300-0000-0000-00002', voidedTimeMillis: String(voidedAt) }] : []),
  };
  const keys = googleKeys();
  const logged = [];
  const store = new StorePurchaseService({
    pool, config, google, history: (client, event) => platform.appendEvent(client, event), log: (level, message) => logged.push(message),
    googlePush: new GooglePushVerifier({ ...config.googlePlayNotifications, fetch: keys.fetch }),
  });
  await store.verifyGoogle(user.id, { productId: 'room_51_week_pass', purchaseToken: token });
  const push = (messageId) => store.handleGoogleNotification({
    authorization: `Bearer ${pushToken(keys.current())}`,
    body: pushBody({ version: '1.0', packageName: 'com.togetherledger.ledger', eventTimeMillis: String(Date.now()), voidedPurchaseNotification: { purchaseToken: token, orderId: 'GPA.3300-0000-0000-00002', productType: 2, refundType: 1 } }, { messageId }),
  });
  const messageId = `${Date.now()}3`;
  const notes = () => pool.query("SELECT outcome FROM billing_store_notifications WHERE store='google' AND notification_id=$1", [messageId]);

  // Not listed: four deliveries at once are all asked for again, and leave one waiting row, logged once.
  const early = await Promise.allSettled(Array.from({ length: 4 }, () => push(messageId)));
  assert.deepEqual(early.map((answer) => answer.reason?.code), Array(4).fill('store_notification_not_confirmed'));
  assert.deepEqual((await notes()).rows, [{ outcome: 'waiting' }]);
  assert.equal(logged.filter((message) => message === 'google has not listed a refund yet').length, 1);

  // Listed: four at once, applied once, to the same row.
  google.listed = true;
  const answers = await Promise.all(Array.from({ length: 4 }, () => push(messageId)));
  assert.deepEqual(answers.map((answer) => answer.outcome).sort(), ['already-received', 'already-received', 'already-received', 'refunded']);
  assert.deepEqual((await notes()).rows, [{ outcome: 'refunded' }]);

  // 035's outcome check, as real Postgres names and enforces it.
  await assert.rejects(pool.query("UPDATE billing_store_notifications SET outcome='nonsense' WHERE store='google' AND notification_id=$1", [messageId]), /billing_store_notifications_outcome_check/);
  await pool.query("UPDATE billing_store_notifications SET outcome='reinstated' WHERE store='google' AND notification_id=$1", [messageId]);
  await platform.deleteAccount(user.id, 'correct horse battery staple');
});

// #96: leaving, against the real schema: the append-only history takes the entry, the photo of a
// private moment goes with it, and two leaves sent together (a double tap, a retry after a lost
// reply) leave once, with one entry in History, while the second finds nothing to leave.
test('real PostgreSQL lets a journeyer leave once, with what they held privately, and keeps the chain whole', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({ NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'test-groups', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const person = async (name) => {
    const email = `${name}-${suffix}@example.test`;
    const { user } = await platform.register({ email, username: `${name}-${suffix}`, password: 'correct horse battery staple' });
    await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
    return { ...user, email };
  };
  const [owner, leaver, stays] = [await person('leave-owner'), await person('leave-member'), await person('leave-stays')];
  const journey = await platform.createJourney(owner.id, { name: 'Left once', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const join = async (invited, agreeing = []) => {
    const { proposalId } = await platform.proposeInvitation(owner.id, journey.id, invited.email, '', 'http://127.0.0.1:4174');
    for (const member of agreeing) await platform.decideInviteProposal(member.id, journey.id, proposalId, 'agree', 'http://127.0.0.1:4174');
    await platform.acceptInvitation(invited.id, mailer.messages.findLast((message) => message.type === 'invitation' && message.to === invited.email).token);
  };
  await join(leaver);
  await join(stays, [leaver]);

  const base = { kind: 'memory', kindLabel: '', occurredOn: '2026-08-01', detail: '', theme: '', moneyCents: null, moneyCurrency: '', locations: [{ label: 'The harbour', latitude: 38.7, longitude: -9.1, accuracyMeters: 12 }] };
  const kept = await platform.createMoment(leaver.id, journey.id, { ...base, title: 'Only mine', visibility: 'private', idempotencyKey: `leave-private-${suffix}` });
  const shared = await platform.createMoment(leaver.id, journey.id, { ...base, title: 'For everyone', visibility: 'shared-now' });
  const photo = await readFile(new URL('./fixtures/photos/sideways-with-gps.jpg', import.meta.url));
  await platform.uploadMomentImage(leaver.id, journey.id, kept.id, 'image/jpeg', photo);
  const { proposalId } = await platform.proposeInvitation(leaver.id, journey.id, `asked-${suffix}@example.test`, '', 'http://127.0.0.1:4174');

  const both = await Promise.allSettled([platform.leaveJourney(leaver.id, journey.id), platform.leaveJourney(leaver.id, journey.id)]);
  assert.equal(both.filter((result) => result.status === 'fulfilled').length, 1, 'one of them leaves');
  assert.equal(both.find((result) => result.status === 'rejected').reason.code, 'not_found', 'the other finds nothing to leave');

  const count = async (sql, params) => (await pool.query(sql, params)).rows[0].count;
  assert.equal(await count("SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1 AND action='member_left'", [journey.id]), 1);
  assert.equal(await count('SELECT count(*)::int AS count FROM journey_moments WHERE id=$1', [kept.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS count FROM moment_images WHERE moment_id=$1', [kept.id]), 0, 'the photo goes with its moment');
  assert.equal(await count('SELECT count(*)::int AS count FROM moment_hold_keys WHERE journey_id=$1 AND author_user_id=$2', [journey.id, leaver.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS count FROM journey_moments WHERE id=$1', [shared.id]), 1, 'what they shared stays');
  assert.equal((await pool.query('SELECT status FROM journey_invite_proposals WHERE id=$1', [proposalId])).rows[0].status, 'withdrawn');
  await assert.rejects(pool.query("UPDATE journey_events SET summary='rewritten' WHERE journey_id=$1 AND action='member_left'", [journey.id]), /journey events are append-only/);

  const after = await platform.snapshot(stays.id, journey.id);
  assert.equal(after.eventChainValid, true);
  assert.equal(after.events.at(-1).summary, `leave-member-${suffix} left the journey`);
  assert.equal(after.moments.find((moment) => moment.id === shared.id).createdBy, `leave-member-${suffix}`);
  assert.deepEqual(after.members.map((member) => member.id).sort(), [owner.id, stays.id].sort());
  await assert.rejects(platform.snapshot(leaver.id, journey.id), { code: 'forbidden' });
  assert.deepEqual(await platform.listJourneys(leaver.id), []);
  await assert.rejects(platform.leaveJourney(owner.id, journey.id), { code: 'ownership_transfer_required' });

  // Paying on the web for this journey's room: leaving waits until that payment ends.
  const billing = new StripeBillingService({ pool, config: { stripeEnvironment: 'test' }, stripe: {} });
  await pool.query(
    `INSERT INTO billing_subscriptions (provider_subscription_id,environment,payer_user_id,journey_id,provider_customer_id,offer_id,paid_capacity,status)
     VALUES ($1,'test',$2,$3,'cus_leave','additional-person-monthly',1,'active')`,
    [`sub_leave_${suffix}`, stays.id, journey.id],
  );
  await assert.rejects(billing.assertJourneyLeavable(stays.id, journey.id), { code: 'billing_subscription_active' });
  await pool.query("UPDATE billing_subscriptions SET status='canceled' WHERE provider_subscription_id=$1", [`sub_leave_${suffix}`]);
  await billing.assertJourneyLeavable(stays.id, journey.id);
  await platform.leaveJourney(stays.id, journey.id);
  assert.deepEqual((await platform.snapshot(owner.id, journey.id)).members.map((member) => member.id), [owner.id]);
});

// #266: reading an invitation before answering it writes nothing, and only the invited, verified
// account learns the journey and who sent it; someone already in it, the owner included, spends nothing.
test('real PostgreSQL reads an invitation for the person it was sent to, and looking spends nothing', { skip: !databaseUrl }, async (t) => {
  const config = loadConfig({ NODE_ENV: 'development', JOURNEY_CAPACITY_MODE: 'test-groups', DATABASE_URL: databaseUrl, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32) });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer });
  const suffix = Date.now().toString(36);
  const verified = async (name) => {
    const email = `${name}-${suffix}@example.test`;
    const { user } = await platform.register({ email, username: `${name}-${suffix}`, password: 'correct horse battery staple' });
    return { user, email, verify: () => platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token) };
  };
  const alice = await verified('preview-alice');
  await alice.verify();
  const journey = await platform.createJourney(alice.user.id, { name: 'Read before joining', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 });
  const bobEmail = `preview-bob-${suffix}@example.test`;
  await platform.proposeInvitation(alice.user.id, journey.id, bobEmail, '', 'https://app.together-ledger.com');
  const token = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === bobEmail).token;
  const state = async () => ({
    invitation: (await pool.query('SELECT accepted_at,revoked_at,reservation_active,lapse_recorded_at FROM invitations WHERE journey_id=$1', [journey.id])).rows,
    events: (await pool.query('SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1', [journey.id])).rows[0].count,
    members: (await pool.query('SELECT count(*)::int AS count FROM journey_members WHERE journey_id=$1', [journey.id])).rows[0].count,
  });
  const before = await state();

  const bob = await verified('preview-bob');
  assert.deepEqual(await platform.previewInvitation(bob.user.id, token), { state: 'verify_email' });
  await bob.verify();
  const open = await platform.previewInvitation(bob.user.id, token);
  assert.equal(open.state, 'open');
  assert.equal(open.journeyName, 'Read before joining');
  assert.equal(open.invitedByDisplayName, `preview-alice-${suffix}`);
  assert.deepEqual(await platform.previewInvitation(alice.user.id, token), { state: 'already_member', journeyId: journey.id, journeyName: 'Read before joining' });
  const carol = await verified('preview-carol');
  await carol.verify();
  assert.deepEqual(await platform.previewInvitation(carol.user.id, token), { state: 'another_account' });
  assert.deepEqual(await platform.previewInvitation(bob.user.id, 'no-such-code-at-all-here'), { state: 'not_found' });
  assert.deepEqual(await state(), before, 'nothing written by looking');

  // The owner tapping their own link spends nothing either.
  await assert.rejects(platform.acceptInvitation(alice.user.id, token), (error) => error.code === 'invalid_invitation');
  assert.deepEqual(await state(), before);

  assert.equal(await platform.acceptInvitation(bob.user.id, token), journey.id);
  const joined = await state();
  assert.equal(joined.members, before.members + 1);
  assert.deepEqual(await platform.previewInvitation(bob.user.id, token), { state: 'already_member', journeyId: journey.id, journeyName: 'Read before joining' });
  await assert.rejects(platform.acceptInvitation(bob.user.id, token), (error) => error.code === 'invalid_invitation');
  assert.deepEqual(await state(), joined, 'tapping again adds and spends nothing');
});
