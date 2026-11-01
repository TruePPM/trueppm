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
#   4. no `pip install` line (backslash continuations joined) in .gitlab-ci.yml
#      names build, twine, hatchling or pypi-attestations without
#      --require-hashes;
#   5. publish-build.txt pins the same hatchling== as publish-build.in;
#   6. a job that declares PYPI_ID_TOKEN runs no `python -m build` and no
#      `pip install` other than `--require-hashes -r .gitlab/ci/publish-upload.txt`
#      (the issue's core invariant: nothing but the hashed upload tools runs
#      while the OIDC tokens exist). ci:pypi-mint-probe is exempt by name: it is
#      the manual PYPI_PROBE mirror that builds and holds tokens in one job, with
#      every tool hash-pinned. The install must be exactly one `pip install`
#      whose only `-r` is that file (a longer name such as `.../publish-upload.txt.x`
#      fails) plus --require-hashes/--no-deps/--quiet; `pip3.11 install`, a second
#      `pip install` or extra `-r` on the line, and `python3 -m build` / `uv build` /
#      `pyproject-build` are all recognized. Comment lines are dropped before
#      backslash continuations are joined.
#
# STILL NOT HANDLED (text-based, not a resolved-YAML audit): `extends:` and
# `default:` are not followed, so a token-holding job inheriting a script from a
# template escapes it; `!reference` bodies other than the pip-floor are not
# expanded; an install or build hidden in a script file the job calls
# (`bash foo.sh`), a `python -m pip install` spelling, `pipx`, `uv pip install`,
# or an install assembled from variables is not seen; and top-level job
# detection assumes a job key at column 0 ending in `:`.
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
EXEMPT = {"ci:pypi-mint-probe"}
LOGS = {}

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

# 5: the compiled build file pins the same hatchling as the .in
txt = os.path.join(root, ".gitlab/ci/publish-build.txt")
if os.path.isfile(txt) and hatch_in:
    pinned = [m.group(1) for m in (re.match(r"^hatchling==(\S+)", l.strip()) for l in open(txt, encoding="utf-8")) if m]
    if pinned != [hatch_in]:
        bad.append(f".gitlab/ci/publish-build.txt: hatchling pin {pinned or 'missing'} != publish-build.in (=={hatch_in})")

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

