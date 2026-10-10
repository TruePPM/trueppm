#!/usr/bin/env bash
# nginx -t syntax check on the Helm chart's rendered web ConfigMap (#4356).
#
# scripts/check-demo-nginx-allowlist.sh and scripts/check-nginx-security-headers.sh
# both parse the TEXT of packages/helm/templates/web/configmap.yaml's rendered
# `data["default.conf"]` with awk, asserting routes and headers. Neither one
# proves the text is syntactically valid nginx: `helm lint`, `helm template` and
# kubeconform only ever see a YAML string, so a Go-template edit that emits
# broken nginx (an unbalanced brace, a directive missing its `;`, a stray `{{`
# left unrendered) is caught only at pod crash-loop, in a cluster, well after
# the MR merged. This script closes that gap by handing the rendered text to
# nginx's OWN `nginx -t` syntax checker.
#
# ── Why docker, and why --add-host ───────────────────────────────────────────
# `nginx -t` needs a real nginx binary plus the `http { }` context the chart's
# ConfigMap is written to be included INTO (its own comment: "this file is
# included from nginx.conf's http block") — a bare `server { }` fragment has no
# such context on its own. The web image's own base,
# nginxinc/nginx-unprivileged:alpine (pinned to the same digest
# packages/web/Dockerfile's serve stage uses, so this tests the nginx the
# project actually ships), already supplies both: drop the rendered text at
# /etc/nginx/conf.d/default.conf and its stock nginx.conf includes it.
#
# `nginx -t` does not only parse syntax, though — for a `proxy_pass` whose
# target is a LITERAL hostname (not a variable), nginx resolves that hostname
# while loading the config, same as it would at `nginx -s reload`. Confirmed
# empirically while writing this script: a container with no entry for
# "trueppm-api" fails config *test* with `host not found in upstream
# "trueppm-api"`, indistinguishable in exit code from a real syntax error. The
# rendered configs proxy to two literal hosts — `api` (the compose templates'
# and the baked image's upstream name) and `<fullname>-api` (the chart's
# Service DNS name; `trueppm-api` for the release name this script renders
# with) — neither of which exists inside this throwaway container's network.
# `docker run --add-host` seeds static /etc/hosts entries for both, pointed at
# loopback, so the name resolves and nginx validates the REST of the directive
# (upstream syntax, balanced braces, the proxy_* headers) without needing the
# literal services to exist. A resolver directive was considered and rejected:
# it only changes resolution for a proxy_pass target supplied via a VARIABLE,
# which is not the shape these configs use.
#
# Exit codes:
#   0  every rendered variant is valid nginx syntax
#   1  `nginx -t` failed on at least one rendered variant
#   2  invocation / setup error (`helm template` failed, yq extracted no
#      data["default.conf"], or a docker run itself could not start)
#
# docker/helm/yq availability: if any of the three is missing, or the docker
# daemon is unreachable, this check is SKIPPED with a loud warning rather than
# failing — the same local-only-fallback trade-off
# scripts/check-nginx-security-headers.sh documents for `helm`. The CI job this
# script runs in (nginx:headers' docker-equipped sibling) always has all three.
#
# Modes:
#   bash scripts/check-helm-nginx-syntax.sh             # check the chart
#   bash scripts/check-helm-nginx-syntax.sh --self-test # synthesize fixtures, assert

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELM_CHART="packages/helm"
# Pinned to the exact digest packages/web/Dockerfile's serve stage FROMs, so a
# syntax pass here means "valid against the nginx this project actually ships,"
# not just "valid against whatever :alpine resolves to today."
NGINX_IMAGE="docker.io/nginxinc/nginx-unprivileged:alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083"

violations=0

# Render one branch of the chart's web ConfigMap and extract data["default.conf"]
# with yq. Mirrors scripts/check-demo-nginx-allowlist.sh's render_helm_default_conf
# — duplicated rather than shared, since the two scripts are wired into
# different CI jobs and must not develop a cross-script runtime dependency.
render_default_conf() {
  local rendered err conf
  err="$(mktemp)"
  if ! rendered="$(helm template trueppm "$HELM_CHART" --set image.tag=latest "$@" \
      --show-only templates/web/configmap.yaml 2>"$err")"; then
    echo "ERROR: helm template failed:" >&2
    cat "$err" >&2
    rm -f "$err"
    return 2
  fi
  rm -f "$err"
  conf="$(printf '%s\n' "$rendered" | yq '.data["default.conf"]' - 2>/dev/null || true)"
  if [ -z "$conf" ] || [ "$conf" = "null" ]; then
    echo "ERROR: yq extracted no data[\"default.conf\"] from the rendered ConfigMap." >&2
    return 2
  fi
  printf '%s\n' "$conf"
  return 0
}

