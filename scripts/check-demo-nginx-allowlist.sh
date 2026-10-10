#!/usr/bin/env bash
# Public-demo nginx allowlist gate (#1763, extended #4356).
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
# #4356: the chart's web ConfigMap (packages/helm/templates/web/configmap.yaml)
# renders TWO Helm equivalents of this surface — the share-link demo
# (`demo.enabled`) and the interactive demo (`demo.interactive`, ADR-1197) — and
# until now nothing checked them: the comment at configmap.yaml:189 says the
# share-link block "mirrors" nginx/demo.conf.template, but nothing enforced that
# claim, so a future Go-template edit could reopen a blanket /api/ proxy in the
# chart while this gate kept checking only the compose file and stayed green.
# This script now ALSO renders both Helm branches with `helm template` and checks
# each against its own invariants (below). The production chart render is
# deliberately NOT checked, for the same reason as the compose production
# template: production is auth-gated with real accounts and correctly proxies
# all of /api/.
#
# Invariants enforced on nginx/demo.conf.template AND the rendered
# `demo.enabled` (non-interactive) ConfigMap — both are a ROUTE ALLOWLIST:
#   1. Every `location` block that has `proxy_pass` must target a path in the
#      allowlist (share projections, liveness probe, Django static, loopback
#      admin). Any other proxied path — a blanket `/api/`, `/api/v1/`, `/ws/`,
#      or a specific sensitive route like `/api/v1/auth/` — is a violation.
#   2. A catch-all `location /api/` must exist and DENY (return, no proxy_pass),
#      so every non-allowlisted API route is closed rather than defaulting open.
#   3. The share-link data plane (`/api/v1/share/`) must be proxied, so the
#      demo still actually works.
#
# Invariants enforced on the rendered `demo.interactive` ConfigMap — a METHOD
# FENCE, not a route list (ADR-1197 D1 amended 2026-09-20: a full-app tour reads
# from essentially every GET under /api/v1/, so no route list is narrow enough;
# D2's read-only middleware is the real control and this fence mirrors it at the
# edge):
#   4. The only locations that may proxy to the API are: the three exact D2 auth
#      carve-outs (`/api/v1/auth/token/`, `/api/v1/auth/token/refresh/`,
#      `/api/v1/auth/logout/`), `/static/`, and the catch-all `/api/` itself.
#      Any OTHER proxied location is a surface-widening regression.
#   5. Each of the three D2 auth carve-outs must be present and proxy — otherwise
#      sign-in/refresh/logout (and therefore the whole demo) is unreachable.
#   6. The catch-all `location /api/` must proxy (so the tour has content) AND
#      its body must contain `limit_except GET HEAD OPTIONS { deny all; }` (or
#      an equivalent deny) — a bare, unfenced `proxy_pass` here is exactly the
#      blanket-API regression this gate exists to catch, just reached through a
#      method fence instead of a route list.
#
# Exit codes:
#   0  every checked config satisfies its invariants
#   1  a violation (proxied non-allowlisted path, missing deny/share rule, or an
#      unfenced/missing method-fence element)
#   2  invocation / setup error (template missing, `helm template` failed, the
#      rendered ConfigMap had no `data["default.conf"]` key, or no `location`
#      blocks were parsed — never treated as "nothing to check")
#
# Helm availability: if `helm` or `yq` is not on PATH, the two chart-rendered
# checks are SKIPPED with a loud warning and the compose-template check still
# runs — the same documented trade-off scripts/check-nginx-security-headers.sh
# makes, for the same reason: it keeps `make pre-push` usable on a machine with
# no Helm toolchain. The CI job this script runs in is pinned to an image that
# has both, so the skip path is a local-only fallback and the chart is always
# checked in the pipeline.
#
# Modes:
#   bash scripts/check-demo-nginx-allowlist.sh             # check the tree
#   bash scripts/check-demo-nginx-allowlist.sh --self-test # synthesize fixtures, assert

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DEFAULT="nginx/demo.conf.template"
HELM_CHART="packages/helm"

