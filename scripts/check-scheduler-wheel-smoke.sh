#!/usr/bin/env bash
# scripts/check-scheduler-wheel-smoke.sh — run a smoke subset of the scheduler test
# suite against the BUILT trueppm-scheduler wheel, not the editable src/ tree (#4544).
#
# Why. scheduler:sdist-check asserts file membership and api:wheel-install-probe
# AST-resolves symbols, but nothing executed the package as installed. A packaging
# defect that leaves every symbol resolvable yet breaks behavior (a missing data
# file, a module shadowed by the wheel layout, a build-backend change) reached PyPI.
# scheduler:test runs from `pip install -e`, where src/ would mask all of those.
#
# How.
#   1. Install the wheel into a throwaway venv in a temp dir OUTSIDE the repo.
#   2. Install only the test dependencies (pytest, hypothesis) at the specifiers the
#      wheel's own METADATA declares under the `dev` extra — no hardcoded versions.
#   3. Copy tests/ plus the three package-root data files the suite reads
#      (pyproject.toml, README.md, CHANGELOG.md) into the temp dir. NOT src/. pytest
#      runs from there, so the source tree is unreachable from sys.path.
#   4. Assert, in the interpreter pytest itself runs in (a `-p` plugin, plus a
#      pre-flight check), that trueppm_scheduler.__file__ is inside the venv's
#      site-packages. A run that quietly imported an editable copy fails.
#   5. Run test_public_surface.py and test_engine.py.
#
# --negative-control gutted-wheel mode: removes a module from a COPY of the wheel and
# requires the smoke to FAIL. A gate that has never been seen to fail proves nothing.
#
# Used by scheduler:sdist-check (via check-scheduler-sdist.sh, every MR) and
# scheduler:build (tag; publish needs build, so a failure precedes any upload).
#
# Usage:  scripts/check-scheduler-wheel-smoke.sh [--negative-control] <wheel>
# Exit:   0 pass · 1 smoke failed (or, with --negative-control, the gutted wheel passed)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO_ROOT/packages/scheduler"
SMOKE_TESTS="test_public_surface.py test_engine.py"
# Test dependencies the smoke subset + conftest import. Specifiers come from the wheel.
SMOKE_DEPS="pytest hypothesis"

# The one location assertion: pre-flight, the pytest plugin and --self-test all use it.
write_location_check() { # write_location_check <dir>
  cat > "$1/smoke_location.py" <<'PY'
"""Fail unless a module file lives inside the given site-packages directory."""
import sys
from pathlib import Path


def assert_installed(module_file, purelib):
    f, site = Path(module_file).resolve(), Path(purelib).resolve()
    if site not in f.parents:
        raise SystemExit(f"trueppm_scheduler imported from {f}, not site-packages {site}")
    return f


if __name__ == "__main__":
    if sys.argv[1:2] == ["--check"]:  # --check <module file> <purelib>
        assert_installed(*sys.argv[2:4])
    else:
        import sysconfig

        import trueppm_scheduler

        f = assert_installed(trueppm_scheduler.__file__, sysconfig.get_paths()["purelib"])
        print("trueppm_scheduler.__file__ =", f)
PY
}

if [ "${1:-}" = "--self-test" ]; then
  st="$(mktemp -d)"; trap 'rm -rf "$st"' EXIT
  write_location_check "$st"
  rc=0
  expect() { # expect <0|1> <name> <command...>
    local want="$1" name="$2" got=0; shift 2
    "$@" >/dev/null 2>&1 || got=1
    if [ "$got" -eq "$want" ]; then echo "ok   $name"; else echo "FAIL $name"; rc=1; fi
  }
  expect 0 "module inside site-packages passes" \
    python3 -I "$st/smoke_location.py" --check /v/lib/site-packages/trueppm_scheduler/__init__.py /v/lib/site-packages
  expect 1 "module from a source tree is rejected" \
    python3 -I "$st/smoke_location.py" --check /repo/packages/scheduler/src/trueppm_scheduler/__init__.py /v/lib/site-packages
  expect 1 "module from a different venv is rejected" \
    python3 -I "$st/smoke_location.py" --check /other/lib/site-packages/trueppm_scheduler/__init__.py /v/lib/site-packages
  expect 1 "no wheel argument is a usage error" bash "${BASH_SOURCE[0]}"
  expect 1 "a missing wheel is a usage error" bash "${BASH_SOURCE[0]}" /nonexistent.whl
  [ "$rc" -eq 0 ] && echo "SELF-TEST OK: check-scheduler-wheel-smoke.sh rejects shadowed imports and bad usage."
  exit "$rc"
fi

