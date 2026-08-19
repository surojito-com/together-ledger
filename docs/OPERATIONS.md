# Operations runbook

## Deployment posture

PR#0003 uses one portable container and standard PostgreSQL so the same artifact can run in the owner's AWS and GCP accounts. The low-volume launch posture is deliberately active/passive:

```text
Cloudflare DNS
      │
      ▼
AWS primary ───── private PostgreSQL + encrypted backups
      │                           │
      └── encrypted logical backup copy ──► GCP storage
                                               │
                                               ▼
                                      GCP cold standby
```

AWS is the only writer in normal operation. GCP stores a separately encrypted backup copy and a deployable standby configuration. A documented restore drill promotes GCP only during an incident; there is no fragile or expensive cross-cloud dual-write path. DNS changes happen only after database restore, integrity verification, and smoke tests.

## Local platform test

1. Copy `.env.example` to `.env` and replace both secret values.
2. Run `docker compose up --build`.
3. Open `http://127.0.0.1:4174`.
4. Open Mailpit at `http://127.0.0.1:8025` for verification, invitation, and recovery messages.
5. Run `npm run check` outside the containers.

Local Docker is optional for unit tests; the automated API suite runs against an in-memory PostgreSQL-compatible test database.

## Production requirements

- TLS terminates at the cloud load balancer or proxy; `PUBLIC_ORIGIN` is the exact HTTPS origin.
- `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
- `SESSION_SECRET` and `AUDIT_HMAC_KEY` are different random secrets held in AWS Secrets Manager and GCP Secret Manager, never environment files or Git.
- `SMTP_URL` points to the owner's authenticated SMTP relay. AWS SES SMTP is suitable for the primary; the standby must have a separately tested relay path.
- PostgreSQL accepts private-network traffic only. The application role owns application tables; humans use separate audited administrative roles.
- Backups are encrypted, copied to the other cloud, retained according to the deletion policy, and restored quarterly into an isolated database.
- Application logs exclude cookies, authorization headers, passwords, raw tokens, expense notes, account labels, and concern details.

## Production bundle (no cloud action yet)

`compose.production.yaml` is deliberately separate from the local `compose.yaml` file. It has no Mailpit service and exposes only Caddy on ports 80 and 443. PostgreSQL and the Node service have no host ports and communicate only on the Docker network.

1. Build and review an image, then record its immutable registry digest as `TOGETHER_IMAGE`. A registry is not configured yet; do this only during the later server deployment pass.
2. Copy `.env.production.example` to a root-owned, mode-0600 file outside the repository, such as `/run/together-ledger/production.env`. In production, materialize its real values from AWS Secrets Manager; do not commit it.
3. Set `CADDY_DOMAIN=api.together-ledger.com` only after staging DNS and TLS are ready. Keep `PUBLIC_ORIGIN=https://together-ledger.com`.
4. Start the bundle with `TOGETHER_ENV_FILE=/run/together-ledger/production.env docker compose --env-file /run/together-ledger/production.env -f compose.production.yaml up -d`. Compose needs `--env-file` for its own image and database variable substitutions; service-level `env_file` alone is not enough.
5. Check `https://api.together-ledger.com/healthz` and `/readyz`; do not route the public frontend to the API until the synthetic-account checks pass.

### Encrypted logical backup

Install `age` on the server and create an offline backup encryption key. Keep only its public recipient in the scheduled job. Run:

```sh
TOGETHER_ENV_FILE=/run/together-ledger/production.env \
AGE_RECIPIENT=age1replace-with-your-public-recipient \
./scripts/backup-postgres.sh
```

The script creates a custom-format PostgreSQL dump, encrypts it before writing it to disk, writes a SHA-256 sidecar, and prints the created path. Copy both files to AWS and GCP storage through a separately reviewed transfer procedure. Test restoring into an isolated database before treating any backup as usable.

## Release gate

1. `npm ci` and `npm run check` pass from a clean checkout.
2. Build the immutable container image once and record its digest.
3. Apply migrations using the same image against a pre-production copy.
4. Exercise registration, verification, invitation, two-seat enforcement, access denial, recovery, concurrent edit conflict, Event Manager integrity, export, and deletion with synthetic data.
5. Deploy AWS primary, run `/healthz`, then run authenticated smoke tests.
6. Copy a backup to GCP, restore it into the standby database, deploy the same digest, and test using a private temporary hostname.
7. Configure `api.together-ledger.com`, then set the public frontend's API-origin configuration only after both the rollback and standby restore paths have passed. `together-ledger.com` becomes the GitHub Pages frontend. Keep `together.surojito.com` as a redirect only after the new path is verified.

Read the companion [production readiness gate](PRODUCTION_READINESS.md) before opening ports 80 or 443. The host preflight is deliberately read-only:

```sh
./scripts/verify-production-host.sh
```

## AWS rollback procedure

Use this procedure only after a deployed release. It does not replace the incident/failover plan below.

1. Record the failing release digest, UTC time, symptoms, and whether writes may have succeeded. Do not delete volumes, logs, backups, or the running database.
2. If the issue is limited to the app or proxy, keep PostgreSQL running and return the application image to the last reviewed digest in the root-owned environment file.
3. Run `TOGETHER_ENV_FILE=/run/together-ledger/production.env docker compose --env-file /run/together-ledger/production.env -f compose.production.yaml up -d` from the reviewed checkout.
4. Verify `/healthz` and `/readyz` privately first. Then test one synthetic account flow; never use a real user's account as a probe.
5. If database integrity is in doubt, freeze writes and stop. Choose the newest validated encrypted logical backup, restore it only into an isolated database, verify HMAC event chains and synthetic checks, then make a separate promotion decision.
6. Record the outcome in the product journey document without secrets, IP addresses, account identifiers, or user data.

## Incident rule

Never promote GCP merely because one health check fails. Confirm the AWS database state, freeze writes, select the newest valid cross-cloud backup, verify the HMAC event chains, restore, smoke test, then change DNS. Record every failover and restore in the product journey document without including secrets or user data.
