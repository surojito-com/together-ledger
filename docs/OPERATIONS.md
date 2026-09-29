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

Delivery is split on purpose. The static app Worker is deployed by CI on every reviewed `main` push; the API in `server/` is deployed by hand from the host. That asymmetry is a recorded decision, not an omission — the reasoning, and what would reverse it, is in [API server deployment](SERVER_DEPLOY.md). A drafted build-and-publish workflow sits at `.github/workflows/server-image.yml.draft`, inert until someone renames it, and it would still not deploy.

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
- Production `SMTP_URL` uses the authenticated Resend SMTPS relay. A standby relay path must be configured and independently tested before it is relied on during recovery.
- PostgreSQL accepts private-network traffic only. The application role owns application tables; humans use separate audited administrative roles.
- Backups are encrypted, copied to the other cloud, retained according to the deletion policy, and restored quarterly into an isolated database.
- Application logs exclude cookies, authorization headers, passwords, raw tokens, expense notes, account labels, and concern details.

## Production bundle

The API has never been deployed. [API server deployment](SERVER_DEPLOY.md) holds the full
procedure — registry, build, digest, migrations, verification, rollback — and records why
deploying `server/` is deliberately manual while the app Worker is automated. This section
remains the summary; that document is the thing to follow on the host.

`compose.production.yaml` is deliberately separate from the local `compose.yaml` file. It has no Mailpit service and exposes only Caddy on ports 80 and 443. PostgreSQL and the Node service have no host ports and communicate only on the Docker network.

1. Build and review an image, then record its immutable registry digest as `TOGETHER_IMAGE`. The registry, the build, and the digest record are specified step by step in the [API server deployment procedure](SERVER_DEPLOY.md): a private Amazon ECR repository in the owner's account. That procedure has been written but never run, so treat its first execution as the review of both the release and the document.
2. Copy `.env.production.example` to a persistent, root-owned, mode-0600 file outside the repository, such as `/etc/together-ledger/production.env`. Do not use `/run`, which is cleared at reboot. In production, materialize its real values from AWS Secrets Manager; do not commit it.
3. Set `CADDY_DOMAIN=api.together-ledger.com` and `API_ORIGIN=https://api.together-ledger.com` only after staging DNS and TLS are ready. Set `PUBLIC_ORIGIN=https://app.together-ledger.com` and `ACCOUNT_ORIGIN=https://app.together-ledger.com`. During a dual-host rollout, set `APP_ORIGINS` to the legacy app origin as a comma-separated exact-origin list. `ACCOUNT_ORIGIN` is the safe fallback for trusted non-browser jobs. Browser-issued verification, recovery, and invitation emails preserve the already allowlisted origin that requested them: app actions return to the app origin, direct API testing returns to the API client, and arbitrary origins are rejected before mail is sent.
4. Start the bundle with `TOGETHER_ENV_FILE=/etc/together-ledger/production.env docker compose --env-file /etc/together-ledger/production.env -f compose.production.yaml up -d`. Compose needs `--env-file` for its own image and database variable substitutions; service-level `env_file` alone is not enough.
5. Check `https://api.together-ledger.com/healthz` and `/readyz`; do not route the public frontend to the API until the synthetic-account checks pass.

### Encrypted logical backup

Install `age` on the server and create an offline backup encryption key. Keep the private identity off the server and out of the repository. Put only its public recipient in the root-owned `/etc/together-ledger/backup-recipient.env` file:

```sh
sudo install -d -m 700 /etc/together-ledger
sudo sh -c 'printf "%s\\n" "AGE_RECIPIENT=age1replace-with-your-public-recipient" > /etc/together-ledger/backup-recipient.env'
sudo chmod 600 /etc/together-ledger/backup-recipient.env
```

The recipient file must be root-owned with mode `0600`. The backup script reads that file without executing it, creates a custom-format PostgreSQL dump, encrypts it before writing it to disk, writes a SHA-256 sidecar, and prints the created path.

### Automated offsite recovery copy

PR#0018 makes the recovery job explicit but does not add a cloud credential to the application or its container. Create a separate GCP service identity that has only `Storage Object Creator` on this one backup bucket. It can add a new uniquely named encrypted backup pair but cannot read, list, alter, or delete historic backups.

Keep that uploader credential in a root-owned mode-0600 file outside the repository. The matching root-owned `/etc/together-ledger/backup-uploader.env` contains the bucket name, the uploader's service-account email, and the credential path. The job activates that named identity only in a short-lived root-only Google CLI configuration, then removes that configuration when the job exits; it cannot fall back to a personal Google login. Then install the reviewed timer files:

```sh
GCP_BACKUP_BUCKET=replace-with-private-bucket
GCP_BACKUP_SERVICE_ACCOUNT=backup-uploader@your-project.iam.gserviceaccount.com
GOOGLE_APPLICATION_CREDENTIALS=/etc/together-ledger/backup-uploader-key.json
```

```sh
sudo ./scripts/install-production-recovery-timer.sh
sudo systemctl start together-ledger-backup.service
sudo /usr/local/lib/together-ledger/verify-production-recovery.sh
sudo systemctl enable --now together-ledger-backup.timer
```

The one-off service first makes and checksum-verifies the local encrypted dump, uploads the dump and sidecar, and then records a root-only upload receipt. The recovery preflight accepts only a current local backup whose checksum agrees with that receipt. It deliberately fails closed if the recipient file, uploader configuration, backup, checksum, or receipt is missing or stale.

The uploader's successful cloud response is deployment evidence, but a human GCP owner should still periodically check the private bucket and perform an isolated restore drill. Do not upload the private age identity.

## Release gate

