#!/usr/bin/env bash
# Production docker-compose boot drill (#2817).
#
# The runtime half of the prod-compose completeness work (#2804, !1945). That MR
# made the documented single-server path bootable — celery-beat, the boot guards,
# the certbot profile — but every fix was verified by `docker compose config`
# rendering and unit-level contract tests. Nothing actually started the stack, so
# the whole class stays one edit away from regressing silently: a compose file can
# render perfectly and still crash-loop, and a service can be declared and never
# heartbeat.
#
# This is the compose counterpart to scripts/helm-install-drill.sh (#2279), which
# already caught a real deploy regression (#2283). It boots the UNMODIFIED
# docker-compose.prod.yml through the UNMODIFIED init-prod.sh — the exact two
# artefacts the deployment docs tell an operator to run — from a .env filled the
# way deployment.md's "Required minimums" block says to fill it, and proves:
#
#   1. api-init completes: migrate + collectstatic + create_admin all succeed;
#   2. the api container clears every settings.prod import-time boot guard —
#      SECRET_KEY (#566), INTEGRATION_ENCRYPTION_KEY (#1002), the
#      attachment-storage choice (#775) — rather than crash-looping on one;
#   3. GET /api/v1/readyz reports ready through nginx (the real ingress path,
#      not a container-internal probe);
#   4. GET /api/v1/health/beat/ returns 200, which proves the celery-beat service
#      #2804 added actually dispatches CELERY_BEAT_SCHEDULE — the endpoint reads a
#      row only the beat.heartbeat task writes, so a declared-but-dead beat is a
#      503 here and a green `compose config` everywhere else;
#   5. the stack survives `docker compose restart api`.
#
# HEAD code, not the last release: ci:build-deploy-images (#2284) builds api/web
# from the commit under test and tags them $CI_COMMIT_SHA; this script retags them
# to the `ghcr.io/trueppm/*:latest` references the prod compose file resolves, so
# compose finds them in the local daemon and pulls nothing. The retag is
# deliberately the ONLY accommodation made for CI — no override compose file, no
# CI-only env var read by the prod file — because an override is exactly where a
# drift between "what the drill boots" and "what an operator boots" would hide.
#
# TLS/certbot is out of scope: it needs a real domain and ports 80/443 reachable
# from the ACME servers. TLS_MODE=none exercises the same api/celery/beat/nginx
# wiring over the app-http template; the renewal path stays a tag-day manual
# smoke, documented in #2804.
#
# Expects a working Docker daemon (dind in CI) with docker compose v2, curl, and
# python3 on PATH. Registry auth via $CI_REGISTRY{,_USER,_PASSWORD} in CI.
set -euo pipefail

PROD_COMPOSE_FILE="${PROD_COMPOSE_FILE:-docker-compose.prod.yml}"
# Own compose project, forced — NOT inherited from the environment.
#
# The teardown below runs `down -v`, which destroys the project's volumes. A
# developer running this locally has COMPOSE_PROJECT_NAME=trueppm exported by
# their worktree's .envrc (and by the repo's own dev workflow), so an inherited
# value would point `down -v` straight at the dev stack's postgres_data. In CI
# the daemon is a throwaway dind, so this costs nothing there and is the only
# thing standing between a local run and someone's development database.
export COMPOSE_PROJECT_NAME="trueppm-prod-drill"
REGISTRY="${CI_REGISTRY:-registry.gitlab.com}"
IMAGE_REPO="${IMAGE_REPO:-${REGISTRY}/trueppm/trueppm}"
RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-latest}"
# Host the drill reaches the published nginx port on. In CI the dind service is
# addressable as `docker`; locally the daemon publishes on the loopback.
PROBE_HOST="${PROBE_HOST:-docker}"
BASE_URL="http://${PROBE_HOST}"
# The api's readiness ceiling. Migrations against an empty database dominate this.
READY_TIMEOUT="${READY_TIMEOUT:-300}"
# beat-heartbeat runs on a 30 s period (settings/base.py CELERY_BEAT_SCHEDULE), so
# the first write lands within ~30 s of beat starting. Three periods of headroom
# keeps a loaded shared runner from reading as a dead scheduler.
BEAT_TIMEOUT="${BEAT_TIMEOUT:-120}"
ADMIN_EMAIL="${DJANGO_SUPERUSER_EMAIL:-admin@trueppm.example.com}"
# create_admin derives the username from the local part of the email when
# DJANGO_SUPERUSER_USERNAME is unset, and the JWT endpoint authenticates on
# Django's default USERNAME_FIELD ("username") — NOT on the email.
ADMIN_USERNAME="${DJANGO_SUPERUSER_USERNAME:-${ADMIN_EMAIL%%@*}}"

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

