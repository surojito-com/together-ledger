# Deploying the API server

## Status of this document

**This procedure was run for the first time on 2026-09-29**, releasing `76221ea`. It was first
written without anyone having looked at the running host, and the survey that preceded that
release found the deployment in a materially different state than the document assumed. The
corrections are recorded here rather than quietly folded in, because the difference is the
substance.

What that first run covered: a verified current backup, a build from a clean checkout, the
migrations rehearsed against a restored copy and then applied to production ahead of the image
swap, and confirmation from outside. What it did not cover, and why, is tracked in #225 — no
image has been pushed to the registry, so the release is still pinned by tag and the rollback
anchor is a local build.

**The API is deployed, and has been since 2026-09-14.** It runs on a single EC2 host in
`<AWS_REGION>` from `compose.production.yaml`, behind Caddy, with a healthy daily encrypted
backup timer. Issue #198 was filed against this repository's own documentation, which said no
registry was configured and left every Deployment box unticked. The documentation was behind the
machine, not the other way round.

What the survey found, and what this document now assumes:

- **A procedure already exists, and it lives in one person's habit.** The host holds a clone of
  this repository at `<REPO_DIR>`. An image is built there, tagged with the registry address, and
  started with `docker compose up -d`. Nothing is written down, and nothing is recorded after.
- **The ECR repository is named but has never been used.** `TOGETHER_IMAGE` points at a registry
  address, but the image behind it was built on the host: it carries no registry digest, and the
  AWS CLI is not installed there, so nothing has been pushed or pulled. The registry address is
  decoration.
- **Images are pinned by tag, not by digest.** The rollback path below depends on immutable
  digests. Until a build is genuinely pushed and pinned by digest, that rollback is a plan and
  not a capability.
- **Production drifts silently.** At the survey the running image was 47 commits, 8 server-side
  pull requests and 4 migrations behind `main`, and nothing reported that anywhere. The API
  publishes no release marker, so the gap was only visible by probing routes from outside and
  reading `schema_migrations` on the host.

So the first run of this procedure is not a first deploy. It is the first *recorded* one, and the
first that leaves the service in a state a later operator can reason about.

