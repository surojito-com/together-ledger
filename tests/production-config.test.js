import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { runMigrations } from '../server/db.js';

test('production deployment bundle keeps the database private and requires deliberate secrets', async () => {
  const [compose, caddy, environment, backup, backupRunner, recoveryCheck, recoveryInstaller, backupService, backupTimer, hostCheck, readiness, dockerfile] = await Promise.all([
    readFile(new URL('../compose.production.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../Caddyfile', import.meta.url), 'utf8'),
    readFile(new URL('../.env.production.example', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/backup-postgres.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/run-production-backup.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/verify-production-recovery.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/install-production-recovery-timer.sh', import.meta.url), 'utf8'),
    readFile(new URL('../ops/together-ledger-backup.service', import.meta.url), 'utf8'),
    readFile(new URL('../ops/together-ledger-backup.timer', import.meta.url), 'utf8'),
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
  assert.match(environment, /PUBLIC_ORIGIN=https:\/\/app\.together-ledger\.com/);
  assert.match(environment, /APP_ORIGINS=https:\/\/together-ledger\.com/);
  assert.match(environment, /API_ORIGIN=https:\/\/api\.together-ledger\.com/);
  assert.match(environment, /ACCOUNT_ORIGIN=https:\/\/app\.together-ledger\.com/);
  assert.match(environment, /no-reply@together-ledger\.com/);
  assert.match(environment, /POSTGRES_PASSWORD=replace-with-64-hex-characters/);
  assert.match(environment, /replace-with-a-different-long-random-secret/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /age -r/);
  assert.match(backup, /BACKUP_RECIPIENT_FILE/);
  assert.match(backup, /exactly one AGE_RECIPIENT value/);
  assert.match(backup, /export TOGETHER_ENV_FILE/);
  assert.match(backup, /production environment file is not readable/);
  assert.match(backup, /TOGETHER_REPO_DIR/);
  assert.match(backup, /production Compose file is missing/);
  assert.match(backup, /mkfifo/);
  assert.match(backup, /wait "\$dump_pid"/);
  assert.match(backupRunner, /GCP_BACKUP_BUCKET/);
  assert.match(backupRunner, /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(backupRunner, /GCP_BACKUP_SERVICE_ACCOUNT/);
  assert.match(backupRunner, /gcloud auth activate-service-account/);
  assert.match(backupRunner, /CLOUDSDK_CONFIG/);
  assert.match(backupRunner, /install -d -m 700 \/var\/lib\/together-ledger/);
  assert.match(backupRunner, /gcloud storage cp/);
  assert.match(backupRunner, /last-offsite-backup\.env/);
  assert.match(recoveryCheck, /must have mode 0600/);
  assert.match(recoveryCheck, /backup runtime file/);
  assert.match(recoveryCheck, /newest encrypted backup has no matching offsite upload receipt/);
  assert.match(recoveryCheck, /Recovery preflight passed/);
  assert.match(recoveryInstaller, /systemctl daemon-reload/);
  assert.match(recoveryInstaller, /backup-runtime\.env/);
  assert.match(backupService, /BACKUP_RECIPIENT_FILE/);
  assert.match(backupService, /EnvironmentFile=\/etc\/together-ledger\/backup-runtime\.env/);
  assert.match(backupService, /EnvironmentFile=\/etc\/together-ledger\/backup-uploader\.env/);
  assert.match(backupTimer, /OnCalendar=\*-\*-\* 03:30:00/);
  assert.match(backupTimer, /Persistent=true/);
  assert.match(hostCheck, /does not deploy the app or open any network port/);
  assert.match(hostCheck, /grep -Eq '5432:5432\|4174:4174\|mailpit'/);
  assert.match(readiness, /never committed/);
  assert.match(readiness, /budget alert is monitoring/);
  assert.match(readiness, /api\.together-ledger\.com/);
  assert.match(dockerfile, /FROM node:24\.21\.0-alpine3\.24@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2 AS dependencies/);
  assert.equal(dockerfile.match(/RUN apk upgrade --no-cache/g)?.length, 2);
  assert.match(dockerfile, /apk add --no-cache python3 make g\+\+/);
  assert.match(dockerfile, /FROM node:24\.21\.0-alpine3\.24@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2\nENV NODE_ENV=production/);
});

test('operations use the production environment file for Compose substitutions', async () => {
  const operations = await readFile(new URL('../docs/OPERATIONS.md', import.meta.url), 'utf8');
  assert.match(operations, /docker compose --env-file \/etc\/together-ledger\/production\.env -f compose\.production\.yaml up -d/);
});

test('public home is prepared for the protected account service', async () => {
  const publicHome = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(publicHome, /<meta name="together-api-origin" content="https:\/\/api\.together-ledger\.com" \/>/);
  assert.match(publicHome, /<meta name="together-accounts-enabled" content="true" \/>/);
});

test('the migration entry point reports what it applied and repeats nothing', async () => {
  // Only pool.connect() and a client with query/release are used, so the contract that the
  // deploy procedure leans on can be proven without a database: the schema moves as a step
  // whose output someone reads, and running it again is a no-op.
  const statements = [];
  const alreadyApplied = new Set(['001_platform.sql']);
  const pool = {
    connect: async () => ({
      query: async (text, values) => {
        statements.push(text);
        if (text.startsWith('SELECT 1 FROM schema_migrations')) {
          return { rowCount: alreadyApplied.has(values[0]) ? 1 : 0 };
        }
        if (text.startsWith('INSERT INTO schema_migrations')) alreadyApplied.add(values[0]);
        return { rowCount: 0 };
      },
      release: () => {},
    }),
  };

  const first = await runMigrations(pool);
  assert.ok(first.applied.length > 0);
  assert.ok(!first.applied.includes('001_platform.sql'), 'an applied migration is never run twice');
  assert.ok(first.applied.includes('023_let-a-phone-carry-its-own-key.sql'));
  assert.deepEqual(first.applied, [...first.applied].sort(), 'migrations apply in filename order');
  assert.equal(statements.at(-1), 'COMMIT');

  assert.deepEqual((await runMigrations(pool)).applied, []);
});

test('the API has a written deploy path, and it is deliberately manual', async () => {
  const [deploy, operations, readiness, draft] = await Promise.all([
    readFile(new URL('../docs/SERVER_DEPLOY.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/OPERATIONS.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/PRODUCTION_READINESS.md', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/server-image.yml.draft', import.meta.url), 'utf8'),
  ]);

  // The decision the issue asked to be recorded rather than left as a gap.
  assert.match(deploy, /Deploying the API stays manual/);
  assert.match(deploy, /Revisit this decision when/);
  // Deploy by digest, never by a tag someone can move.
  assert.match(deploy, /<ECR_REPOSITORY>@<DIGEST>/);
  assert.match(deploy, /node server\/migrate\.js/);
  // A health check is not evidence that the change shipped.
  assert.match(deploy, /Confirm against production, not against the deploy/);
  assert.match(deploy, /## Rollback/);
  assert.match(deploy, /must be safe for the previous image to run against/);

  // The registry question is answered somewhere, so OPERATIONS may no longer say it is open.
  assert.doesNotMatch(operations, /A registry is not configured yet/);
  assert.match(operations, /SERVER_DEPLOY\.md/);
  assert.match(operations, /Returning the image does not return the schema/);
  assert.match(readiness, /SERVER_DEPLOY\.md/);
  assert.match(readiness, /a written procedure is not a performed one/);

  // The draft builds and publishes. It must never grow a deploy step, because the reason it is
  // allowed to exist is that it cannot reach production.
  assert.match(draft, /workflow_dispatch:/);
  assert.doesNotMatch(draft, /compose\.production\.yaml/);
  assert.doesNotMatch(draft, /appleboy\/ssh-action|ssh -/);
});

test('the drafted image workflow stays inert until someone renames it on purpose', async () => {
  // GitHub Actions reads only .yml and .yaml here. A draft that ships as either one is live,
  // whatever its comments say, so adopting it has to be a visible rename in a pull request.
  const workflows = readdirSync(new URL('../.github/workflows', import.meta.url));
  assert.ok(workflows.includes('server-image.yml.draft'));
  assert.ok(!workflows.includes('server-image.yml'));
  assert.ok(!workflows.includes('server-image.yaml'));
});
