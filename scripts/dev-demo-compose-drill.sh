#!/usr/bin/env bash
# Dev and demo docker-compose boot drills (#4026).
#
# installation.md leads every evaluator through `docker compose up -d`
# (docker-compose.yml, the DEVELOPMENT stack) and try-it.md leads through
# `docker compose -f docker-compose.demo.yml up` (the public read-only demo
# stack) — the two paths most people actually take before ever touching
# docker-compose.prod.yml. Until this script, nothing booted either one:
# compose:image-pins and compose:project-names (see .gitlab-ci.yml) only render
# and grep the YAML statically. scripts/prod-compose-drill.sh proved a compose
# file rendering clean is not evidence it boots (#2817, #2828 found four
# independently fatal faults invisible to `docker compose config`); the dev and
# demo stacks carried exactly that same unproven status.
#
# One script, two modes (DRILL_MODE=dev|demo), mirroring the TLS_MODE parameter
# on scripts/prod-compose-drill.sh rather than forking a second file: both legs
# share the "own compose project, forced teardown, poll for health, curl the
# routes" shape, and a shared script keeps that shape from drifting between the
# two the way two independent scripts eventually would.
#
# ── dev leg (DRILL_MODE=dev) ──────────────────────────────────────────────────
# Boots the UNMODIFIED docker-compose.yml, building the api/web images from
# THIS commit's source (`docker compose up -d --build`) — the dev target is a
# distinct build path from the runtime image ci:build-deploy-images produces
# (packages/api/Dockerfile's `dev` stage skips the compiled psycopg extra;
# packages/web/Dockerfile's `dev` stage runs the Vite dev server, not the nginx
# serve stage), so nothing else in CI exercises it. Asserts:
#   1. db, valkey, api reach the `healthy` state their own healthchecks define
#      (api's IS `/api/v1/readyz`, so this doubles as the migration-completion
#      check the compose file relies on for `depends_on: condition:
#      service_healthy`);
#   2. GET /api/v1/readyz reports `status: ok` through the published port;
#   3. `/tmp/trueppm_admin_password` exists in the api container and the
#      password it holds authenticates — the exact two-line retrieval
#      installation.md hands every evaluator;
#   4. GET :5173/ (the Vite dev server) returns the SPA document;
#   5. `celery -A trueppm_api.celery inspect ping` gets a reply from the
#      worker;
#   6. GET /api/v1/health/beat/ returns 200, proving celery-beat actually
#      dispatches CELERY_BEAT_SCHEDULE rather than merely being declared.
#
# ── demo leg (DRILL_MODE=demo) ────────────────────────────────────────────────
# Boots the UNMODIFIED docker-compose.demo.yml. Its `api`/`web` images
# reference `ghcr.io/trueppm/{api,web}:${APP_VERSION:-latest}` — a PUBLISHED
# release tag, not a build context (#939, #2271) — so a naive `up` on a non-tag
# pipeline would drill the last release's code, not this commit's, silently
# widening the gap between "what CI proved" and "what merged" for any compose-
# or nginx-template change bundled with an application change. This script
# retags the SAME per-commit images ci:build-deploy-images already built (see
# the identical step in scripts/prod-compose-drill.sh) under the `ghcr.io/
# trueppm/*:latest` names the demo file resolves, so the drill boots HEAD code
# through an unmodified compose file and pulls nothing from GHCR. That is the
# deliberate accommodation the prod drill also makes, and the only one made
# here.
#
# Consequence worth stating plainly: this proves the demo BOOT CHAIN (compose
# wiring, migrations, seed, the nginx allowlist, the share-link mint) against
# HEAD. It does not exercise Cloudflare Access, the try.trueppm.com TLS
# termination, or anything about the real hosted demo's edge — those are
# outside a compose file entirely.
#
# Asserts:
#   1. db, valkey reach `healthy`; api-init and demo-seed each exit 0; api
#      reaches `healthy`;
#   2. demo-seed's log contains the printed share URL, and following it
#      through nginx returns the SPA document (200, text/html) — the same
#      "read the logs, open the link" path try-it.md documents;
#   3. the underlying share API endpoint (`/api/v1/share/schedule/<token>/`)
#      answers 200 with no authentication — the demo's one real data plane;
#   4. the nginx allowlist in deployment.md's "Public route" table holds:
#      `/api/v1/health/` is reachable, `/robots.txt` disallows everything and
#      carries `X-Robots-Tag: noindex`, and three representative DISALLOWED
#      routes (`/api/v1/auth/token/`, `/api/v1/programs/`, `/admin/`) come
#      back closed — 404 for the two bare `/api/` catch-all routes, and
#      `/admin/`'s explicit `deny all` (403, never reaching Django).
#
# ── shared shape ──────────────────────────────────────────────────────────────
# Own compose project per mode (trueppm-{dev,demo}-drill), FORCED via
# COMPOSE_PROJECT_NAME rather than left to the compose file's own `name:` pin
# (`trueppm-dev` / `trueppm-demo`) — those pins exist so a developer's real dev
# stack and the public demo never collide with each other or with
# docker-compose.prod.yml (#3928); this drill must equally never collide with a
# developer's *actual* running stack. Teardown always runs `down -v` — the
# volumes are throwaway CI artifacts, and leaving a populated postgres_data
# behind would let the next run skip migrations and pass for the wrong reason
# (same reasoning as scripts/prod-compose-drill.sh).
#
# Expects a working Docker daemon (dind in CI) with docker compose v2, curl,
# and python3 on PATH.
set -euo pipefail