1. `npm ci` and `npm run check` pass from a clean checkout.
2. Build the immutable container image once and record its digest.
3. Apply migrations using the same image against a pre-production copy: `docker run --rm --env-file <pre-production env file> <image>@<digest> node server/migrate.js`. That entry point runs the same migrations the server runs at startup and then exits, so the schema moves as a step someone reads the output of rather than as a side effect of a container starting. See [API server deployment](SERVER_DEPLOY.md), *Rehearse the migrations against a pre-production copy*.
4. Exercise registration, verification, invitation, two-seat enforcement, access denial, recovery, concurrent edit conflict, Event Manager integrity, export, and deletion with synthetic data.
5. Deploy AWS primary, run `/healthz`, then run authenticated smoke tests.
6. Run `sudo /usr/local/lib/together-ledger/verify-production-recovery.sh`; it must pass before deployment. Confirm the encrypted pair is visible in the private GCP bucket, restore it into the standby database, deploy the same digest, and test using a private temporary hostname.
7. Configure `api.together-ledger.com`, then set the app frontend's API-origin configuration only after both the rollback and standby restore paths have passed. `app.together-ledger.com` becomes the canonical running web app and `together-ledger.com` becomes the company site. Keep the legacy app origin as a redirect only after the new path is verified.

Read the companion [production readiness gate](PRODUCTION_READINESS.md) before opening ports 80 or 443. The host preflight is deliberately read-only:

```sh
./scripts/verify-production-host.sh
```

### Container scan evidence

Buildx can publish an OCI image index even when the release was built explicitly for
`linux/amd64`. ECR Basic scanning cannot scan that index directly. For each immutable
release, resolve the index's `linux/amd64` child manifest and retrieve the completed
scan status and severity counts from that child.

Do not treat a missing scan on the index as a clean scan, and do not deploy a candidate
until its runnable child has completed scanning. Record the counts and the release
decision without publishing registry account details, digests, or private infrastructure
information.

## AWS rollback procedure

Use this procedure only after a deployed release. It does not replace the incident/failover plan below. [API server deployment](SERVER_DEPLOY.md) holds the commands, the release log this depends on, and how to rehearse the whole path on a pre-production copy before an incident asks for it.

1. Record the failing release digest, UTC time, symptoms, and whether writes may have succeeded. Do not delete volumes, logs, backups, or the running database.
2. If the issue is limited to the app or proxy, keep PostgreSQL running and return the application image to the last reviewed digest in the root-owned environment file. `/etc/together-ledger/releases.log` says which digest that is.
3. Run `TOGETHER_ENV_FILE=/etc/together-ledger/production.env docker compose --env-file /etc/together-ledger/production.env -f compose.production.yaml up -d` from the reviewed checkout.
4. Verify `/healthz` and `/readyz` privately first. Then test one synthetic account flow; never use a real user's account as a probe.
5. If database integrity is in doubt, freeze writes and stop. Choose the newest validated encrypted logical backup, restore it only into an isolated database, verify HMAC event chains and synthetic checks, then make a separate promotion decision.
6. Record the outcome in the product journey document without secrets, IP addresses, account identifiers, or user data.

Returning the image does not return the schema. Migrations are forward-only and `schema_migrations` keeps recording an applied migration after the image that introduced it is gone, so the previous release must be able to run against the newer schema. That is only true while every migration is additive — new tables, new nullable columns, new indexes, nothing dropped, renamed, or narrowed in the same release that stops writing to it. A release that cannot honour that says so in its release log line, and its rollback is a restore from the pre-migration backup rather than an image change.

## App Worker delivery and rollback

`app.together-ledger.com` is the independently deployed public application. Protected `main` reaches it only after the `CI` workflow for that exact push succeeds. The delivery workflow rebuilds from the lockfile, repeats the repository checks, packages the static Worker, and deploys it with the `app` environment's `CLOUDFLARE_API_TOKEN`.

The final parity check is deliberately made through a separate, fixed-purpose Cloudflare Worker. The probe accepts only a full revision SHA, fetches only the public app's release marker and home page, and succeeds only when both the deployed SHA and the `Keep what matters,` control agree. Its `workers.dev` endpoint is verification-only; it serves no app traffic, takes no secrets or user input beyond the revision, and is not an authority for the root site. This separates delivery evidence from the GitHub runner network path without weakening app protections.

Keep that token scoped only to the production app Worker deployment path. Store it as an environment secret, not in repository files, workflow text, command arguments, or issue discussion. A missing token intentionally fails the delivery job before it can claim the reviewed release is live.

`together-ledger.com` is the company site. It is served through Cloudflare from the separate `together-ledger.com` repository and is deployed by that repository's own workflow. Nothing in this repository builds or deploys the apex, and no check here can speak for it.

If a Worker release needs to be rolled back, first record the symptoms and the current release revision. From a reviewed checkout with the authorized deployment credential available only in the process environment:

```sh
npm ci
./node_modules/.bin/wrangler versions list --config wrangler.jsonc
./node_modules/.bin/wrangler versions deploy <previous-worker-version-id>@100 --config wrangler.jsonc --message "Return app Worker to reviewed revision"
node scripts/verify-worker-release.mjs --base-url https://app.together-ledger.com --revision <previous-reviewed-commit-sha> --required-text "Keep what matters,"
```

Choose the prior Worker version by its recorded reviewed-main message and use its matching commit SHA in the last command. A Worker rollback changes only the static app bundle. It does not roll back the API container, database schema or data, billing state, DNS, or release-specific behavioral decisions.

## Incident rule

Never promote GCP merely because one health check fails. Confirm the AWS database state, freeze writes, select the newest valid cross-cloud backup, verify the HMAC event chains, restore, smoke test, then change DNS. Record every failover and restore in the product journey document without including secrets or user data.