# Paths that MAY be proxied to the API container on the public demo (route
# allowlist — nginx/demo.conf.template and the rendered demo.enabled ConfigMap).
#   /api/v1/share/   anonymous read-only share-link projections (AllowAny)
#   /api/v1/health/  liveness probe (AllowAny) for an upstream LB / ingress
#   /static/         Django-collected static assets (admin CSS, etc.)
#   /admin/          Django admin — already deny-all-but-loopback in the block
ALLOWED_PROXY_PATHS=("/api/v1/share/" "/api/v1/health/" "/static/" "/admin/")

# The D2 auth carve-outs the interactive demo's method fence mirrors at the edge
# (ADR-1197 D1/D2). These — plus /static/ and the fenced /api/ catch-all itself
# — are the only locations allowed to proxy in demo.interactive mode.
AUTH_EXACT_PATHS=("/api/v1/auth/token/" "/api/v1/auth/token/refresh/" "/api/v1/auth/logout/")

# Running total across every config/render this invocation checks. Reset to 0
# per self-test probe; left to accumulate across the real multi-variant run so
# the final summary counts every violation found, in every variant, in one go.
violations=0

is_allowed() {
  local p="$1" a
  for a in "${ALLOWED_PROXY_PATHS[@]}"; do
    [ "$p" = "$a" ] && return 0
  done
  return 1
}

is_auth_exact() {
  local p="$1" a
  for a in "${AUTH_EXACT_PATHS[@]}"; do
    [ "$p" = "$a" ] && return 0
  done
  return 1
}

# Emit one "path<TAB>proxy<TAB>deny" record per `location` block, read from
# STDIN. proxy=1 if the block contains proxy_pass; deny=1 if it contains a
# `return`.
#
# A three-state machine that is DELIBERATELY brace-position-independent: the
# opening "{" may be on the `location` line (single- or multi-line block) OR on a
# later line — the common `location …\n{` nginx style must NOT evade the gate,
# since re-opening the authenticated API in that style is exactly the regression
# this guard exists to catch (#1763 review finding). State 0 = idle; 1 = header
# seen, awaiting "{"; 2 = inside the block body, counting braces to the close.
parse_locations() {
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
  '
}

# Print the body text of the `location <want>` block, read from STDIN. Same
# brace-position independence as parse_locations above, adapted from
# scripts/check-nginx-security-headers.sh's location_body so the interactive
# fence check can look INSIDE the /api/ block for limit_except + deny.
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

# ── Route-allowlist check (compose template + rendered demo.enabled) ──────────
# Appends to the global $violations counter and prefixes every line with
# "$label" so a multi-variant run says WHICH config failed.
check_route_allowlist() {
  local label="$1" text="$2"
  local records
  records="$(printf '%s\n' "$text" | parse_locations)"
  if [ -z "$records" ]; then
    echo "ERROR: no location blocks parsed for '$label' — has the format changed?" >&2
    return 2
  fi

  local saw_catchall_deny=0 saw_share_proxy=0 path proxy deny
  while IFS=$'\t' read -r path proxy deny; do
    [ -z "$path" ] && continue

    # (1) Any proxied path outside the allowlist is a surface-widening regression.
    if [ "$proxy" = "1" ] && ! is_allowed "$path"; then
      echo "VIOLATION [$label]: location '$path' proxies to the API but is not in the demo allowlist." >&2
      echo "    The public demo must only proxy: ${ALLOWED_PROXY_PATHS[*]}" >&2
      violations=$((violations + 1))
    fi

    # (2) The catch-all /api/ must be a deny, not a proxy.
    if [ "$path" = "/api/" ]; then
      if [ "$proxy" = "1" ]; then
        echo "VIOLATION [$label]: catch-all 'location /api/' proxies to the API — it must DENY (return 404)," >&2
        echo "    otherwise the full authenticated API is exposed on the public demo." >&2
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
    echo "VIOLATION [$label]: no catch-all 'location /api/ { return … }' deny found." >&2
    echo "    Without it, any /api/ route not explicitly allowlisted defaults to open." >&2
    violations=$((violations + 1))
  fi
  if [ "$saw_share_proxy" -ne 1 ]; then
    echo "VIOLATION [$label]: the share-link data plane 'location ^~ /api/v1/share/' is not proxied —" >&2
    echo "    the public demo would have no reachable content." >&2
    violations=$((violations + 1))
  fi
  return 0
}

