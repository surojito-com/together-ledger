#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run this installer with sudo" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
install -d -m 700 /usr/local/lib/together-ledger
install -o root -g root -m 700 "$repo_dir/scripts/backup-postgres.sh" /usr/local/lib/together-ledger/backup-postgres.sh
install -o root -g root -m 700 "$repo_dir/scripts/run-production-backup.sh" /usr/local/lib/together-ledger/run-production-backup.sh
install -o root -g root -m 700 "$repo_dir/scripts/verify-production-recovery.sh" /usr/local/lib/together-ledger/verify-production-recovery.sh
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-backup.service" /etc/systemd/system/together-ledger-backup.service
install -o root -g root -m 644 "$repo_dir/ops/together-ledger-backup.timer" /etc/systemd/system/together-ledger-backup.timer
systemctl daemon-reload
printf '%s\n' "Recovery timer files installed. Run one verified backup before enabling the timer."