DRILL_MODE="${DRILL_MODE:-}"
case "${DRILL_MODE}" in
  dev|demo) ;;
  *) echo "DRILL_MODE must be 'dev' or 'demo' (got '${DRILL_MODE}')" >&2; exit 2 ;;
esac

# Host the drill reaches the stack's published ports on. In CI the dind
# service is addressable as `docker`; locally the daemon publishes on the
# loopback.
PROBE_HOST="${PROBE_HOST:-docker}"
READY_TIMEOUT="${READY_TIMEOUT:-300}"
# beat-heartbeat runs on a 30s period (settings/base.py CELERY_BEAT_SCHEDULE);
# three periods of headroom keeps a loaded shared runner from reading as a dead
# scheduler. Dev leg only — the demo stack runs no celery/beat at all (it is
# read-only, so nothing ever needs auto-scheduling).
BEAT_TIMEOUT="${BEAT_TIMEOUT:-120}"

REGISTRY="${CI_REGISTRY:-registry.gitlab.com}"
IMAGE_REPO="${IMAGE_REPO:-${REGISTRY}/trueppm/trueppm}"
RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-latest}"

if [ "${DRILL_MODE}" = "dev" ]; then
  COMPOSE_FILE="docker-compose.yml"
  export COMPOSE_PROJECT_NAME="trueppm-dev-drill"
  API_BASE_URL="http://${PROBE_HOST}:8000"
  WEB_BASE_URL="http://${PROBE_HOST}:5173"
else
  COMPOSE_FILE="docker-compose.demo.yml"
  export COMPOSE_PROJECT_NAME="trueppm-demo-drill"
  BASE_URL="http://${PROBE_HOST}"
fi

log()  { echo "==> [${DRILL_MODE}] $*"; }
fail() { echo "FAIL [${DRILL_MODE}]: $*" >&2; exit 1; }

compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }

dump_diagnostics() {
  echo "======== DIAGNOSTICS (${DRILL_MODE} compose stack did not reach a healthy state) ========" >&2
  compose ps -a 2>&1 | sed 's/^/  /' >&2 || true
  local services
  services="$(compose config --services 2>/dev/null || true)"
  for svc in ${services}; do
    echo "---- logs: ${svc} ----" >&2
    compose logs --tail=120 "${svc}" 2>&1 | sed 's/^/  /' >&2 || true
  done
}

teardown() {
  local status=$?
  [ "${status}" -eq 0 ] || dump_diagnostics
  log "tearing down (down -v)"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  return "${status}"
}
trap teardown EXIT

# Poll a container's Docker healthcheck status (not `compose ps`'s formatted
# text, which changes shape across compose versions) until it reports
# "healthy", or fail with diagnostics on timeout.
wait_healthy() {
  local service="$1" timeout="${2:-${READY_TIMEOUT}}" deadline cid status
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    cid="$(compose ps -q "${service}" 2>/dev/null || true)"
    if [ -n "${cid}" ]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "${cid}" 2>/dev/null || echo "")"
      [ "${status}" = "healthy" ] && return 0
      [ "${status}" = "unhealthy" ] && fail "${service} reported unhealthy (see diagnostics)"
    fi
    [ "$(date +%s)" -lt "${deadline}" ] || fail "${service} did not become healthy within ${timeout}s"
    sleep 3
  done
}

