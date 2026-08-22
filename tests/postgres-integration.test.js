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
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  const pool = createPool(config);
  t.after(async () => pool.end());
  await runMigrations(pool);

  const migrations = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(migrations.rows.map((row) => row.name), ['001_platform.sql', '002_append_only_events.sql', '003_private_usernames.sql', '004_shared_moments.sql']);

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

  await platform.deleteAccount(registration.user.id, 'correct horse battery staple');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journeys WHERE id=$1', [journey.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1', [journey.id])).rows[0].count, 0);
  const deleted = await pool.query('SELECT email_normalized,username,display_name,deleted_at FROM users WHERE id=$1', [registration.user.id]);
  assert.match(deleted.rows[0].email_normalized, /^deleted-/);
  assert.match(deleted.rows[0].username, /^deleted-/);
  assert.equal(deleted.rows[0].display_name, 'Deleted account');
  assert.ok(deleted.rows[0].deleted_at);
});
