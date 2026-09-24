#!/usr/bin/env bash
# scripts/check-pypi-id-tokens.sh — the set of CI jobs that can mint a live
# PyPI upload token is exactly the known publish jobs, and each of them still
# declares the `environment:` name its PyPI Trusted Publisher is registered
# against (#3993).
#
# WHY THIS EXISTS
# ----------------
# `id_tokens:` is NOT a CI/CD variable. A Masked + Protected variable is
# withheld from a job running on an unprotected ref — that is what actually
# guards GHCR_USER/GHCR_TOKEN (#3990). `id_tokens:` is different: GitLab
# issues a short-lived OIDC ID token to ANY job that declares one, on ANY
# ref, protected or not. Ref protection does not gate it at all.
#
# #3992's probe proved this the hard way: a job that was not `api:publish:pypi`,
# running on an ordinary unprotected feature branch, declared
# `id_tokens: {PYPI_ID_TOKEN: {aud: pypi}}` plus `environment: {name: pypi-api}`
# and minted a real, project-scoped `trueppm-api` upload token from PyPI's
# `mint-token` endpoint. Both declarations are plain YAML — readable and
# copyable by anyone with push access to this repository, in a job that never
# has to be `api:publish:pypi` itself.
#
# What PyPI's Trusted Publisher actually matches on is namespace, project,
# workflow filepath, and the `environment:` NAME. So two things can silently
# widen the trust surface, and neither has any other tell:
#   1. a NEW job declares `id_tokens: PYPI_ID_TOKEN` — a new, silent path to a
#      live upload token, indistinguishable from a legitimate publish job
#      without reading every job in this file by hand;
#   2. an EXISTING publish job's `environment:` name is removed or changed —
#      which either breaks that job's own publish (mint fails closed, loud)
#      or, worse, silently matches a *different* registered Trusted Publisher.
#
# This script asserts both directions instead of leaving them to review.
#
# WHAT THIS SCRIPT DOES NOT DO
# -----------------------------
# It cannot make the `environment:` NAME an actual access boundary — that is
# GitLab Protected Environments (Settings -> CI/CD -> Protected environments),
# a project-settings change with no repository artifact, tracked as a
# follow-up to #3993. Until that lands, this script keeps the *set* of jobs
# and their environment names honest; it does not restrict who can push a
# branch that runs one of the allowlisted jobs.
#
# scheduler:publish declares `pypi-scheduler` like the other publish jobs. It
# was a blank-environment exception until #4016, when the PyPI-side Trusted
# Publisher was re-registered against the name first (a blank publisher matches
# on project claims alone).
#
# Usage:
#   check-pypi-id-tokens.sh [CI_FILE]     # CI_FILE defaults to .gitlab-ci.yml
#   check-pypi-id-tokens.sh --self-test
#
# Exit codes:
#   0  the id_tokens: PYPI_ID_TOKEN job set and their environment: names match
#   1  a violation (unknown job, missing job, or wrong/missing environment)
#   2  invocation error (bad path, python3 missing)

set -euo pipefail

# The allowlist lives IN THE SCRIPT, not derived from the file — the whole
# point is that a new job cannot silently add itself to the trusted set by
# copying a YAML block.
#
#   job name            -> expected `environment: name:` value
ALLOWLIST_JOBS="api:publish:pypi mcp:publish scheduler:publish ci:pypi-mint-probe"
expected_env() {
  case "$1" in
    api:publish:pypi)   echo "pypi-api" ;;
    ci:pypi-mint-probe) echo "pypi-api" ;;
    mcp:publish)        echo "pypi-mcp" ;;
    scheduler:publish)  echo "pypi-scheduler" ;;
    *)                  echo "__UNKNOWN__" ;;
  esac
}

err()  { printf '\033[31mVIOLATION:\033[0m %s\n' "$*" >&2; }
note() { printf '%s\n' "$*" >&2; }

