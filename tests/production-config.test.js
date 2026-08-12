import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production deployment bundle keeps the database private and requires deliberate secrets', async () => {
  const [compose, caddy, environment, backup, hostCheck, readiness] = await Promise.all([
    readFile(new URL('../compose.production.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../Caddyfile', import.meta.url), 'utf8'),
    readFile(new URL('../.env.production.example', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/backup-postgres.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/verify-production-host.sh', import.meta.url), 'utf8'),
    readFile(new URL('../docs/PRODUCTION_READINESS.md', import.meta.url), 'utf8'),
  ]);
  assert.match(compose, /caddy:2\.10-alpine/);
  assert.match(compose, /"80:80"/);
  assert.match(compose, /"443:443"/);
  assert.doesNotMatch(compose, /5432:5432|4174:4174|mailpit/i);
  assert.match(compose, /TOGETHER_ENV_FILE/);
  assert.match(caddy, /\{\$CADDY_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy app:4174/);
  assert.match(environment, /COOKIE_SECURE=true/);
  assert.match(environment, /TRUST_PROXY=true/);
  assert.match(environment, /POSTGRES_PASSWORD=replace-with-64-hex-characters/);
  assert.match(environment, /replace-with-a-different-long-random-secret/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /age -r/);
  assert.match(backup, /export TOGETHER_ENV_FILE/);
  assert.match(hostCheck, /does not deploy the app or open any network port/);
  assert.match(hostCheck, /grep -Eq '5432:5432\|4174:4174\|mailpit'/);
  assert.match(readiness, /never committed/);
  assert.match(readiness, /budget alert is monitoring/);
});
