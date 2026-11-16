#!/usr/bin/env bash
# Structural guard for docker-compose.demo.yml's per-install secrets (#4946).
#
# Two properties hold only by convention otherwise:
#   1. Overriding `entrypoint` makes Compose drop the image's CMD, so `api`
#      restates it as `command:`. That copy must equal packages/api/Dockerfile's CMD.
#   2. Every API-image service except `secrets-init` must run the shared
#      secrets entrypoint AND mount `demo_secrets:/secrets:ro`; a service missing
#      either boots with no SECRET_KEY (or, worse, a stale one).
#
# Usage: bash scripts/check-demo-compose-secrets.sh [--self-test]
# Env:   COMPOSE_FILE, DOCKERFILE override the guarded files (self-test uses them).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check() {
  local compose="$1" dockerfile="$2" rc=0 want got
  want="$(sed -n 's/^CMD[[:space:]]*\[\(.*\)\][[:space:]]*$/\1/p' "$dockerfile" | tr -d '[:space:]"')"
  got="$(awk '/^  api:[[:space:]]*$/{s=1;next} /^  [A-Za-z0-9_-]+:[[:space:]]*$/{s=0} s&&/^    command:[[:space:]]*\[/{print}' "$compose" \
    | sed 's/^[^[]*\[\(.*\)\].*$/\1/' | tr -d '[:space:]"')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "VIOLATION: api.command in $compose ('${got}') does not equal the Dockerfile CMD ('${want}')" >&2
    rc=1
  fi
  # The expected API-image services must each be found AND inspected; an image
  # rename would otherwise leave the awk below matching nothing and passing.
  for svc in api-init demo-seed api; do
    if ! awk -v n="$svc" '$0 ~ "^  " n ":[[:space:]]*$" {s=1;next} /^  [A-Za-z0-9_-]+:[[:space:]]*$/{s=0} s{l=$0; sub(/(^|[[:space:]])#.*/,"",l)} s&&l ~ /image:.*trueppm\/api/{f=1} END{exit !f}' "$compose"; then
      echo "VIOLATION: expected API-image service '$svc' not found (or no trueppm/api image) in $compose" >&2
      rc=1
    fi
  done
  # One line per API-image service: name, has-entrypoint, has-mount.
  awk '
    function flush() { if (name != "" && api && name != "secrets-init") print name, ep, mnt }
    /^services:/ { ins=1; next }
    /^[a-z]/ && !/^services:/ { flush(); name=""; ins=0 }
    ins && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { flush(); name=$1; sub(":","",name); api=0; ep=0; mnt=0; next }
    { l=$0; sub(/(^|[[:space:]])#.*/,"",l) }
    ins && l ~ /image:.*trueppm\/api/ { api=1 }
    ins && l ~ /^    <<:.*\*secrets-entrypoint/ { ep=1 }
    ins && l ~ /^      - demo_secrets:\/secrets:ro/ { mnt=1 }
    END { flush() }
  ' "$compose" | while read -r svc ep mnt; do
    [ "$ep" = 1 ] || { echo "VIOLATION: service '$svc' does not use *secrets-entrypoint" >&2; echo bad; }
    [ "$mnt" = 1 ] || { echo "VIOLATION: service '$svc' does not mount demo_secrets:/secrets:ro" >&2; echo bad; }
  done > "${TMPDIR:-/tmp}/.demo-secrets.$$" 2>&1 || true
  if grep -q VIOLATION "${TMPDIR:-/tmp}/.demo-secrets.$$"; then
    grep VIOLATION "${TMPDIR:-/tmp}/.demo-secrets.$$" >&2
    rc=1
  fi
  rm -f "${TMPDIR:-/tmp}/.demo-secrets.$$"
  return "$rc"
}

# docker-compose.yml (the dev stack, #4672): no service may pin a literal
# SECRET_KEY, and api/celery/celery-beat must each mount dev_secrets and wait for
# secrets-init, or they boot on the image's baked default key.
check_dev() {
  local compose="$1" rc=0 svc
  if grep -Eq '^[[:space:]]*SECRET_KEY:[[:space:]]*[^$[:space:]#]' "$compose"; then
    echo "VIOLATION: $compose pins a literal SECRET_KEY; it must come from secrets-init" >&2
    rc=1
  fi
  for svc in secrets-init api celery celery-beat; do
    awk -v n="$svc" '$0 ~ "^  " n ":[[:space:]]*$" {f=1} END{exit !f}' "$compose" \
      || { echo "VIOLATION: service '$svc' not found in $compose" >&2; rc=1; }
  done
  for svc in api celery celery-beat; do
    awk -v n="$svc" '
      $0 ~ "^  " n ":[[:space:]]*$" {s=1; next}
      /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {s=0}
      /^[a-z]/ {s=0}
      { l=$0; sub(/(^|[[:space:]])#.*/,"",l) }
      s && l ~ /^      - dev_secrets:\/secrets:ro/ {m=1}
      s && l ~ /^      secrets-init:/ {d=1}
      END { exit !(m && d) }' "$compose" \
      || { echo "VIOLATION: dev service '$svc' must mount dev_secrets:/secrets:ro and depend on secrets-init" >&2; rc=1; }
  done
  return "$rc"
}

self_test() {
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf 'FROM x\nCMD ["uvicorn", "a:b", "--port", "8000"]\n' > "$tmp/Dockerfile"
  good() { cat <<'Y'
services:
  secrets-init:
    image: ghcr.io/trueppm/api:latest
  api-init:
    <<: [*logging, *secrets-entrypoint]
    image: ghcr.io/trueppm/api:latest
    volumes:
      - demo_secrets:/secrets:ro
  demo-seed:
    <<: [*logging, *secrets-entrypoint]
    image: ghcr.io/trueppm/api:latest
    volumes:
      - demo_secrets:/secrets:ro
  api:
    <<: [*logging, *secrets-entrypoint]
    image: ghcr.io/trueppm/api:latest
    command: ["uvicorn", "a:b", "--port", "8000"]
    volumes:
      - demo_secrets:/secrets:ro
  db:
    image: postgres:16
volumes:
  demo_secrets:
Y
  }
  good > "$tmp/c.yml"
  check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: compliant fixture rejected" >&2; return 1; }
  good | sed 's/--port", "8000"/--port", "9000"/' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: drifted CMD not caught" >&2; return 1; }
  good | awk '/api-init:/{s=1} s&&/demo_secrets:\/secrets:ro/{s=0;next} {print}' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: missing mount not caught" >&2; return 1; }
  good | awk '/^  api-init:/{s=1} s&&/secrets-entrypoint/{s=0;next} {print}' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: missing entrypoint not caught" >&2; return 1; }
  good | sed 's#trueppm/api#trueppm/server#' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: renamed API image not caught" >&2; return 1; }
  good | awk '/^  api-init:/{s=1} s&&/<<:/{print "    <<: *logging"; print "    # was <<: [*logging, *secrets-entrypoint]"; s=0; next} {print}' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: entrypoint present only in a comment not caught" >&2; return 1; }
  good | awk '/^  api-init:/{s=1} s&&/<<:/{print "    <<: *logging  # *secrets-entrypoint"; s=0; next} {print}' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: trailing-comment entrypoint not caught" >&2; return 1; }
  good | awk '/^  api-init:/{s=1} s&&/demo_secrets:\/secrets:ro/{print "      # - demo_secrets:/secrets:ro"; s=0; next} {print}' > "$tmp/c.yml"
  ! check "$tmp/c.yml" "$tmp/Dockerfile" 2>/dev/null || { echo "SELF-TEST FAIL: commented-out mount not caught" >&2; return 1; }
  cat > "$tmp/dev.yml" <<'Y'
services:
  secrets-init:
    image: x
  api:
    volumes:
      - dev_secrets:/secrets:ro
    depends_on:
      secrets-init:
        condition: service_completed_successfully
  celery:
    volumes:
      - dev_secrets:/secrets:ro
    depends_on:
      secrets-init:
        condition: service_completed_successfully
  celery-beat:
    volumes:
      - dev_secrets:/secrets:ro
    depends_on:
      secrets-init:
        condition: service_completed_successfully
Y
  check_dev "$tmp/dev.yml" 2>/dev/null || { echo "SELF-TEST FAIL: compliant dev fixture rejected" >&2; return 1; }
  sed 's/^  celery:/  celery:\n    environment:\n      SECRET_KEY: dev-secret-key-change-in-prod/' "$tmp/dev.yml" > "$tmp/d.yml"
  ! check_dev "$tmp/d.yml" 2>/dev/null || { echo "SELF-TEST FAIL: literal dev SECRET_KEY not caught" >&2; return 1; }
  awk '/dev_secrets/ && !d {d=1; next} {print}' "$tmp/dev.yml" > "$tmp/d.yml"
  ! check_dev "$tmp/d.yml" 2>/dev/null || { echo "SELF-TEST FAIL: dev service missing the secrets mount not caught" >&2; return 1; }
  echo "SELF-TEST OK: compliant fixture passes; drifted CMD, missing mount, missing entrypoint, renamed image and comment-only entrypoint are each caught."
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi
check "${COMPOSE_FILE:-$REPO_ROOT/docker-compose.demo.yml}" "${DOCKERFILE:-$REPO_ROOT/packages/api/Dockerfile}"
check_dev "${DEV_COMPOSE_FILE:-$REPO_ROOT/docker-compose.yml}"
echo "OK: docker-compose.demo.yml api command matches the Dockerfile CMD; every API-image service sources and mounts the demo secrets."