# Line-based structural scan of the CI file: no full YAML parse (no PyYAML
# dependency, matching the sibling gates' "shell + grep/awk, python3 only for
# structure a regex cannot express" convention — see check-extension-signals.sh
# Part 2). Relies on this file's consistent 2-space indent: job keys at column
# 0, a job's own keys (`id_tokens:`, `environment:`) at indent 2, their
# children (`PYPI_ID_TOKEN:`, `name:`) at indent >= 4. That convention is
# exercised by this script's own --self-test fixtures.
scan_jobs() {
  python3 - "$1" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    lines = fh.readlines()

jobs = {}  # name -> {"pypi": bool, "env": str|None}
job = None
state = None  # None | "id_tokens" | "environment"

BARE_KEY = re.compile(r"^(\S.*?):\s*$")


def strip_comment(line: str) -> str:
    idx = line.find("#")
    return line[:idx] if idx != -1 else line


for raw in lines:
    stripped = strip_comment(raw.rstrip("\n"))
    if not stripped.strip():
        continue
    indent = len(stripped) - len(stripped.lstrip(" "))
    content = stripped.strip()

    if indent == 0:
        m = BARE_KEY.match(content)
        if m:
            job = m.group(1)
            jobs.setdefault(job, {"pypi": False, "env": None})
            state = None
        else:
            job = None
            state = None
        continue

    if job is None:
        continue

    if indent == 2:
        if content == "id_tokens:":
            state = "id_tokens"
        elif content == "environment:":
            state = "environment"
        elif content.startswith("environment:"):
            val = content[len("environment:"):].strip()
            if val:
                jobs[job]["env"] = val
            state = None
        else:
            state = None
        continue

    if indent >= 4 and state == "id_tokens":
        if content == "PYPI_ID_TOKEN:" or content.startswith("PYPI_ID_TOKEN:"):
            jobs[job]["pypi"] = True
        continue

    if indent >= 4 and state == "environment":
        if content.startswith("name:"):
            val = content[len("name:"):].strip().strip("'\"")
            jobs[job]["env"] = val
        continue

for name, d in jobs.items():
    env = d["env"] if d["env"] is not None else ""
    print(f"{name}\t{'yes' if d['pypi'] else 'no'}\t{env}")
PY
}

run_scan() {
  local ci_file="$1" violations=0
  local scan
  scan="$(scan_jobs "$ci_file")"

  # job -> env, restricted to jobs declaring id_tokens: PYPI_ID_TOKEN.
  local found_pypi=""
  local job pypi env
  while IFS=$'\t' read -r job pypi env; do
    [ -z "$job" ] && continue
    if [ "$pypi" = "yes" ]; then
      found_pypi="$found_pypi $job"
    fi
  done <<<"$scan"

  # 1. Every job declaring id_tokens: PYPI_ID_TOKEN must be on the allowlist.
  local j
  for j in $found_pypi; do
    case " $ALLOWLIST_JOBS " in
      *" $j "*) : ;;
      *)
        err "job '$j' in $ci_file declares id_tokens: PYPI_ID_TOKEN but is not" \
            "in this script's allowlist ($ALLOWLIST_JOBS)."
        note "  An id_tokens: block is issued on ANY ref, protected or not — a new job"
        note "  with one is a new, silent path to a live PyPI upload token (#3993)."
        note "  If this job is a legitimate new publish job, add it to ALLOWLIST_JOBS"
        note "  in scripts/check-pypi-id-tokens.sh (and register its own PyPI Trusted"
        note "  Publisher / Protected Environment first)."
        violations=$((violations + 1))
        ;;
    esac
  done

  # 2. Every allowlisted job must still be present and still declare the
  #    token — a silent removal breaks that package's release path just as
  #    surely as an addition widens the trust surface.
  local allow
  for allow in $ALLOWLIST_JOBS; do
    case " $found_pypi " in
      *" $allow "*) : ;;
      *)
        err "allowlisted publish job '$allow' does not declare" \
            "id_tokens: PYPI_ID_TOKEN in $ci_file."
        note "  Either the job was renamed/removed (update ALLOWLIST_JOBS in"
        note "  scripts/check-pypi-id-tokens.sh) or it silently lost its OIDC"
        note "  declaration, which would break its PyPI publish at the next tag."
        violations=$((violations + 1))
        ;;
    esac
  done

  # 3. Each allowlisted job that IS present must declare the environment: name
  #    its PyPI Trusted Publisher is registered against.
  while IFS=$'\t' read -r job pypi env; do
    [ -z "$job" ] && continue
    [ "$pypi" = "yes" ] || continue
    local want
    want="$(expected_env "$job")"
    [ "$want" = "__UNKNOWN__" ] && continue  # already reported above (#1)
    if [ "$env" != "$want" ]; then
      err "job '$job' in $ci_file declares environment: '${env:-<none>}'," \
          "expected '$want'."
      note "  PyPI matches its Trusted Publisher on this exact name. A mismatch"
      note "  either fails the mint closed (loud) or — if it happens to match a"
      note "  DIFFERENT registered publisher — silently widens that publisher's"
      note "  trust surface to this job (#3993)."
      violations=$((violations + 1))
    fi
  done <<<"$scan"

  if [ "$violations" -gt 0 ]; then
    note ""
    note "$violations violation(s). See scripts/check-pypi-id-tokens.sh's header for context."
    return 1
  fi

  note "OK: id_tokens: PYPI_ID_TOKEN is declared by exactly the allowlisted publish jobs, each with its expected environment: name."
  return 0
}

