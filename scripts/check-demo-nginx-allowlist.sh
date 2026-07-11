#!/usr/bin/env bash
# Public-demo nginx allowlist gate (#1763).
#
# The hosted read-only demo (try.trueppm.com, docker-compose.demo.yml) bakes a
# fixed SECRET_KEY that is safe ONLY because the demo has zero user accounts and
# no authenticated write path — access is exclusively the anonymous, read-only,
# tokenized share link (#283/#1486). A blanket `location /api/ { proxy_pass … }`
# on the demo's nginx template (the production posture) would expose the FULL
# authenticated API — auth/token, every project viewset, the Admin-only
# share-link management routes, workspace SSO, the OpenAPI schema — to the public
# internet, breaking that invariant. This gate fails the pipeline if the demo
# template ever regresses to proxying anything beyond the vetted allowlist.
#
# Invariants enforced on nginx/demo.conf.template:
#   1. Every `location` block that has `proxy_pass` must target a path in the
#      allowlist (share projections, liveness probe, Django static, loopback
#      admin). Any other proxied path — a blanket `/api/`, `/api/v1/`, `/ws/`,
#      or a specific sensitive route like `/api/v1/auth/` — is a violation.
#   2. A catch-all `location /api/` must exist and DENY (return, no proxy_pass),
#      so every non-allowlisted API route is closed rather than defaulting open.
#   3. The share-link data plane (`/api/v1/share/`) must be proxied, so the
#      demo still actually works.
#
# The production template (nginx/app-http.conf.template) is intentionally NOT
# checked — production is auth-gated with real accounts and correctly proxies
# all of /api/.
#
# Exit codes:
#   0  template satisfies the allowlist invariants
#   1  a violation (proxied non-allowlisted path, or missing deny/share rule)
#   2  invocation / setup error (template missing)
#
# Modes:
#   bash scripts/check-demo-nginx-allowlist.sh             # check the demo template
#   bash scripts/check-demo-nginx-allowlist.sh --self-test # synthesize fixtures, assert

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DEFAULT="nginx/demo.conf.template"

# Paths that MAY be proxied to the API container on the public demo. Anything
# else that proxies is a surface-widening regression.
#   /api/v1/share/   anonymous read-only share-link projections (AllowAny)
#   /api/v1/health/  liveness probe (AllowAny) for an upstream LB / ingress
#   /static/         Django-collected static assets (admin CSS, etc.)
#   /admin/          Django admin — already deny-all-but-loopback in the block
ALLOWED_PROXY_PATHS=("/api/v1/share/" "/api/v1/health/" "/static/" "/admin/")

is_allowed() {
  local p="$1" a
  for a in "${ALLOWED_PROXY_PATHS[@]}"; do
    [ "$p" = "$a" ] && return 0
  done
  return 1
}

