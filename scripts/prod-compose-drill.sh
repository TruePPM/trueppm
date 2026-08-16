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
# TLS is a PARAMETER of this drill, not an exclusion (#2829). `TLS_MODE=none`
# (the default) boots nginx/app-http.conf.template; `TLS_MODE=selfsigned` boots
# nginx/app.conf.template — the TLS variant, a genuinely different file — and
# adds three assertions the plain-HTTP leg structurally cannot make:
#
#   6. HTTPS serves the app on :443 from the certificate init-prod.sh minted;
#   7. plain HTTP redirects to HTTPS (301), so the :80 server block works;
#   8. `/.well-known/acme-challenge/` is served FROM THE WEBROOT over plain
#      HTTP and is NOT swallowed by that redirect — which is precisely the
#      assumption `certbot renew -a webroot` depends on, and the one that would
#      otherwise fail silently at ~60 days with the certificate already issued.
#
# `TLS_MODE=letsencrypt` remains out of scope: it needs a real domain and ACME
# reachability. What is left uncovered after the selfsigned leg is narrow and
# worth naming — the `--standalone` first issuance in init-prod.sh, and the
# authenticator switch from standalone to webroot recorded in the renewal
# lineage. Those stay a tag-day manual smoke (#2804).
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
REGISTRY="${CI_REGISTRY:-registry.gitlab.com}"
IMAGE_REPO="${IMAGE_REPO:-${REGISTRY}/trueppm/trueppm}"
RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-latest}"
# Host the drill reaches the published nginx port on. In CI the dind service is
# addressable as `docker`; locally the daemon publishes on the loopback.
PROBE_HOST="${PROBE_HOST:-docker}"

# Which TLS posture to drill (#2829). `none` is the original mode and stays the
# default so an unparameterized run is unchanged.
#
# `selfsigned` is what gets `nginx/app.conf.template` — the TLS variant, a
# DIFFERENT FILE from the app-http template `none` boots — under a real boot for
# the first time. It is the whole point of this parameter: #2828 found four
# independently fatal faults in the one nginx service CI actually started, and
# every one of them was invisible to `docker compose config` and to the
# structural contract tests. The TLS template had had exactly as much real-boot
# coverage as that service did, which is none.
#
# `letsencrypt` is deliberately NOT drillable here: it needs a real domain and
# ACME reachability on :80. What `selfsigned` still proves about it is the part
# that breaks silently at day ~60 — that nginx serves `/.well-known/acme-challenge/`
# from the webroot the certbot service renews through (`-a webroot`), rather than
# swallowing it in the HTTPS redirect. Issuance-vs-renewal authenticator drift
# remains a tag-day manual smoke.
TLS_MODE="${TLS_MODE:-none}"
case "${TLS_MODE}" in
  none|selfsigned) ;;
  *) echo "TLS_MODE must be 'none' or 'selfsigned' for the drill (got '${TLS_MODE}')" >&2; exit 2 ;;
esac

# One compose project PER MODE, so the two drills can run as sibling CI jobs (or
# back to back locally) without `down -v` in one reaping the other's stack.
export COMPOSE_PROJECT_NAME="trueppm-prod-drill-${TLS_MODE}"

if [ "${TLS_MODE}" = "none" ]; then
  BASE_URL="http://${PROBE_HOST}"
  # An array rather than a string: `set -u` plus word-splitting makes an empty
  # scalar expand to an empty ARGUMENT, which curl reads as a URL and rejects.
  CURL=(curl -s)
else
  BASE_URL="https://${PROBE_HOST}"
  # The certificate is self-signed by construction, so verification failing is
  # the expected state, not a finding. `-k` is scoped to this drill and never
  # reaches an operator's stack.
  CURL=(curl -s -k)
