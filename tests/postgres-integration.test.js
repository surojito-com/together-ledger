import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

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
  assert.deepEqual(migrations.rows.map((row) => row.name), ['001_platform.sql', '002_append_only_events.sql', '003_private_usernames.sql', '004_shared_moments.sql', '005_make-shared-journeys-more-humane.sql', '006_expand-shared-moment-vocabulary.sql', '007_person_specific_moment_visibility.sql', '008_stripe_web_billing.sql', '009_reserve-group-places.sql', '010_stripe_reconciliation_runs.sql', '011_hold-one-image-with-each-moment.sql', '012_bill-additional-moment-images.sql', '013_name-moment-image-attachments.sql', '014_hold-places-with-shared-moments.sql', '015_bill-additional-moment-places.sql', '016_make-extra-image-payments-one-time.sql', '017_keep-one-removed-photo-per-moment.sql', '018_allow-ninety-nine-paid-journey-places.sql', '019_let-moments-carry-their-own-atmosphere.sql', '020_let-entitlements-hold-ninety-nine-places.sql', '021_let-unpaid-capacity-rest-without-losing-history.sql', '022_agree-together-before-adding-someone.sql', '023_let-a-phone-carry-its-own-key.sql']);

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
