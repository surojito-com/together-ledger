#!/usr/bin/env sh
set -eu
umask 077

: "${TOGETHER_ENV_FILE:?Set TOGETHER_ENV_FILE to the root-owned production environment file}"
export TOGETHER_ENV_FILE

if [ -n "${BACKUP_RECIPIENT_FILE:-}" ]; then
  if [ -n "${AGE_RECIPIENT:-}" ]; then
    echo "set either BACKUP_RECIPIENT_FILE or AGE_RECIPIENT, not both" >&2
    exit 1
  fi
  if [ ! -r "$BACKUP_RECIPIENT_FILE" ]; then
    echo "backup recipient file is not readable by this user" >&2
    echo "run this backup with the account permitted to read it; do not loosen its permissions" >&2
    exit 1
  fi
  AGE_RECIPIENT=$(sed -n 's/^AGE_RECIPIENT=//p' "$BACKUP_RECIPIENT_FILE")
  if [ "$(printf '%s\n' "$AGE_RECIPIENT" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "backup recipient file must contain exactly one AGE_RECIPIENT value" >&2
    exit 1
  fi
fi
: "${AGE_RECIPIENT:?Set BACKUP_RECIPIENT_FILE to the root-owned recipient file}"

if [ ! -r "$TOGETHER_ENV_FILE" ]; then
  echo "production environment file is not readable by this user" >&2
  echo "run this backup with the account permitted to read it; do not loosen its permissions" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=${TOGETHER_REPO_DIR:-$(CDPATH= cd -- "$script_dir/.." && pwd)}
if [ ! -f "$repo_dir/compose.production.yaml" ]; then
  echo "production Compose file is missing from TOGETHER_REPO_DIR" >&2
  echo "reinstall the production recovery service from the reviewed production checkout" >&2
  exit 1
fi
backup_dir=${BACKUP_DIR:-/var/backups/together-ledger}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/together-ledger-$timestamp.dump.age"
temporary="$target.partial"
stream="$backup_dir/.together-ledger-$timestamp.dump.fifo"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }
mkdir -p "$backup_dir"
trap 'rm -f "$temporary" "$stream"' EXIT HUP INT TERM
mkfifo "$stream"

docker compose --env-file "$TOGETHER_ENV_FILE" -f "$repo_dir/compose.production.yaml" \
  exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$stream" &
dump_pid=$!

if age -r "$AGE_RECIPIENT" -o "$temporary" < "$stream"; then
  age_status=0
else
  age_status=$?
fi

if wait "$dump_pid"; then
  dump_status=0
else
  dump_status=$?
fi

if [ "$age_status" -ne 0 ] || [ "$dump_status" -ne 0 ]; then
  echo "database backup was not written; encrypted output was discarded" >&2
  exit 1
fi

mv "$temporary" "$target"
trap - EXIT HUP INT TERM
rm -f "$stream"
sha256sum "$target" > "$target.sha256"
printf '%s\n' "$target"
