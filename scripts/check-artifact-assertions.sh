#!/usr/bin/env bash
# scripts/check-artifact-assertions.sh — every publish job that declares
# artifacts:paths must assert, in its own script, that each path is non-empty
# (#4062).
#
# WHY: GitLab passes a job that uploaded nothing ("ERROR: No files to upload",
# "Job succeeded"). In the v0.4.0-beta.4 tag pipeline web:publish and
# web:publish:arm64 (script `cd packages/web`, so sbom/ was unreachable) and
# web:publish:npm (exits before building) did exactly that, and
# web:publish:manifest failed downstream. api:publish:pypi did it on beta.1.
#
# WHAT IT CHECKS (static): for each job in ENFORCED_JOBS (the tag publish jobs
# whose artifacts are otherwise unverified) that declares artifacts:paths, each declared path appears as an argument of a
# `ci-assert-artifacts.sh` line in that job's script. The helper itself
# anchors at $CI_PROJECT_DIR and fails the job at runtime.
#
# WHAT IT CANNOT CHECK: that the producing command really writes there (only
# the runtime helper can), that the assertion line is reached (an earlier
# `exit 0`, like web:publish:npm's no-NPM_TOKEN skip, bypasses it and GitLab
# still warns), or jobs outside ENFORCED_JOBS (add a job there when it gains an artifacts: block). Tag-only jobs cannot run until
# a tag, so the wiring is proven statically here and the behavior only at the
# next tag.
#
# Usage: check-artifact-assertions.sh [CI_FILE] | --self-test
set -euo pipefail

ENFORCED_JOBS=" web:publish web:publish:arm64 api:publish:pypi "

scan() {
  ENFORCED_JOBS="$ENFORCED_JOBS" python3 - "$1" <<'PY'
import os, re, sys
ENFORCED = os.environ["ENFORCED_JOBS"]
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
jobs, job, state = {}, None, None
for raw in lines:
    if not raw.strip() or raw.lstrip().startswith("#"):
        continue
    ind = len(raw) - len(raw.lstrip(" "))
    c = raw.strip()
    if ind == 0:
        m = re.match(r"^(\S.*?):\s*$", c)
        job = m.group(1) if m else None
        if job: jobs.setdefault(job, {"paths": [], "assert": []})
        state = None
        continue
    if job is None:
        continue
    if ind == 2:
        state = "artifacts" if c == "artifacts:" else None
        if state is None and "ci-assert-artifacts.sh" in c:
            jobs[job]["assert"].append(c)
        continue
    if state == "artifacts" and ind == 4:
        state = "paths" if c == "paths:" else "artifacts"
        continue
    if state == "paths" and ind >= 6 and c.startswith("- "):
        jobs[job]["paths"].append(c[2:].strip().strip("\"'"))
        continue
    if state == "paths" and ind <= 4:
        state = "artifacts"
    if "ci-assert-artifacts.sh" in c:
        jobs[job]["assert"].append(c)
for n, d in jobs.items():
    if (" " + n + " ") in ENFORCED and d["paths"]:
        print(n + "\t" + "\t".join(d["paths"]) + "\t\x1f\t" + " ".join(d["assert"]))
PY
}

run() {
  local rc=0 line job rest paths asserts p
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    job="${line%%$'\t'*}"; rest="${line#*$'\t'}"
    paths="${rest%%$'\t'$'\x1f'*}"; asserts="${rest#*$'\x1f'$'\t'}"
    IFS=$'\t' read -ra arr <<<"$paths"
    for p in "${arr[@]}"; do
      case " $asserts " in
        *"$p"*) : ;;
        *) printf 'VIOLATION: %s declares artifacts:paths %s but no `ci-assert-artifacts.sh %s` in its script (#4062)\n' "$job" "$p" "$p" >&2; rc=1 ;;
      esac
    done
  done < <(scan "$1")
  [ "$rc" -eq 0 ] && echo "OK: every publish job asserts its declared artifact paths are non-empty." >&2
  return "$rc"
}

self_test() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  cat >"$d/good.yml" <<'Y'
web:publish:
  script:
    - cd packages/x
    - sh scripts/ci-assert-artifacts.sh sbom/
  artifacts:
    paths:
      - sbom/
Y
  sed 's#- sh scripts/ci-assert-artifacts.sh sbom/#- true#' "$d/good.yml" >"$d/bad.yml"
  cat >"$d/other.yml" <<'Y'
other:job:
  artifacts:
    paths:
      - dist/
Y
  run "$d/good.yml" 2>/dev/null || { echo "self-test: good fixture rejected" >&2; return 1; }
  if run "$d/bad.yml" 2>/dev/null; then echo "self-test: unasserted publish job NOT caught" >&2; return 1; fi
  run "$d/other.yml" 2>/dev/null || { echo "self-test: non-publish job flagged" >&2; return 1; }
  # runtime helper: empty dir and missing path fail, populated passes
  mkdir -p "$d/p/empty" "$d/p/full"; echo x >"$d/p/full/f"
  CI_PROJECT_DIR="$d/p" sh scripts/ci-assert-artifacts.sh full/ 2>/dev/null || { echo "self-test: helper rejected populated dir" >&2; return 1; }
  if CI_PROJECT_DIR="$d/p" sh scripts/ci-assert-artifacts.sh empty/ 2>/dev/null; then echo "self-test: helper passed empty dir" >&2; return 1; fi
  if CI_PROJECT_DIR="$d/p" sh scripts/ci-assert-artifacts.sh nope/ 2>/dev/null; then echo "self-test: helper passed missing dir" >&2; return 1; fi
  echo "self-test OK" >&2
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run "${1:-.gitlab-ci.yml}" ;;
esac
