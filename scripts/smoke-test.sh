#!/usr/bin/env bash
# scripts/smoke-test.sh — post-release smoke test
#
# Boots a fresh dev stack, seeds the demo project, obtains a JWT, and
# curls the key shipped endpoints. Exits 0 only if every check passes.
#
# Usage:
#   bash scripts/smoke-test.sh          # uses http://localhost:8000
#   BASE_URL=https://staging.trueppm.com bash scripts/smoke-test.sh
#
# Called by `make release-smoke` (runs against the local dev stack).

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
PASS=0
FAIL=0

green()  { printf '\033[0;32m  [pass]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
red()    { printf '\033[0;31m  [FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
header() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() {
  local label="$1" url="$2" expected_status="${3:-200}"
  local extra_args=("${@:4}")
  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" \
    "${extra_args[@]}" "$url")
  if [[ "$http_status" == "$expected_status" ]]; then
    green "$label  →  $http_status"
  else
    red "$label  →  $http_status (expected $expected_status)"
  fi
}

# ---------------------------------------------------------------------------
# 1. Ensure stack is running
# ---------------------------------------------------------------------------
header "Stack"
if ! docker compose ps --services --filter "status=running" 2>/dev/null \
    | grep -q "^api$"; then
  echo "  Starting dev stack…"
  docker compose up -d
  echo "  Waiting for API to be healthy…"
  for i in $(seq 1 30); do
    if curl -sf "$BASE_URL/api/v1/health/" > /dev/null 2>&1; then break; fi
    sleep 2
  done
fi
green "stack running"

# ---------------------------------------------------------------------------
# 2. Seed demo project (idempotent — safe to re-run)
# ---------------------------------------------------------------------------
header "Seed"
docker compose exec -T api python manage.py seed_demo_project --with-personas \
  > /dev/null 2>&1
green "seed_demo_project --with-personas"

# ---------------------------------------------------------------------------
# 3. Obtain a JWT for the demo user
# ---------------------------------------------------------------------------
header "Auth"
token_json=$(curl -sf -X POST "$BASE_URL/api/v1/auth/token/" \
  -H "Content-Type: application/json" \
  -d '{"username":"maya","password":"demo"}')
ACCESS_TOKEN=$(echo "$token_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['access'])" 2>/dev/null || true)
if [[ -n "$ACCESS_TOKEN" ]]; then
  green "JWT obtained for maya"
else
  red "JWT acquisition failed — remaining checks will use no auth"
fi

AUTH=()
if [[ -n "$ACCESS_TOKEN" ]]; then
  AUTH=(-H "Authorization: Bearer $ACCESS_TOKEN")
fi

# ---------------------------------------------------------------------------
# 4. Unauthenticated endpoints
# ---------------------------------------------------------------------------
header "Public endpoints"
check "GET /api/v1/health/" "$BASE_URL/api/v1/health/"
check "GET /api/v1/edition/" "$BASE_URL/api/v1/edition/"
check "GET /api/schema/" "$BASE_URL/api/schema/"

# ---------------------------------------------------------------------------
# 5. Authenticated endpoints
# ---------------------------------------------------------------------------
header "Authenticated endpoints"
check "GET /api/v1/auth/me/"      "$BASE_URL/api/v1/auth/me/"             200 "${AUTH[@]}"
check "GET /api/v1/projects/"     "$BASE_URL/api/v1/projects/"            200 "${AUTH[@]}"
check "GET /api/v1/tasks/"        "$BASE_URL/api/v1/tasks/"               200 "${AUTH[@]}"
check "GET /api/v1/calendars/"    "$BASE_URL/api/v1/calendars/"           200 "${AUTH[@]}"
check "GET /api/v1/resources/"    "$BASE_URL/api/v1/resources/"           200 "${AUTH[@]}"
check "GET /api/v1/project-resources/" "$BASE_URL/api/v1/project-resources/" 200 "${AUTH[@]}"
check "GET /api/v1/dependencies/" "$BASE_URL/api/v1/dependencies/"        200 "${AUTH[@]}"

# ---------------------------------------------------------------------------
# 6. Result
# ---------------------------------------------------------------------------
printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
  printf '\033[0;32m✅  All %d checks passed.\033[0m\n\n' "$PASS"
  exit 0
else
  printf '\033[0;31m❌  %d of %d checks failed.\033[0m\n\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
