#!/usr/bin/env sh
set -eu
umask 077

: "${TOGETHER_ENV_FILE:?Set TOGETHER_ENV_FILE to the root-owned production environment file}"
: "${AGE_RECIPIENT:?Set AGE_RECIPIENT to the public age recipient used for backup encryption}"
export TOGETHER_ENV_FILE

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
backup_dir=${BACKUP_DIR:-/var/backups/together-ledger}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/together-ledger-$timestamp.dump.age"
temporary="$target.partial"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }
mkdir -p "$backup_dir"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

docker compose --env-file "$TOGETHER_ENV_FILE" -f "$repo_dir/compose.production.yaml" \
  exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  | age -r "$AGE_RECIPIENT" -o "$temporary"
mv "$temporary" "$target"
trap - EXIT HUP INT TERM
sha256sum "$target" > "$target.sha256"
printf '%s\n' "$target"
