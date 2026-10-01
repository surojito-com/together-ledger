#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run this installer with sudo" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
install -d -o root -g root -m 700 /etc/together-ledger

if [ ! -f /etc/together-ledger/alert-webhook.env ]; then
  alert_temporary=$(mktemp /etc/together-ledger/.alert-webhook.XXXXXX)
  trap 'rm -f "$alert_temporary"' EXIT HUP INT TERM
  umask 077
  printf 'ALERT_WEBHOOK_URL=https://replace-with-your-on-call-webhook\n' > "$alert_temporary"
  install -o root -g root -m 600 "$alert_temporary" /etc/together-ledger/alert-webhook.env
  rm -f "$alert_temporary"
  trap - EXIT HUP INT TERM
  echo "Wrote a placeholder /etc/together-ledger/alert-webhook.env -- set ALERT_WEBHOOK_URL before relying on alerts."
fi

install -d -m 700 /usr/local/lib/together-ledger
install -o root -g root -m 700 "$repo_dir/scripts/run-production-stripe-reconciliation.sh" /usr/local/lib/together-ledger/run-production-stripe-reconciliation.sh
install -o root -g root -m 700 "$repo_dir/scripts/check-production-stripe-reconciliation-freshness.sh" /usr/local/lib/together-ledger/check-production-stripe-reconciliation-freshness.sh
install -o root -g root -m 700 "$repo_dir/scripts/alert-on-call.sh" /usr/local/lib/together-ledger/alert-on-call.sh
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-stripe-reconciliation.service" /etc/systemd/system/together-ledger-stripe-reconciliation.service
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-stripe-reconciliation.timer" /etc/systemd/system/together-ledger-stripe-reconciliation.timer
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-stripe-reconciliation-freshness.service" /etc/systemd/system/together-ledger-stripe-reconciliation-freshness.service
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-stripe-reconciliation-freshness.timer" /etc/systemd/system/together-ledger-stripe-reconciliation-freshness.timer
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-alert@.service" "/etc/systemd/system/together-ledger-alert@.service"
systemctl daemon-reload
printf '%s\n' "Stripe reconciliation timer files installed. Set ALERT_WEBHOOK_URL, run one manual reconciliation pass, then enable the timers:"
printf '%s\n' "  sudo systemctl enable --now together-ledger-stripe-reconciliation.timer together-ledger-stripe-reconciliation-freshness.timer"
