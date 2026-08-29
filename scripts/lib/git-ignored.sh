# shellcheck shell=bash
#
# Shared "is this path part of the repository?" predicate for the file-scanning
# gates (#3178). Extracted verbatim from check-docs-tree-split.sh (#3151), where
# it was written for one gate and then found to be needed by eight more.
#
# Every gate here enumerates with `find` or `grep -r` and, before this, never
# consulted git — so any ignored artifact inside a scan root was read as though
# it were committed. That is a false RED, locally, on a file CI can never see:
# CI clones clean, so the same gate passes there. The contradiction is the only
# tell, and nothing in the failure output points at it.
#
# The sharp case is `docs/audit/`, ignored ON PURPOSE (audit reports carry live
# exploit detail ahead of the fix, so they are filed as tracker entries rather
# than committed) — which made the developers who reliably have files there the
# ones doing security work.

# True when git ignores <path>.
#
# False whenever the question cannot be asked: git absent (several of these jobs
# run on bare alpine), or the path outside any worktree (the scripts' own
# mktemp self-test fixtures). Both leave each scan exactly as wide as it was,
# which is the safe direction and is why CI behavior is unchanged — a clean
# clone has nothing ignored to skip. Answering "ignored" in those cases instead
# would pass every expect-fail fixture in every self-test and hollow all nine
# gates out at once while looking green.
is_ignored() { # <path>
  command -v git >/dev/null 2>&1 || return 1
  git check-ignore -q -- "$1" 2>/dev/null
}

# Filter `path:...` lines on stdin (grep -rn / -rl output) down to those whose
# path is part of the repository. For the gates that COUNT matches rather than
# loop over them, where there is no per-file loop to guard with is_ignored.
#
# One `git check-ignore --stdin` for the whole batch rather than one process per
# line: these gates run over thousands of matches and are budgeted in seconds.
# Same degradation contract as is_ignored — if git cannot answer, every line
# passes through and the scan is exactly as wide as it was.
drop_ignored_lines() {
  local all ignored
  all="$(cat)"
  [ -z "$all" ] && return 0
  if ! command -v git >/dev/null 2>&1 \
     || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '%s\n' "$all"; return 0
  fi
  ignored="$(printf '%s\n' "$all" | sed 's/:.*//' | sort -u \
    | git check-ignore --stdin 2>/dev/null || true)"
  if [ -z "$ignored" ]; then printf '%s\n' "$all"; return 0; fi
  # Match on the path field only: a content match could otherwise look like a path.
  printf '%s\n' "$all" | awk -v ign="$ignored" '
    BEGIN { n = split(ign, a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") drop[a[i]] = 1 }
    { p = $0; sub(/:.*/, "", p); if (!(p in drop)) print }
  '
}
