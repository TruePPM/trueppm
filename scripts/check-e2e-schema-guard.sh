#!/usr/bin/env bash
# The e2e mock layer must stay bound to docs/api/openapi.json (#3440).
#
# `packages/web/e2e/fixtures/schema-guard.ts` validates every mocked API response
# against the schema the real server declares, and it is wired in by exactly one
# line — `installSchemaGuard(page)` inside `setupCatchAll`. Delete that line and
# 290 specs go back to asserting the front end against itself, with the whole
# suite still green: the failure mode of this binding is silence, which is the
# same shape as the bug it was written to close.
#
# This gate is the cheap structural half. It cannot check a payload — only the
# suite can, and `e2e/schema-guard.spec.ts` is what proves the guard still
# rejects one. What it checks in ~50ms is that nothing has quietly disarmed it:
#
#   1. `setupCatchAll` still installs the guard.
#   2. Nothing in `.gitlab-ci.yml` sets TRUEPPM_E2E_SCHEMA_GUARD. `off` disables
#      the binding outright and `report` downgrades a failure to a log line; both
#      leave a green pipeline that proves nothing.
#   3. The waiver ledger has not grown, and every waiver names an issue.
#   4. The guard's own negative-control spec is still present and still runs
#      (it is not in the config's `testIgnore`).
#
# Usage: scripts/check-e2e-schema-guard.sh [--self-test]
#
# Exit codes:
#   0  the binding is armed and the ledger has not grown
#   1  it is not (CI fails; see output)
#   2  invocation error
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The number of OPERATIONS the drift ledger is allowed to hold. This is a
# RATCHET: a run that finds fewer fails too, and asks you to lower it, so that
# every operation actually fixed is recorded here rather than absorbed silently.
# It went in at the measured count (#3440) and the only legal direction is down.
WAIVER_BUDGET=102

WAIVERS="packages/web/e2e/fixtures/schema-guard-waivers.ts"
FIXTURE="packages/web/e2e/fixtures/api-mocks.ts"
GUARD="packages/web/e2e/fixtures/schema-guard.ts"
SELFTEST_SPEC="packages/web/e2e/schema-guard.spec.ts"
PW_CONFIG="packages/web/playwright.config.ts"
CI_FILE=".gitlab-ci.yml"

