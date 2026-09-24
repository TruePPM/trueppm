#!/bin/sh
# scripts/ci-assert-artifacts.sh — fail the CURRENT job when a declared
# artifacts:paths entry produced nothing (#4062).
#
# GitLab treats an empty artifact upload as non-fatal: "WARNING: <path>: no
# matching files" + "ERROR: No files to upload" and the job still finishes
# "Job succeeded". Call this as the LAST `script:` line of a publish job, once
# per declared path, so the job that failed to produce the artifact is the job
# that goes red, naming the path.
#
# It anchors every path at $CI_PROJECT_DIR, which is where GitLab resolves
# `artifacts:paths` — regardless of any `cd` the job's script did earlier.
# It must run in `script:`, not `after_script:` (an after_script failure does
# not fail the job).
#
# Usage: ci-assert-artifacts.sh PATH [PATH...]   (a trailing / means directory)
# Exit:  0 every path exists and is non-empty · 1 a path is missing/empty · 2 usage

[ "$#" -gt 0 ] || { echo "usage: ci-assert-artifacts.sh PATH [PATH...]" >&2; exit 2; }
root="${CI_PROJECT_DIR:-$(pwd)}"
rc=0
for p in "$@"; do
  full="$root/${p%/}"
  if [ -d "$full" ]; then
    if [ -z "$(find "$full" -type f -print -quit 2>/dev/null)" ]; then
      echo "ERROR: declared artifact path '$p' is empty (no files under $full)" >&2
      rc=1
    fi
  elif [ -s "$full" ]; then
    :
  else
    echo "ERROR: declared artifact path '$p' does not exist or is empty ($full)" >&2
    echo "       GitLab would upload nothing and still mark this job successful (#4062)." >&2
    rc=1
  fi
done
exit "$rc"
