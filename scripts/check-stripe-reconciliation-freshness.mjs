import { fileURLToPath } from 'node:url';
import { createPool } from '../server/db.js';
import { loadConfig } from '../server/config.js';

export const MAX_RECONCILIATION_AGE_MS = 8 * 60 * 60 * 1000;

export function isStale(lastSucceededAt, now = new Date()) {
  if (!lastSucceededAt) return true;
  return now.getTime() - new Date(lastSucceededAt).getTime() > MAX_RECONCILIATION_AGE_MS;
}

async function main() {
  const config = loadConfig();
  if (!config.billingEnabled) throw new Error('Stripe billing must be enabled before checking reconciliation freshness.');
  const pool = createPool(config);
  try {
    const result = await pool.query(
      `SELECT completed_at FROM billing_reconciliation_runs
       WHERE provider='stripe' AND environment=$1 AND processing_state='succeeded'
       ORDER BY completed_at DESC LIMIT 1`,
      [config.stripeEnvironment],
    );
    const lastSucceededAt = result.rows[0]?.completed_at ?? null;
    if (isStale(lastSucceededAt)) {
      process.stdout.write(`${JSON.stringify({ ok: false, lastSucceededAt })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, lastSucceededAt })}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ ok: false, message: 'Stripe reconciliation freshness check failed to run.' })}\n`);
    process.exitCode = 1;
  });
}