negative=0
if [ "${1:-}" = "--negative-control" ]; then negative=1; shift; fi
wheel="${1:-}"
if [ -z "$wheel" ] || [ ! -f "$wheel" ]; then
  echo "usage: $0 [--negative-control] <path to trueppm_scheduler wheel>" >&2
  exit 2
fi
wheel="$(cd "$(dirname "$wheel")" && pwd)/$(basename "$wheel")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# run_smoke <wheel> <label>; returns the smoke's status.
run_smoke() {
  local whl="$1" label="$2" venv="$work/venv-$2" root="$work/pkg-$2" guard="$work/guard"
  if command -v uv >/dev/null 2>&1; then
    UV_PYTHON_PREFERENCE=only-system uv venv --quiet --python "$(command -v python3)" "$venv"
    inst() { uv pip install --quiet --python "$venv/bin/python" "$@"; }
  else
    python3 -m venv "$venv"
    inst() { "$venv/bin/python" -m pip install --quiet "$@"; }
  fi
  inst "$whl"

  # Declared dev-extra specifiers for the smoke deps, read from the wheel METADATA.
  local reqs
  reqs="$("$venv/bin/python" -I - $SMOKE_DEPS <<'PY'
import re, sys
from importlib.metadata import requires
want = {n.lower() for n in sys.argv[1:]}
out = []
for r in requires("trueppm-scheduler") or []:
    spec, _, marker = r.partition(";")
    if "extra" not in marker or "dev" not in marker:
        continue
    name = re.split(r"[<>=!~\[ ]", spec.strip(), maxsplit=1)[0].lower()
    if name in want:
        out.append(spec.strip())
        want.discard(name)
if want:
    sys.exit(f"dev extra declares no requirement for: {sorted(want)}")
print("\n".join(out))
PY
)"
  # shellcheck disable=SC2086
  (IFS=$'\n'; inst $reqs)

  # Throwaway package root: tests + data files only. Deliberately no src/.
  mkdir -p "$root"
  cp -R "$PKG/tests" "$root/tests"
  cp "$PKG/pyproject.toml" "$PKG/README.md" "$PKG/CHANGELOG.md" "$root/"
  find "$root" -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

  mkdir -p "$guard"
  write_location_check "$guard"
  cat > "$guard/smoke_guard.py" <<'PY'
"""pytest plugin: fail the run unless trueppm_scheduler came from site-packages."""
import sys
import sysconfig

import smoke_location
import trueppm_scheduler


def pytest_configure(config):
    f = smoke_location.assert_installed(
        trueppm_scheduler.__file__, sysconfig.get_paths()["purelib"]
    )
    print(f"smoke_guard: trueppm_scheduler -> {f}", file=sys.stderr)
PY

  local py="$venv/bin/python" tests=() t
  # Pre-flight in isolated mode (-I: no PYTHONPATH, no cwd) from the throwaway root.
  (cd "$root" && "$py" -I "$guard/smoke_location.py") || return 1
  # And src/ must not be reachable from the interpreter pytest will use.
  if PYTHONPATH="$guard" "$py" -c 'import sys; sys.exit(any(p.endswith("packages/scheduler/src") for p in sys.path))'; then :; else
    echo "source tree on sys.path" >&2; return 1; fi
  for t in $SMOKE_TESTS; do tests+=("tests/$t"); done
  (cd "$root" && env -u PYTHONPATH PYTHONNOUSERSITE=1 PYTHONPATH="$guard" \
    "$py" -m pytest -p smoke_guard -p no:cacheprovider "${tests[@]}")
}

if [ "$negative" -eq 1 ]; then
  # Gut a COPY of the wheel: drop engine.py, which both smoke modules import.
  gutted="$work/gutted/$(basename "$wheel")"
  mkdir -p "$work/gutted"
  python3 - "$wheel" "$gutted" <<'PY'
import sys, zipfile
src, dst = sys.argv[1:]
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
    dropped = 0
    for i in zi.infolist():
        if i.filename.endswith("trueppm_scheduler/engine.py"):
            dropped += 1
            continue
        zo.writestr(i, zi.read(i.filename))
    assert dropped == 1, "negative control found no engine.py to remove"
PY
  if run_smoke "$gutted" neg >"$work/neg.log" 2>&1; then
    cat "$work/neg.log"
    echo "FAIL: negative control — the smoke PASSED against a wheel with engine.py removed; the gate cannot fail."
    exit 1
  fi
  echo "OK: negative control — smoke fails against a wheel with engine.py removed."
  exit 0
fi

if ! run_smoke "$wheel" real; then
  echo "FAIL: smoke tests failed against the built wheel (#4544). The installed package misbehaves where the editable tree does not." >&2
  exit 1
fi
echo "OK: smoke tests pass against the installed wheel."
