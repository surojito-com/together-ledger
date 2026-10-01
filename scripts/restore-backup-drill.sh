#!/usr/bin/env sh
# Restore drill for one encrypted backup (docs/OPERATIONS.md, "Restore drill"; #254).
#
#   scripts/restore-backup-drill.sh <together-ledger-…dump.age> <age identity file>
#
# Run it away from the production host: the age identity must never be on that machine. It checks
# the backup against the .sha256 file downloaded beside it, decrypts it straight into pg_restore,
# and restores it into a throwaway PostgreSQL 16 container that is removed when the script exits
# (or into DRILL_DATABASE_URL, an empty database you made for the drill). It prints only counts:
# the migrations the backup carries and how many rows each table holds, never a row itself.
set -eu
umask 077

archive=${1:-}
identity=${2:-}
if [ -z "$archive" ] || [ -z "$identity" ]; then
  echo "usage: $0 <backup .dump.age file> <age identity file>" >&2
  exit 2
fi
[ -f "$archive" ] || { echo "backup file not found" >&2; exit 1; }
[ -r "$identity" ] || { echo "age identity file is not readable" >&2; exit 1; }
sidecar="$archive.sha256"
[ -f "$sidecar" ] || { echo "download the .sha256 file that sits beside the backup in the bucket, into the same folder" >&2; exit 1; }
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }

# The sidecar names the file by its path on the host, so compare the hash rather than the path.
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
expected=$(awk 'NR == 1 {print $1}' "$sidecar")
if [ "$actual" != "$expected" ]; then
  echo "backup does not match its .sha256 file; it is damaged or not the file the host uploaded" >&2
  exit 1
fi

count_sql="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
migrations_sql="SELECT count(*) || ' migrations, newest ' || max(name) FROM schema_migrations"

if [ -n "${DRILL_DATABASE_URL:-}" ]; then
  command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
  command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
  existing=$(psql "$DRILL_DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
  [ "$existing" = 0 ] || { echo "DRILL_DATABASE_URL must point at an empty database" >&2; exit 1; }
  age -d -i "$identity" "$archive" | pg_restore --exit-on-error --no-owner --no-privileges -d "$DRILL_DATABASE_URL"
  run_sql() { psql "$DRILL_DATABASE_URL" -Atc "$1"; }
else
  command -v docker >/dev/null || { echo "docker is required, or set DRILL_DATABASE_URL to an empty database" >&2; exit 1; }
  container="together-ledger-restore-drill-$$"
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT HUP INT TERM
  docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill postgres:16-alpine >/dev/null
  tries=0
  until docker exec "$container" pg_isready -U postgres -d drill >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo "the drill database did not start" >&2; exit 1; }
    sleep 1
  done
  age -d -i "$identity" "$archive" | docker exec -i "$container" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d drill
  run_sql() { docker exec "$container" psql -U postgres -d drill -Atc "$1"; }
fi

tables=$(run_sql "$count_sql")
[ -n "$tables" ] || { echo "the restored database has no tables" >&2; exit 1; }
migrations=$(run_sql "$migrations_sql")
printf '%s\n' "$tables"
printf 'Restore drill passed: %s restored, %s, %s tables.\n' "$(basename "$archive")" "$migrations" "$(printf '%s\n' "$tables" | wc -l | tr -d ' ')"
