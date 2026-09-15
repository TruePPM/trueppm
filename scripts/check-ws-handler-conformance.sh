#!/usr/bin/env bash
# WebSocket event-to-frontend-handler conformance gate (#3775, proposed in #2845).
#
# Nothing checked whether a broadcast WS event has a frontend consumer, and the
# predictable consequence happened three times. Three independent audits each
# found a DIFFERENT slice of the same class:
#
#   #2847 — label_created/updated/deleted, task_relation_created, sprint_reranked,
#           project_restored have no handler
#   #3245 — project_calendar_changed has no handler
#   0.4 pre-release — task_relation_updated/_deleted, the signal-privacy ceiling
#           events, the velocity-suggestion events
#
# Each found what its grep happened to reach. None was looking for the others'
# findings, and none could have found them all, because the only mechanism was
# convention plus review. #2845's fix plan proposed exactly this conformance
# test and it was never built.
#
# What it checks, both directions:
#
#   1. Every event type reaching broadcast_board_event()/abroadcast_board_event()
#      in packages/api is registered by an on(...) handler in
#      packages/web/src/hooks/useProjectWebSocket.ts, or carries a waiver.
#   2. Every on(...) registration names an event something actually emits — a
#      handler for an event nothing broadcasts is dead code — or carries a waiver.
#   3. No event is registered twice. `on()` is last-write-wins
#      (`eventHandlers[type] = handler`), so a second registration silently
#      replaces the first; the hook's own comments warn about this twice.
#   4. The waiver ledger is ratcheted: every entry names a real issue, a waiver
#      whose event has since acquired a handler (or stopped being emitted) fails,
#      and each budget must equal its dict's length so the list can only shrink
#      without a deliberate, visible diff line.
#
# The emitter half is NOT a new scan. It is the AST sweep
# test_ws_event_type_set_is_frozen has used since #1019 — including the one level
# of wrapper indirection added in #1381 — moved into
# packages/api/tests/apps/sync/ws_event_scan.py so the freeze guard and this gate
# can never disagree about what the API emits.
#
# WHY A SEPARATE JOB AND NOT JUST PYTEST: api:test is gated on
# `changes: packages/api/**`. Deleting a handler is a WEB-ONLY diff, so a
# pytest-only gate would be blind to exactly the edit that breaks it. This job
# runs unconditionally on every MR and on main.
#
# Exit codes:
#   0  the two halves agree (or every disagreement is waived)
#   1  at least one conformance violation
#   2  invocation / setup error, INCLUDING "the scanner matched nothing" — a gate
#      that reports OK because it inspected nothing is worse than no gate
#
# Modes:
#   bash scripts/check-ws-handler-conformance.sh
#   bash scripts/check-ws-handler-conformance.sh --self-test

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_SRC_DEFAULT="packages/api/src/trueppm_api"
TS_DEFAULT="packages/web/src/hooks/useProjectWebSocket.ts"
PKG_ROOT_DEFAULT="packages/api"
LEDGER_DEFAULT="tests.apps.sync.ws_handler_waivers"

# run_scan <api_src> <ts_path> <ledger_module> <syspath_1> [syspath_2]
run_scan() {
  python3 - "$@" <<'PY'
import importlib
import pathlib
import sys

api_src, ts_path, ledger_module = sys.argv[1:4]
for entry in sys.argv[4:]:
    sys.path.insert(0, entry)

try:
    from tests.apps.sync.ws_event_scan import ScanError, evaluate
except ImportError as exc:  # pragma: no cover - setup fault
    sys.stderr.write(
        "ERROR: could not import the shared WS event scanner "
        "(packages/api/tests/apps/sync/ws_event_scan.py): %s\n" % exc
    )
    sys.exit(2)

try:
    ledger = importlib.import_module(ledger_module).LEDGER
except (ImportError, AttributeError) as exc:
    sys.stderr.write("ERROR: could not load LEDGER from %s: %s\n" % (ledger_module, exc))
    sys.exit(2)

try:
    violations = evaluate(pathlib.Path(api_src), pathlib.Path(ts_path), ledger)
except ScanError as exc:
    # Vacuity and setup faults are exit 2, never a quiet pass.
    sys.stderr.write("ERROR: %s\n" % exc)
    sys.exit(2)

if violations:
    sys.stderr.write("\n")
    for violation in violations:
        sys.stderr.write("VIOLATION: %s\n" % violation.render())
    sys.stderr.write(
        "\nERROR: %d WebSocket event/handler conformance violation(s).\n"
        "       Ledger: packages/api/tests/apps/sync/ws_handler_waivers.py\n" % len(violations)
    )
    sys.exit(1)

waived = len(ledger.unhandled) + len(ledger.unemitted)
print(
    "OK: every broadcast WS event has a frontend handler or a waiver "
    "(%d waived), and every handler has an emitter." % waived
)
sys.exit(0)
PY
}