# --- self-test ---------------------------------------------------------------
# A gate whose failure mode is a green pipeline has to prove it can still go red,
# in this job, on this code (#3194). Each case below runs the REAL script against
# a fixture tree, so there is no second copy of the detection to drift.
if [ "${1:-}" = "--self-test" ]; then
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0

  st_make_tree() { # <dir> — a minimal tree that PASSES
    local d="$1"
    mkdir -p "$d/packages/web/e2e/fixtures"
    printf 'export async function setupCatchAll(page: Page) {\n  installSchemaGuard(page);\n}\n' \
      > "$d/$FIXTURE"
    printf 'export function installSchemaGuard(page: Page): void {}\n' > "$d/$GUARD"
    printf 'export const SCHEMA_GUARD_WAIVERS = {\n  %s: {\n    reason:\n      %s +\n      %s,\n    allow: ["a:type"],\n  },\n};\n' \
      "'GET /api/v1/x/'" "'a reason whose issue reference lands in the '" "'second fragment, see #1234'" \
      > "$d/$WAIVERS"
    printf 'test("guard is wired", () => {});\n' > "$d/$SELFTEST_SPEC"
    printf 'export default { testIgnore: ["integration/**"] };\n' > "$d/$PW_CONFIG"
    printf 'web:e2e:\n  script:\n    - npx playwright test\n' > "$d/$CI_FILE"
  }

  st_probe() { # <name> <expect-pass|expect-fail> <dir> [budget]
    local budget="${4:-1}"
    if WAIVER_BUDGET_OVERRIDE="$budget" bash "$SELF" --root "$3" >/dev/null 2>&1; then
      if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
      else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi
    else
      if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
      else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi
    fi
  }

  d="$st_tmp/ok"; st_make_tree "$d"
  st_probe "an armed tree" expect-pass "$d"

  # (1) the one wire that makes the binding universal
  d="$st_tmp/unwired"; st_make_tree "$d"
  printf 'export async function setupCatchAll(page: Page) {\n  // guard removed\n}\n' > "$d/$FIXTURE"
  st_probe "setupCatchAll no longer installs the guard" expect-fail "$d"

  # (2) CI disabling or downgrading the guard
  d="$st_tmp/disabled"; st_make_tree "$d"
  printf 'web:e2e:\n  variables:\n    TRUEPPM_E2E_SCHEMA_GUARD: "off"\n  script:\n    - npx playwright test\n' \
    > "$d/$CI_FILE"
  st_probe "CI setting TRUEPPM_E2E_SCHEMA_GUARD=off" expect-fail "$d"
  d="$st_tmp/reported"; st_make_tree "$d"
  printf 'web:e2e:\n  script:\n    - TRUEPPM_E2E_SCHEMA_GUARD=report npx playwright test\n' > "$d/$CI_FILE"
  st_probe "CI downgrading the guard to report mode" expect-fail "$d"

  # (3) the ledger ratchet, both directions
  d="$st_tmp/grown"; st_make_tree "$d"
  printf 'export const SCHEMA_GUARD_WAIVERS = {\n  %s: {\n    reason: %s,\n    allow: ["a:type"],\n  },\n  %s: {\n    reason: %s,\n    allow: ["*"],\n  },\n};\n' \
    "'GET /api/v1/x/'" "'see #1234'" "'GET /api/v1/y/'" "'see #1234'" \
    > "$d/$WAIVERS"
  st_probe "a ledger that grew past its budget" expect-fail "$d"
  d="$st_tmp/shrunk"; st_make_tree "$d"
  st_probe "a ledger that shrank below its budget (must be recorded)" expect-fail "$d" 2

  # (4) a waiver with no issue reference
  d="$st_tmp/noissue"; st_make_tree "$d"
  printf 'export const SCHEMA_GUARD_WAIVERS = {\n  %s: {\n    reason: %s,\n    allow: ["a:type"],\n  },\n};\n' \
    "'GET /api/v1/x/'" "'flaky'" > "$d/$WAIVERS"
  st_probe "a waiver whose reason names no issue" expect-fail "$d"

  # (5) the negative control removed, or excluded from the run
  d="$st_tmp/nospec"; st_make_tree "$d"; rm "$d/$SELFTEST_SPEC"
  st_probe "the guard's negative-control spec deleted" expect-fail "$d"
  d="$st_tmp/ignored"; st_make_tree "$d"
  printf 'export default { testIgnore: ["integration/**", "schema-guard.spec.ts"] };\n' > "$d/$PW_CONFIG"
  st_probe "the negative-control spec excluded by testIgnore" expect-fail "$d"

  exit $st_rc
fi

# --- real run ----------------------------------------------------------------
if [ "${1:-}" = "--root" ]; then
  [ -n "${2:-}" ] || { echo "check-e2e-schema-guard: --root needs a directory" >&2; exit 2; }
  REPO_ROOT="$2"
fi
cd "$REPO_ROOT"
[ -n "${WAIVER_BUDGET_OVERRIDE:-}" ] && WAIVER_BUDGET="$WAIVER_BUDGET_OVERRIDE"

rc=0
fail() { echo "check-e2e-schema-guard: FAIL  $1" >&2; rc=1; }

