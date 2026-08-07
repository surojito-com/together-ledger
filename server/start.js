import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, runMigrations } from './db.js';
import { ConsoleBlockedMailer, SmtpMailer } from './mailer.js';
import { PlatformService } from './platform.js';

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool);
const mailer = config.SMTP_URL
  ? new SmtpMailer({ smtpUrl: config.SMTP_URL, from: config.MAIL_FROM, publicOrigin: config.PUBLIC_ORIGIN })
  : new ConsoleBlockedMailer();
const platform = new PlatformService({
  pool,
  config,
  mailer,
  onDeliveryFailure: ({ kind, errorName }) => process.stderr.write(`${JSON.stringify({ level: 'error', message: 'email delivery failed', kind, errorName })}\n`),
});
const app = await buildApp({ platform, config, logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.token'] } });

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
