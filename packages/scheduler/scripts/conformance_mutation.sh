#!/usr/bin/env bash
# Measure how tightly the shared conformance fixtures bind the two engines (#2637).
#
# Runs mutmut over the engine package with ONLY tests/test_wasm_conformance.py as
# the kill suite. A mutant that survives is a Python-side behavior change that no
# fixture in packages/wasm-scheduler/fixtures/ would notice: wasm:conformance and
# wasm:test both stay green while the engines diverge. A mutant killed only by a
# unit test is NOT counted, which is the difference from scheduler:mutation.
#
# This measures Class A only (the corpus does not cover the region). It cannot see
# two engines sharing one misreading of the spec: the snapshots are generated from
# Python, so a mutant toward the spec would score as killed.
#
# Usage (from anywhere, with mutmut and the scheduler's dev deps on PATH):
#   packages/scheduler/scripts/conformance_mutation.sh [only_mutate glob ...]
# Default scope is */engine/*.py, which includes engine/montecarlo/. Pass globs such
# as '*/engine/forward.py' to measure one module. The full engine is thousands of
# mutants; run it in the background. Non-gating: it prints the score and exits 0.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wasm="$(cd "$here/../wasm-scheduler" && pwd)"
globs=("$@")
[ ${#globs[@]} -gt 0 ] || globs=('*/engine/*.py')

work="$(mktemp -d "${TMPDIR:-/tmp}/conformance-mutation.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir "$work/tests"
cp -R "$here/src" "$work/src"
cp "$here/tests/test_wasm_conformance.py" "$work/tests/"
[ ! -f "$here/tests/conftest.py" ] || cp "$here/tests/conftest.py" "$work/tests/"
# Helper imported by one conformance test; it is not a kill suite (not selected below).
cp "$here/tests/__init__.py" "$here/tests/test_sub_start_floor.py" "$here/tests/test_contract_fuzz.py" "$work/tests/"
# test_wasm_conformance.py finds the fixtures at <tests>/../../wasm-scheduler, which
# inside mutmut's mutants/ sandbox resolves to <work>/wasm-scheduler.
ln -s "$wasm" "$work/wasm-scheduler"

only=""
for g in "${globs[@]}"; do only+="    \"$g\",\n"; done
{
  printf '[project]\nname = "conformance-mutation"\nversion = "0"\n'
  printf '[tool.mutmut]\nsource_paths = ["src/trueppm_scheduler"]\nonly_mutate = [\n'
  printf '%b' "$only"
  printf ']\npytest_add_cli_args_test_selection = ["tests/test_wasm_conformance.py"]\n'
} > "$work/pyproject.toml"

cd "$work"
mutmut run || true
mutmut export-cicd-stats
python3 - <<'PY'
import json

s = json.load(open("mutants/mutmut-cicd-stats.json"))
killed, survived = s.get("killed", 0), s.get("survived", 0)
scored = killed + survived
print(json.dumps(s, sort_keys=True))
if scored:
    print(f"conformance-scoped mutation score: {killed}/{scored} = {killed / scored:.1%}")
else:
    print("NOT MEASURED: no scoreable mutants")
PY
mutmut results 2>/dev/null | grep -i survived | sort || true