# Poll a one-shot service (api-init, demo-seed) to exit 0, or fail on any
# non-zero exit or timeout. Mirrors scripts/prod-compose-drill.sh's api-init
# wait exactly.
wait_exited_zero() {
  local service="$1" timeout="${2:-${READY_TIMEOUT}}" deadline state
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    state="$(compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null | awk -v s="${service}" '$1==s{print $2" "$3}')"
    case "${state}" in
      "exited 0") return 0 ;;
      exited*) fail "${service} exited non-zero: ${state}" ;;
    esac
    [ "$(date +%s)" -lt "${deadline}" ] || fail "${service} did not complete within ${timeout}s"
    sleep 3
  done
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

wait_http_200() {
  local url="$1" timeout="${2:-${READY_TIMEOUT}}" deadline
  deadline=$(( $(date +%s) + timeout ))
  until [ "$(http_code "${url}")" = "200" ]; do
    [ "$(date +%s)" -lt "${deadline}" ] || {
      curl -s "${url}" | sed 's/^/  /' >&2 || true
      fail "GET ${url} did not return 200 within ${timeout}s"
    }
    sleep 3
  done
}

# ============================================================================
if [ "${DRILL_MODE}" = "dev" ]; then

  log "booting the unmodified dev stack (docker compose up -d --build)"
  compose up -d --build

  log "waiting for db, valkey, api to report healthy"
  wait_healthy db
  wait_healthy valkey
  wait_healthy api

  log "asserting GET /api/v1/readyz reports ok"
  readyz="$(curl -s "${API_BASE_URL}/api/v1/readyz")"
  grep -q '"status": *"ok"' <<<"${readyz}" || fail "readyz is not ok: ${readyz}"

  log "reading the bootstrapped admin password from /tmp/trueppm_admin_password"
  admin_password="$(compose exec -T api cat /tmp/trueppm_admin_password | tr -d '\r\n')"
  [ -n "${admin_password}" ] || fail "admin password file was empty — create_admin did not write it"

  # create_admin defaults DJANGO_SUPERUSER_EMAIL to admin@example.com when
  # unset (docker-compose.yml sets neither), so the username is its local
  # part — matching installation.md's own curl example.
  log "obtaining an admin JWT"
  token="$(curl -s -X POST "${API_BASE_URL}/api/v1/auth/token/" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${admin_password}\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access",""))')"
  [ -n "${token}" ] || fail "could not obtain an admin JWT — the retrieved password did not authenticate"

  log "waiting for the Vite dev server on :5173 to serve the SPA"
  wait_http_200 "${WEB_BASE_URL}/"
  web_headers="$(curl -s -o /dev/null -D - "${WEB_BASE_URL}/")"
  grep -qi '^content-type:.*text/html' <<<"${web_headers}" || \
    fail "GET ${WEB_BASE_URL}/ did not carry a text/html content-type"

  log "waiting for the celery worker to report healthy (heartbeat file, #3346)"
  wait_healthy celery

  log "asserting the celery worker answers inspect ping"
  # inspect ping forks a full Django import into the worker being measured
  # (#3236), so it is deliberately NOT the healthcheck itself — but it is the
  # right assertion here, since it is the exact command
  # installation.md#4-celery-worker---consuming-the-queue hands an operator.
  # Retried rather than one-shot: it can transiently miss just after the
  # worker's own healthcheck first goes green.
  deadline=$(( $(date +%s) + 60 ))
  while :; do
    ping_out="$(compose exec -T celery celery -A trueppm_api.celery inspect ping 2>&1 || true)"
    grep -qi 'pong' <<<"${ping_out}" && break
    [ "$(date +%s)" -lt "${deadline}" ] || fail "celery inspect ping got no pong: ${ping_out}"
    sleep 3
  done

  log "waiting for GET /api/v1/health/beat/ to return 200 (proves celery-beat dispatches)"
  deadline=$(( $(date +%s) + BEAT_TIMEOUT ))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" "${API_BASE_URL}/api/v1/health/beat/")" = "200" ]; do
    [ "$(date +%s)" -lt "${deadline}" ] || {
      compose logs --tail=60 celery-beat 2>&1 | sed 's/^/  /' >&2 || true
      fail "/api/v1/health/beat/ never returned 200 within ${BEAT_TIMEOUT}s — celery-beat is declared but not dispatching"
    }
    sleep 5
  done

  log "dev compose drill passed"