# Emit one "path<TAB>proxy<TAB>deny" record per `location` block in the file.
# proxy=1 if the block contains proxy_pass; deny=1 if it contains a `return`.
#
# A three-state machine that is DELIBERATELY brace-position-independent: the
# opening "{" may be on the `location` line (single- or multi-line block) OR on a
# later line — the common `location …\n{` nginx style must NOT evade the gate,
# since re-opening the authenticated API in that style is exactly the regression
# this guard exists to catch (#1763 review finding). State 0 = idle; 1 = header
# seen, awaiting "{"; 2 = inside the block body, counting braces to the close.
parse_locations() {
  local template="$1"
  awk '
    function loc_path(line) {
      sub(/^[ \t]*location[ \t]+/, "", line)
      sub(/[ \t]*\{.*$/, "", line)          # strip from the first "{" if present on this line
      # strip a leading match modifier (= exact, ^~ prefix, ~/~* regex)
      sub(/^(=|\^~|~\*|~)[ \t]+/, "", line)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      return line
    }
    {
      if (state == 0 && $0 ~ /^[ \t]*location[ \t]+/) {
        path = loc_path($0); proxy = 0; deny = 0; depth = 0; state = 1
      }
      if (state >= 1) {
        if ($0 ~ /proxy_pass/) proxy = 1
        # An nginx `return <code>` directive — on its own line or inline after
        # "{". Kept simple (no leading-boundary group) for busybox-awk portability.
        if ($0 ~ /return[ \t]+[0-9]/) deny = 1
        n = gsub(/\{/, "{"); m = gsub(/\}/, "}")
        if (n > 0 && state == 1) state = 2    # the block body has now opened
        depth += n - m
        if (state == 2 && depth <= 0) {
          printf "%s\t%d\t%d\n", path, proxy, deny
          state = 0
        }
      }
    }
  ' "$template"
}

run_check() {
  local template="$1"

  if [ ! -f "$template" ]; then
    echo "ERROR: demo nginx template not found at: $template" >&2
    return 2
  fi

  local records
  records="$(parse_locations "$template")"
  if [ -z "$records" ]; then
    echo "ERROR: no location blocks parsed from $template — has the format changed?" >&2
    return 2
  fi

  local violations=0
  local saw_catchall_deny=0
  local saw_share_proxy=0
  local path proxy deny

  while IFS=$'\t' read -r path proxy deny; do
    [ -z "$path" ] && continue

    # (1) Any proxied path outside the allowlist is a surface-widening regression.
    if [ "$proxy" = "1" ] && ! is_allowed "$path"; then
      echo "VIOLATION: location '$path' proxies to the API but is not in the demo allowlist."
      echo "    The public demo must only proxy: ${ALLOWED_PROXY_PATHS[*]}"
      violations=$((violations + 1))
    fi

    # (2) The catch-all /api/ must be a deny, not a proxy.
    if [ "$path" = "/api/" ]; then
      if [ "$proxy" = "1" ]; then
        echo "VIOLATION: catch-all 'location /api/' proxies to the API — it must DENY (return 404),"
        echo "    otherwise the full authenticated API is exposed on the public demo."
        violations=$((violations + 1))
      elif [ "$deny" = "1" ]; then
        saw_catchall_deny=1
      fi
    fi

    # (3) The share data plane must be reachable.
    if [ "$path" = "/api/v1/share/" ] && [ "$proxy" = "1" ]; then
      saw_share_proxy=1
    fi
  done <<< "$records"

  if [ "$saw_catchall_deny" -ne 1 ]; then
    echo "VIOLATION: no catch-all 'location /api/ { return … }' deny found."
    echo "    Without it, any /api/ route not explicitly allowlisted defaults to open."
    violations=$((violations + 1))
  fi
  if [ "$saw_share_proxy" -ne 1 ]; then
    echo "VIOLATION: the share-link data plane 'location ^~ /api/v1/share/' is not proxied —"
    echo "    the public demo would have no reachable content."
    violations=$((violations + 1))
  fi

  echo ""
  if [ "$violations" -gt 0 ]; then
    echo "ERROR: $violations demo-nginx allowlist violation(s) in $template."
    echo "The public read-only demo must proxy ONLY the anonymous share endpoints,"
    echo "the liveness probe, static assets, and loopback admin. See #1763."
    return 1
  fi
  echo "OK: $template proxies only the vetted allowlist; the authenticated API is closed."
  return 0
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time.
  trap "rm -rf '$tmp'" EXIT

  # GOOD: allowlist template (share + health proxied, catch-all denies).
  cat >"$tmp/good.conf" <<'CONF'
server {
    location / { try_files $uri /index.html; }
    location ^~ /api/v1/share/ { proxy_pass http://api:8000; }
    location = /api/v1/health/ { proxy_pass http://api:8000; }
    location /api/ { return 404; }
    location /ws/ { return 404; }
    location /static/ { proxy_pass http://api:8000; }
}
CONF

  # BAD 1: blanket /api/ proxy (the vulnerability #1763 closes).
  cat >"$tmp/bad_blanket.conf" <<'CONF'
server {
    location ^~ /api/v1/share/ { proxy_pass http://api:8000; }
    location /api/ { proxy_pass http://api:8000; }
    location /static/ { proxy_pass http://api:8000; }
}
CONF

  # BAD 2: a specific sensitive route proxied + no catch-all deny.
  cat >"$tmp/bad_auth.conf" <<'CONF'
server {
    location ^~ /api/v1/share/ { proxy_pass http://api:8000; }
    location ^~ /api/v1/auth/ { proxy_pass http://api:8000; }
    location = /api/v1/health/ { proxy_pass http://api:8000; }
}
CONF

  # BAD 3: share data plane not proxied (demo would be empty).
  cat >"$tmp/bad_noshare.conf" <<'CONF'
server {
    location = /api/v1/health/ { proxy_pass http://api:8000; }
    location /api/ { return 404; }
}
CONF

  # BAD 4: a sensitive route re-opened with the opening brace on the NEXT line
  # (a common nginx style). The parser must NOT let this evade the gate (#1763
  # review finding), even though a catch-all deny is also present.
  cat >"$tmp/bad_nextline.conf" <<'CONF'
server {
    location ^~ /api/v1/share/ { proxy_pass http://api:8000; }
    location ^~ /api/v1/auth/
    {
        proxy_pass http://api:8000;
    }
    location /api/ { return 404; }
}
CONF

  local rc=0
  if run_check "$tmp/good.conf" >/dev/null 2>&1; then
    echo "SELF-TEST OK: allowlist template accepted."
  else
    echo "SELF-TEST FAILED: valid allowlist template was rejected." >&2; rc=1
  fi
  if run_check "$tmp/bad_blanket.conf" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: blanket /api/ proxy was accepted." >&2; rc=1
  else
    echo "SELF-TEST OK: blanket /api/ proxy correctly rejected."
  fi
  if run_check "$tmp/bad_auth.conf" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: proxied /api/v1/auth/ (+ missing deny) was accepted." >&2; rc=1
  else
    echo "SELF-TEST OK: sensitive-route proxy correctly rejected."
  fi
  if run_check "$tmp/bad_noshare.conf" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: template with no share data plane was accepted." >&2; rc=1
  else
    echo "SELF-TEST OK: missing share data plane correctly rejected."
  fi
  if run_check "$tmp/bad_nextline.conf" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: brace-on-next-line proxy of a sensitive route was accepted." >&2; rc=1
  else
    echo "SELF-TEST OK: brace-on-next-line sensitive-route proxy correctly rejected."
  fi
  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  cd "$REPO_ROOT"
  run_check "${TEMPLATE_OVERRIDE:-$TEMPLATE_DEFAULT}"
}

main "$@"
