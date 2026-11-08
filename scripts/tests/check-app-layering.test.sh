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

# A git hook exports these; fixtures must not inherit the real repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR

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
  : > "$PKG/apps/base/__init__.py"; : > "$PKG/apps/top/__init__.py"
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
grep -q "have been fixed" "$TMP/out" && rc=0 || rc=1
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
mkdir -p "$PKG/apps/ghost" && : > "$PKG/apps/ghost/__init__.py"
if run_gate; then rc=1; else rc=0; fi
check "an app directory with no declared layer fails" "$rc"

stage base <<'PY'
# layering-ok: stale, separated by a blank line

from trueppm_api.apps.top import x
PY
if run_gate; then rc=1; else rc=0; fi
check "a marker separated from the import by a blank line does not apply" "$rc"

stage base <<'PY'
# layering-ok: sanctioned hook
from trueppm_api.apps.top import x
PY
run_gate; grep -q "1 opted out" "$TMP/out" && rc=0 || rc=1
check "the opted-out site count is printed on every run" "$rc"

printf 'from trueppm_api.apps.base import x\n' > "$TMP/legal.py"
stage top < "$TMP/legal.py"
python3 "$GATE" --root "$TMP/tree" --config "$CFG" --graph >"$TMP/out" 2>&1; grep -q "top -> base" "$TMP/out" && rc=1 || rc=0
check "--graph lists only violating edges" "$rc"
python3 "$GATE" --root "$TMP/tree" --config "$CFG" --graph --all >"$TMP/out" 2>&1; grep -q "top -> base 1" "$TMP/out" && rc=0 || rc=1
check "--graph --all lists every edge with its site count" "$rc"

# Baseline-raise check against the merge base, in a throwaway git repo.
stage base <<'PY'
from trueppm_api.apps.top import x
PY
echo "base -> top 1" > "$BASE"
G="$TMP/tree"
git -C "$G" init -q && git -C "$G" -c user.email=t@t -c user.name=t add -A >/dev/null
mkdir -p "$G/packages/api" && cp "$BASE" "$G/packages/api/app-layering-baseline.txt"
cp "$CFG" "$G/packages/api/app-layering.toml"
git -C "$G" add -A && git -C "$G" -c user.email=t@t -c user.name=t commit -qm base
BASE_SHA="$(git -C "$G" rev-parse HEAD)"
env_gate() { env TRUEPPM_LAYERING_BASE_REF="$BASE_SHA" "$@" python3 "$GATE" --root "$G" >"$TMP/out" 2>&1; }
env_gate && rc=0 || rc=1
check "an unchanged committed baseline passes the merge-base check" "$rc"
printf '# h\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
printf 'from trueppm_api.apps.top import x\nfrom trueppm_api.apps.top import y\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
if env_gate; then rc=1; else rc=0; fi
check "a hand-raised baseline count fails the merge-base check" "$rc"
grep -q "BASELINE RAISED" "$TMP/out" && rc=0 || rc=1
check "the raise failure names the edge" "$rc"
printf '# h\n# raise-ok: deliberate re-layering, see MR\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
env_gate && rc=0 || rc=1
check "a # raise-ok: <reason> above the edge permits the raise" "$rc"
printf '# h\n# raise-ok:\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
if env_gate; then rc=1; else rc=0; fi
check "a # raise-ok: with no reason fails" "$rc"
printf '# h\n# raise-ok:\nbase -> top 1\n' > "$G/packages/api/app-layering-baseline.txt"
printf 'from trueppm_api.apps.top import x\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
if env_gate; then rc=1; else rc=0; fi
check "a reasonless # raise-ok: fails even when nothing was raised" "$rc"
printf 'from trueppm_api.apps.top import x\nfrom trueppm_api.apps.top import y\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
printf '# h\n# raise-ok: reason\n\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
if env_gate; then rc=1; else rc=0; fi
check "a # raise-ok: not directly above the edge does not apply" "$rc"
printf '# h\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
if env_gate TRUEPPM_LAYERING_BASE_REF=deadbeef; then rc=1; else rc=0; fi
check "an unreachable explicit base ref FAILS (fails closed)" "$rc"
if env_gate CI_MERGE_REQUEST_DIFF_BASE_SHA=deadbeef TRUEPPM_LAYERING_BASE_REF=; then rc=1; else rc=0; fi
check "an unreachable CI diff-base SHA FAILS (fails closed)" "$rc"
env -u TRUEPPM_LAYERING_BASE_REF -u CI_MERGE_REQUEST_DIFF_BASE_SHA python3 "$GATE" --root "$G" >"$TMP/out" 2>&1 && rc=0 || rc=1
check "with no CI variable and no origin/main the check is skipped" "$rc"
grep -q "skipped" "$TMP/out" && rc=0 || rc=1
check "the local skip is announced" "$rc"

