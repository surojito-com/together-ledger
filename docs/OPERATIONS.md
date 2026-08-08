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

## Release gate

1. `npm ci` and `npm run check` pass from a clean checkout.
2. Build the immutable container image once and record its digest.
3. Apply migrations using the same image against a pre-production copy.
4. Exercise registration, verification, invitation, two-seat enforcement, access denial, recovery, concurrent edit conflict, Event Manager integrity, export, and deletion with synthetic data.
5. Deploy AWS primary, run `/healthz`, then run authenticated smoke tests.
6. Copy a backup to GCP, restore it into the standby database, deploy the same digest, and test using a private temporary hostname.
7. Route `together.surojito.com` only after both the rollback and standby restore paths have passed.

## Incident rule

Never promote GCP merely because one health check fails. Confirm the AWS database state, freeze writes, select the newest valid cross-cloud backup, verify the HMAC event chains, restore, smoke test, then change DNS. Record every failover and restore in the product journey document without including secrets or user data.
