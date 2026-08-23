import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4174),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:4174'),
  API_ORIGIN: z.string().url().or(z.literal('')).default(''),
  ACCOUNT_ORIGIN: z.string().url().or(z.literal('')).default(''),
  DATABASE_URL: z.string().min(1).default('postgres://together@127.0.0.1:5432/together_ledger'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  SESSION_SECRET: z.string().min(32).default('development-session-secret-change-me-0001'),
  AUDIT_HMAC_KEY: z.string().min(32).default('development-audit-secret-change-me-00001'),
  SESSION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  TOKEN_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Together Ledger <no-reply@together-ledger.com>'),
  MAIL_FROM_INVITATION: z.string().default(''),
  MAIL_FROM_VERIFICATION: z.string().default(''),
  MAIL_FROM_RECOVERY: z.string().default(''),
});

export function loadConfig(overrides = {}) {
  const config = ConfigSchema.parse({ ...process.env, ...overrides });
  if (config.NODE_ENV === 'production') {
    if (!config.PUBLIC_ORIGIN.startsWith('https://')) throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
    if (!config.API_ORIGIN.startsWith('https://')) throw new Error('Production API_ORIGIN must use HTTPS.');
    if (!config.ACCOUNT_ORIGIN.startsWith('https://')) throw new Error('Production ACCOUNT_ORIGIN must use HTTPS.');
    if (config.COOKIE_SECURE !== 'true') throw new Error('Production cookies must be secure.');
    if (config.SESSION_SECRET.startsWith('development-') || config.AUDIT_HMAC_KEY.startsWith('development-')) throw new Error('Production secrets must not use development defaults.');
    if (!config.SMTP_URL) throw new Error('Production SMTP delivery must be configured.');
  }
  return {
    ...config,
    databaseSsl: config.DATABASE_SSL === 'true',
    cookieSecure: config.COOKIE_SECURE === 'true',
    trustProxy: config.TRUST_PROXY === 'true',
  };
}
