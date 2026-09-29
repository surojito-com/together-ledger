// Migrations normally run as a side effect of the server starting. That is the right default
// for one container, and the wrong one for a deploy: the schema change and the new code arrive
// in the same breath, with nothing in between to look at or stop at.
//
// This entry point runs the same migrations through the same code path and then exits, so a
// release can apply them against a pre-production copy first, and so the production run is a
// step someone chose and read the output of. Starting the server afterwards finds nothing left
// to do, which is the point: the schema moved when somebody was watching.
import { loadConfig } from './config.js';
import { createPool, runMigrations } from './db.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const { applied } = await runMigrations(pool);
  process.stdout.write(`${JSON.stringify({ level: 'info', message: 'migrations complete', applied })}\n`);
} finally {
  await pool.end();
}
