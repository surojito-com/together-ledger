import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production deployment bundle keeps the database private and requires deliberate secrets', async () => {
  const [compose, caddy, environment, backup, hostCheck, readiness, dockerfile] = await Promise.all([
    readFile(new URL('../compose.production.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../Caddyfile', import.meta.url), 'utf8'),
    readFile(new URL('../.env.production.example', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/backup-postgres.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/verify-production-host.sh', import.meta.url), 'utf8'),
    readFile(new URL('../docs/PRODUCTION_READINESS.md', import.meta.url), 'utf8'),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  ]);
  assert.match(compose, /caddy:2\.10-alpine/);
  assert.match(compose, /"80:80"/);
  assert.match(compose, /"443:443"/);
  assert.doesNotMatch(compose, /5432:5432|4174:4174|mailpit/i);
  assert.match(compose, /TOGETHER_ENV_FILE/);
  assert.match(compose, /image: \$\{TOGETHER_IMAGE/);
  assert.match(caddy, /\{\$CADDY_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy app:4174/);
  assert.match(environment, /COOKIE_SECURE=true/);
  assert.match(environment, /TRUST_PROXY=true/);
  assert.match(environment, /CADDY_DOMAIN=api\.together-ledger\.com/);
  assert.match(environment, /PUBLIC_ORIGIN=https:\/\/together-ledger\.com/);
  assert.match(environment, /API_ORIGIN=https:\/\/api\.together-ledger\.com/);
  assert.match(environment, /no-reply@together-ledger\.com/);
  assert.match(environment, /POSTGRES_PASSWORD=replace-with-64-hex-characters/);
  assert.match(environment, /replace-with-a-different-long-random-secret/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /age -r/);
  assert.match(backup, /export TOGETHER_ENV_FILE/);
  assert.match(backup, /production environment file is not readable/);
  assert.match(backup, /mkfifo/);
  assert.match(backup, /wait "\$dump_pid"/);
  assert.match(hostCheck, /does not deploy the app or open any network port/);
  assert.match(hostCheck, /grep -Eq '5432:5432\|4174:4174\|mailpit'/);
  assert.match(readiness, /never committed/);
  assert.match(readiness, /budget alert is monitoring/);
  assert.match(readiness, /api\.together-ledger\.com/);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS dependencies/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends python3 make g\+\+/);
});

test('operations use the production environment file for Compose substitutions', async () => {
  const operations = await readFile(new URL('../docs/OPERATIONS.md', import.meta.url), 'utf8');
  assert.match(operations, /docker compose --env-file \/etc\/together-ledger\/production\.env -f compose\.production\.yaml up -d/);
});