fi
# Plain-HTTP base, used in TLS mode to assert the :80 server block's two jobs:
# redirect everything, EXCEPT the ACME challenge.
HTTP_BASE_URL="http://${PROBE_HOST}"
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
  # init-prod.sh mints the self-signed lineage into the checkout, and the ACME
  # probe below writes a challenge file next to it. Both are generated artefacts
  # containing a private key — leave neither behind for a later `git add -A`.
  rm -rf certbot
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
# The self-signed lineage is minted at CN=${DOMAIN} and nginx resolves its
# certificate path from the same variable, so DOMAIN and PROBE_HOST have to be
# the one name — a mismatch is a file-not-found at nginx start, not a name
# warning (the drill passes `-k`, so hostname mismatch alone would go unnoticed).
set_env TLS_MODE "${TLS_MODE}"
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
#
# dind caveat, and the reason for sync_checkout_to_daemon below.
#
# `docker compose` runs in THIS container but the daemon runs in the dind
# service, and a bind mount's SOURCE path is resolved by the daemon — on its own
# filesystem, where our checkout does not exist. Docker's response to a missing
# bind source is to create it, as a DIRECTORY. The nginx service is the only one
# in this stack with bind mounts (its config template and the certbot webroots);
# everything else uses named volumes, which live in the daemon and work fine.
# So nginx alone came up with a directory where its template should be and
# crash-looped on `envsubst: ... Is a directory`, while every other service
# reported healthy.
#
# The fix is to place the checkout on the daemon's filesystem at the SAME
# absolute path, so the relative sources in the compose file resolve to the real
# files. `-v /:/host` from a throwaway container reaches the dind root. Only the
# paths the compose file binds are copied — the certbot directories are
# genuinely directories, so Docker auto-creating those is harmless and correct.
#
# This runs TWICE on purpose: once before init-prod.sh so the daemon has the
# templates, and once after, because init-prod.sh's own `cp` of the selected
# template lands on THIS container's filesystem. The trailing `up -d` then
# recreates nginx against the now-correct source. Doing it this way keeps the
# drill running the real init-prod.sh rather than a re-implementation of it.
sync_checkout_to_daemon() {
  # `rm -rf` the target first: once compose has started a service whose bind
  # source is missing, the daemon holds a DIRECTORY at that path, and tar cannot
  # extract a regular file over a directory — it fails and leaves the directory,
  # which is exactly how this looked like it had not been fixed.
  #
  # In TLS mode `certbot/` joins the payload (#2829). Its subdirectories are
  # genuinely directories, so Docker auto-creating them is harmless — but their
  # CONTENTS are not: `certbot/conf/live/${DOMAIN}/{fullchain,privkey}.pem` is
  # the certificate init-prod.sh just minted on THIS filesystem, and nginx reads
  # it from the daemon's. Without this, nginx starts against an empty directory
  # and dies on "cannot load certificate ... No such file or directory" — the
  # #2828 failure shape exactly, one mount over.
  #
  # `certbot/` only joins once init-prod.sh has created it — this function also
  # runs BEFORE that, to place the templates, and tar exits non-zero on a
  # missing member.
  local paths=(nginx)
  if [ "${TLS_MODE}" != "none" ] && [ -d certbot ]; then
    paths+=(certbot)
  fi
  # One `rm -rf` taking every path, not one per path: `rm -rf a rm -rf b` is a
  # single command whose argument list contains the literal word `rm`.
  local targets
  targets="$(printf "'/host${PWD}/%s' " "${paths[@]}")"
  tar -C "$PWD" -cf - "${paths[@]}" 2>/dev/null \
    | docker run --rm -i -v /:/host alpine:3 \
        sh -c "rm -rf ${targets} && mkdir -p '/host${PWD}' && tar -C '/host${PWD}' -xf -" \
    >/dev/null
}