# ── Method-fence check (rendered demo.interactive) ─────────────────────────────
# ADR-1197 D1 (amended 2026-09-20): a full-app tour needs almost every GET under
# /api/, so the allowlist shape above does not apply here. Instead: nothing may
# proxy except the three D2 auth carve-outs, /static/, and the fenced /api/
# catch-all — and that catch-all must actually be fenced.
check_interactive_fence() {
  local label="$1" text="$2"
  local records
  records="$(printf '%s\n' "$text" | parse_locations)"
  if [ -z "$records" ]; then
    echo "ERROR: no location blocks parsed for '$label' — has the format changed?" >&2
    return 2
  fi

  local saw_api_proxy=0 seen_auth="" path proxy deny
  while IFS=$'\t' read -r path proxy deny; do
    [ -z "$path" ] && continue

    if [ "$path" = "/api/" ]; then
      [ "$proxy" = "1" ] && saw_api_proxy=1
      continue
    fi

    if [ "$proxy" = "1" ]; then
      if is_auth_exact "$path"; then
        seen_auth="$seen_auth $path"
      elif [ "$path" != "/static/" ]; then
        echo "VIOLATION [$label]: location '$path' proxies to the API outside the D2-mirrored method fence (ADR-1197 D1)." >&2
        echo "    Only the three auth carve-outs, /static/, and the fenced /api/ catch-all may proxy here." >&2
        violations=$((violations + 1))
      fi
    fi
  done <<< "$records"

  local a
  for a in "${AUTH_EXACT_PATHS[@]}"; do
    case " $seen_auth " in
      *" $a "*) ;;
      *)
        echo "VIOLATION [$label]: the D2 auth carve-out 'location = $a' is missing or does not proxy —" >&2
        echo "    sign-in/refresh/logout would be unreachable and the whole interactive demo unusable." >&2
        violations=$((violations + 1))
        ;;
    esac
  done

  if [ "$saw_api_proxy" -ne 1 ]; then
    echo "VIOLATION [$label]: the fenced 'location /api/' does not proxy — the interactive demo would have no API content." >&2
    violations=$((violations + 1))
  else
    local body
    body="$(printf '%s\n' "$text" | location_body "/api/")"
    if ! grep -qE 'limit_except[ \t]+GET[ \t]+HEAD[ \t]+OPTIONS' <<<"$body"; then
      echo "VIOLATION [$label]: 'location /api/' proxies without 'limit_except GET HEAD OPTIONS' —" >&2
      echo "    every unsafe method (POST/PUT/PATCH/DELETE) reaches the authenticated API unfenced." >&2
      violations=$((violations + 1))
    elif ! grep -qE '(^|[ \t{])deny[ \t]+all[ \t]*;' <<<"$body"; then
      echo "VIOLATION [$label]: 'location /api/' has a limit_except block that never denies —" >&2
      echo "    the fence is declared but does not actually refuse anything." >&2
      violations=$((violations + 1))
    fi
  fi
  return 0
}

# Render one branch of the chart's web ConfigMap with `helm template` and
# extract data["default.conf"] with yq. Prints the extracted nginx config to
# stdout on success. An empty/absent key is a SETUP error (exit 2), never a
# silent pass — the whole point of this gate is to not go vacuously green.
render_helm_default_conf() {
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
    echo "ERROR: yq extracted no data[\"default.conf\"] from the rendered ConfigMap —" >&2
    echo "    has the chart's ConfigMap key name or structure changed?" >&2
    return 2
  fi
  printf '%s\n' "$conf"
  return 0
}