else # DRILL_MODE=demo

  # Same retag as scripts/prod-compose-drill.sh step 0: pulls this commit's
  # already-built images under the names docker-compose.demo.yml resolves, so
  # the drill exercises HEAD code and touches GHCR not at all.
  if [ -n "${CI_REGISTRY_PASSWORD:-}" ]; then
    echo "${CI_REGISTRY_PASSWORD}" | docker login -u "${CI_REGISTRY_USER}" --password-stdin "${REGISTRY}"
  fi
  log "retagging ${IMAGE_REPO}/{api,web}:${RELEASE_IMAGE_TAG} as ghcr.io/trueppm/*:latest"
  for svc in api web; do
    src="${IMAGE_REPO}/${svc}:${RELEASE_IMAGE_TAG}"
    docker pull "${src}" >/dev/null || fail "could not pull ${src} — did ci:build-deploy-images run?"
    docker tag "${src}" "ghcr.io/trueppm/${svc}:latest"
  done

  log "booting the unmodified demo stack (docker compose up -d)"
  compose up -d

  log "waiting for db, valkey to report healthy"
  wait_healthy db
  wait_healthy valkey

  log "waiting for api-init (migrate -> collectstatic) to complete"
  wait_exited_zero api-init

  log "waiting for demo-seed (load_sample_project -> create_demo_share_link) to complete"
  wait_exited_zero demo-seed

  log "waiting for api to report healthy"
  wait_healthy api

  log "reading the share URL demo-seed printed"
  share_url="$(compose logs demo-seed 2>&1 | grep -oE 'URL: *http://[^[:space:]]+' | tail -n1 | sed -E 's/^URL: *//')"
  [ -n "${share_url}" ] || fail "demo-seed logged no share URL — create_demo_share_link did not print one"
  # The printed URL names TRUEPPM_DEMO_BASE_URL (default http://localhost);
  # rewrite it onto PROBE_HOST, which is what this drill can actually reach.
  share_path="${share_url#http://localhost}"
  share_path="${share_path#https://localhost}"
  token="${share_path##*/}"

  log "waiting for nginx to serve the SPA at the share URL (${BASE_URL}${share_path})"
  wait_http_200 "${BASE_URL}${share_path}"
  spa_headers="$(curl -s -o /dev/null -D - "${BASE_URL}${share_path}")"
  grep -qi '^content-type:.*text/html' <<<"${spa_headers}" || \
    fail "GET ${BASE_URL}${share_path} did not carry a text/html content-type — the share link does not render"

  log "asserting the underlying share API answers with no authentication"
  share_api_code="$(http_code "${BASE_URL}/api/v1/share/schedule/${token}/")"
  [ "${share_api_code}" = "200" ] || fail \
    "GET ${BASE_URL}/api/v1/share/schedule/${token}/ returned ${share_api_code}, not 200 — the demo's one real data plane is not serving"

  log "asserting the nginx allowlist (deployment.md's Public route table) holds"
  health_code="$(http_code "${BASE_URL}/api/v1/health/")"
  [ "${health_code}" = "200" ] || fail "GET ${BASE_URL}/api/v1/health/ returned ${health_code}, not 200 — the allowlisted liveness route is closed"

  robots_headers="$(curl -s -o /tmp/demo-robots.txt -D - "${BASE_URL}/robots.txt")"
  grep -qi '^x-robots-tag:.*noindex' <<<"${robots_headers}" || \
    fail "GET ${BASE_URL}/robots.txt carries no X-Robots-Tag: noindex — the demo is not opted out of indexing"
  grep -q 'Disallow: /' /tmp/demo-robots.txt || fail "/robots.txt does not disallow everything"
  rm -f /tmp/demo-robots.txt

  # Three representative DISALLOWED routes, one per denial mechanism in
  # nginx/demo.conf.template: the bare `/api/` catch-all (`return 404`, twice —
  # auth and a project viewset) and `/admin/`'s `deny all` (403, never reaching
  # Django). A regression that widened the allowlist back to a blanket proxy
  # would turn any of these into a 2xx/3xx or a Django error page instead.
  auth_code="$(http_code -X POST "${BASE_URL}/api/v1/auth/token/")"
  [ "${auth_code}" = "404" ] || fail "POST ${BASE_URL}/api/v1/auth/token/ returned ${auth_code}, not 404 — the auth surface is reachable from the public demo"

  programs_code="$(http_code "${BASE_URL}/api/v1/programs/")"
  [ "${programs_code}" = "404" ] || fail "GET ${BASE_URL}/api/v1/programs/ returned ${programs_code}, not 404 — an authenticated viewset is reachable from the public demo"

  admin_code="$(http_code "${BASE_URL}/admin/")"
  [ "${admin_code}" = "403" ] || fail "GET ${BASE_URL}/admin/ returned ${admin_code}, not 403 — the admin deny-all is not in effect"

  log "demo compose drill passed"

fi