# Fail fast and legibly if the sync did not land a real file. Without this the
# drill spends 300 s polling readyz and then reports a timeout, which reads as a
# slow application rather than a broken mount.
assert_template_on_daemon() {
  local kind
  kind="$(docker run --rm -v /:/host alpine:3 sh -c \
    "if [ -f '/host${PWD}/nginx/active.conf.template' ]; then echo file; \
     elif [ -d '/host${PWD}/nginx/active.conf.template' ]; then echo directory; \
     else echo missing; fi")"
  [ "${kind}" = "file" ] || fail \
    "nginx/active.conf.template is a ${kind} on the dind daemon, not a file — the \
bind mount would resolve to it and nginx dies on 'envsubst: ... Is a directory'."
}

log "syncing bind-mount sources onto the dind daemon filesystem"
sync_checkout_to_daemon

log "booting the stack via init-prod.sh (TLS_MODE=${TLS_MODE})"
bash init-prod.sh

# init-prod.sh rendered nginx/active.conf.template on THIS filesystem; the daemon
# still has the pre-render tree, so nginx is currently bound to a stale or absent
# source. Re-sync and recreate it.
log "re-syncing the rendered nginx template and recreating nginx"
sync_checkout_to_daemon
assert_template_on_daemon
# --no-deps is essential: without it compose recreates nginx's dependency chain
# too, which re-runs api-init — migrations, collectstatic AND the create_admin
# bootstrap — in the middle of the drill. Only nginx's bind source changed.
compose up -d --no-deps --force-recreate nginx

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
until [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/readyz")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || {
    "${CURL[@]}" "${BASE_URL}/api/v1/readyz" | sed 's/^/  /' >&2 || true
    fail "/api/v1/readyz did not go ready within ${READY_TIMEOUT}s"
  }
  sleep 3
done
readyz="$("${CURL[@]}" "${BASE_URL}/api/v1/readyz")"
echo "${readyz}" | grep -q '"status": *"ok"' || fail "readyz 200 but status is not ok: ${readyz}"

# ---- 4a. the TLS server blocks (#2829) --------------------------------------
# Only reachable in TLS mode, and this is the half of nginx/app.conf.template
# that app-http.conf.template does not have at all. Reaching readyz over https
# above already proved the certificate loads and the :443 block proxies; these
# three assert the :80 block, whose entire job is the ACME handshake plus the
# redirect — and which is the part a certificate renewal depends on 60 days
# after anyone last looked at it.
if [ "${TLS_MODE}" != "none" ]; then
  log "asserting plain HTTP redirects to HTTPS"
  redirect_code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${HTTP_BASE_URL}/")"
  [ "${redirect_code}" = "301" ] || fail \
    "GET ${HTTP_BASE_URL}/ returned ${redirect_code}, not 301 — the :80 server block is not redirecting to HTTPS."
  redirect_target="$("${CURL[@]}" -o /dev/null -w '%{redirect_url}' "${HTTP_BASE_URL}/")"
  case "${redirect_target}" in
    https://*) ;;
    *) fail "plain HTTP redirected to '${redirect_target}', which is not an https:// URL" ;;
  esac

  # THE renewal assertion. `certbot renew -a webroot` writes its challenge token
  # into /var/www/certbot/.well-known/acme-challenge/ and the ACME server fetches
  # it over PLAIN HTTP on :80 — so this path must be served from the webroot and
  # must NOT be caught by the redirect above. Nothing else in CI covers it: the
  # certificate is already issued by then, so the failure is invisible until the
  # lineage expires. Writing the token by hand is what removes the need for an
  # ACME server to test it at all.
  log "asserting the ACME challenge webroot is served over plain HTTP (certbot -a webroot)"
  challenge_token="drill-$(date +%s)"
  # Written STRAIGHT INTO the daemon's filesystem, not here-then-synced.
  #
  # nginx is already running with ./certbot/www bind-mounted, and a bind mount
  # follows the INODE: `sync_checkout_to_daemon` starts with `rm -rf`, so calling
  # it now would unlink the directory nginx holds and recreate a new one at the
  # same path. nginx would keep the old, now-orphaned inode and see an empty
  # webroot — the probe would fail against a stack that is actually fine, which
  # is a worse outcome than not testing it. Adding one file touches no inode
  # nginx depends on.
  docker run --rm -v /:/host alpine:3 sh -c "
    mkdir -p '/host${PWD}/certbot/www/.well-known/acme-challenge' &&
    printf '%s' '${challenge_token}' > '/host${PWD}/certbot/www/.well-known/acme-challenge/${challenge_token}'" \
    >/dev/null || fail "could not write the ACME challenge token onto the daemon filesystem"
  challenge_body="$("${CURL[@]}" "${HTTP_BASE_URL}/.well-known/acme-challenge/${challenge_token}")"
  [ "${challenge_body}" = "${challenge_token}" ] || fail \
    "GET ${HTTP_BASE_URL}/.well-known/acme-challenge/${challenge_token} returned '${challenge_body}', not the token. \
nginx is not serving the webroot certbot renews through — the certificate would issue, then fail to renew at ~60 days. See #2829."

  log "asserting HSTS is set on the HTTPS response"
  "${CURL[@]}" -o /dev/null -D - "${BASE_URL}/" 2>/dev/null | grep -qi '^strict-transport-security:' || fail \
    "the HTTPS response carries no Strict-Transport-Security header — nginx/app.conf.template's add_header did not survive."