Every step that needs a value only the owner holds is written as `<A_PLACEHOLDER>` and listed in
[Values the owner supplies](#values-the-owner-supplies). Nothing in this repository invents a
registry address, a host name, a secret ARN, or an account identifier.

Tick the [production readiness gate](PRODUCTION_READINESS.md) as each item becomes true by
having been done, not by having been read here.

## The decision: deliberately manual

**Deploying the API stays manual. Building and publishing its image may become a workflow later.
Nothing deploys `server/` from CI today, and that is a choice.**

Why:

- **The posture is single-host active/passive.** One writer, one database, low volume, one
  operator. A deploy pipeline exists to remove human error from work done often. This work is
  not done often.
- **A deploy workflow would need credentials with production reach.** The app Worker's token is
  scoped to publishing one static bundle. An API deploy needs registry push, host access, and
  the database behind it. That is a much larger thing to leave in a repository's settings than
  the deploys it would save.
- **There is no staging replica and no blue/green.** `docker compose up -d` recreates the app
  container in place, and Caddy proxies to it. A deploy is a brief interruption either way, and
  an automated one is a brief interruption nobody is watching.
- **Migrations run against the only database.** Until there is a second environment that a
  release passes through first, a push-button deploy is a push-button migration.
- **A green workflow is a claim, not evidence.** The confirmation step for this service is a
  request to `https://api.together-ledger.com` from outside, and that is manual regardless. The
  automation would cover the easy half.

What half is worth automating, and is drafted but not wired:

Building the image is deterministic, has no production reach, and is the least reliable manual
step — it is the one that quietly depends on which machine you are standing at. A build-and-push
workflow is drafted at `.github/workflows/server-image.yml.draft`. It is deliberately **not** a
`.yml` file, so GitHub Actions does not read it and it cannot run. Renaming it is the act of
adopting it; see [The drafted build workflow](#the-drafted-build-workflow).

Revisit this decision when any of these becomes true:

- Server changes reach `main` more than about once a week.
- A pre-production environment exists that a release passes through automatically.
- More than one person deploys.
- The service stops being able to take a short interruption.

## Values the owner supplies

| Placeholder | What it is | Where it comes from |
| --- | --- | --- |
| `<AWS_ACCOUNT_ID>` | The AWS account that holds the registry and the host | AWS console |
| `<AWS_REGION>` | The region of the registry and the host | AWS console |
| `<REGISTRY>` | `<AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com` | derived from the two above |
| `<ECR_REPOSITORY>` | The repository name inside that registry | AWS console; one already exists |
| `<HOST>` | SSH target of the production host | the owner's SSH configuration |
| `<REPO_DIR>` | The reviewed checkout on the host, for example `/srv/together-ledger` | chosen at first deploy |
| `<SECRET_ID_SESSION>` | Secrets Manager name or ARN holding `SESSION_SECRET` | AWS Secrets Manager |
| `<SECRET_ID_AUDIT>` | Secrets Manager name or ARN holding `AUDIT_HMAC_KEY` | AWS Secrets Manager |
| `<SECRET_ID_POSTGRES>` | Secrets Manager name or ARN holding `POSTGRES_PASSWORD` | AWS Secrets Manager |
| `<SECRET_ID_SMTP>` | Secrets Manager name or ARN holding the Resend relay URL | AWS Secrets Manager |
| `<SECRET_ID_APPLE_SIGN_IN>` | Secrets Manager name or ARN holding `APPLE_SIGN_IN_PRIVATE_KEY`: the Sign in with Apple key `985BDXJP8S`'s `.p8` contents, on one line | AWS Secrets Manager |
| `<SECRET_ID_APPLE_TOKENS>` | Secrets Manager name or ARN holding `APPLE_TOKEN_ENCRYPTION_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`) | AWS Secrets Manager |
| `<COMMIT>` | The reviewed `main` commit being released | `git rev-parse HEAD` in a clean checkout |
| `<DIGEST>` | The immutable image digest recorded in step 2 | printed by the build |

Do not paste a real value into an issue, a pull request, a commit, or a chat window. The
readiness gate treats a secret that appeared in any of those as burned.

## Why Amazon ECR

The registry was not a settled fact anywhere in this repository, so it is settled here: **a
private Amazon ECR repository in `<AWS_REGION>`, the same account as the host.** One already
exists there and is named by `TOGETHER_IMAGE`; what has never happened is an image being pushed
to it. Choosing ECR is therefore a ratification of what the host already points at, not a move.

- `docs/OPERATIONS.md` already documents how to read scan evidence out of **ECR Basic scanning**,
  including the OCI-index caveat. That procedure was written for ECR and works nowhere else.
- The image never leaves the account that runs it, and the host pulls over the AWS network.
- It needs no third-party credential in addition to the AWS one already required for Secrets
  Manager and backups.

GitHub Container Registry is the reasonable alternative and would pair more naturally with a
future build workflow. It is not chosen because it would strand the scan-evidence procedure and
add a second credential holder for no benefit at this size. If it is ever adopted, the scan
evidence section of `OPERATIONS.md` has to be rewritten at the same time, not afterwards.

## One-time setup

### 1. The registry

**A repository already exists in the owner's account. Look before creating one**, and if it is
there, confirm its settings rather than making a second:

```sh
aws ecr describe-repositories --region <AWS_REGION> \
  --query 'repositories[].[repositoryName,imageTagMutability,encryptionConfiguration.encryptionType]' \
  --output table
```

If it is missing, create it. Immutable tags, so a tag can never be moved to a different image
behind a recorded digest:

```sh
aws ecr create-repository \
  --repository-name <ECR_REPOSITORY> \
  --region <AWS_REGION> \
  --image-tag-mutability IMMUTABLE \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
```

If it exists with mutable tags, fix that before relying on a recorded digest:

```sh
aws ecr put-image-tag-mutability --repository-name <ECR_REPOSITORY> \
  --region <AWS_REGION> --image-tag-mutability IMMUTABLE
```

**The host needs an AWS CLI to pull from the registry, and may not have one.** Check with
`command -v aws` on the host before assuming a pull is possible. Without it the host cannot
authenticate to ECR, and an image tagged with a registry address is a local build wearing a
registry's name — which is exactly the state the 2026-09-29 survey found. Either install it, or
record here that the build happens on the host, rather than describing a pull that does not
happen.

Give the host an IAM principal that can pull from this one repository and nothing else
(`ecr:GetAuthorizationToken`, plus `ecr:BatchGetImage` and
`ecr:GetDownloadUrlForLayer` on this repository's ARN). It must not be able to push, delete, or
read any other repository. Keep its credential in a root-owned mode-0600 file on the host, as
the backup uploader's credential already is.

### 2. Create the production environment file

Follow `OPERATIONS.md` step 2. The file is root-owned, mode `0600`, outside the repository:

```sh
sudo install -d -m 700 /etc/together-ledger
sudo install -m 600 /dev/null /etc/together-ledger/production.env
```

Fill it from `.env.production.example`, then materialise the real values from Secrets Manager
without letting them reach the terminal, the shell history, or another process's view of the
process table. `printf` is a shell builtin, so the value is never an argument to an executed
command:

```sh
sudo sh -c 'umask 077; {
  printf "SESSION_SECRET=%s\n" "$(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_SESSION> --query SecretString --output text)"
  printf "AUDIT_HMAC_KEY=%s\n" "$(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_AUDIT> --query SecretString --output text)"
  printf "POSTGRES_PASSWORD=%s\n" "$(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_POSTGRES> --query SecretString --output text)"
  printf "SMTP_URL=%s\n" "$(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_SMTP> --query SecretString --output text)"
} >> /etc/together-ledger/production.env'
```

Then add the two Sign in with Apple values as below. Confirm the file has exactly one line for
each key and no placeholder left from the example. `DATABASE_URL` is derived by
`compose.production.yaml`; do not set it by hand.

**What the running host actually has (owner, 2026-10-01).** The four values above live in one
combined secret holding several values, not one secret each as the block assumes. The
production file already holds them, so a release does not re-run that block. If it ever has to
be rebuilt, read each value out of the combined secret instead, still without printing it.

#### Adding the two Sign in with Apple values (#218)

The two Apple values are one secret each (`<SECRET_ID_APPLE_SIGN_IN>`,
`<SECRET_ID_APPLE_TOKENS>`), kept apart from the combined secret so either can be replaced
without rewriting the others. Done on 2026-10-01, before #249 merged.

**Who reads them.** The `aws` that runs under `sudo` on the host is the IAM role
`together-ledger-host-image-pull`, through the host's managed-instance (`mi-`) registration. The
login user's `aws` is the Lightsail-managed instance role, in Lightsail's own account, and can
read nothing of ours. The pull role was given one inline policy,
`read-together-ledger-apple-secrets`: `secretsmanager:GetSecretValue` on those two secrets' ARNs
and nothing else. They use the default `aws/secretsmanager` key, so no KMS grant is needed.
Check it without printing a value:

```sh
sudo aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_APPLE_TOKENS> \
  --query 'length(SecretString)' --output text      # 44
```

**Appending them to an existing file.** Back the file up first (`sudo cp -p`, and remove the
copy once the checks below pass). The values go into variables inside one root shell, so
nothing is printed. If either comes back empty, nothing is written. A missing final newline is
added first, so the new lines cannot join the last one. `tr -d "\r\n"` folds the `.p8` onto one
line, Windows line endings included; the server rebuilds the PEM from it (`server/apple.js`).

```sh
sudo sh -c 'umask 077
F=/etc/together-ledger/production.env
K=$(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_APPLE_SIGN_IN> --query SecretString --output text | tr -d "\r\n")
E=$(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id <SECRET_ID_APPLE_TOKENS> --query SecretString --output text | tr -d "\r\n")
if [ -z "$K" ] || [ -z "$E" ]; then echo "a secret came back empty; nothing written"; exit 1; fi
[ -z "$(tail -c1 "$F")" ] || printf "\n" >> "$F"
printf "APPLE_SIGN_IN_PRIVATE_KEY=%s\nAPPLE_TOKEN_ENCRYPTION_KEY=%s\n" "$K" "$E" >> "$F"
echo "written"'
```

Before appending, `sudo grep -c -E '^APPLE_(SIGN_IN_PRIVATE_KEY|TOKEN_ENCRYPTION_KEY)=' <file>`
must print `0`. If it prints anything else, replace those lines rather than adding new ones.

**Proving they are set, without printing them:**

```sh
F=/etc/together-ledger/production.env
# One line each, and how long each value is.
sudo awk -F= '/^APPLE_(SIGN_IN_PRIVATE_KEY|TOKEN_ENCRYPTION_KEY)=/ { print $1, length($0) - length($1) - 1 }' "$F"
# The key parses as P-256: prints only "ASN1 OID: prime256v1" and "NIST CURVE: P-256".
sudo sed -n 's/^APPLE_SIGN_IN_PRIVATE_KEY=//p' "$F" \
  | sed -e 's/-----BEGIN PRIVATE KEY-----//' -e 's/-----END PRIVATE KEY-----//' \
  | base64 -d | openssl pkey -inform DER -noout -text_pub | grep -E 'ASN1 OID|NIST CURVE'
# The encryption key is 32 bytes.
sudo sed -n 's/^APPLE_TOKEN_ENCRYPTION_KEY=//p' "$F" | base64 -d | wc -c
# Both match Secrets Manager.
sudo bash -c 'F=/etc/together-ledger/production.env
for n in APPLE_SIGN_IN_PRIVATE_KEY:<SECRET_ID_APPLE_SIGN_IN> APPLE_TOKEN_ENCRYPTION_KEY:<SECRET_ID_APPLE_TOKENS>; do
  k=${n%%:*}; id=${n#*:}
  cmp -s <(sed -n "s/^$k=//p" "$F") \
         <(aws secretsmanager get-secret-value --region <AWS_REGION> --secret-id "$id" --query SecretString --output text | tr -d "\r\n"; echo) \
    && echo "$k matches Secrets Manager" || echo "$k DIFFERS"
done'
# Compose hands both to the app: prints only true/false.
cd <REPO_DIR>
sudo TOGETHER_ENV_FILE="$F" docker compose --env-file "$F" -f compose.production.yaml config --format json \
  | jq '.services.app.environment | {signInKey: has("APPLE_SIGN_IN_PRIVATE_KEY"), tokenKey: has("APPLE_TOKEN_ENCRYPTION_KEY")}'
```

No restart is needed when only these two lines are added: code before #249 ignores them, and the
next release's `up -d` picks them up.

### 3. Create the release log

Rollback needs to know what the last good release was. Nothing records that today:

```sh
sudo install -m 600 /dev/null /etc/together-ledger/releases.log
```

One line per release, appended in step 5. It holds a UTC timestamp, a commit, a digest, and the
migrations that release applied — no secrets, so it can be read aloud during an incident.

### 4. Preflight the host

```sh
cd <REPO_DIR> && ./scripts/verify-production-host.sh
```

Read-only. It deploys nothing and opens no port.

## Releasing

### 1. Start from a clean reviewed checkout

Build from the exact commit that CI passed, with nothing uncommitted. A dirty tree produces an
image whose digest corresponds to no reviewed revision:

```sh
git fetch origin main
git checkout <COMMIT>
test -z "$(git status --porcelain)" || { echo "Working tree is dirty. Stop."; exit 1; }
npm ci && npm run check
```

### 2. Build and publish, recording the digest

Build for the host's architecture explicitly. `--provenance=false --sbom=false` keeps buildx
from publishing an OCI image index around a single-platform image, which is what makes ECR Basic
scanning unable to scan it directly — the caveat `OPERATIONS.md` describes. With these flags
there is one manifest and one digest:

```sh
COMMIT=$(git rev-parse HEAD)
aws ecr get-login-password --region <AWS_REGION> \
  | docker login --username AWS --password-stdin <REGISTRY>

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --tag <REGISTRY>/<ECR_REPOSITORY>:"$COMMIT" \
  --metadata-file /tmp/together-ledger-image.json \
  --push .

DIGEST=$(jq -r '."containerimage.digest"' /tmp/together-ledger-image.json)
printf 'built %s\n' "$DIGEST"
```

The ECR login token lasts twelve hours. Log in again rather than wondering why a pull fails.

Then ask the registry what it actually stored, and require the two answers to agree. The build's
own report is a claim; the registry is the thing the host will pull from:

```sh
aws ecr describe-images \
  --repository-name <ECR_REPOSITORY> \
  --region <AWS_REGION> \
  --image-ids imageTag="$COMMIT" \
  --query 'imageDetails[0].imageDigest' --output text
```

If that differs from `$DIGEST`, stop and find out why before going further.

### 3. Read the scan before deciding

```sh
aws ecr describe-image-scan-findings \
  --repository-name <ECR_REPOSITORY> \
  --region <AWS_REGION> \
  --image-id imageDigest="$DIGEST" \
  --query '{status: imageScanStatus.status, counts: imageScanFindings.findingSeverityCounts}'
```

`status` must be `COMPLETE`. A scan that is missing, `IN_PROGRESS`, or `FAILED` is not a clean
scan — see *Container scan evidence* in `OPERATIONS.md`, including what to do if an older image
was built without `--provenance=false` and ECR is holding an index it will not scan. Record the
counts and the decision; do not publish the registry address or the digest outside the host and
the release log.

### 4. Rehearse the migrations against a pre-production copy

This is `OPERATIONS.md` release gate step 3, and until now there was no command for it. Restore
the newest verified encrypted backup into an isolated database — never the production one — and
run the migrations from **the same image** you are about to deploy:

```sh
docker run --rm \
  --env-file /etc/together-ledger/preproduction.env \
  --network together-preproduction \
  <REGISTRY>/<ECR_REPOSITORY>@<DIGEST> \
  node server/migrate.js
```

It prints the migrations it applied and exits non-zero if any of them fails. All migrations run
in one transaction, so a failure leaves the copy on the schema it started from.

Read the list. Then check each new migration against the rule in
[Rollback](#rollback): a release whose migrations are not additive cannot be undone by putting
the previous image back, and has to be planned as two releases instead of one.

For the release that carries `023_let-a-phone-carry-its-own-key.sql`, the list will contain that
one migration, and it is additive — `CREATE TABLE IF NOT EXISTS api_tokens` plus two indexes. No
existing table, column, or constraint changes, so the previous image runs against the new schema
unharmed.

### 5. Deploy

On the host, in the reviewed checkout at the same commit.

First, a restore point. The pre-migration backup is the only thing that can undo a schema
change, so take it before anything moves:

```sh
sudo systemctl start together-ledger-backup.service
sudo /usr/local/lib/together-ledger/verify-production-recovery.sh
```

Do not continue unless that passes.

Record the digest that is live right now — this is what you will roll back to:

```sh
grep '^TOGETHER_IMAGE=' /etc/together-ledger/production.env    # via sudo; empty on a first deploy
```

Point the environment file at the new digest, by digest and never by tag:

```sh
sudo sh -c 'umask 077; sed -i "s|^TOGETHER_IMAGE=.*|TOGETHER_IMAGE=<REGISTRY>/<ECR_REPOSITORY>@<DIGEST>|" /etc/together-ledger/production.env'
sudo grep '^TOGETHER_IMAGE=' /etc/together-ledger/production.env
```

Pull, apply migrations as their own visible step, then start:

```sh
cd <REPO_DIR>
export COMPOSE="docker compose --env-file /etc/together-ledger/production.env -f compose.production.yaml"

TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE pull app
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE run --rm app node server/migrate.js
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE up -d
```

`run --rm app` brings PostgreSQL up and waits for it to be healthy first, then applies the
migrations and exits. Starting the app afterwards finds nothing left to apply. Compose needs
both `TOGETHER_ENV_FILE` and `--env-file`: the first satisfies the services' `env_file`, the
second its own variable substitution.

Caddy only starts once the app reports healthy, and the app only reports healthy once `/readyz`
answers. A deploy that fails to become healthy therefore fails loudly — the API returns errors
rather than quietly serving the previous release. That is the intended behaviour and it is also
why there is an interruption: there is no second app container to fall back to.

Append the release to the log:

```sh
sudo sh -c 'umask 077; printf "%s %s %s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "<COMMIT>" "<DIGEST>" "<migrations-applied-or-none>" >> /etc/together-ledger/releases.log'
```

### 6. Confirm against production, not against the deploy

Privately on the host first:

```sh
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE ps
curl -fsS http://127.0.0.1:4174/healthz    # from inside the app container, or via the compose network
```

Then from outside, over the real internet path, from a machine that is not the host:

```sh
curl -fsS https://api.together-ledger.com/healthz
curl -fsS https://api.together-ledger.com/readyz
```

`/readyz` answering `{"status":"ready"}` means the app reached PostgreSQL. It does **not** mean
the release you intended is the one running. Confirm the running digest on the host:

```sh
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE ps -q app \
  | xargs docker inspect --format '{{index .RepoDigests 0}}'
```

That must be the digest from step 2.

Finally, confirm the *change*. A health check proves a server is up; it proves nothing about
what merged. Exercise the thing the release added, with a synthetic account, never a real one.
For the release carrying #179, the new capability is a phone getting a token instead of a
cookie:

```sh
curl -fsS https://api.together-ledger.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -H 'x-together-client: app' \
  --data '{"email":"<SYNTHETIC_ACCOUNT_EMAIL>","password":"<SYNTHETIC_ACCOUNT_PASSWORD>"}' \
  | jq 'has("data") and (.data | has("token") and has("refreshToken"))'
```

`true` means the migrated table exists, the route is live, and this release is the one answering.
A `404`, or a reply carrying a session cookie instead, means the deploy did not land whatever the
health check says.

There is one gap left here worth naming: the API publishes no release marker, so unlike
`app.together-ledger.com` — which serves `release.json` — there is no way to ask production which
revision it is running from outside. Until there is, the digest check above is a host-side check,
and the behavioural probe is the only outside evidence. Adding a revision to `/healthz` would
close it and is a change for its own story, not for a deploy runbook to make on the way past.

### 7. Record it

Write the outcome into the product journey document: the UTC time, the commit, the migrations
applied, the scan counts, the verification results, and anything that did not go as written.
Correct this document where it was wrong. It has never been run, and the first run is the
review.

## Rollback

The Worker's rollback replaces a static bundle. This one does not: the container and its
database move together on the way forward, and only the container can move back.

### The rule that makes rollback possible

**A migration must be safe for the previous image to run against.** Add tables, add nullable
columns, add indexes. Do not drop, rename, or narrow anything in the same release that stops
writing to it. A change that must remove something is two releases — one that stops using it,
one that removes it — and the second cannot ship until the first is the version you would roll
back to. `023_let-a-phone-carry-its-own-key.sql` obeys this.

When a release breaks the rule, say so in the release log line, and accept that its rollback is
a database restore rather than an image change.

### Returning to the previous image

Roughly ten minutes, no data loss, provided the rule above held.

```sh
# 1. Record first: the failing digest, UTC time, symptoms, and whether writes may have landed.
#    Delete nothing — not volumes, logs, backups, or the database.
sudo tail -5 /etc/together-ledger/releases.log

# 2. Point the environment file back at the last good digest.
sudo sh -c 'umask 077; sed -i "s|^TOGETHER_IMAGE=.*|TOGETHER_IMAGE=<REGISTRY>/<ECR_REPOSITORY>@<PREVIOUS_DIGEST>|" /etc/together-ledger/production.env'

# 3. Start that image. PostgreSQL keeps running; only the app container is replaced.
cd <REPO_DIR>
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE pull app
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE up -d app

# 4. Verify privately, then from outside, then one synthetic account flow.
curl -fsS https://api.together-ledger.com/healthz
curl -fsS https://api.together-ledger.com/readyz
```

The schema does not move backwards. The rolled-back image simply never runs the newer
migrations, and `schema_migrations` keeps recording them as applied — so redeploying the newer
image later applies nothing and starts cleanly. The extra table or column sits unused. That is
the intended outcome, not a defect to tidy up during an incident.

Append the rollback to the release log the same way a release is appended, so the log reads as
what is running rather than what was last attempted.

### When the image is not the problem

If data looks wrong, or a migration that broke the additive rule has run, stop. Freeze writes,
do not roll the image, and follow *AWS rollback procedure* step 5 in `OPERATIONS.md`: choose the
newest validated encrypted backup, restore it into an **isolated** database, verify the HMAC
event chains and the synthetic checks, and make promotion a separate, deliberate decision.

### Rehearsing it

The readiness gate asks for a rehearsal without production user data, and this is how to do one
before the first real deploy — entirely on a pre-production copy:

1. Restore a synthetic-data backup into the isolated database.
2. Deploy image A there, with a synthetic environment file.
3. Deploy image B (the newer commit) and run its migrations.
4. Return to image A by digest, and confirm it starts and serves against the newer schema.
5. Record how long steps 2 to 4 took. That number is the rollback budget during an incident.

Only after that rehearsal passes should the Deployment and Recoverability items in
`PRODUCTION_READINESS.md` be ticked.

## The drafted build workflow

`.github/workflows/server-image.yml.draft` builds and pushes the image and reports its digest.
It does not deploy, does not touch the host, and does not run migrations.

It is inert. GitHub Actions reads only `.yml` and `.yaml` files in that directory, so a file
ending in `.draft` is never scheduled, never dispatchable, and never triggered. A test asserts
it stays that way, so adopting it is a deliberate rename in a pull request rather than a file
that quietly becomes live.

Before renaming it, the owner has to:

- Create an IAM role that GitHub Actions can assume by OIDC, allowed to push to this one ECR
  repository and to do nothing else.
- Store its ARN and the registry values as environment secrets under a protected environment, as
  `CLOUDFLARE_API_TOKEN` already is.
- Decide whether it runs on `workflow_dispatch` only, or also after CI passes on `main`. The
  draft is dispatch-only, because a build that runs on every merge accumulates images nobody
  chose.

Even then, the deploy steps stay manual. A workflow that publishes an image is not a deploy path;
it is a shorter step 2.