self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  _case() { # <name> <expect-pass|expect-fail> <fixture-file>
    if run_scan "$3" >/dev/null 2>&1; then
      if [ "$2" = "expect-pass" ]; then
        echo "SELF-TEST OK: $1 (accepted)."
      else
        echo "SELF-TEST FAILED: $1 — accepted, expected rejection." >&2
        rc=1
      fi
    else
      if [ "$2" = "expect-fail" ]; then
        echo "SELF-TEST OK: $1 (correctly rejected)."
      else
        echo "SELF-TEST FAILED: $1 — rejected, expected acceptance." >&2
        rc=1
      fi
    fi
  }

  # A minimal, fully-correct fixture mirroring the real file's shape,
  # including scheduler:publish's named environment.
  cat >"$tmp/good.yml" <<'YAML'
api:publish:pypi:
  stage: publish
  environment:
    name: pypi-api
    url: https://pypi.org/project/trueppm-api/
  id_tokens:
    PYPI_ID_TOKEN:
      aud: pypi
    SIGSTORE_ID_TOKEN:
      aud: sigstore

mcp:publish:
  stage: publish
  environment:
    name: pypi-mcp
    url: https://pypi.org/project/trueppm-mcp/
  id_tokens:
    PYPI_ID_TOKEN:
      aud: pypi

scheduler:publish:
  stage: publish
  environment:
    name: pypi-scheduler
    url: https://pypi.org/project/trueppm-scheduler/
  id_tokens:
    PYPI_ID_TOKEN:
      aud: pypi

ci:pypi-mint-probe:
  stage: publish
  environment:
    name: pypi-api
    url: https://pypi.org/project/trueppm-api/
  id_tokens:
    PYPI_ID_TOKEN:
      aud: pypi

unrelated:job:
  stage: test
  script:
    - echo hi
YAML
  _case "the known-good shape" expect-pass "$tmp/good.yml"

  # THE #3993 SHAPE: an unrelated job copies id_tokens: PYPI_ID_TOKEN.
  cp "$tmp/good.yml" "$tmp/extra-job.yml"
  cat >>"$tmp/extra-job.yml" <<'YAML'

feat:probe:something:
  stage: test
  id_tokens:
    PYPI_ID_TOKEN:
      aud: pypi
YAML
  _case "a new, non-allowlisted job declares id_tokens: PYPI_ID_TOKEN" expect-fail "$tmp/extra-job.yml"

  # api:publish:pypi silently loses its environment: block — widens the
  # Trusted Publisher match.
  python3 - "$tmp/good.yml" "$tmp/no-env.yml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    text = f.read()
lines = text.splitlines(keepends=True)
out = []
skip = False
for line in lines:
    if line.startswith("  environment:") and "pypi-api" in "".join(lines[lines.index(line):lines.index(line)+3]):
        skip = True
        continue
    if skip:
        if line.startswith("    ") :
            continue
        skip = False
    out.append(line)
with open(dst, "w") as f:
    f.write("".join(out))
PY
  _case "api:publish:pypi's environment: block removed" expect-fail "$tmp/no-env.yml"

  # scheduler:publish reverts to the old blank environment, which would
  # silently reopen the wider project-claims-only trust surface.
  python3 - "$tmp/good.yml" "$tmp/sched-blank.yml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
old = ("scheduler:publish:\n  stage: publish\n  environment:\n"
       "    name: pypi-scheduler\n"
       "    url: https://pypi.org/project/trueppm-scheduler/\n")
assert old in text
open(dst, "w").write(text.replace(old, "scheduler:publish:\n  stage: publish\n"))
PY
  _case "scheduler:publish loses its environment (blank)" expect-fail "$tmp/sched-blank.yml"

  # An allowlisted job's id_tokens: block disappears entirely.
  python3 - "$tmp/good.yml" "$tmp/missing-job.yml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    text = f.read()
block_start = text.index("mcp:publish:")
block_end = text.index("scheduler:publish:")
text = text[:block_start] + text[block_end:]
with open(dst, "w") as f:
    f.write(text)
PY
  _case "mcp:publish's whole block removed" expect-fail "$tmp/missing-job.yml"

  [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  return "$rc"
}

# --- entrypoint --------------------------------------------------------------

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

CI_FILE="${1:-.gitlab-ci.yml}"

if [ ! -f "$CI_FILE" ]; then
  echo "ERROR: '$CI_FILE' not found. Run from the repository root, or pass a path." >&2
  exit 2
fi

command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: python3 is required to parse $CI_FILE" >&2
  exit 2
}

run_scan "$CI_FILE"
