// Re-applies account deletions to a database restored from backup. A backup taken before someone
// deleted their account still holds that account; this erases it again, with the same steps the
// app takes, before the restored database serves anyone. It lives in server/ so it ships in the
// production image. Usage and where the ids come from: docs/OPERATIONS.md, "Re-applying deletions
// after a restore".
//
//   node server/reapply-account-deletions.js <account-id> [<account-id> ...]

import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { PlatformService } from './platform.js';

const ids = process.argv.slice(2);
if (!ids.length) {
  process.stderr.write('Pass the id of each account to delete again.\n');
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config);
const platform = new PlatformService({ pool, config, mailer: null });
let failed = 0;
try {
  for (const id of ids) {
    try {
      const erased = await platform.eraseAccount(id);
      process.stdout.write(`${JSON.stringify({ id, result: erased ? 'deleted' : 'already deleted' })}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`${JSON.stringify({ id, result: 'not deleted', code: error.code || error.name })}\n`);
    }
  }
} finally {
  await pool.end();
}
if (failed) process.exitCode = 2;