# A marker already present at the base was spent by the MR that added it.
printf '# h\n# raise-ok: first deliberate raise\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
printf 'from trueppm_api.apps.top import x\nfrom trueppm_api.apps.top import y\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
git -C "$G" add -A && git -C "$G" -c user.email=t@t -c user.name=t commit -qm marker
BASE2="$(git -C "$G" rev-parse HEAD)"
printf '# h\n# raise-ok: first deliberate raise\nbase -> top 3\n' > "$G/packages/api/app-layering-baseline.txt"
printf 'from trueppm_api.apps.top import x\nfrom trueppm_api.apps.top import y\nfrom trueppm_api.apps.top import z\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
if env TRUEPPM_LAYERING_BASE_REF="$BASE2" python3 "$GATE" --root "$G" >"$TMP/out" 2>&1; then rc=1; else rc=0; fi
check "a marker already present at the base does not license a further raise" "$rc"
printf '# h\n# raise-ok: second raise, new marker text\nbase -> top 3\n' > "$G/packages/api/app-layering-baseline.txt"
printf '# h\nbase -> top 2\n' > "$TMP/b.txt"
# --update-baseline drops a marker whose edge is no longer above the base count
printf '# h\n# raise-ok: spent\nbase -> top 2\n' > "$G/packages/api/app-layering-baseline.txt"
printf 'from trueppm_api.apps.top import x\nfrom trueppm_api.apps.top import y\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
env TRUEPPM_LAYERING_BASE_REF="$BASE2" python3 "$GATE" --root "$G" --update-baseline >/dev/null 2>&1 || true
grep -q "^# raise-ok: spent" "$G/packages/api/app-layering-baseline.txt" && rc=1 || rc=0
check "--update-baseline drops a marker whose edge is no longer above the base count" "$rc"

# A git failure inside a work tree is an error, never a fallback to walking the filesystem.
mkdir -p "$TMP/shim"
printf '#!/bin/sh\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n' > "$TMP/shim/git"
chmod +x "$TMP/shim/git"
if PATH="$TMP/shim:$PATH" python3 "$GATE" --root "$G" >"$TMP/out" 2>&1; then rc=1; else rc=0; fi
check "a git failure inside a work tree is an error, not a silent walk" "$rc"
grep -q "dubious ownership" "$TMP/out" && rc=0 || rc=1
check "the git failure is reported" "$rc"

# Untracked residue must not be read: a leftover dir and a stray .py with violations.
printf '# h\nbase -> top 1\n' > "$G/packages/api/app-layering-baseline.txt"
printf 'from trueppm_api.apps.top import x\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/mod.py"
mkdir -p "$G/packages/api/src/trueppm_api/apps/workshops/migrations"
echo 'x = 1' > "$G/packages/api/src/trueppm_api/apps/workshops/migrations/0001.py"
printf 'from trueppm_api.apps.top import y\nfrom trueppm_api.apps.top import z\n' > "$G/$(echo "${PKG#$TMP/tree/}")/apps/base/scratch.py"
env_gate && rc=0 || rc=1
check "an untracked residue dir and an untracked stray .py are ignored in a git checkout" "$rc"

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
