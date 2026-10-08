// Builds, or rebuilds, the sample journey an app reviewer signs in to (#260). What it makes and
// the guard that keeps it away from anyone else's account: server/review-journey.js. When to run
// it and where the credentials live: docs/APP_REVIEW.md. It lives in server/ so it ships in the
// production image.
//
//   REVIEW_EMAIL=… REVIEW_PARTNER_EMAIL=… REVIEW_PASSWORD=… node server/seed-review-journey.js
//
// It prints what it made, never the password, and the STORE_SANDBOX_ACCOUNT_IDS line the live
// server needs so App Review's sandbox purchases count (#272).

import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { seedReviewJourney } from './review-journey.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const made = await seedReviewJourney({
    pool,
    config,
    reviewerEmail: process.env.REVIEW_EMAIL,
    partnerEmail: process.env.REVIEW_PARTNER_EMAIL,
    password: process.env.REVIEW_PASSWORD,
  });
  process.stdout.write(`${JSON.stringify(made)}\n`);
  // The reviewer's account id is new after every run, so the live server's list of sandbox testers
  // has to be set again before the next review, or App Review's test purchases will be refused.
  process.stdout.write(`\nThe reviewer's account id has changed. Before the next review, set this in the live server's environment and restart it:\n${made.storeSandboxAccountIds}\n`);
} catch (error) {
  process.stderr.write(`${error.message || error.name}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