compose() { docker compose -f "${PROD_COMPOSE_FILE}" "$@"; }

# ---- diagnostics + teardown ------------------------------------------------
dump_diagnostics() {
  echo "======== DIAGNOSTICS (prod compose stack did not reach a healthy state) ========" >&2
  compose ps -a 2>&1 | sed 's/^/  /' >&2 || true
  # api-init runs migrate/collectstatic/create_admin and api waits on it, so its
  # log is where a failed bootstrap shows up — the api log would just be empty.
  for svc in api-init api celery celery-beat nginx db valkey; do
    echo "---- logs: ${svc} ----" >&2
    compose logs --tail=120 "${svc}" 2>&1 | sed 's/^/  /' >&2 || true
  done
}

# `down -v` unconditionally: the volumes are throwaway (#2817 pt.4) and leaving a
# populated postgres_data behind would let the NEXT run skip migrations and pass
# for the wrong reason.
teardown() {
  local status=$?
  [ "${status}" -eq 0 ] || dump_diagnostics
  log "tearing down (down -v)"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env nginx/active.conf.template
  return "${status}"
}
trap teardown EXIT

# ---- 0. per-commit images under the names the prod file resolves ------------
if [ -n "${CI_REGISTRY_PASSWORD:-}" ]; then
  echo "${CI_REGISTRY_PASSWORD}" | docker login -u "${CI_REGISTRY_USER}" --password-stdin "${REGISTRY}"
fi
log "retagging ${IMAGE_REPO}/{api,web}:${RELEASE_IMAGE_TAG} as ghcr.io/trueppm/*:latest"
for svc in api web; do
  src="${IMAGE_REPO}/${svc}:${RELEASE_IMAGE_TAG}"
  docker pull "${src}" >/dev/null || fail "could not pull ${src} — did ci:build-deploy-images run?"
  # APP_VERSION is left unset below, so the compose file resolves :latest.
  docker tag "${src}" "ghcr.io/trueppm/${svc}:latest"
done

# ---- 1. fill .env.example the way deployment.md says to ---------------------
# Every value below is generated, not hardcoded: a committed dummy SECRET_KEY is
# a credential-shaped string in the repo that some operator eventually copies.
log "filling .env from .env.example"
gen_secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(50))'; }
# Fernet keys are exactly 32 raw bytes, urlsafe-base64 with padding. Generated
# without importing `cryptography`, which is not installed in the CI image.
gen_fernet() { python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'; }

cp .env.example .env
chmod 600 .env

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  # Drop both the live line and any commented-out form, then append. Matching the
  # commented form matters for the attachment-storage choice, which ships as two
  # mutually exclusive `# KEY=` lines that must be chosen between (#775).
  grep -v -E "^[[:space:]]*#?[[:space:]]*${key}=" .env > "${tmp}" || true
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  cat "${tmp}" > .env
  rm -f "${tmp}"
}

set_env DOMAIN "${PROBE_HOST}"
set_env TLS_MODE none
# ALLOWED_HOSTS carries every name the probes and the nginx proxy_set_header Host
# can present. A miss here is a 400 from Django that reads like a routing bug.
set_env ALLOWED_HOSTS "${PROBE_HOST},localhost,127.0.0.1"
set_env SECRET_KEY "$(gen_secret)"
set_env DB_PASSWORD "$(gen_secret)"
set_env REDIS_PASSWORD "$(gen_secret)"
set_env INTEGRATION_ENCRYPTION_KEY "$(gen_fernet)"
# Attachment-storage choice (b): local disk. The drill uploads nothing, and (a)
# would need a live S3/MinIO endpoint — the guard being drilled is that the api
# refuses to boot until a choice is MADE, not that either backend works.
set_env TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE true
set_env DJANGO_SUPERUSER_EMAIL "${ADMIN_EMAIL}"

