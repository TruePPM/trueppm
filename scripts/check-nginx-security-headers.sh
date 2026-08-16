#!/usr/bin/env bash
# Cross-deployment-path nginx hardening parity gate (#2849).
#
# TruePPM ships the SPA behind nginx from FIVE separate configs, and nothing has
# ever compared them to each other:
#
#   1. nginx/app.conf.template        compose prod, TLS  (:443)
#   2. nginx/app-http.conf.template   compose prod, plain HTTP
#   3. nginx/demo.conf.template       compose public demo
#   4. packages/web/nginx.conf        BAKED INTO the published web image
#   5. packages/helm/templates/web/configmap.yaml  (prod + demo branches)
#
# Two defects came straight out of that: the Helm production branch — the path
# the docs recommend for production — served index.html and every JS bundle with
# ZERO security response headers while both compose paths set four, and the
# image-baked config still proxied /admin/ wide open and unthrottled long after
# #2569 hardened the three *rendered* configs. Both are the same shape: a fix
# applied at its instances, with nothing enumerating the instances as a set.
#
# Django's XFrameOptionsMiddleware / SECURE_CONTENT_TYPE_NOSNIFF / CSP middleware
# only decorate responses DJANGO produces. index.html and the bundles come off
# disk from nginx and never touch Django, so these headers are the only ones the
# document that runs the whole application ever carries.
#
# Invariants, asserted on every config above:
#
#   A. Every server block that serves the SPA (identified by a `try_files …
#      /index.html` fallback — the ACME/redirect listener is correctly exempt)
#      sets all three of:
#        - add_header X-Frame-Options        "DENY"     always
#        - add_header X-Content-Type-Options "nosniff"  always
#        - add_header Content-Security-Policy "…"       always
#      The CSP must contain `default-src 'self'` and `frame-ancestors 'none'`.
#      `always` is load-bearing: without it nginx skips the header on 4xx/5xx.
#   B. Any server block that terminates TLS (`listen … ssl`) additionally sets
#      Strict-Transport-Security. Plain-HTTP listeners are exempt — HSTS over a
#      non-secure transport is ignored by browsers (RFC 6797 §8.1).
#   C. Every `location /admin/` in every config is fail-closed: either it
#      `return`s (404 — the path does not exist on the public listener), or it
#      pairs a `deny all` with a `limit_req`. An /admin/ proxy with neither is
#      an unthrottled credential-guessing surface against the superuser the
#      bootstrap step guarantees exists (#2569).
#
# The Helm renders are included by shelling out to `helm template`. If helm is
# not on PATH the static configs are still checked and the Helm halves are
# reported as SKIPPED — the CI job runs in an image that has helm, so the full
# set is always covered there.
#
# Exit codes:
#   0  every config satisfies the baseline
#   1  a violation
#   2  invocation / setup error (a config file has gone missing or unparseable)
#
# Modes:
#   bash scripts/check-nginx-security-headers.sh             # check the tree
#   bash scripts/check-nginx-security-headers.sh --self-test # synthesized fixtures

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="packages/helm"

violations=0
checked_blocks=0
checked_admin=0
skipped_helm=0

note()  { echo "  $*"; }
viol()  { echo "VIOLATION [$1]: ${*:2}" >&2; violations=$((violations + 1)); }

