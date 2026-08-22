#!/usr/bin/env sh
set -eu
umask 077

: "${GCP_BACKUP_BUCKET:?Set GCP_BACKUP_BUCKET in the root-owned backup uploader file}"
: "${GOOGLE_APPLICATION_CREDENTIALS:?Set GOOGLE_APPLICATION_CREDENTIALS in the root-owned backup uploader file}"
: "${GCP_BACKUP_SERVICE_ACCOUNT:?Set GCP_BACKUP_SERVICE_ACCOUNT in the root-owned backup uploader file}"

if [ ! -r "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "GCP backup uploader credential is not readable by this user" >&2
  exit 1
fi

command -v gcloud >/dev/null || { echo "gcloud is required for the offsite backup upload" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 700 /var/lib/together-ledger
gcloud_config=$(mktemp -d /var/lib/together-ledger/gcloud.XXXXXX)
trap 'rm -rf "$gcloud_config"' EXIT HUP INT TERM
export CLOUDSDK_CONFIG="$gcloud_config"
gcloud auth activate-service-account "$GCP_BACKUP_SERVICE_ACCOUNT" \
  --key-file "$GOOGLE_APPLICATION_CREDENTIALS" --quiet >/dev/null
archive=$("$script_dir/backup-postgres.sh")
sidecar="$archive.sha256"

[ -f "$sidecar" ] || { echo "backup checksum sidecar was not written" >&2; exit 1; }
sha256sum -c "$sidecar" >/dev/null
gcloud storage cp --account "$GCP_BACKUP_SERVICE_ACCOUNT" \
  "$archive" "$sidecar" "gs://$GCP_BACKUP_BUCKET/"

receipt_dir=/var/lib/together-ledger
receipt="$receipt_dir/last-offsite-backup.env"
checksum=$(sha256sum "$archive" | awk '{print $1}')
{
  printf 'BACKUP_FILE=%s\n' "$(basename "$archive")"
  printf 'BACKUP_SHA256=%s\n' "$checksum"
  printf 'UPLOADED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$receipt"
chmod 600 "$receipt"
printf '%s\n' "$archive"
