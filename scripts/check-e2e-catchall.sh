#!/usr/bin/env bash
# Every Playwright spec that mocks the API must register the shared catch-all
# (`setupCatchAll`) before its own routes (#2366).
#
# Without it, any endpoint the spec forgot to mock escapes the browser-level
# mocks. What happens next depends on the machine: in CI (no backend) it hits the
# preview server, and on a developer box with `make up` running it reaches the
# real API and 401s, which drives the client's token-refresh + session-teardown
# path and races the page render. Same spec, different outcome per environment —
# which is how `wave6-heatmap.spec.ts` spent months being triaged as an
# "environmental flake" (14 failed / 13 passed at --repeat-each=3; 36/36 with the
# catch-all).
#
# The catch-all answers anything unmocked with a typed 404 plus a console warning
# naming the URL, so a missing mock becomes a visible, deterministic warning
# instead of a machine-dependent race.
#
# Usage: scripts/check-e2e-catchall.sh [SPEC_DIR]
#        scripts/check-e2e-catchall.sh --self-test
#
# SPEC_DIR defaults to packages/web/e2e. A relative path is resolved from the
# repository root (the script cd's there first); an absolute path is used as
# given. It exists so --self-test can run this exact script against fixture
# trees instead of keeping a second copy of the detection greps.
#
# Exit codes:
#   0  every API-mocking spec registers the catch-all
#   1  at least one does not (CI fails; see output)
#   2  invocation error
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

if [ "${1:-}" = "--self-test" ]; then
  # A gate that cannot fail is indistinguishable from one that works (#3194).
  # This gate's detection is two greps and an allowlist, and all three ways it
  # can silently stop detecting are invisible: the mock-detection grep stops
  # matching (a spec helper gets renamed), the catch-all grep starts matching
  # everything, or the allowlist swallows a name it should not. Every case below
  # runs the REAL script against a fixture directory, so there is no second copy
  # of the patterns to drift.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_probe() { # <name> <expect-pass|expect-fail> <dir>
    if bash "$SELF" "$3" >/dev/null 2>&1; then
      if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
      else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi
    else
      if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
      else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi
    fi
  }

  # --- accept direction -----------------------------------------------------
  d="$st_tmp/ok-route"; mkdir -p "$d"
  cat > "$d/ok-route.spec.ts" <<'ST'
import { test } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

test.beforeEach(async ({ page }) => {
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/**', (route) => route.fulfill({ status: 200, body: '[]' }));
});
ST
  st_probe "page.route spec WITH setupCatchAll" expect-pass "$d"

  d="$st_tmp/ok-helper"; mkdir -p "$d"
  cat > "$d/ok-helper.spec.ts" <<'ST'
import { setupApiMocks, setupCatchAll } from './fixtures';

test.beforeEach(async ({ page }) => {
  await setupCatchAll(page);
  await setupApiMocks(page, { tasks: [] });
});
ST
  st_probe "setupApiMocks spec WITH setupCatchAll" expect-pass "$d"

  # A spec that mocks nothing has nothing to escape its mocks — the gate must
  # not demand a catch-all from it, or it becomes noisy enough to get disabled,
  # which is how the protection is really lost.
  d="$st_tmp/ok-nomocks"; mkdir -p "$d"
  cat > "$d/ok-nomocks.spec.ts" <<'ST'
import { test, expect } from '@playwright/test';

test('renders the marketing headline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
ST
  st_probe "spec that mocks nothing at all" expect-pass "$d"

  # The documented exemption: an ALLOWLIST name may mock without the catch-all.
  # Same file body as the rejected case below — only the basename differs, which
  # is exactly what the allowlist claims to control.
  d="$st_tmp/ok-allowlisted"; mkdir -p "$d"
  cat > "$d/auth.spec.ts" <<'ST'
import { test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/login/', (route) => route.fulfill({ status: 401 }));
});
ST
  st_probe "allowlisted pre-auth spec mocking without catch-all" expect-pass "$d"

  # --- reject direction -----------------------------------------------------
  d="$st_tmp/bad-route"; mkdir -p "$d"
  cat > "$d/bad-route.spec.ts" <<'ST'
import { test } from './fixtures/coverage';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/projects/**', (route) => route.fulfill({ status: 200, body: '[]' }));
});
ST
  st_probe "page.route spec WITHOUT setupCatchAll" expect-fail "$d"

  d="$st_tmp/bad-helper"; mkdir -p "$d"
  cat > "$d/bad-helper.spec.ts" <<'ST'
import { setupApiMocks } from './fixtures';

test.beforeEach(async ({ page }) => {
  await setupApiMocks(page, { tasks: [] });
});
ST
  st_probe "setupApiMocks spec WITHOUT setupCatchAll" expect-fail "$d"

  # One clean spec beside one violating spec: the gate must not be satisfied by
  # the clean one. Guards the "reports the first file and stops" regression.
  d="$st_tmp/bad-mixed"; mkdir -p "$d"
  cp "$st_tmp/ok-route/ok-route.spec.ts" "$d/aaa-clean.spec.ts"
  cp "$st_tmp/bad-route/bad-route.spec.ts" "$d/zzz-violating.spec.ts"
  st_probe "violating spec alongside a clean one" expect-fail "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

cd "$(dirname "$0")/.."
SPEC_DIR="${1:-packages/web/e2e}"

if [ ! -d "$SPEC_DIR" ]; then
  echo "ERROR: '$SPEC_DIR' is not a directory. Run from the repository root." >&2
  exit 2
fi

# Specs that legitimately need no catch-all: they render pre-auth surfaces (no
# session to tear down) or assert on the unmocked path itself. Keep this list
# short and justified — an entry here is a claim that the spec does not depend on
# API mocks at all.
ALLOWLIST=(
  # Pre-auth surfaces — no authenticated session exists to lose.
  "auth.spec.ts"
  "wave8-login.spec.ts"
  "password-reset.spec.ts"
  "invite-accept.spec.ts"
  "landing-redirect.spec.ts"
  # Static design-token assertions — makes no API calls at all.
  "brand.spec.ts"
)

is_allowlisted() {
  local name="$1"
  for entry in "${ALLOWLIST[@]}"; do
    [[ "$name" == "$entry" ]] && return 0
  done
  return 1
}

missing=()
for spec in "$SPEC_DIR"/*.spec.ts; do
  # An unmatched glob stays literal; skip it rather than grepping a missing file.
  [ -e "$spec" ] || continue
  name="$(basename "$spec")"
  is_allowlisted "$name" && continue
  # Only specs that mock the API need the catch-all.
  grep -q "page.route(\|setupApiMocks" "$spec" || continue
  grep -q "setupCatchAll" "$spec" || missing+=("$name")
done

if (( ${#missing[@]} > 0 )); then
  echo "✖ e2e specs mock the API but never call setupCatchAll:" >&2
  printf '    %s\n' "${missing[@]}" >&2
  cat >&2 <<'EOF'

Add it as the FIRST route registration in the spec's setup (later routes win):

    import { setupCatchAll } from './fixtures';
    await setupCatchAll(page);

If the spec genuinely makes no API calls, add it to ALLOWLIST in
scripts/check-e2e-catchall.sh with a one-line reason.
EOF
  exit 1
fi

echo "✅ all API-mocking e2e specs register the catch-all"