# 4 + 6: toolchain installs in the CI file (comments dropped, then continuations joined)
ci = os.path.join(root, ".gitlab-ci.yml")
if os.path.isfile(ci):
    tool = re.compile(r"""(?<![\w./-])(build|twine|hatchling|pypi-attestations)(?![\w./-])""")
    PIP = re.compile(r"\bpip[0-9.]*\s+install\b")
    BUILD = re.compile(r"\bpython[0-9.]*\s+-m\s+build\b|\buv\s+build\b|\bpyproject-build\b")
    UPLOAD = ".gitlab/ci/publish-upload.txt"
    OKFLAGS = {"--require-hashes", "--no-deps", "--quiet", "-q"}
    logical, buf, start = [], "", 0
    for i, raw in enumerate(open(ci, encoding="utf-8").read().splitlines(), 1):
        if not buf and raw.lstrip().startswith("#"):
            continue  # a comment ending in a backslash must not swallow the next line
        if not buf:
            start = i
        if raw.rstrip().endswith("\\"):
            buf += raw.rstrip()[:-1] + " "
            continue
        logical.append((start, buf + raw))
        buf = ""
    job, holds, per_job = None, set(), {}
    for n, line in logical:
        if line and not line[0].isspace() and line.rstrip().endswith(":"):
            job = line.rstrip()[:-1]
        s = line.strip()
        if job and s.startswith("PYPI_ID_TOKEN:"):
            holds.add(job)
        if PIP.search(s) and tool.search(PIP.split(s, 1)[1]) and "--require-hashes" not in s:
            bad.append(f".gitlab-ci.yml:{n}: unhashed install of the build/upload toolchain: {s}")
        if job and (PIP.search(s) or BUILD.search(s)):
            per_job.setdefault(job, []).append((n, s))
    for j in sorted(holds - EXEMPT):
        for n, s in per_job.get(j, []):
            if BUILD.search(s):
                bad.append(f".gitlab-ci.yml:{n}: job {j} holds PYPI_ID_TOKEN but runs a build: {s}")
                continue
            ok = len(PIP.findall(s)) == 1
            if ok:
                toks = PIP.split(s, 1)[1].split()
                ok = False
                if "-r" in toks and toks.count("-r") == 1 and "--require-hashes" in toks:
                    k = toks.index("-r")
                    rest = toks[:k] + toks[k + 2:]
                    ok = k + 1 < len(toks) and toks[k + 1] == UPLOAD and all(x in OKFLAGS for x in rest)
            if not ok:
                bad.append(f".gitlab-ci.yml:{n}: job {j} holds PYPI_ID_TOKEN but installs more than the hashed upload tools: {s}")
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
    printf 'j:\n  id_tokens:\n    PYPI_ID_TOKEN:\n      aud: pypi\n  before_script:\n    - pip install --require-hashes --no-deps -r .gitlab/ci/publish-upload.txt\n  script:\n    - twine upload dist/*\nk:\n  script:\n    - pip install uv==0.9.5\n    - python -m build --no-isolation\n' >"$1/.gitlab-ci.yml"
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
  mk "$tmp/txtdrift"; printf 'build==1.0.0 \\\n    --hash=sha256:aa\nhatchling==1.9.9 \\\n    --hash=sha256:bb\n' >"$tmp/txtdrift/.gitlab/ci/publish-build.txt"
  expect "publish-build.txt hatchling differs from .in" fail "$tmp/txtdrift"
  mk "$tmp/fold"; printf 'k:\n  script:\n    - pip install uv==0.9.5 \\\n        twine --quiet\n' >"$tmp/fold/.gitlab-ci.yml"
  expect "pip install folded across lines" fail "$tmp/fold"
  mk "$tmp/tokbuild"; printf 'j:\n  id_tokens:\n    PYPI_ID_TOKEN:\n      aud: pypi\n  script:\n    - python -m build\n' >"$tmp/tokbuild/.gitlab-ci.yml"
  expect "job holding PYPI_ID_TOKEN runs python -m build" fail "$tmp/tokbuild"
  mk "$tmp/tokpip"; printf 'j:\n  id_tokens:\n    PYPI_ID_TOKEN:\n      aud: pypi\n  before_script:\n    - pip install --require-hashes --no-deps -r .gitlab/ci/publish-build.txt\n' >"$tmp/tokpip/.gitlab-ci.yml"
  expect "job holding PYPI_ID_TOKEN installs the build file" fail "$tmp/tokpip"
  tok() { printf 'j:\n  id_tokens:\n    PYPI_ID_TOKEN:\n      aud: pypi\n  script:\n%s\n' "$2" >"$1/.gitlab-ci.yml"; }
  mk "$tmp/pipv"; tok "$tmp/pipv" '    - pip3.11 install --require-hashes -r .gitlab/ci/publish-build.txt'
  expect "pip3.11 install of the build file under a token" fail "$tmp/pipv"
  mk "$tmp/uvb"; tok "$tmp/uvb" '    - uv build'
  expect "uv build under a token" fail "$tmp/uvb"
  mk "$tmp/pyb"; tok "$tmp/pyb" '    - python3.11 -m build --wheel'
  expect "python3.11 -m build under a token" fail "$tmp/pyb"
  mk "$tmp/evil"; tok "$tmp/evil" '    - pip install --require-hashes -r .gitlab/ci/publish-upload.txt.evil'
  expect "upload path with a suffix" fail "$tmp/evil"
  mk "$tmp/two"; tok "$tmp/two" '    - pip install --require-hashes -r .gitlab/ci/publish-upload.txt && pip install --require-hashes -r x.txt'
  expect "two pip installs on one line" fail "$tmp/two"
  mk "$tmp/extr"; tok "$tmp/extr" '    - pip install --require-hashes -r .gitlab/ci/publish-upload.txt -r other.txt'
  expect "extra -r" fail "$tmp/extr"
  mk "$tmp/cmt"; printf 'j:\n  id_tokens:\n    PYPI_ID_TOKEN:\n      aud: pypi\n  script:\n    # note \\\n    - pip install requests\n' >"$tmp/cmt/.gitlab-ci.yml"
  expect "comment ending in a backslash must not hide the next line" fail "$tmp/cmt"
  [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  return "$rc"
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -d "$ROOT" ] || { echo "ERROR: '$ROOT' is not a directory." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 2; }
run "$ROOT"
