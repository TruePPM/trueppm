#!/usr/bin/env bash
# scripts/tests/check-suppression-issues.test.sh
#
# Offline tests for scripts/check-suppression-issues.sh (#2603) — the gate that
# fails when a suppression outlives the issue it was waiting on.
#
# These cover the DISCOVERY half via the script's `--list` mode: which markers it
# finds, and which directories it refuses to look in. The GitLab half is not
# unit-tested (it needs a live API, as with check-issue-boundary.sh) — but the
# discovery half is where a silent failure lives. If the regex stops matching,
# the gate reports "no markers found" and exits 0, which is indistinguishable
# from a clean tree. That fail-open shape is what the gate exists to prevent, so
# it is the half worth pinning down.
#
# The marker literal is assembled from a variable in every fixture below. Writing
# it out would put a real marker inside a file that the live gate scans, and this
# file's fixtures would then be flagged as the repo's own stale suppressions.
#
# Run: bash scripts/tests/check-suppression-issues.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-suppression-issues.sh"

# Assembled, never written literally — see the note above.
MARK="SUPPRESSED-UNTIL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $1"
    fail=$((fail + 1))
  fi
}

run_list() { # sets $OUT and $RC
  set +e
  OUT="$(bash "$GATE" "$TMP/tree" --list 2>&1)"
  RC=$?
  set -e
}

# --- Nothing to find --------------------------------------------------------
rm -rf "$TMP/tree"; mkdir -p "$TMP/tree"
echo "const x = 1" > "$TMP/tree/plain.ts"
run_list
check "clean tree exits 0" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "clean tree says so" "$(echo "$OUT" | grep -q 'no .* markers found' && echo 0 || echo 1)"

# --- Finds a marker in a line comment ---------------------------------------
rm -rf "$TMP/tree"; mkdir -p "$TMP/tree"
printf '// %s(#4242)\ndisableRules: ["color-contrast"],\n' "$MARK" > "$TMP/tree/spec.ts"
run_list
check "finds marker in a // comment" "$(echo "$OUT" | grep -q '4242' && echo 0 || echo 1)"
check "reports the file it found it in" "$(echo "$OUT" | grep -q 'spec.ts' && echo 0 || echo 1)"

# --- Finds it across comment syntaxes and languages --------------------------
rm -rf "$TMP/tree"; mkdir -p "$TMP/tree"
printf '# %s(#101)\n@pytest.mark.skip\n' "$MARK" > "$TMP/tree/test_thing.py"
printf '/* %s(#202) */\n' "$MARK" > "$TMP/tree/styles.css"
printf '<!-- %s(#303) -->\n' "$MARK" > "$TMP/tree/notes.md"
run_list
for n in 101 202 303; do
  check "finds marker #$n" "$(echo "$OUT" | grep -q "$n" && echo 0 || echo 1)"
done

# --- Multiple markers for one issue are all reported -------------------------
# The gate makes one API call per unique issue but must print every site, or a
# fix would look complete after the first one.
rm -rf "$TMP/tree"; mkdir -p "$TMP/tree"
printf '// %s(#555)\n' "$MARK" > "$TMP/tree/a.ts"
printf '// %s(#555)\n' "$MARK" > "$TMP/tree/b.ts"
run_list
check "reports both sites of a repeated issue" \
  "$([ "$(echo "$OUT" | grep -c '555')" -eq 2 ] && echo 0 || echo 1)"

# --- Vendored trees are out of scope ----------------------------------------
# A marker inside node_modules is someone else's, and scanning there would make
# the gate's runtime and its false-positive rate both unbounded.
rm -rf "$TMP/tree"; mkdir -p "$TMP/tree/node_modules/pkg" "$TMP/tree/.venv/lib" "$TMP/tree/dist"
printf '// %s(#999)\n' "$MARK" > "$TMP/tree/node_modules/pkg/index.js"
printf '# %s(#998)\n' "$MARK" > "$TMP/tree/.venv/lib/mod.py"
printf '// %s(#997)\n' "$MARK" > "$TMP/tree/dist/bundle.js"
run_list
check "ignores node_modules/.venv/dist" \
  "$(echo "$OUT" | grep -qE '99[789]' && echo 1 || echo 0)"
check "and therefore reports a clean tree" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"

# --- A bare issue reference is NOT a marker ---------------------------------
# The deliberate design choice: ~32 bare `#NNNN` references sit near suppressions
# in this repo and nearly all are explanatory history. Matching them would make
# the gate mostly noise, and a noisy gate gets deleted.
rm -rf "$TMP/tree"; mkdir -p "$TMP/tree"
printf '// contrast debt fixed in #2265, exclusion dropped\ndisableRules: [],\n' > "$TMP/tree/spec.ts"
run_list
check "bare issue reference near a suppression is not a marker" \
  "$([ "$RC" -eq 0 ] && echo "$OUT" | grep -q 'no .* markers found' && echo 0 || echo 1)"

# --- The live tree's markers all parse --------------------------------------
# Guards the premise: #2603 introduced markers in packages/web/e2e/a11y.spec.ts.
# If a refactor drops or reshapes them, the gate goes quiet rather than red.
set +e
LIVE="$(bash "$GATE" "$REPO_ROOT" --list 2>&1)"
set -e
check "live tree still carries at least one marker" \
  "$(echo "$LIVE" | grep -qE '[0-9]{3,4}' && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "check-suppression-issues.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-suppression-issues.test.sh: $fail failed, $pass passed"
  exit 1
fi