# Run `nginx -t` against one rendered config's text. Appends to the global
# $violations counter on a syntax failure; a docker invocation failure (the
# daemon rejecting the run itself, not nginx rejecting the config) is a setup
# error and propagates as exit 2.
check_syntax() {
  local label="$1" conf_text="$2"
  local tmp out rc
  tmp="$(mktemp -d)"
  printf '%s\n' "$conf_text" >"$tmp/default.conf"

  set +e
  out="$(docker run --rm \
    --add-host api:127.0.0.1 \
    --add-host trueppm-api:127.0.0.1 \
    -v "$tmp/default.conf:/etc/nginx/conf.d/default.conf:ro" \
    "$NGINX_IMAGE" nginx -t 2>&1)"
  rc=$?
  set -e
  rm -rf "$tmp"

  # The entrypoint's own startup script runs first and can itself fail to
  # launch (image pull auth, daemon unreachable) before ever invoking nginx -t.
  # Distinguish that from an actual nginx verdict by requiring nginx's own
  # "syntax is ok" / "test failed" lines, so a docker-level fault is reported
  # as a setup error (2) rather than misread as a syntax violation (1).
  if ! grep -qE 'configuration file .* test (is successful|failed)' <<<"$out"; then
    echo "ERROR: docker run for '$label' did not reach nginx's own config test:" >&2
    echo "$out" | sed 's/^/    /' >&2
    return 2
  fi

  if [ "$rc" -eq 0 ]; then
    echo "OK [$label]: nginx -t passed."
    return 0
  fi
  echo "VIOLATION [$label]: nginx -t FAILED on the rendered config:" >&2
  echo "$out" | sed 's/^/    /' >&2
  violations=$((violations + 1))
  return 0
}

tooling_available() {
  command -v docker >/dev/null 2>&1 || return 1
  command -v helm >/dev/null 2>&1 || return 1
  command -v yq >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

run_check() {
  cd "$REPO_ROOT"

  if ! tooling_available; then
    echo "WARNING: docker, helm and/or yq are not available (or the docker daemon is" >&2
    echo "         unreachable) — the Helm nginx-syntax check was NOT run. The CI job" >&2
    echo "         this script runs in always has all three; this skip is a local-only" >&2
    echo "         fallback." >&2
    return 0
  fi

  local conf

  conf="$(render_default_conf)" || return $?
  check_syntax "helm production" "$conf" || return $?

  conf="$(render_default_conf \
    -f "$HELM_CHART/values-demo.yaml" \
    --set demo.baseUrl=https://demo.example.com \
    --set demo.shareToken.schedule=ci-schedule-token \
    --set demo.shareToken.board=ci-board-token \
    --set networkPolicy.ingressControllerConfirmed=true)" || return $?
  check_syntax "helm demo (share-link)" "$conf" || return $?

  conf="$(render_default_conf \
    -f "$HELM_CHART/values-demo.yaml" \
    --set demo.baseUrl=https://demo.example.com \
    --set demo.shareToken.schedule=ci-schedule-token \
    --set demo.shareToken.board=ci-board-token \
    --set demo.interactive=true \
    --set demo.loginHint.username=atlas-visitor \
    --set demo.loginHint.password=ci-demo-password \
    --set networkPolicy.ingressControllerConfirmed=true)" || return $?
  check_syntax "helm demo (interactive)" "$conf" || return $?

  echo ""
  if [ "$violations" -gt 0 ]; then
    echo "ERROR: $violations rendered Helm web ConfigMap variant(s) failed nginx -t." >&2
    return 1
  fi
  echo "OK: all three rendered Helm web ConfigMap variants are valid nginx syntax."
  return 0
}

self_test() {
  if ! tooling_available; then
    echo "SELF-TEST SKIPPED: docker/helm/yq unavailable locally — nginx -t cannot run (CI always has them)."
    return 0
  fi

  local rc=0

  # GOOD: a minimal, valid server block proxying to one of the literal hosts
  # this script seeds with --add-host. Proves --add-host is doing real work —
  # without it this exact fixture fails config test with "host not found in
  # upstream", which is the empirical finding the header comment documents.
  local good_conf
  good_conf='server {
    listen 8080;
    location /api/ {
        proxy_pass http://trueppm-api:8000;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
}'
  violations=0
  check_syntax "self-test good" "$good_conf" >/dev/null 2>&1 || true
  if [ "$violations" -eq 0 ]; then
    echo "SELF-TEST OK: valid config with a literal upstream host passes nginx -t."
  else
    echo "SELF-TEST FAILED: a valid config was rejected by nginx -t." >&2
    rc=1
  fi

  # BAD: a deliberately broken nginx snippet — missing semicolon AND an
  # unbalanced brace. Must FAIL nginx -t. This is the negative control: a
  # syntax checker that accepts broken nginx is worse than no checker, because
  # it reads as coverage that is not there.
  local bad_conf
  bad_conf='server {
    listen 8080;
    location /api/ {
        proxy_pass http://trueppm-api:8000
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
'
  violations=0
  check_syntax "self-test bad" "$bad_conf" >/dev/null 2>&1 || true
  if [ "$violations" -gt 0 ]; then
    echo "SELF-TEST OK: a syntactically broken config (missing ';', unbalanced brace) is rejected by nginx -t."
  else
    echo "SELF-TEST FAILED: a deliberately broken nginx snippet was NOT rejected — the syntax check is vacuous." >&2
    rc=1
  fi

  # Negative control for the yq extraction itself, same shape as
  # check-demo-nginx-allowlist.sh's: an empty/absent data["default.conf"] key
  # must be treated as a setup failure, never as "nothing to check."
  local empty_conf
  empty_conf="$(printf 'apiVersion: v1\nkind: ConfigMap\ndata:\n  other.conf: |\n    x\n' | yq '.data["default.conf"]' - 2>/dev/null || true)"
  if [ -z "$empty_conf" ] || [ "$empty_conf" = "null" ]; then
    echo "SELF-TEST OK: a rendered ConfigMap with no data[\"default.conf\"] key extracts as empty/null (would exit 2, not pass)."
  else
    echo "SELF-TEST FAILED: empty-extraction negative control did not reproduce — got: $empty_conf" >&2
    rc=1
  fi

  violations=0
  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  run_check
}

main "$@"
