#!/usr/bin/env bash
# scripts/tests/check-bulk-create-server-version.test.sh
#
# Unit test for scripts/check-bulk-create-server-version.py -- the gate for a
# VersionedModel bulk_create that leaves server_version = 0.
#
# A gate only ever watched passing on a clean tree is indistinguishable from one that
# always passes, so this leads with the violation, then proves the correct shapes and
# the opt-out pass, then DISARMS the gate in a copy and requires the proof to fail.
#
# Run: bash scripts/tests/check-bulk-create-server-version.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-bulk-create-server-version.py"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <exit-code-0-means-ok>
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

# stage <module body from stdin> -- a fresh tree with a models module and one caller.
stage() {
  rm -rf "$TMP/tree"
  local d="$TMP/tree/packages/api/src/trueppm_api/apps/x"
  mkdir -p "$d"
  printf 'class VersionedModel:\n    pass\n\n\nclass Thing(VersionedModel):\n    pass\n' > "$d/models.py"
  cat > "$d/mod.py"
}
run_gate() { python3 "$GATE" --root "$TMP/tree" >"$TMP/out" 2>&1; }

echo "check-bulk-create-server-version.test.sh"

stage <<'PY'
def go():
    Thing.objects.bulk_create([Thing()])
PY
if run_gate; then rc=1; else rc=0; fi
check "a bulk_create with no server_version fails the gate" "$rc"
grep -q "mod.py:2 (Thing)" "$TMP/out" && rc=0 || rc=1
check "the failure names file, line and model" "$rc"

stage <<'PY'
def go(seq):
    rows = [Thing()]
    for r in rows:
        r.sync_seq = seq
    Thing.objects.bulk_create(rows)
PY
if run_gate; then rc=1; else rc=0; fi
check "setting only sync_seq (the shape that hid this class) still fails" "$rc"

stage <<'PY'
def go():
    Thing.objects.bulk_create([Thing(server_version=1)])
PY
run_gate && rc=0 || rc=1
check "server_version= on the constructor passes" "$rc"

stage <<'PY'
def go():
    rows = [Thing()]
    for r in rows:
        r.server_version = 1
    Thing.objects.bulk_create(rows)
PY
run_gate && rc=0 || rc=1
check "an assignment loop passes" "$rc"

stage <<'PY'
def go():
    # safe-bulk-create: the caller re-saves every row, which sets the counter.
    Thing.objects.bulk_create([Thing()])
PY
run_gate && rc=0 || rc=1
check "a # safe-bulk-create: opt-out passes" "$rc"

# The real tree must be clean, or the gate cannot be turned on. The counts are pinned
# on purpose: a site the scanner silently stops seeing would otherwise read as clean.
python3 "$GATE" >"$TMP/real" 2>&1 && rc=0 || { cat "$TMP/real"; rc=1; }
check "the committed tree passes the gate" "$rc"
grep -q "(11 checked, 3 unresolved" "$TMP/real" && rc=0 || rc=1
check "all 11 resolved sites and 3 unresolved receivers are accounted for" "$rc"

# Disarm: drop the one line that records a violation, then require the built-in
# self-test to notice. If this passes with the gate disarmed, the self-test proves nothing.
sed 's/result.violations.append(where)  # GATE-ARMED/pass/' "$GATE" > "$TMP/disarmed.py"
grep -q "GATE-ARMED" "$TMP/disarmed.py" && rc=1 || rc=0
check "the disarm mutation actually applied" "$rc"
if python3 "$TMP/disarmed.py" --self-test >/dev/null 2>&1; then rc=1; else rc=0; fi
check "the self-test fails when the gate is disarmed" "$rc"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "FAILED: $fail of $((pass + fail)) checks"
  exit 1
fi
echo "OK: $pass checks passed"
