#!/usr/bin/env sh
set -eu
umask 077

production_env_file=${TOGETHER_ENV_FILE:-/etc/together-ledger/production.env}
recipient_file=${BACKUP_RECIPIENT_FILE:-/etc/together-ledger/backup-recipient.env}
runtime_file=${BACKUP_RUNTIME_FILE:-/etc/together-ledger/backup-runtime.env}
backup_dir=${BACKUP_DIR:-/var/backups/together-ledger}
receipt=${OFFSITE_RECEIPT_FILE:-/var/lib/together-ledger/last-offsite-backup.env}
max_age_hours=${BACKUP_MAX_AGE_HOURS:-26}

if [ "$(id -u)" -ne 0 ]; then
  echo "run this recovery verification with sudo; do not loosen protected-file permissions" >&2
  exit 1
fi

require_root_file() {
  path=$1
  label=$2
  [ -f "$path" ] || { echo "$label is missing" >&2; exit 1; }
  [ "$(stat -c '%U' "$path")" = root ] || { echo "$label must be owned by root" >&2; exit 1; }
  [ "$(stat -c '%a' "$path")" = 600 ] || { echo "$label must have mode 0600" >&2; exit 1; }
}

read_field() {
  field=$1
  file=$2
  value=$(sed -n "s/^$field=//p" "$file")
  if [ "$(printf '%s\n' "$value" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "$file must contain exactly one $field value" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

require_root_file "$production_env_file" "production environment file"
require_root_file "$recipient_file" "backup recipient file"
require_root_file "$runtime_file" "backup runtime file"
require_root_file "$receipt" "offsite backup receipt"
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }

recipient=$(read_field AGE_RECIPIENT "$recipient_file")
age -r "$recipient" -o /dev/null < /dev/null
repo_dir=$(read_field TOGETHER_REPO_DIR "$runtime_file")
[ -f "$repo_dir/compose.production.yaml" ] || { echo "backup runtime file does not point to a production Compose file" >&2; exit 1; }

latest=$(find "$backup_dir" -maxdepth 1 -type f -name 'together-ledger-*.dump.age' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
[ -n "$latest" ] || { echo "no encrypted database backup exists" >&2; exit 1; }
sidecar="$latest.sha256"
[ -f "$sidecar" ] || { echo "newest encrypted backup has no checksum sidecar" >&2; exit 1; }
sha256sum -c "$sidecar" >/dev/null

age_minutes=$((max_age_hours * 60))
if ! find "$latest" -mmin -"$age_minutes" -print -quit | grep -q .; then
  echo "newest encrypted backup is older than ${max_age_hours} hours" >&2
  exit 1
fi

expected_file=$(read_field BACKUP_FILE "$receipt")
expected_checksum=$(read_field BACKUP_SHA256 "$receipt")
actual_checksum=$(sha256sum "$latest" | awk '{print $1}')
if [ "$(basename "$latest")" != "$expected_file" ] || [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "newest encrypted backup has no matching offsite upload receipt" >&2
  exit 1
fi

printf '%s\n' "Recovery preflight passed: current encrypted backup and offsite upload receipt agree."
