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
const billing = createBillingService({ pool, config });
const app = await buildApp({
  platform,
  billing,
  config,
  logger: loggerOptions,
});

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
