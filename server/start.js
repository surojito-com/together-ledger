import { buildApp } from './app.js';
import { createBillingService } from './billing.js';
import { loadConfig } from './config.js';
import { createPool, runMigrations } from './db.js';
import { loggerOptions } from './log-options.js';
import { ConsoleBlockedMailer, SmtpMailer } from './mailer.js';
import { PlatformService } from './platform.js';

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool);
const mailer = config.SMTP_URL
  ? new SmtpMailer({
    smtpUrl: config.SMTP_URL,
    from: config.MAIL_FROM,
    invitationFrom: config.MAIL_FROM_INVITATION || config.MAIL_FROM,
    verificationFrom: config.MAIL_FROM_VERIFICATION || config.MAIL_FROM,
    recoveryFrom: config.MAIL_FROM_RECOVERY || config.MAIL_FROM,
    accountOrigin: config.ACCOUNT_ORIGIN,
  })
  : new ConsoleBlockedMailer();
const platform = new PlatformService({
  pool,
  config,
  mailer,
  onDeliveryFailure: ({ kind, errorName }) => process.stderr.write(`${JSON.stringify({ level: 'error', message: 'email delivery failed', kind, errorName })}\n`),
});
// Journeys migration 029 moved from fully paused to read-only get their history entry here, once.
await platform.recordRestingMadeReadOnly();
const billing = createBillingService({ pool, config });
const app = await buildApp({
  platform,
  billing,
  config,
  logger: loggerOptions,
});

// Apple revocations a deletion couldn't finish (Apple unreachable) are retried every ten minutes
// (#218). A failure here is logged and left for the next round; it never stops the server.
const appleRetry = setInterval(() => {
  platform.drainAppleRevocations()
    .then((tally) => { if (tally.revoked || tally.retrying || tally.dropped) app.log.info(tally, 'apple revocations'); })
    .catch((error) => app.log.error({ err: { name: error?.name } }, 'apple revocations failed'));
}, 10 * 60 * 1000);
appleRetry.unref();

async function shutdown(signal) {
  clearInterval(appleRetry);
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