# ---------------------------------------------------------------------------
# Self-test. Runs the REAL scanner and the REAL evaluator against fixture trees
# and fixture ledgers, so a neutered gate cannot pass this. A --self-test that
# asserts only the happy path proves nothing (#3194), so every case below plants
# a specific defect and asserts the gate rejects it.
# ---------------------------------------------------------------------------
_self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  mkdir -p "$tmp/ledgers"

  # mk_api <dir> <body>
  mk_api() {
    mkdir -p "$1/api"
    printf '%s\n' "$2" >"$1/api/views.py"
  }

  # mk_ts <dir> <body>
  mk_ts() {
    mkdir -p "$1"
    printf '%s\n' "$2" >"$1/hook.ts"
  }

  # mk_ledger <name> <unhandled-entries> <unemitted-entries> <unhandled-budget> <unemitted-budget>
  mk_ledger() {
    cat >"$tmp/ledgers/$1.py" <<LEDGER
from tests.apps.sync.ws_event_scan import Waiver, WaiverLedger

UNHANDLED = {$2}
UNEMITTED = {$3}
LEDGER = WaiverLedger(
    unhandled=UNHANDLED, unemitted=UNEMITTED, unhandled_budget=$4, unemitted_budget=$5
)
LEDGER
  }

  # case_run <name> <expect: pass|violation|setup-error> <dir> <ledger>
  case_run() {
    local name="$1" expect="$2" dir="$3" ledger="$4" rc=0
    run_scan "$dir/api" "$dir/hook.ts" "$ledger" "$REPO_ROOT/$PKG_ROOT_DEFAULT" "$tmp/ledgers" \
      >/dev/null 2>&1 || rc=$?
    local actual
    case "$rc" in
      0) actual="pass" ;;
      1) actual="violation" ;;
      2) actual="setup-error" ;;
      *) actual="unexpected-exit-$rc" ;;
    esac
    if [ "$actual" = "$expect" ]; then
      echo "SELF-TEST OK: $name → $actual"
      return 0
    fi
    echo "SELF-TEST FAILED: $name expected $expect, got $actual." >&2
    return 1
  }

  local EMIT_AB='def a(self):
    broadcast_board_event(project_id, "alpha_happened", {"id": 1})


def b(self):
    broadcast_board_event(project_id, "beta_happened", {"id": 2})'

  local HANDLE_AB="on(['alpha_happened', 'beta_happened'], () => {});"
  local HANDLE_A="on('alpha_happened', () => {});"

  mk_ledger empty "" "" 0 0

  # 1. Both halves agree.
  mk_api "$tmp/clean" "$EMIT_AB"
  mk_ts "$tmp/clean" "$HANDLE_AB"
  case_run "both-halves-agree" pass "$tmp/clean" empty || return 1

  # 2. THE NEGATIVE CONTROL: an emitted event with no handler and no waiver. This
  #    is the defect the gate exists for — #2847, #3245 and the 0.4 pass are all
  #    this shape. If this case passes, the gate is inert.
  mk_api "$tmp/unhandled" "$EMIT_AB"
  mk_ts "$tmp/unhandled" "$HANDLE_A"
  case_run "emitted-event-with-no-handler" violation "$tmp/unhandled" empty || return 1

  # 3. The same tree, waived.
  mk_ledger waive_beta "'beta_happened': Waiver(reason='tracked', issue=2847)," "" 1 0
  case_run "emitted-event-waived" pass "$tmp/unhandled" waive_beta || return 1

  # 4. Ratchet: the handler landed, the waiver did not come off.
  case_run "stale-waiver-handler-now-exists" violation "$tmp/clean" waive_beta || return 1

  # 5. Ratchet: a waiver for an event nothing emits any more.
  mk_ledger waive_ghost "'ghost_event': Waiver(reason='tracked', issue=1)," "" 1 0
  case_run "stale-waiver-event-no-longer-emitted" violation "$tmp/clean" waive_ghost || return 1

  # 6. Reverse direction: a handler for an event nothing broadcasts.
  mk_api "$tmp/dead" "$EMIT_AB"
  mk_ts "$tmp/dead" "on(['alpha_happened', 'beta_happened', 'never_emitted'], () => {});"
  case_run "handler-for-unemitted-event" violation "$tmp/dead" empty || return 1

  mk_ledger waive_dead "" "'never_emitted': Waiver(reason='direct consumer frame', issue=321)," 0 1
  case_run "handler-for-unemitted-event-waived" pass "$tmp/dead" waive_dead || return 1

  # 7. on() is last-write-wins — a second registration silently replaces the first.
  mk_api "$tmp/dup" "$EMIT_AB"
  mk_ts "$tmp/dup" "on('alpha_happened', () => {});