# ── Block extraction ─────────────────────────────────────────────────────────
# Emit "<block-index>\t<line>" for every line inside a top-level `server { … }`.
# Brace-counted rather than line-anchored so an added nested block (map, if,
# location) cannot shift the boundary. Deliberately tolerant of the `server`
# keyword and its brace being on separate lines.
split_server_blocks() {
  awk '
    {
      line = $0
      if (!inblk && (line ~ /^[ \t]*server[ \t]*\{/ || line ~ /^[ \t]*server[ \t]*$/)) {
        blk++; inblk = 1; depth = 0; opened = 0
      }
      if (inblk) {
        print blk "\t" line
        tmp = line
        o = gsub(/\{/, "{", tmp)
        c = gsub(/\}/, "}", tmp)
        if (o > 0) opened = 1
        depth += o - c
        if (opened && depth <= 0) inblk = 0
      }
    }
  '
}

# Body of a `location <path>` block, brace-position-independent (the opening
# brace may sit on the location line or the next one).
location_body() {
  local want="$1"
  awk -v want="$want" '
    function loc_path(line) {
      sub(/^[ \t]*location[ \t]+/, "", line)
      sub(/[ \t]*\{.*$/, "", line)
      sub(/^(=|\^~|~\*|~)[ \t]+/, "", line)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      return line
    }
    {
      if (state == 0 && $0 ~ /^[ \t]*location[ \t]+/) {
        path = loc_path($0); depth = 0; state = 1; buf = ""
      }
      if (state >= 1) {
        buf = buf $0 "\n"
        tmp = $0
        n = gsub(/\{/, "{", tmp); m = gsub(/\}/, "}", tmp)
        if (n > 0 && state == 1) state = 2
        depth += n - m
        if (state == 2 && depth <= 0) {
          if (path == want) printf "%s", buf
          state = 0
        }
      }
    }
  '
}

# ── Per-config assertions ────────────────────────────────────────────────────
check_config() {
  local label="$1" text="$2"

  local blocks
  blocks="$(printf '%s\n' "$text" | split_server_blocks)"
  if [ -z "$blocks" ]; then
    echo "ERROR: no server blocks parsed from '$label' — has the format changed?" >&2
    return 2
  fi

  local idx body
  for idx in $(printf '%s\n' "$blocks" | cut -f1 | sort -un); do
    body="$(printf '%s\n' "$blocks" | awk -F'\t' -v b="$idx" '$1 == b { sub(/^[^\t]*\t/, ""); print }')"

    # (C) /admin/ must be fail-closed wherever it appears — including on a
    #     listener that serves no documents.
    local admin
    admin="$(printf '%s\n' "$body" | location_body "/admin/" || true)"
    if [ -n "$admin" ]; then
      checked_admin=$((checked_admin + 1))
      if printf '%s\n' "$admin" | grep -qE '(^|[ \t{])return[ \t]+[0-9]'; then
        : # closed outright — the path does not exist on this listener
      else
        printf '%s\n' "$admin" | grep -qE '(^|[ \t{])deny[ \t]+all[ \t]*;' \
          || viol "$label" "location /admin/ proxies without a \`deny all\` — a default install publishes the Django admin login (#2569)."
        printf '%s\n' "$admin" | grep -q 'limit_req[ \t]' \
          || viol "$label" "location /admin/ proxies without a \`limit_req\` — Django admin is a plain Django view, so no DRF throttle covers it (#2569)."
      fi
    fi

    # (A) Only blocks that actually serve the SPA document need the header set.
    #     The compose :80 ACME/redirect listener serves no document and is exempt.
    printf '%s\n' "$body" | grep -q 'try_files.*index\.html' || continue
    checked_blocks=$((checked_blocks + 1))

    printf '%s\n' "$body" | grep -qE 'add_header[ \t]+X-Frame-Options[ \t]+"?DENY"?[ \t]+always' \
      || viol "$label" "SPA server block #$idx does not set \`add_header X-Frame-Options \"DENY\" always\` — the document is framable for clickjacking."
    printf '%s\n' "$body" | grep -qE 'add_header[ \t]+X-Content-Type-Options[ \t]+"?nosniff"?[ \t]+always' \
      || viol "$label" "SPA server block #$idx does not set \`add_header X-Content-Type-Options \"nosniff\" always\`."

    local csp
    csp="$(printf '%s\n' "$body" | grep -E 'add_header[ \t]+Content-Security-Policy' || true)"
    if [ -z "$csp" ]; then
      viol "$label" "SPA server block #$idx sets no Content-Security-Policy."
    else
      printf '%s\n' "$csp" | grep -q 'always' \
        || viol "$label" "SPA server block #$idx sets a CSP without \`always\` — nginx then omits it on every 4xx/5xx response."
      printf '%s\n' "$csp" | grep -q "default-src 'self'" \
        || viol "$label" "SPA server block #$idx CSP has no \`default-src 'self'\` baseline."
      printf '%s\n' "$csp" | grep -q "frame-ancestors 'none'" \
        || viol "$label" "SPA server block #$idx CSP has no \`frame-ancestors 'none'\` (the modern counterpart to X-Frame-Options)."
    fi

    # (B) HSTS only where TLS actually terminates.
    if printf '%s\n' "$body" | grep -qE '(^|[ \t{])listen[ \t].*ssl'; then
      printf '%s\n' "$body" | grep -qE 'add_header[ \t]+Strict-Transport-Security' \
        || viol "$label" "SPA server block #$idx terminates TLS but sets no Strict-Transport-Security."
    fi
  done
  return 0
}

check_file() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "ERROR: expected nginx config not found: $path" >&2
    return 2
  fi
  check_config "$label" "$(cat "$path")"
}

# Render one branch of the chart's web ConfigMap and check the nginx it emits.
check_helm() {
  local label="$1"; shift
  local rendered
  if ! rendered="$(helm template trueppm "$CHART" --set image.tag=latest "$@" \
      --show-only templates/web/configmap.yaml 2>&1)"; then
    echo "ERROR: helm template failed for '$label':" >&2
    printf '%s\n' "$rendered" >&2
    return 2
  fi
  # The ConfigMap carries the nginx config as a `|` block scalar under
  # data["default.conf"]. Strip the YAML wrapper so brace counting sees only
  # nginx. yq would be cleaner but is not guaranteed on PATH here.
  local conf
  conf="$(printf '%s\n' "$rendered" | awk '
    /^  default\.conf: \|/ { grab = 1; next }
    grab {
      if ($0 ~ /^[^ ]/ || ($0 ~ /^ [^ ]/)) { grab = 0; next }
      sub(/^    /, "")
      print
    }
  ')"
  if [ -z "$conf" ]; then
    echo "ERROR: could not extract data[\"default.conf\"] from the rendered '$label' ConfigMap." >&2
    return 2
  fi
  check_config "$label" "$conf"
}

run_check() {
  cd "$REPO_ROOT"
  echo "nginx hardening parity — checking every deployment path's rendered config"
  echo ""

  check_file "compose prod (TLS)"  "nginx/app.conf.template"
  check_file "compose prod (HTTP)" "nginx/app-http.conf.template"
  check_file "compose demo"        "nginx/demo.conf.template"
  check_file "baked web image"     "packages/web/nginx.conf"

  if command -v helm >/dev/null 2>&1; then
    check_helm "helm production"
    check_helm "helm demo" \
      -f "$CHART/values-demo.yaml" \
      --set demo.baseUrl=https://demo.example.com \
      --set demo.shareToken.schedule=ci-schedule-token \
      --set demo.shareToken.board=ci-board-token
  else
    skipped_helm=1
    echo "WARNING: helm is not on PATH — the two Helm-rendered configs were NOT checked." >&2
    echo "         The nginx:headers CI job runs in an image that has helm." >&2
  fi

  echo ""
  if [ "$violations" -gt 0 ]; then
    {
      echo "ERROR: $violations nginx hardening parity violation(s)."
      echo "Every deployment path must agree on the SPA security-header baseline and on"
      echo "a fail-closed /admin/. Fixing one path and not its siblings is the exact"
      echo "defect class this gate exists to catch (#2849)."
    } >&2
    return 1
  fi
  note "$checked_blocks SPA server block(s) carry X-Frame-Options + nosniff + CSP (and HSTS where TLS terminates)"
  note "$checked_admin /admin/ location(s) are fail-closed (return, or deny all + limit_req)"
  [ "$skipped_helm" -eq 1 ] && note "helm renders SKIPPED (helm not on PATH)"
  echo "OK: all deployment paths agree on the nginx hardening baseline."
  return 0
}

# ── Self-test ────────────────────────────────────────────────────────────────
# A gate nobody has watched fail is indistinguishable from one with a typo in
# its pattern, so every fixture below is checked in BOTH directions.
self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time.
  trap "rm -rf '$tmp'" EXIT

  local GOOD_HEADERS='        add_header X-Frame-Options        "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "default-src '"'"'self'"'"'; frame-ancestors '"'"'none'"'"'" always;'

  # GOOD: headers present, /admin/ deny+limit_req, plus a redirect-only listener
  # that legitimately carries no headers.
  cat >"$tmp/good.conf" <<CONF
server {
    listen 80;
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    add_header Strict-Transport-Security "max-age=63072000" always;
$GOOD_HEADERS
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ {
        allow 127.0.0.1;
        deny all;
        limit_req zone=admin_login burst=2 nodelay;
        proxy_pass http://api:8000;
    }
}
CONF

  # GOOD: /admin/ closed outright, plain HTTP listener needs no HSTS.
  cat >"$tmp/good_404.conf" <<CONF
server {
    listen 8080;
$GOOD_HEADERS
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ { return 404; }
}
CONF

  # BAD 1: the Helm production shape — SPA served with no headers at all.
  cat >"$tmp/bad_noheaders.conf" <<CONF
server {
    listen 8080;
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ { return 404; }
}
CONF

  # BAD 2: the pre-#2569 baked-image shape — /admin/ proxied wide open.
  cat >"$tmp/bad_admin.conf" <<CONF
server {
    listen 8080;
$GOOD_HEADERS
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ {
        proxy_pass http://api:8000;
        proxy_set_header Host \$host;
    }
}
CONF

  # BAD 3: allow/deny present but unthrottled.
  cat >"$tmp/bad_nolimit.conf" <<CONF
server {
    listen 8080;
$GOOD_HEADERS
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://api:8000;
    }
}
CONF

  # BAD 4: headers set but without `always` — silently absent on every error page.
  cat >"$tmp/bad_notalways.conf" <<CONF
