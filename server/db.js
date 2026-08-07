import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createPool(config) {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  });
}

export async function runMigrations(pool, { includeProtection = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql') && (includeProtection || !name.startsWith('002_'))).sort();
    for (const name of files) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (exists.rowCount) continue;
      await client.query(await readFile(join(migrationsDirectory, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