on('beta_happened', () => {});
on('alpha_happened', () => {});"
  case_run "duplicate-registration" violation "$tmp/dup" empty || return 1

  # 8. A waiver with no issue number, or no reason, is a bug waiting to be re-found.
  mk_ledger no_issue "'beta_happened': Waiver(reason='tracked', issue=0)," "" 1 0
  case_run "waiver-without-issue-number" violation "$tmp/unhandled" no_issue || return 1

  mk_ledger no_reason "'beta_happened': Waiver(reason='   ', issue=2847)," "" 1 0
  case_run "waiver-without-a-reason" violation "$tmp/unhandled" no_reason || return 1

  # The reverse-direction ledger is held to the same shape, not just the forward one.
  mk_ledger rev_no_issue "" "'never_emitted': Waiver(reason='tracked', issue=0)," 0 1
  case_run "unemitted-waiver-without-issue-number" violation "$tmp/dead" rev_no_issue || return 1

  mk_ledger rev_budget "" "'never_emitted': Waiver(reason='tracked', issue=321)," 0 0
  case_run "unemitted-waiver-budget-not-updated" violation "$tmp/dead" rev_budget || return 1

  # 9. A waiver added without raising the budget line a reviewer reads.
  mk_ledger bad_budget "'beta_happened': Waiver(reason='tracked', issue=2847)," "" 0 0
  case_run "waiver-budget-not-updated" violation "$tmp/unhandled" bad_budget || return 1

  # 10. Wrapper indirection (#1381) reaches this gate too: an event emitted only
  #     through a parameter-forwarding helper must still require a handler.
  mk_api "$tmp/wrapper" 'def _broadcast(self, event_type, payload):
    broadcast_board_event(self.project_id, event_type, payload)


def run(self):
    self._broadcast("alpha_happened", {})
    self._broadcast("wrapped_only", {})'
  mk_ts "$tmp/wrapper" "$HANDLE_A"
  case_run "wrapper-emitted-event-with-no-handler" violation "$tmp/wrapper" empty || return 1

  # 11. A prose mention of an event in a comment is NOT a handler. The hook's doc
  #     block names most event types in sentences; without comment stripping the
  #     gate would read those as coverage and pass on a real gap.
  mk_api "$tmp/prose" "$EMIT_AB"
  mk_ts "$tmp/prose" "// beta_happened is described here but never registered:
/* on(['beta_happened'], () => {}); */
$HANDLE_A"
  case_run "commented-out-registration-is-not-a-handler" violation "$tmp/prose" empty || return 1

  # 11b. Nor is an on(...) that lives inside a STRING literal — an error message,
  #      a log line, a doc string in the code. Stripping comments alone leaves this
  #      open, and it masks a real emitted-no-handler finding rather than adding a
  #      false one: exactly the silent pass the gate exists to prevent.
  mk_api "$tmp/strlit" "$EMIT_AB"
  mk_ts "$tmp/strlit" 'const msg = "register it with on(\"beta_happened\") — see the guide";
const alt = `or on("beta_happened") in a template literal`;
'"$HANDLE_A"
  case_run "on-inside-a-string-literal-is-not-a-handler" violation "$tmp/strlit" empty || return 1

  # 12/13. Vacuity — either half inspecting nothing is exit 2, never a pass.
  mk_api "$tmp/noemit" 'def a(self):
    return 1'
  mk_ts "$tmp/noemit" "$HANDLE_A"
  case_run "no-broadcast-call-sites" setup-error "$tmp/noemit" empty || return 1

  mk_api "$tmp/noreg" "$EMIT_AB"
  mk_ts "$tmp/noreg" "const x = 1;"
  case_run "no-handler-registrations" setup-error "$tmp/noreg" empty || return 1

  # 14. An on(...) the parser cannot read must be loud, not silently "no handler".
  mk_api "$tmp/opaque" "$EMIT_AB"
  mk_ts "$tmp/opaque" "$HANDLE_AB
on(EVENT_TYPES, () => {});"
  case_run "unreadable-registration-form" setup-error "$tmp/opaque" empty || return 1

  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    _self_test
    return $?
  fi
  cd "$REPO_ROOT"
  run_scan \
    "${API_SRC_OVERRIDE:-$API_SRC_DEFAULT}" \
    "${TS_OVERRIDE:-$TS_DEFAULT}" \
    "${LEDGER_OVERRIDE:-$LEDGER_DEFAULT}" \
    "${PKG_ROOT_OVERRIDE:-$PKG_ROOT_DEFAULT}"
}

main "$@"