fi

# ---- 4b. collected static actually reaches the process that serves it -------
# nginx PROXIES /static/ to the api, where WhiteNoise serves STATIC_ROOT — so
# this asserts the whole chain: api-init's collectstatic wrote the shared volume,
# the api container mounts that same volume at the STATIC_ROOT it resolves, and
# nginx routes to it. Each of those was independently wrong before #2828, and a
# clean `collectstatic` in the api-init log proves none of them. The Django admin
# stylesheet is the probe because it is present in every collectstatic output
# regardless of which optional apps are installed.
log "asserting /static/ serves the collected assets"
static_code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE_URL}/static/admin/css/base.css")"
[ "${static_code}" = "200" ] || fail \
  "GET /static/admin/css/base.css returned ${static_code}, not 200 — collectstatic output is not reaching WhiteNoise (admin CSS and the Swagger UI / ReDoc assets are broken). See #2828."

# ---- 5. celery-beat actually heartbeats -------------------------------------
# /health/beat/ is IsAdminUser-gated (it exposes operational state), so the drill
# authenticates as the bootstrapped superuser. The password is generated by
# create_admin into the shared emptyDir — reading it back also re-proves the
# admin-password retrieval path the deployment docs hand operators.
log "reading the bootstrapped admin password"
admin_password="$(compose exec -T api cat /run/trueppm/admin_password | tr -d '\r\n')"
[ -n "${admin_password}" ] || fail "admin password file was empty — create_admin did not write it"

log "obtaining an admin JWT"
token="$("${CURL[@]}" -X POST "${BASE_URL}/api/v1/auth/token/" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${admin_password}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access",""))')"
[ -n "${token}" ] || fail "could not obtain an admin JWT for ${ADMIN_USERNAME}"

log "waiting for GET /api/v1/health/beat/ to return 200 (proves celery-beat dispatches)"
deadline=$(( $(date +%s) + BEAT_TIMEOUT ))
until [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' \
            -H "Authorization: Bearer ${token}" \
            "${BASE_URL}/api/v1/health/beat/")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || {
    "${CURL[@]}" -H "Authorization: Bearer ${token}" "${BASE_URL}/api/v1/health/beat/" | sed 's/^/  /' >&2 || true
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
until [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/readyz")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || fail "/api/v1/readyz did not recover within ${READY_TIMEOUT}s after restarting api"
  sleep 3
done
if compose logs api 2>&1 | grep -q "Refusing to start:"; then
  fail "api refused to start on a boot guard AFTER restart"
fi

log "prod compose drill passed"
