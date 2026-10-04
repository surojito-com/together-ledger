#!/usr/bin/env sh
# Generic on-call notifier invoked by a systemd OnFailure= unit. Posts the
# failed unit's name only -- no error text, credentials, or provider
# identifiers -- to an operator-configured webhook (Slack incoming webhook,
# PagerDuty Events API, or any endpoint that accepts a JSON POST).
set -eu

: "${ALERT_WEBHOOK_URL:?Set ALERT_WEBHOOK_URL in the root-owned alert webhook file}"
unit="${1:?Pass the failed systemd unit name as the first argument}"

command -v curl >/dev/null || { echo "curl is required to send the on-call alert" >&2; exit 1; }

payload=$(printf '{"text":"together-ledger: %s failed on %s at %s"}' \
  "$unit" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")

curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null
