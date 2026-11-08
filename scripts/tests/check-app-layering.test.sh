#!/usr/bin/env bash
# scripts/tests/check-app-layering.test.sh
#
# Unit test for scripts/check-app-layering.py -- the gate for imports between the
# Django domain apps (#4887). Leads with the fixture import that MUST fail, then
# proves the legal shapes pass, the ratchet only goes one way, and that the real tree
# is clean against its committed baseline. Finally DISARMS the gate in a copy and
# requires its built-in self-test to notice.
#
# Run: bash scripts/tests/check-app-layering.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-app-layering.py"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <exit-code-0-means-ok>
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

PKG="$TMP/tree/packages/api/src/trueppm_api"
CFG="$TMP/cfg.toml"
BASE="$TMP/baseline.txt"
cat > "$CFG" <<'TOML'
[platform]
modules = ["core"]
[composition_roots]
modules = ["settings"]
[[layer]]
name = "low"
apps = ["base"]
[[layer]]
name = "high"
apps = ["top"]
TOML

# stage <app> -- fresh two-app tree; the module body for <app> comes from stdin.
stage() {
  rm -rf "$TMP/tree"
  mkdir -p "$PKG/apps/base" "$PKG/apps/top" "$PKG/core" "$PKG/settings"
  cat > "$PKG/apps/$1/mod.py"
  : > "$BASE"
}
run_gate() { python3 "$GATE" --root "$TMP/tree" --config "$CFG" --baseline "$BASE" >"$TMP/out" 2>&1; }

echo "check-app-layering.test.sh"

stage base <<'PY'
from trueppm_api.apps.top.models import Thing
PY
if run_gate; then rc=1; else rc=0; fi
check "a lower-layer app importing a higher one fails the gate" "$rc"
grep -q "base -> top: 1 site" "$TMP/out" && grep -q "mod.py:1" "$TMP/out" && rc=0 || rc=1
check "the failure names the edge, file and line" "$rc"

stage top <<'PY'
from trueppm_api.apps.base.models import Thing
from trueppm_api.core import util
PY
run_gate && rc=0 || rc=1
check "importing a lower layer and platform passes" "$rc"

stage base <<'PY'
def f():
    from trueppm_api.apps.top import x
PY
if run_gate; then rc=1; else rc=0; fi
check "a function-local import is still coupling" "$rc"

stage base <<'PY'
from trueppm_api.apps.top import x
PY
echo "base -> top 1" > "$BASE"
run_gate && rc=0 || rc=1
check "a baselined violation passes" "$rc"
grep -q "baseline 1 on 1 edges" "$TMP/out" && rc=0 || rc=1
check "the baseline count is printed on every run" "$rc"

stage base <<'PY'
from trueppm_api.apps.top import x
from trueppm_api.apps.top import y
PY
echo "base -> top 1" > "$BASE"
if run_gate; then rc=1; else rc=0; fi
check "a second import on a baselined edge exceeds the ceiling" "$rc"
cp "$BASE" "$TMP/base.before"
if python3 "$GATE" --root "$TMP/tree" --config "$CFG" --baseline "$BASE" --update-baseline >/dev/null 2>&1; then rc=1; else rc=0; fi
check "--update-baseline refuses to raise an entry" "$rc"
cmp -s "$BASE" "$TMP/base.before" && rc=0 || rc=1
check "a refused --update-baseline leaves the baseline untouched" "$rc"

stage base <<'PY'
from trueppm_api.core import x
PY
echo "base -> top 3" > "$BASE"
run_gate && rc=0 || rc=1
check "a fixed violation (slack) does not fail" "$rc"
grep -q "fixed since the baseline" "$TMP/out" && rc=0 || rc=1
check "slack is reported so shrinkage is visible" "$rc"
python3 "$GATE" --root "$TMP/tree" --config "$CFG" --baseline "$BASE" --update-baseline >/dev/null 2>&1 && rc=0 || rc=1
check "--update-baseline lowers the baseline" "$rc"
grep -q "base -> top" "$BASE" && rc=1 || rc=0
check "a fully fixed edge is dropped from the baseline" "$rc"

stage base <<'PY'
# layering-ok: bootstrap hook has to reach the scheduler registry
from trueppm_api.apps.top import x
PY
run_gate && rc=0 || rc=1
check "a # layering-ok: <reason> opt-out passes" "$rc"

stage base <<'PY'
from trueppm_api.apps.top import x  # layering-ok:
PY
if run_gate; then rc=1; else rc=0; fi
check "an opt-out with no reason fails" "$rc"

stage base <<'PY'
PY
mkdir -p "$PKG/apps/ghost"
if run_gate; then rc=1; else rc=0; fi
check "an app directory with no declared layer fails" "$rc"

# The real tree must be clean against its committed baseline, or the gate cannot be on.
python3 "$GATE" >"$TMP/real" 2>&1 && rc=0 || { cat "$TMP/real"; rc=1; }
check "the committed tree passes against the committed baseline" "$rc"
grep -q "^app layering: [0-9]* violating import sites" "$TMP/real" && rc=0 || rc=1
check "the real run prints the baseline total" "$rc"

# Disarm: stop the layering predicate from ever reporting a violation, then require the
# built-in self-test to notice. If it passes disarmed, the self-test proves nothing.
sed 's/return not (d == s and self.lateral\[s\])/return False  # DISARMED/' "$GATE" > "$TMP/disarmed.py"
grep -q "DISARMED" "$TMP/disarmed.py" && rc=0 || rc=1
check "the disarm mutation actually applied" "$rc"
if python3 "$TMP/disarmed.py" --self-test >/dev/null 2>&1; then rc=1; else rc=0; fi
check "the self-test fails when the gate is disarmed" "$rc"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "FAILED: $fail of $((pass + fail)) checks"
  exit 1
fi
echo "OK: $pass checks passed"
