// Builds, or rebuilds, the sample journey an app reviewer signs in to (#260). What it makes and
// the guard that keeps it away from anyone else's account: server/review-journey.js. When to run
// it and where the credentials live: docs/APP_REVIEW.md. It lives in server/ so it ships in the
// production image.
//
//   REVIEW_EMAIL=… REVIEW_PARTNER_EMAIL=… REVIEW_PASSWORD=… node server/seed-review-journey.js
//
// It prints what it made, never the password.

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
} catch (error) {
  process.stderr.write(`${error.message || error.name}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
