#!/usr/bin/env bash
# scripts/check-build-system-pins.sh — the PyPI build toolchain is pinned and
# hash-verified end to end (#4717).
#
# WHY THIS EXISTS
# ----------------
# The tag publish jobs build with `python -m build` and upload with twine. When
# those tools (or the `hatchling` build backend that `[build-system].requires`
# names) are unpinned, whatever PyPI serves at tag time runs inside the job. A
# compromised release of any of them, or of one of their dependencies, executes
# next to a freshly minted OIDC identity and can publish a trojaned package that
# still carries valid PEP 740 attestations. The release jobs therefore (a) pin
# hatchling exactly in every pyproject.toml, (b) install build/twine/attestation
# tooling with `pip install --require-hashes` from the compiled
# .gitlab/ci/publish-{build,upload}.txt, and (c) build with --no-isolation so
# hatchling's own dependencies come from that hashed file too.
#
# WHAT IT CHECKS (static, no network)
#   1. every packages/*/pyproject.toml [build-system].requires entry is pinned
#      with an exact `==X.Y.Z` (no ranges, no wildcards, no bare names);
#   2. the hatchling pin equals the one in .gitlab/ci/publish-build.in, so the
#      isolated and --no-isolation builds use the same backend;
#   3. every requirement in .gitlab/ci/publish-{build,upload}.txt carries a
#      --hash (pip would refuse otherwise; this fails earlier, in pre-push);
#   4. no `pip install` line in .gitlab-ci.yml names build, twine, hatchling or
#      pypi-attestations without --require-hashes.
#
# WHAT IT CANNOT CHECK
#   That the .txt files are the faithful compile of the .in files (regenerate
#   with `uv pip compile --generate-hashes --universal --python-version 3.11`),
#   that a pinned release is itself trustworthy, or that the tag-only jobs run
#   (they cannot, until a tag).
#
# Usage: check-build-system-pins.sh [ROOT] | --self-test      (ROOT defaults to repo root)
# Exit:  0 pinned · 1 violation · 2 invocation error
set -euo pipefail

err() { printf '\033[31mVIOLATION:\033[0m %s\n' "$*" >&2; }