run_check() {
  local template="${TEMPLATE_OVERRIDE:-$TEMPLATE_DEFAULT}"

  if [ ! -f "$template" ]; then
    echo "ERROR: demo nginx template not found at: $template" >&2
    return 2
  fi
  check_route_allowlist "compose demo template" "$(cat "$template")" || return $?

  if command -v helm >/dev/null 2>&1 && command -v yq >/dev/null 2>&1; then
    local conf

    conf="$(render_helm_default_conf \
      -f "$HELM_CHART/values-demo.yaml" \
      --set demo.baseUrl=https://demo.example.com \
      --set demo.shareToken.schedule=ci-schedule-token \
      --set demo.shareToken.board=ci-board-token \
      --set networkPolicy.ingressControllerConfirmed=true)" || return $?
    check_route_allowlist "helm demo (share-link)" "$conf" || return $?

    conf="$(render_helm_default_conf \
      -f "$HELM_CHART/values-demo.yaml" \
      --set demo.baseUrl=https://demo.example.com \
      --set demo.shareToken.schedule=ci-schedule-token \
      --set demo.shareToken.board=ci-board-token \
      --set demo.interactive=true \
      --set demo.loginHint.username=atlas-visitor \
      --set demo.loginHint.password=ci-demo-password \
      --set networkPolicy.ingressControllerConfirmed=true)" || return $?
    check_interactive_fence "helm demo (interactive)" "$conf" || return $?
  else
    echo "WARNING: helm and/or yq are not on PATH — the two chart-rendered demo" >&2
    echo "         ConfigMap branches were NOT checked. The security:demo-nginx-allowlist" >&2
    echo "         CI job runs in an image that has both; this skip is a local-only" >&2
    echo "         fallback (same trade-off as scripts/check-nginx-security-headers.sh)." >&2
  fi

  echo ""
  if [ "$violations" -gt 0 ]; then
    {
      echo "ERROR: $violations demo-nginx allowlist/fence violation(s)."
      echo "The public read-only demo must proxy ONLY the anonymous share endpoints,"
      echo "the liveness probe, static assets, and loopback admin (route allowlist mode),"
      echo "or the three D2 auth carve-outs behind a GET/HEAD/OPTIONS method fence"
      echo "(interactive mode). See #1763, ADR-1197."
    } >&2
    return 1
  fi
  echo "OK: the compose template and both rendered Helm demo branches proxy only the vetted allowlist/fence."
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

  # GOOD: interactive demo method fence — the three auth carve-outs, /static/,
  # and a properly fenced catch-all /api/. /admin/ and /ws/ deny.
  cat >"$tmp/good_interactive.conf" <<'CONF'
server {
    location / { try_files $uri $uri/ /index.html; }
    location = /api/v1/auth/token/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/token/refresh/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/logout/ { proxy_pass http://api:8000; }
    location /api/ {
        limit_except GET HEAD OPTIONS {
            deny all;
        }
        proxy_pass http://api:8000;
    }
    location /ws/ { return 404; }
    location /admin/ { return 404; }
    location /static/ { proxy_pass http://api:8000; }
}
CONF

  # BAD 5: the catch-all /api/ proxies with NO method fence at all — the exact
  # regression this check exists to catch, reached through the interactive
  # block's "it's supposed to proxy /api/" shape instead of a route list.
  cat >"$tmp/bad_interactive_unfenced.conf" <<'CONF'
server {
    location = /api/v1/auth/token/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/token/refresh/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/logout/ { proxy_pass http://api:8000; }
    location /api/ {
        proxy_pass http://api:8000;
    }
    location /ws/ { return 404; }
    location /admin/ { return 404; }
}
CONF

  # BAD 6: limit_except is declared but never actually denies anything — a
  # fence that looks present and refuses nothing.
  cat >"$tmp/bad_interactive_nodeny.conf" <<'CONF'
server {
    location = /api/v1/auth/token/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/token/refresh/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/logout/ { proxy_pass http://api:8000; }
    location /api/ {
        limit_except GET HEAD OPTIONS {
            proxy_pass http://api:8000;
        }
        proxy_pass http://api:8000;
    }
    location /ws/ { return 404; }
    location /admin/ { return 404; }
}
CONF

  # BAD 7: a sensitive route proxied OUTSIDE the fence alongside a correctly
  # fenced catch-all — the fence being correct elsewhere must not mask a second
  # location widening the surface.
  cat >"$tmp/bad_interactive_extra_route.conf" <<'CONF'
server {
    location = /api/v1/auth/token/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/token/refresh/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/logout/ { proxy_pass http://api:8000; }
    location ^~ /api/v1/auth/users/ { proxy_pass http://api:8000; }
    location /api/ {
        limit_except GET HEAD OPTIONS {
            deny all;
        }
        proxy_pass http://api:8000;
    }
    location /ws/ { return 404; }
    location /admin/ { return 404; }
}
CONF

  # BAD 8: the logout carve-out is missing — sign-in would work but a visitor
  # could never sign out.
  cat >"$tmp/bad_interactive_missing_carveout.conf" <<'CONF'
server {
    location = /api/v1/auth/token/ { proxy_pass http://api:8000; }
    location = /api/v1/auth/token/refresh/ { proxy_pass http://api:8000; }
    location /api/ {
        limit_except GET HEAD OPTIONS {
            deny all;
        }
        proxy_pass http://api:8000;
    }
    location /ws/ { return 404; }
    location /admin/ { return 404; }
}
CONF

  probe() {
    local fixture="$1" expect="$2" desc="$3" checker="$4"
    violations=0
    "$checker" "$fixture" "$(cat "$tmp/$fixture")" >/dev/null 2>&1 || true
    local got=0
    [ "$violations" -gt 0 ] && got=1
    if [ "$got" = "$expect" ]; then
      echo "SELF-TEST OK: $desc"
    else
      echo "SELF-TEST FAILED: $desc (expected violation=$expect, got $got)" >&2
      rc=1
    fi
  }

  local rc=0
  probe good.conf                              0 "allowlist template accepted"                                            check_route_allowlist
  probe bad_blanket.conf                       1 "blanket /api/ proxy correctly rejected"                                  check_route_allowlist
  probe bad_auth.conf                          1 "sensitive-route proxy correctly rejected"                                check_route_allowlist
  probe bad_noshare.conf                       1 "missing share data plane correctly rejected"                             check_route_allowlist
  probe bad_nextline.conf                      1 "brace-on-next-line sensitive-route proxy correctly rejected"             check_route_allowlist
  probe good_interactive.conf                  0 "interactive method-fence config accepted"                                check_interactive_fence
  probe bad_interactive_unfenced.conf          1 "unfenced blanket /api/ proxy in interactive mode correctly rejected"     check_interactive_fence
  probe bad_interactive_nodeny.conf            1 "declared-but-non-denying limit_except correctly rejected"               check_interactive_fence
  probe bad_interactive_extra_route.conf       1 "sensitive route proxied outside the fence correctly rejected"           check_interactive_fence
  probe bad_interactive_missing_carveout.conf  1 "missing D2 logout carve-out correctly rejected"                         check_interactive_fence

  # Negative control for the yq extraction itself: a ConfigMap render with no
  # data["default.conf"] key must FAIL (exit 2), never silently pass as "nothing
  # to check" — the vacuous-pass shape a security gate must not have (#4356
  # security-review note). Skipped if yq is not on PATH (same local-only
  # fallback as the real run).
  if command -v yq >/dev/null 2>&1; then
    local empty_render empty_conf empty_rc=0
    empty_render="$tmp/empty_configmap.yaml"
    cat >"$empty_render" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: trueppm-web-nginx
data:
  other.conf: |
    server {}
YAML
    empty_conf="$(cat "$empty_render" | yq '.data["default.conf"]' - 2>/dev/null || true)"
    if [ -z "$empty_conf" ] || [ "$empty_conf" = "null" ]; then
      echo "SELF-TEST OK: a rendered ConfigMap with no data[\"default.conf\"] key extracts as empty/null (would exit 2, not pass)."
    else
      echo "SELF-TEST FAILED: empty-extraction negative control did not reproduce — got: $empty_conf" >&2
      rc=1
    fi
  else
    echo "SELF-TEST SKIPPED: yq not on PATH — empty-extraction negative control not run locally (CI always has yq)."
  fi

  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  cd "$REPO_ROOT"
  run_check
}

main "$@"