server {
    listen 8080;
    add_header X-Frame-Options        "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "default-src 'self'; frame-ancestors 'none'";
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ { return 404; }
}
CONF

  # BAD 5: TLS listener with no HSTS.
  cat >"$tmp/bad_nohsts.conf" <<CONF
server {
    listen 443 ssl;
$GOOD_HEADERS
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ { return 404; }
}
CONF

  # BAD 6: a CSP that omits frame-ancestors.
  cat >"$tmp/bad_csp.conf" <<CONF
server {
    listen 8080;
    add_header X-Frame-Options        "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "default-src 'self'" always;
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/ { return 404; }
}
CONF

  # BAD 7: /admin/ proxied with the opening brace on the NEXT line — a common
  # nginx style that must not evade the parser.
  cat >"$tmp/bad_nextline.conf" <<CONF
server {
    listen 8080;
$GOOD_HEADERS
    location / { try_files \$uri \$uri/ /index.html; }
    location /admin/
    {
        proxy_pass http://api:8000;
    }
}
CONF

  probe() {
    local fixture="$1" expect="$2" desc="$3"
    violations=0; checked_blocks=0; checked_admin=0
    local got=0
    check_config "$fixture" "$(cat "$tmp/$fixture")" >/dev/null 2>&1 || true
    [ "$violations" -gt 0 ] && got=1
    if [ "$got" = "$expect" ]; then
      echo "SELF-TEST OK: $desc"
    else
      echo "SELF-TEST FAILED: $desc (expected violation=$expect, got $got)" >&2
      rc=1
    fi
  }

  probe good.conf          0 "hardened config with a redirect-only listener accepted"
  probe good_404.conf      0 "plain-HTTP config with /admin/ closed accepted"
  probe bad_noheaders.conf 1 "SPA served with no security headers rejected"
  probe bad_admin.conf     1 "wide-open /admin/ proxy rejected"
  probe bad_nolimit.conf   1 "unthrottled /admin/ proxy rejected"
  probe bad_notalways.conf 1 "CSP without \`always\` rejected"
  probe bad_nohsts.conf    1 "TLS listener without HSTS rejected"
  probe bad_csp.conf       1 "CSP without frame-ancestors rejected"
  probe bad_nextline.conf  1 "brace-on-next-line /admin/ proxy rejected"

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