scan() {
  python3 - "$1" <<'PY'
import glob, os, re, sys, tomllib

root = sys.argv[1]
bad = []

# 1 + 2: [build-system].requires
hatch_in = None
inf = os.path.join(root, ".gitlab/ci/publish-build.in")
if os.path.isfile(inf):
    for line in open(inf, encoding="utf-8"):
        m = re.match(r"^hatchling==(\S+)\s*$", line.strip())
        if m:
            hatch_in = m.group(1)
if hatch_in is None:
    bad.append(".gitlab/ci/publish-build.in: no `hatchling==X` line")

EXACT = re.compile(r"^([A-Za-z0-9_.-]+)(\[[^\]]*\])?==([A-Za-z0-9_.!+-]+)$")
for path in sorted(glob.glob(os.path.join(root, "packages/*/pyproject.toml"))):
    rel = os.path.relpath(path, root)
    with open(path, "rb") as fh:
        bs = tomllib.load(fh).get("build-system")
    if bs is None:
        continue
    for req in bs.get("requires", []):
        m = EXACT.match(req.replace(" ", ""))
        if not m:
            bad.append(f"{rel}: [build-system].requires entry {req!r} is not pinned with an exact ==X.Y.Z")
        elif m.group(1).lower() == "hatchling" and hatch_in and m.group(3) != hatch_in:
            bad.append(f"{rel}: hatchling=={m.group(3)} differs from .gitlab/ci/publish-build.in (=={hatch_in})")

# 3: hashes in the compiled files
for name in ("publish-build.txt", "publish-upload.txt"):
    path = os.path.join(root, ".gitlab/ci", name)
    if not os.path.isfile(path):
        bad.append(f".gitlab/ci/{name}: missing")
        continue
    cur, hashed, n = None, False, 0
    def close():
        if cur is not None and not hashed:
            bad.append(f".gitlab/ci/{name}: {cur} has no --hash")
    for line in open(path, encoding="utf-8"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("--hash="):
            hashed = True
        else:
            close()
            cur, hashed = s.rstrip("\\ ").strip(), False
            n += 1
    close()
    if n == 0:
        bad.append(f".gitlab/ci/{name}: contains no requirements")

# 4: unhashed installs of the toolchain in the CI file
ci = os.path.join(root, ".gitlab-ci.yml")
if os.path.isfile(ci):
    tool = re.compile(r"""(?<![\w./-])(build|twine|hatchling|pypi-attestations)(?![\w./-])""")
    for i, line in enumerate(open(ci, encoding="utf-8"), 1):
        s = line.strip()
        if s.startswith("#") or "pip install" not in s:
            continue
        if tool.search(s.split("pip install", 1)[1]) and "--require-hashes" not in s:
            bad.append(f".gitlab-ci.yml:{i}: unhashed install of the build/upload toolchain: {s}")
for b in bad:
    print(b)
PY
}

run() {
  local out
  out="$(scan "$1")"
  if [ -n "$out" ]; then
    while IFS= read -r l; do err "$l"; done <<<"$out"
    echo "See scripts/check-build-system-pins.sh's header (#4717)." >&2
    return 1
  fi
  echo "OK: [build-system].requires pinned; build/upload toolchain hash-verified." >&2
}

self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  mk() { # <dir>
    mkdir -p "$1/packages/a" "$1/.gitlab/ci"
    printf '[build-system]\nrequires = ["hatchling==1.2.3"]\nbuild-backend = "hatchling.build"\n' >"$1/packages/a/pyproject.toml"
    printf 'build==1.0.0\nhatchling==1.2.3\n' >"$1/.gitlab/ci/publish-build.in"
    printf 'build==1.0.0 \\\n    --hash=sha256:aa\nhatchling==1.2.3 \\\n    --hash=sha256:bb\n' >"$1/.gitlab/ci/publish-build.txt"
    printf 'twine==7.0.0 \\\n    --hash=sha256:cc\n' >"$1/.gitlab/ci/publish-upload.txt"
    printf 'j:\n  before_script:\n    - pip install --require-hashes --no-deps -r .gitlab/ci/publish-upload.txt\n    - pip install uv==0.9.5\n' >"$1/.gitlab-ci.yml"
  }
  expect() { # <name> <pass|fail> <dir>
    if run "$3" >/dev/null 2>&1; then
      [ "$2" = pass ] && echo "SELF-TEST OK: $1 (accepted)." || { echo "SELF-TEST FAILED: $1 — accepted, expected rejection." >&2; rc=1; }
    else
      [ "$2" = fail ] && echo "SELF-TEST OK: $1 (correctly rejected)." || { echo "SELF-TEST FAILED: $1 — rejected, expected acceptance." >&2; rc=1; }
    fi
  }
  mk "$tmp/good"; expect "known-good tree" pass "$tmp/good"
  mk "$tmp/unpinned"; printf '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n' >"$tmp/unpinned/packages/a/pyproject.toml"
  expect "bare hatchling (the #4717 shape)" fail "$tmp/unpinned"
  mk "$tmp/range"; printf '[build-system]\nrequires = ["hatchling>=1.2"]\nbuild-backend = "hatchling.build"\n' >"$tmp/range/packages/a/pyproject.toml"
  expect "hatchling range" fail "$tmp/range"
  mk "$tmp/drift"; printf '[build-system]\nrequires = ["hatchling==9.9.9"]\nbuild-backend = "hatchling.build"\n' >"$tmp/drift/packages/a/pyproject.toml"
  expect "hatchling differs from publish-build.in" fail "$tmp/drift"
  mk "$tmp/nohash"; printf 'twine==7.0.0\n' >"$tmp/nohash/.gitlab/ci/publish-upload.txt"
  expect "requirement without --hash" fail "$tmp/nohash"
  mk "$tmp/ci"; printf 'j:\n  before_script:\n    - pip install build "twine>=6.1" --quiet\n' >"$tmp/ci/.gitlab-ci.yml"
  expect "unhashed pip install build/twine in CI" fail "$tmp/ci"
  [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  return "$rc"
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -d "$ROOT" ] || { echo "ERROR: '$ROOT' is not a directory." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 2; }
run "$ROOT"
