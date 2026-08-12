#!/usr/bin/env sh
# Read-only preflight for the Together Ledger production host.
# Run on the server before exposing the deployment on ports 80 and 443.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
failed=0

pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failed=1; }

command -v docker >/dev/null 2>&1 \
  && pass "Docker is installed" \
  || fail "Docker is not installed"

docker compose version >/dev/null 2>&1 \
  && pass "Docker Compose is installed" \
  || fail "Docker Compose is not available"

test -f "$repo_dir/compose.production.yaml" \
  && pass "production Compose file is present" \
  || fail "compose.production.yaml is missing"

test -f "$repo_dir/Caddyfile" \
  && pass "Caddy configuration is present" \
  || fail "Caddyfile is missing"

if test -f "$repo_dir/compose.production.yaml"; then
  if grep -Eq '5432:5432|4174:4174|mailpit' "$repo_dir/compose.production.yaml"; then
    fail "production Compose file exposes a private service"
  else
    pass "PostgreSQL and application ports are not published"
  fi
fi

if command -v ufw >/dev/null 2>&1; then
  ufw_status=$(sudo -n ufw status verbose 2>/dev/null || true)
  if printf '%s' "$ufw_status" | grep -q 'Status: active'; then
    pass "UFW host firewall is active"
  else
    warn "could not confirm UFW is active (run: sudo ufw status verbose)"
  fi
else
  warn "UFW is not installed; confirm equivalent host firewall rules"
fi

if command -v ss >/dev/null 2>&1; then
  listeners=$(ss -ltn 2>/dev/null || true)
  if printf '%s' "$listeners" | grep -Eq ':(5432|4174)([^0-9]|$)'; then
    fail "a private database or application port is already listening on the host"
  else
    pass "no host listener detected on private ports 5432 or 4174"
  fi
fi

if test "$failed" -ne 0; then
  printf '\nPreflight failed. Do not open ports 80/443 or point DNS at this host.\n' >&2
  exit 1
fi

printf '\nPreflight passed. This does not deploy the app or open any network port.\n'
