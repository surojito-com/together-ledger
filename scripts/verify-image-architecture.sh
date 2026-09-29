#!/usr/bin/env sh
# Refuses an image built for a different architecture than the machine about to run it.
# Run on the host after `compose pull` and before migrations or `up`, so a mismatched image is
# stopped before it touches the database rather than rejected afterwards.
#
#   ./scripts/verify-image-architecture.sh <REGISTRY>/<ECR_REPOSITORY>@<DIGEST>
#
# EXPECTED_ARCH overrides the host's own architecture, for checking an image on a machine that
# is not the one it will run on (for example `EXPECTED_ARCH=amd64` on an arm64 workstation).
set -eu

image="${1:?Pass the image reference to check, by digest}"

if [ -n "${EXPECTED_ARCH:-}" ]; then
  expected="$EXPECTED_ARCH"
else
  machine=$(uname -m)
  case "$machine" in
    x86_64 | amd64) expected=amd64 ;;
    aarch64 | arm64) expected=arm64 ;;
    *)
      echo "FAIL  this machine reports an architecture this check does not know: $machine" >&2
      exit 1
      ;;
  esac
fi

if ! platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image" 2>/dev/null); then
  echo "FAIL  the image is not present locally; pull it first, then check it" >&2
  exit 1
fi

if [ "$platform" != "linux/$expected" ]; then
  echo "FAIL  image is $platform but this release needs linux/$expected; do not start it" >&2
  exit 1
fi

printf 'PASS  image is %s, matching linux/%s\n' "$platform" "$expected"
