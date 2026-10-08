import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { AppleTransactionVerifier } from '../server/store-apple.js';
import { StorePurchaseService } from '../server/store-purchases.js';
import { appleChain, signTransaction, transactionPayload } from './support/apple-signing.js';

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
  assert.deepEqual(migrations.rows.map((row) => row.name), ['001_platform.sql', '002_append_only_events.sql', '003_private_usernames.sql', '004_shared_moments.sql', '005_make-shared-journeys-more-humane.sql', '006_expand-shared-moment-vocabulary.sql', '007_person_specific_moment_visibility.sql', '008_stripe_web_billing.sql', '009_reserve-group-places.sql', '010_stripe_reconciliation_runs.sql', '011_hold-one-image-with-each-moment.sql', '012_bill-additional-moment-images.sql', '013_name-moment-image-attachments.sql', '014_hold-places-with-shared-moments.sql', '015_bill-additional-moment-places.sql', '016_make-extra-image-payments-one-time.sql', '017_keep-one-removed-photo-per-moment.sql', '018_allow-ninety-nine-paid-journey-places.sql', '019_let-moments-carry-their-own-atmosphere.sql', '020_let-entitlements-hold-ninety-nine-places.sql', '021_let-unpaid-capacity-rest-without-losing-history.sql', '022_agree-together-before-adding-someone.sql', '023_let-a-phone-carry-its-own-key.sql', '024_let-google-and-apple-open-an-account.sql', '025_revoke-sign-in-with-apple-when-an-account-is-deleted.sql', '026_remember-a-refused-apple-deletion.sql', '027_tie-every-store-purchase-to-an-account.sql', '028_turn-a-store-purchase-into-capacity.sql']);

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

  await pool.query(
    `INSERT INTO invitations (id,journey_id,invited_by_user_id,email_normalized,token_hash,expires_at)
     SELECT (
       substr(md5(series::text),1,8) || '-' || substr(md5(series::text),9,4) || '-' ||
       substr(md5(series::text),13,4) || '-' || substr(md5(series::text),17,4) || '-' ||
       substr(md5(series::text),21,12)
     )::uuid, $1, $2, 'reserved-' || series || '@example.test', md5('a-' || series) || md5('b-' || series), now() + interval '1 hour'
     FROM generate_series(1,97) AS series`,
    [journey.id, registration.user.id],
  );
  const concurrentInvitations = await Promise.allSettled([
    platform.createInvitation(registration.user.id, journey.id, 'boundary-a@example.test'),
    platform.createInvitation(registration.user.id, journey.id, 'boundary-b@example.test'),
  ]);
  assert.equal(concurrentInvitations.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedInvitation = concurrentInvitations.find((result) => result.status === 'rejected');
  assert.equal(rejectedInvitation.reason.code, 'journey_full');
  const capacity = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM journey_members WHERE journey_id=$1) AS members,
       (SELECT count(*)::int FROM invitations WHERE journey_id=$1 AND reservation_active=true AND expires_at>now()) AS reservations`,
    [journey.id],
  );
  assert.deepEqual(capacity.rows[0], { members: 1, reservations: 98 });

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
