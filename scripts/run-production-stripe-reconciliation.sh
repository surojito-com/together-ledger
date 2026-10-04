#!/usr/bin/env sh
# Runs a scheduled Stripe reconciliation pass inside the already-running
# production app container. Exit status is propagated unchanged: 0 means
# reconciliation completed with nothing to review, 2 means it completed but
# an operator must inspect a duplicate Customer or failed webhook row, and 1
# means the run itself failed (including a refused overlapping run).
set -eu

: "${TOGETHER_ENV_FILE:?Set TOGETHER_ENV_FILE to the root-owned production environment file}"

if [ ! -r "$TOGETHER_ENV_FILE" ]; then
  echo "production environment file is not readable by this user" >&2
  exit 1
fi

command -v docker >/dev/null || { echo "docker is required to run reconciliation" >&2; exit 1; }
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec docker compose --env-file "$TOGETHER_ENV_FILE" -f "$repo_dir/compose.production.yaml" \
  exec -T app npm run reconcile:stripe -- --scheduled
