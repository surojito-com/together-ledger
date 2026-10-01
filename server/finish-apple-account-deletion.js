// The owner's tool for an Apple account-deleted event that Delete account refused (#250). Run it
// on the host the way migrations run, so it uses the production database and the same code:
//
//   $COMPOSE run --rm app node server/finish-apple-account-deletion.js
//     lists every refused deletion still waiting, oldest first, with its shared journeys and the
//     people in them. Nothing changes.
//
//   $COMPOSE run --rm app node server/finish-apple-account-deletion.js <accountId> --hand <journeyId>=<newOwnerId> [--hand …]
//     hands each journey to the person chosen, then deletes the account exactly as Delete account
//     would. One --hand per shared journey the account still owns.
//
// Prints JSON only: ids, dates, journey names and display names, never an email or a token.
import { createBillingService } from './billing.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { ConsoleBlockedMailer } from './mailer.js';
import { PlatformService } from './platform.js';
import { finishRefusedAppleDeletion, listRefusedAppleDeletions } from './apple-deletion-followup.js';

function parse(argv) {
  const [userId, ...rest] = argv;
  const handovers = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--hand' || !rest[i + 1]?.includes('=')) throw new Error('Use --hand <journeyId>=<newOwnerId> for each journey.');
    const [journeyId, toUserId] = rest[i + 1].split('=');
    handovers.push({ journeyId, toUserId });
    i += 1;
  }
  return { userId, handovers };
}

const config = loadConfig();
const pool = createPool(config);
try {
  const { userId, handovers } = parse(process.argv.slice(2));
  if (!userId) {
    process.stdout.write(`${JSON.stringify({ waiting: await listRefusedAppleDeletions(pool) }, null, 2)}\n`);
  } else {
    // No email is sent on this path, so a mailer that refuses to send is the honest choice.
    const platform = new PlatformService({ pool, config, mailer: new ConsoleBlockedMailer() });
    const billing = createBillingService({ pool, config });
    process.stdout.write(`${JSON.stringify(await finishRefusedAppleDeletion({ pool, platform, billing }, userId, handovers))}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: 'error', message: error.message, code: error.code || 'error' })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