# (1) The binding is wired into the one entry point every API-mocking spec calls.
if ! grep -q 'installSchemaGuard(page)' "$FIXTURE" 2>/dev/null; then
  fail "$FIXTURE no longer calls installSchemaGuard(page) inside setupCatchAll.
      That single line is what binds ~290 specs to docs/api/openapi.json. Without
      it the suite goes back to asserting the front end against its own fixtures,
      and stays green while doing it (#3440)."
fi
[ -f "$GUARD" ] || fail "$GUARD is missing."

# (2) Nothing in CI disables or downgrades the guard.
if grep -nE 'TRUEPPM_E2E_SCHEMA_GUARD' "$CI_FILE" >/dev/null 2>&1; then
  fail "$CI_FILE sets TRUEPPM_E2E_SCHEMA_GUARD:
$(grep -nE 'TRUEPPM_E2E_SCHEMA_GUARD' "$CI_FILE" | sed 's/^/        /')
      'off' removes the binding and 'report' turns a mismatch into a log line
      nobody reads. Both leave a green web:e2e that is evidence about the
      fixtures again. The variable exists for local measurement only."
fi

# (3) The ledger ratchet. One entry per waived operation.
if [ -f "$WAIVERS" ]; then
  # One `allow:` per waived operation, counted with -o (not `grep -c`, which
  # counts LINES and would collapse a one-line entry). Counting operations rather
  # than the pairs inside them is deliberate: the entries seeded by #3440 are
  # whole-operation waivers (`allow: ['*']` — see the ledger header), so a pair
  # count would read a later property-level SPLIT of one of them as growth.
  # Operations-still-unbound is also the number worth watching.
  # Scoped to the exported object: the file header carries a worked example and
  # an interface doc comment that both contain `allow:` and a placeholder
  # `reason:`, and counting those would make the ledger read two entries larger
  # than it is and fail the issue-reference check on documentation.
  ledger_body="$(sed -n '/^export const SCHEMA_GUARD_WAIVERS/,$p' "$WAIVERS")"
  waivers="$(printf '%s' "$ledger_body" | grep -o 'allow:' | wc -l | tr -d ' ' || true)"
  waivers="${waivers:-0}"
  if [ "$waivers" -gt "$WAIVER_BUDGET" ]; then
    fail "the schema-guard waiver ledger grew: $waivers entries, budget $WAIVER_BUDGET.
      A waiver is a place a spec is still asserting the front end against itself.
      Fix the fixture (or the serializer) instead. If a new waiver is genuinely
      the right call, raise WAIVER_BUDGET in this script in the same MR, with the
      reason in the MR description — deliberately, not as a way past red."
  elif [ "$waivers" -lt "$WAIVER_BUDGET" ]; then
    fail "the schema-guard waiver ledger shrank to $waivers entries (budget $WAIVER_BUDGET).
      That is the good direction — record it: set WAIVER_BUDGET=$waivers in
      $(basename "$SELF"). A ratchet that is not tightened is not a ratchet."
  fi
  # Every waiver must name the issue that removes it — checked per ENTRY, not per
  # `reason:` line. Prettier splits a long reason across several concatenated
  # string fragments, so a line-oriented grep would only ever see the first one
  # and would reject an entry whose issue reference landed in the second.
  missing_issue="$(printf '%s' "$ledger_body" | awk '
    /^  .[A-Z]+ \/api\/v1\// { entry = $0; has = 0; next }
    entry != "" && /#[0-9]+/    { has = 1 }
    entry != "" && /^  },/      { if (!has) print entry; entry = "" }
  ')"
  if [ -n "$missing_issue" ]; then
    fail "these waivers name no issue:
$(printf '%s' "$missing_issue" | sed 's/^/        /')
      A waiver with no issue is a bug waiting to be re-found."
  fi
else
  fail "$WAIVERS is missing — the drift ledger is the record of what is NOT bound."
fi

# (4) The negative control still exists and still runs.
[ -f "$SELFTEST_SPEC" ] || fail "$SELFTEST_SPEC is missing.
      It is the only thing proving the guard can still reject a drifted mock; a
      guard that cannot fail is indistinguishable from one that works (#3194)."
if [ -f "$PW_CONFIG" ] && grep -q 'testIgnore' "$PW_CONFIG" 2>/dev/null; then
  if sed -n '/testIgnore/,/]/p' "$PW_CONFIG" | grep -q 'schema-guard'; then
    fail "$PW_CONFIG excludes schema-guard.spec.ts from the run.
      The negative control only counts if it executes."
  fi
fi

if [ "$rc" -eq 0 ]; then
  echo "check-e2e-schema-guard: OK  guard wired, CI does not disable it, ledger at ${waivers:-0}/$WAIVER_BUDGET."
fi
exit $rc
