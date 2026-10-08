# Deploying the API server

## Status of this document

**This describes the release as it was actually done on 2026-10-01, and twice on 2026-10-08**,
from the account in #356 and from what this guide already said. Production is on migration
`030`.

The guide used to describe a different release: build and push to Amazon ECR, deploy by digest,
rehearse on a pre-production network, and roll back by digest. None of that is how a release has
been done. The image is built on the host and never pushed, migrations are rehearsed on a
throwaway copy of live data, and the rollback anchor is the previous local image. Those plans
are still wanted, so they are kept at the end, under [Planned, not yet done](#planned-not-yet-done),
and marked as plans rather than steps.

**What #356 confirmed and what it didn't.** #356 records five facts about those releases: where
the release log is, that the image is built on the host with nothing pushed, how migrations were
rehearsed, where the rollback anchor is, and that the backup plus `verify-production-recovery.sh`
before the switch matched this guide. Every other step below is carried over from the earlier
guide, which #356 did not flag. Where the exact command used on the host isn't written down
anywhere, this guide does not guess at one: it says what the step does and leaves an
`<OWNER: …>` placeholder for the command, to be filled in from the host by the person who ran it.

**Earlier history, briefly.** The API has run on a single EC2 host in `<AWS_REGION>`, from
`compose.production.yaml` behind Caddy, since 2026-09-14. The first recorded release was
2026-09-29 (`76221ea`). The survey before it found an image built on the host and tagged with a
registry address, with nothing ever pushed, and no record of what had been released. That is
still the shape of a release, now written down.

Every value only the owner holds is written as `<A_PLACEHOLDER>` and listed in
[Values the owner supplies](#values-the-owner-supplies). Nothing in this repository invents a
registry address, a host name, a secret ARN, an account identifier, or a command nobody ran.

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
| `<AWS_REGION>` | The region of the host and its secrets | AWS console |
| `<HOST>` | SSH target of the production host | the owner's SSH configuration |
| `<REPO_DIR>` | The reviewed checkout on the host, for example `/srv/together-ledger` | chosen at first deploy |
| `<SECRET_ID_SESSION>` | Secrets Manager name or ARN holding `SESSION_SECRET` | AWS Secrets Manager |
| `<SECRET_ID_AUDIT>` | Secrets Manager name or ARN holding `AUDIT_HMAC_KEY` | AWS Secrets Manager |
| `<SECRET_ID_POSTGRES>` | Secrets Manager name or ARN holding `POSTGRES_PASSWORD` | AWS Secrets Manager |
| `<SECRET_ID_SMTP>` | Secrets Manager name or ARN holding the Resend relay URL | AWS Secrets Manager |
| `<SECRET_ID_APPLE_SIGN_IN>` | Secrets Manager name or ARN holding `APPLE_SIGN_IN_PRIVATE_KEY`: the Sign in with Apple key `985BDXJP8S`'s `.p8` contents, on one line | AWS Secrets Manager |
| `<SECRET_ID_APPLE_TOKENS>` | Secrets Manager name or ARN holding `APPLE_TOKEN_ENCRYPTION_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`) | AWS Secrets Manager |
| `<COMMIT>` | The reviewed `main` commit being released | `git rev-parse HEAD` in a clean checkout |
| `<IMAGE>` | The name and tag the host-built image is given, which `TOGETHER_IMAGE` names | the build in step 2 |
| `<PREVIOUS_IMAGE>` | The image that was running before the switch | `/etc/together-ledger/previous-image` |

Commands nobody has written down yet, to be filled in from the host by whoever ran the
Oct 1 and Oct 8 releases:

| Placeholder | The step |
| --- | --- |
| `<OWNER: BUILD_COMMAND>` | Building the image on the host, and the tag it is given (step 2) |
| `<OWNER: DUMP_AND_LOAD_COMMANDS>` | Taking the `pg_dump` of live data and loading it into the throwaway container (step 3) |
| `<OWNER: REHEARSAL_RUN_COMMAND>` | Running the new image's `node server/migrate.js` against that container (step 3) |
| `<OWNER: CLEANUP_COMMANDS>` | Deleting the throwaway container and the dump (step 3) |
| `<OWNER: RECORD_PREVIOUS_IMAGE_COMMAND>` | Writing the running image into `/etc/together-ledger/previous-image` (step 5) |
| `<OWNER: SWITCH_COMMAND>` | Pointing `TOGETHER_IMAGE` at the new image, if a release changes it (step 6) |
| `<OWNER: RELEASE_LOG_LINE>` | The line appended to `/etc/together-ledger/release-log`, and its format (step 7) |
| `<OWNER: RUNNING_IMAGE_CHECK>` | Showing which image the app container is running (step 8) |

The registry values (`<AWS_ACCOUNT_ID>`, `<REGISTRY>`, `<ECR_REPOSITORY>`, `<DIGEST>`) belong to
the plan, and are listed there.

Do not paste a real value into an issue, a pull request, a commit, or a chat window. The
readiness gate treats a secret that appeared in any of those as burned.

## One-time setup

### 1. Create the production environment file

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

### 2. The release log and the rollback anchor

Two root-owned files on the host record what is running. Neither holds a secret, so either can be
read aloud during an incident.

- **`/etc/together-ledger/release-log`**: one line per release, appended in step 7. Started on
  2026-09-29. It records a tag rather than a digest, because no image has a registry digest
  (`PRODUCTION_READINESS.md`, #225). Its line format is `<OWNER: RELEASE_LOG_LINE>`.
- **`/etc/together-ledger/previous-image`**: the image that was running before the last switch,
  written in step 5. This is what a rollback returns to.

The earlier guide named the log `releases.log`. It is `release-log` on the host; use that name.

### 3. Preflight the host

```sh
cd <REPO_DIR> && ./scripts/verify-production-host.sh
```

Read-only. It deploys nothing and opens no port.

## Releasing

In order. Each step says whether #356 confirmed it was done this way.

### 1. Start from a clean reviewed checkout

*Carried over from the earlier guide.*

Build from the exact commit that CI passed, with nothing uncommitted. A dirty tree produces an
image that corresponds to no reviewed revision:

```sh
git fetch origin main
git checkout <COMMIT>
test -z "$(git status --porcelain)" || { echo "Working tree is dirty. Stop."; exit 1; }
npm ci && npm run check
```

### 2. Build the image on the host

*As done on Oct 1 and Oct 8 (#356).*

The image is built on the host, in `<REPO_DIR>` at `<COMMIT>`, and stays there. **Nothing is
pushed to a registry, and nothing is pulled.** No image has ever carried a registry digest
(#225).

```sh
<OWNER: BUILD_COMMAND>
```

The result is `<IMAGE>`, a local image. `compose.production.yaml` runs whatever `TOGETHER_IMAGE`
names, so that is the name the app container starts from.

**Never run `docker compose pull app` in a release.** It asks a registry for an image that was
never pushed there.

### 3. Rehearse the migrations on a throwaway copy of live data

*As done on Oct 1 and Oct 8 (#356). This replaces the earlier guide's
`--env-file /etc/together-ledger/preproduction.env --network together-preproduction`: neither
exists on the host.*

This is `OPERATIONS.md` release gate step 3. The migrations are run from **the image just built**
against a copy of production's data, never against production itself:

1. Start a temporary `postgres:16-alpine` container, the same PostgreSQL the production compose
   file runs.
2. Take a `pg_dump` of the live database and load it into that container.
3. Run `node server/migrate.js` from the new image against it, with
   - `DATABASE_URL` pointing at the temporary container, and
   - `NODE_ENV=development`. The image sets `production`, and in production the server refuses a
     `PUBLIC_ORIGIN` that isn't HTTPS. The rehearsal has no HTTPS origin and needs none: it only
     migrates.
4. Delete the temporary container, and the dump with it.

```sh
<OWNER: DUMP_AND_LOAD_COMMANDS>
<OWNER: REHEARSAL_RUN_COMMAND>
<OWNER: CLEANUP_COMMANDS>
```

The dump and the copy are live personal data. Keep them on the host, readable by root only, and
gone when the rehearsal is over. Never print a value from the environment file while doing this.

`node server/migrate.js` prints the migrations it applied and exits non-zero if any of them
fails. All migrations run in one transaction, so a failure leaves the copy on the schema it
started from.

Read the list. Then check each new migration against the rule in
[Rollback](#rollback): a release whose migrations are not additive cannot be undone by putting
the previous image back, and has to be planned as two releases instead of one.

### 4. Back up, and verify the backup

*As done on Oct 1 and Oct 8, matching the earlier guide (#356). This gates the switch.*

The pre-migration backup is the only thing that can undo a schema change, so take it before
anything moves:

```sh
sudo systemctl start together-ledger-backup.service
sudo /usr/local/lib/together-ledger/verify-production-recovery.sh
```

**Do not go on to the switch unless that passes.**

### 5. Record the rollback anchor

*As done on Oct 1 and Oct 8 (#356).*

Write the image running right now into `/etc/together-ledger/previous-image`. This is what a
rollback returns to:

```sh
<OWNER: RECORD_PREVIOUS_IMAGE_COMMAND>
```

The previous image exists only on this host. **Don't prune images while it is the rollback
anchor**, or there is nothing to roll back to.

### 6. Switch

*Carried over from the earlier guide, without its registry pull.*

On the host, in the reviewed checkout at the same commit. If the release changes what
`TOGETHER_IMAGE` names, change it first:

```sh
<OWNER: SWITCH_COMMAND>
sudo grep '^TOGETHER_IMAGE=' /etc/together-ledger/production.env
```

Then apply migrations as their own visible step, and start:

```sh
cd <REPO_DIR>
export COMPOSE="docker compose --env-file /etc/together-ledger/production.env -f compose.production.yaml"

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

### 7. Append the release to the log

*The log is `/etc/together-ledger/release-log` (#356).*

```sh
<OWNER: RELEASE_LOG_LINE>
```

One line: the UTC time, `<COMMIT>`, `<IMAGE>`, and the migrations the release applied, or none.

### 8. Confirm against production, not against the deploy

*Carried over from the earlier guide.*

Privately on the host first:

```sh
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE ps
```

Then from outside, over the real internet path, from a machine that is not the host:

```sh
curl -fsS https://api.together-ledger.com/healthz
curl -fsS https://api.together-ledger.com/readyz
```

`/readyz` answering `{"status":"ready"}` means the app reached PostgreSQL. It does **not** mean
the release you intended is the one running. Confirm on the host that the app container runs
`<IMAGE>`:

```sh
<OWNER: RUNNING_IMAGE_CHECK>
```

Finally, confirm the *change*. A health check proves a server is up; it proves nothing about
what merged. Exercise the thing the release added, with a synthetic account, never a real one.
The earlier guide's example, for the release that let a phone get a token instead of a cookie
(#179):

```sh
curl -fsS https://api.together-ledger.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -H 'x-together-client: app' \
  --data '{"email":"<SYNTHETIC_ACCOUNT_EMAIL>","password":"<SYNTHETIC_ACCOUNT_PASSWORD>"}' \
  | jq 'has("data") and (.data | has("token") and has("refreshToken"))'
```

A `404`, or a reply of the wrong shape, means the deploy did not land whatever the health check
says.

The API publishes no release marker, so unlike `app.together-ledger.com`, which serves
`release.json`, there is no way to ask production from outside which revision it is running.
Until there is, the image check above is a host-side check, and the behavioural probe is the only
outside evidence. Adding a revision to `/healthz` would close that gap; it is a change for its own
story.

### 9. Record it

Write down the UTC time, the commit, the migrations applied, the verification results, and
anything that did not go as written, and correct this document where it was wrong.

## Rollback

The Worker's rollback replaces a static bundle. This one does not: the container and its
database move together on the way forward, and only the container can move back.

### The rule that makes rollback possible

**A migration must be safe for the previous image to run against.** Add tables, add nullable
columns, add indexes. Do not drop, rename, or narrow anything in the same release that stops
writing to it. A change that must remove something is two releases — one that stops using it,
one that removes it — and the second cannot ship until the first is the version you would roll
back to.

When a release breaks the rule, say so in the release log line, and accept that its rollback is
a database restore rather than an image change.

### Returning to the previous image

*The anchor is the previous local image in `/etc/together-ledger/previous-image` (#356). The
steps around it are carried over from the earlier guide, without its registry pull.*

No data loss, provided the rule above held.

1. Record first: the failing image, UTC time, symptoms, and whether writes may have landed.
   Delete nothing — not volumes, logs, backups, images, or the database.

   ```sh
   sudo tail -5 /etc/together-ledger/release-log
   ```

   `/etc/together-ledger/previous-image` names the image to return to.

2. Point `TOGETHER_IMAGE` back at `<PREVIOUS_IMAGE>`, the same way step 6 points it forward
   (`<OWNER: SWITCH_COMMAND>`).
3. Start that image. PostgreSQL keeps running; only the app container is replaced.

   ```sh
   cd <REPO_DIR>
   TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE up -d app
   ```

4. Verify privately, then from outside, then one synthetic account flow.

   ```sh
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

*Not done yet.* The readiness gate asks for a rollback rehearsal without production user data:

1. Restore a synthetic-data backup into an isolated database.
2. Run image A there, with a synthetic environment file.
3. Run image B (the newer commit) and its migrations.
4. Return to image A, and confirm it starts and serves against the newer schema.
5. Record how long steps 2 to 4 took. That number is the rollback budget during an incident.

Only after that rehearsal passes should the Deployment and Recoverability items in
`PRODUCTION_READINESS.md` be ticked.

## Planned, not yet done

**Nothing in this section has been run on the host. These are plans, not steps.** They are kept
because they are still wanted (#225): an image pushed to a registry and deployed by its immutable
digest, a scan read before each release, a pre-production copy that releases pass through, and a
rollback by digest. When any of them is first done, move it into [Releasing](#releasing) and
record the date.

Registry values, for when the plan is carried out:

| Placeholder | What it is | Where it comes from |
| --- | --- | --- |
| `<AWS_ACCOUNT_ID>` | The AWS account that holds the registry and the host | AWS console |
| `<REGISTRY>` | `<AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com` | derived from the account and region |
| `<ECR_REPOSITORY>` | The repository name inside that registry | AWS console; one already exists |
| `<DIGEST>` | The immutable image digest a push reports | printed by the build |
| `<PREVIOUS_DIGEST>` | The digest a rollback would return to | the release log |

### Plan: Amazon ECR

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

#### Creating or confirming the repository

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

**Pulling needs the host to reach ECR with its own AWS credentials.** Since Oct 1, the `aws`
that runs under `sudo` on the host is the IAM role `together-ledger-host-image-pull` (see
[Adding the two Sign in with Apple values](#adding-the-two-sign-in-with-apple-values-218)), but
nothing has ever been pulled with it. Until an image is pushed and pulled, an image tagged with a
registry address is a local build wearing a registry's name: the state the 2026-09-29 survey
found, and still the state today.

Give the host an IAM principal that can pull from this one repository and nothing else
(`ecr:GetAuthorizationToken`, plus `ecr:BatchGetImage` and
`ecr:GetDownloadUrlForLayer` on this repository's ARN). It must not be able to push, delete, or
read any other repository. Keep its credential in a root-owned mode-0600 file on the host, as
the backup uploader's credential already is.

#### Building, pushing and recording the digest

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

#### Reading the scan before deciding

```sh
aws ecr describe-image-scan-findings \
  --repository-name <ECR_REPOSITORY> \
  --region <AWS_REGION> \
  --image-id imageDigest="$DIGEST" \
  --query '{status: imageScanStatus.status, counts: imageScanFindings.findingSeverityCounts}'
```

`status` must be `COMPLETE`. A scan that is missing, `IN_PROGRESS`, or `FAILED` is not a clean
scan — see *Container scan evidence* in `OPERATIONS.md`. Record the counts and the decision; do
not publish the registry address or the digest outside the host and the release log.

#### Deploying and rolling back by digest

Step 6 would point the environment file at the digest, never a tag, and pull it:

```sh
sudo sh -c 'umask 077; sed -i "s|^TOGETHER_IMAGE=.*|TOGETHER_IMAGE=<REGISTRY>/<ECR_REPOSITORY>@<DIGEST>|" /etc/together-ledger/production.env'
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE pull app
```

Step 8 would confirm the running digest:

```sh
TOGETHER_ENV_FILE=/etc/together-ledger/production.env $COMPOSE ps -q app \
  | xargs docker inspect --format '{{index .RepoDigests 0}}'
```

A rollback would point `TOGETHER_IMAGE` at `<REGISTRY>/<ECR_REPOSITORY>@<PREVIOUS_DIGEST>`, pull,
and `up -d app`. The release log would record the digest instead of a tag.

### Plan: a pre-production copy

Migrations would be rehearsed on a standing pre-production database that releases pass through,
rather than on a throwaway container. Neither the environment file nor the network below exists
on the host:

```sh
docker run --rm \
  --env-file /etc/together-ledger/preproduction.env \
  --network together-preproduction \
  <REGISTRY>/<ECR_REPOSITORY>@<DIGEST> \
  node server/migrate.js
```

Until it exists, step 3's throwaway copy is the rehearsal.

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