# ---- 2. boot through the documented entrypoint -----------------------------
log "booting the stack via init-prod.sh (TLS_MODE=none)"
bash init-prod.sh

# ---- 3. the api cleared its import-time boot guards -------------------------
log "waiting for api-init (migrate -> collectstatic -> create_admin)"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  state="$(compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null | awk '$1=="api-init"{print $2" "$3}')"
  case "${state}" in
    "exited 0") break ;;
    exited*) fail "api-init exited non-zero: ${state}" ;;
  esac
  [ "$(date +%s)" -lt "${deadline}" ] || fail "api-init did not complete within ${READY_TIMEOUT}s"
  sleep 3
done

# A boot-guard failure is a RuntimeError at settings import, so the container
# exits before serving anything. Assert on the message as well as on liveness:
# a crash-looping container can read as "starting" for a long time, and the
# guard's own prefix is the unambiguous signal.
if compose logs api 2>&1 | grep -q "Refusing to start:"; then
  compose logs api 2>&1 | grep "Refusing to start:" | sed 's/^/  /' >&2
  fail "api refused to start on a settings.prod boot guard"
fi

# ---- 4. readiness through nginx --------------------------------------------
log "waiting for GET /api/v1/readyz to report ready at ${BASE_URL}"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/readyz")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || {
    curl -s "${BASE_URL}/api/v1/readyz" | sed 's/^/  /' >&2 || true
    fail "/api/v1/readyz did not go ready within ${READY_TIMEOUT}s"
  }
  sleep 3
done
readyz="$(curl -s "${BASE_URL}/api/v1/readyz")"
echo "${readyz}" | grep -q '"status": *"ok"' || fail "readyz 200 but status is not ok: ${readyz}"

# ---- 5. celery-beat actually heartbeats -------------------------------------
# /health/beat/ is IsAdminUser-gated (it exposes operational state), so the drill
# authenticates as the bootstrapped superuser. The password is generated by
# create_admin into the shared emptyDir — reading it back also re-proves the
# admin-password retrieval path the deployment docs hand operators.
log "reading the bootstrapped admin password"
admin_password="$(compose exec -T api cat /run/trueppm/admin_password | tr -d '\r\n')"
[ -n "${admin_password}" ] || fail "admin password file was empty — create_admin did not write it"

log "obtaining an admin JWT"
token="$(curl -s -X POST "${BASE_URL}/api/v1/auth/token/" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${admin_password}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access",""))')"
[ -n "${token}" ] || fail "could not obtain an admin JWT for ${ADMIN_USERNAME}"

log "waiting for GET /api/v1/health/beat/ to return 200 (proves celery-beat dispatches)"
deadline=$(( $(date +%s) + BEAT_TIMEOUT ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' \
            -H "Authorization: Bearer ${token}" \
            "${BASE_URL}/api/v1/health/beat/")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || {
    curl -s -H "Authorization: Bearer ${token}" "${BASE_URL}/api/v1/health/beat/" | sed 's/^/  /' >&2 || true
    compose logs --tail=60 celery-beat 2>&1 | sed 's/^/  /' >&2 || true
    fail "/api/v1/health/beat/ never returned 200 within ${BEAT_TIMEOUT}s — celery-beat is declared but not dispatching"
  }
  sleep 5
done

# ---- 6. the stack survives a restart of the api -----------------------------
# The failure this catches: a container that only boots because a sibling was
# mid-initialization the first time — an ordering accident rather than a
# dependency. api-init has exited by now, so this restart runs against the
# steady state an operator's `systemctl restart` would.
log "restarting the api container"
compose restart api
deadline=$(( $(date +%s) + READY_TIMEOUT ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/readyz")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || fail "/api/v1/readyz did not recover within ${READY_TIMEOUT}s after restarting api"
  sleep 3
done
if compose logs api 2>&1 | grep -q "Refusing to start:"; then
  fail "api refused to start on a boot guard AFTER restart"
fi

log "prod compose drill passed"
