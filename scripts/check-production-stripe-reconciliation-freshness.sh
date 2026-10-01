#!/usr/bin/env sh
# Fails if no Stripe reconciliation run has succeeded within the last 8
# hours, independent of whether the scheduled reconciliation job itself is
# currently running. Catches the case where the timer stopped firing rather
# than only the case where a run failed.
set -eu

: "${TOGETHER_ENV_FILE:?Set TOGETHER_ENV_FILE to the root-owned production environment file}"

if [ ! -r "$TOGETHER_ENV_FILE" ]; then
  echo "production environment file is not readable by this user" >&2
  exit 1
fi

command -v docker >/dev/null || { echo "docker is required to check reconciliation freshness" >&2; exit 1; }
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec docker compose --env-file "$TOGETHER_ENV_FILE" -f "$repo_dir/compose.production.yaml" \
  exec -T app node scripts/check-stripe-reconciliation-freshness.mjs
