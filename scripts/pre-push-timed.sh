#!/usr/bin/env bash
# Wraps `make pre-push` so the wall-clock duration is appended to a local
# timing log. CLAUDE.md targets a 60s budget for pre-push; without a
# persistent log we have no signal when it silently grows past that.
#
# Log location: the git common-dir (so worktrees share a single log with the
# main checkout). Rotated to the last 100 lines on every run.

set -euo pipefail

log_dir="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
log_file="${log_dir}/pre-push.log"
mkdir -p "${log_dir}"

start=$(date +%s)
status=0
make pre-push || status=$?
end=$(date +%s)

timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
elapsed=$((end - start))

printf '%s  %4ds  branch=%s  exit=%d\n' "${timestamp}" "${elapsed}" "${branch}" "${status}" >>"${log_file}"

# Rotate to last 100 lines so the log doesn't grow unbounded.
if [ "$(wc -l <"${log_file}")" -gt 100 ]; then
  tail -n 100 "${log_file}" >"${log_file}.tmp" && mv "${log_file}.tmp" "${log_file}"
fi

exit "${status}"
