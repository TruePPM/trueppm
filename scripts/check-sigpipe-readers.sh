#!/usr/bin/env bash
# scripts/check-sigpipe-readers.sh — no shell script may put an early-exit
# reader (`grep -q`, `grep -m`, `head`) on the far side of a pipe.
#
# Why (#3942, after #3331 and #3758). Every script here runs under
# `set -o pipefail`. An early-exiting reader closes the pipe the moment it has
# what it wants; if the writer is still writing it takes SIGPIPE, the pipeline's
# status becomes 141, and a PRESENT match is reported as a failed one. It is a
# race on how much the writer has flushed, so it passes in every small local
# run and fails once, on a loaded runner or a grown input, with a message that
# names the wrong cause. It has red-flagged this repo twice, and the third
# instance sat in `release.sh` — the script that gates immutable release tags:
# `git tag | grep -qxF "$TAG" && die` reads a spurious 141 as "tag not found"
# and lets the release proceed against a tag that exists.
#
# The fix at each site is a here-string — `grep -q PAT <<<"$(cmd)"` — or, for
# `head`, a reader that drains its input (`sed -n 1p`, `awk 'NR==1'`).
#
# This replaces a hand-listed three-file scan that lived inside
# check-nginx-security-headers.sh's self-test. A hardcoded file list is exactly
# how `release.sh` stayed outside the guard: the scan covered the files that
# had already been bitten. This one walks every shell script under scripts/, so
# the next new script is covered without anyone remembering to list it.
#
# Scope. A file is scanned if it has a `.sh` extension or a bash/sh shebang, and
# git does not ignore it. Comment lines are skipped (a `#` earlier on the line);
# the docstrings that explain this very pattern are therefore not offenders.
#
# Deliberate exceptions. A line whose input is provably tiny and bounded can
# carry an inline `# sigpipe-ok: <reason>` marker. The reason is REQUIRED — a
# bare marker is still an offender — so the exception is read by the next
# person instead of being a silent switch. Prefer converting the site.
#
# What this cannot see: `sed q`, `awk ... exit`, `read -r x < <(...)` and the
# like exit early too, and a pipe split across a `\` continuation is only
# caught on the line that carries the reader. `grep -q` and `head` are the
# forms that have actually recurred; widening this is cheap if another does.
#
# Usage:  scripts/check-sigpipe-readers.sh [ROOT]     # ROOT defaults to scripts/
#         scripts/check-sigpipe-readers.sh --self-test
# Exit:   0 no offenders · 1 at least one offender · 2 invocation error / nothing scanned

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$REPO_ROOT/scripts/lib/git-ignored.sh"

# `(^|[^|])` and the absence of a following `|` keep `a || head` (an OR-list,
# not a pipe) out. `[^#]*` before the pipe skips comment lines.
OFFENDER_RE='^([^#]*[^|#])?\|[[:space:]]*(grep[[:space:]]+(-[A-Za-z-]+[[:space:]]+)*(-[A-Za-z]*[qm][A-Za-z0-9]*|--quiet|--silent|--max-count)([[:space:]=]|$)|head([[:space:]]|$))'

# Files under ROOT that count as shell: .sh extension or a sh/bash shebang.
list_shell_files() { # <root>
  local f
  while IFS= read -r f; do
    is_ignored "$f" && continue
    case "$f" in
      *.sh) printf '%s\n' "$f" ;;
      *.py | *.txt | *.md | *.json | *.yml | *.yaml) ;;
      *)
        if grep -qE '^#!.*[[:space:]/](ba)?sh([[:space:]]|$)' <<<"$(sed -n 1p "$f" 2>/dev/null || true)"; then
          printf '%s\n' "$f"
        fi
        ;;
    esac
  done < <(find "$1" -type f | sort)
}

run_scan() { # <root>
  local root="$1" files f hits found=0 nfiles=0
  files="$(list_shell_files "$root")"
  if [ -z "$files" ]; then
    echo "check-sigpipe-readers: no shell scripts found under $root — refusing to report a clean scan of nothing." >&2
    return 2
  fi
  while IFS= read -r f; do
    nfiles=$((nfiles + 1))
    # Drop lines carrying a `sigpipe-ok: <reason>` marker with a real reason.
    hits="$(grep -nE "$OFFENDER_RE" "$f" | grep -vE 'sigpipe-ok:[[:space:]]*[^[:space:]]' || true)"
    if [ -n "$hits" ]; then
      found=1
      printf '%s\n' "$hits" | sed "s|^|  $f:|" >&2
    fi
  done <<<"$files"
  if [ "$found" -eq 1 ]; then
    cat >&2 <<'MSG'

check-sigpipe-readers: FAIL — an early-exit reader (grep -q / grep -m / head) sits behind a pipe.
Under `set -o pipefail` it can SIGPIPE the writer and report a PRESENT match as missing (#3942).
Use a here-string:      grep -q PATTERN <<<"$(cmd)"        (or <<<"$var")
For `head`, drain:      … | sed -n 1p   or   awk 'NR==1'
A provably tiny, bounded input may carry an inline `# sigpipe-ok: <reason>` marker instead.
MSG
    return 1
  fi
  echo "check-sigpipe-readers: OK — $nfiles shell scripts under $root, no early-exit reader behind a pipe."
}

self_test() {
  local tmp rc=0 pipe='|'
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  # Fixtures are assembled with printf so this file never contains the pattern
  # it polices — the gate is scanned by itself.
  probe() { # <name> <accept|reject> <fixture-dir>
    local want got=0
    case "$2" in accept) want=0 ;; reject) want=1 ;; *) echo "SELF-TEST: bad expectation" >&2; rc=1; return ;; esac
    run_scan "$3" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then
      echo "SELF-TEST OK: $1 — $2 (exit $got)."
    else
      echo "SELF-TEST FAILED: $1 — expected $2 (exit $want), got exit $got." >&2
      rc=1
    fi
  }
  fixture() { # <name> <file> <line...>  — writes a one-line script into its own root
    local d="$tmp/$1"
    mkdir -p "$d"
    printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$3" >"$d/$2"
  }

  # shellcheck disable=SC2016  # $TAG is fixture text, not an expansion.
  fixture clean a.sh 'grep -qxF "$TAG" <<<"$(git tag)" && exit 1'
  probe "here-string reader" accept "$tmp/clean"

  fixture bad_q a.sh "git tag $pipe grep -qxF \"\$TAG\" && exit 1"
  probe "the release.sh tag guard (grep -qxF)" reject "$tmp/bad_q"

  fixture bad_q2 a.sh "echo \"\$x\" $pipe grep -q foo"
  probe "plain grep -q" reject "$tmp/bad_q2"

  fixture bad_qi a.sh "echo \"\$x\" $pipe grep -qi foo"
  probe "grep -qi" reject "$tmp/bad_qi"

  fixture bad_eq a.sh "echo \"\$x\" $pipe grep -Eq foo"
  probe "grep -Eq (q not first)" reject "$tmp/bad_eq"

  fixture bad_sep a.sh "echo \"\$x\" $pipe grep -E -q foo"
  probe "grep -E -q (separate flags)" reject "$tmp/bad_sep"

  fixture bad_m a.sh "echo \"\$x\" $pipe grep -m1 foo"
  probe "grep -m1 (also exits early)" reject "$tmp/bad_m"

  fixture bad_head a.sh "grep '^version' f $pipe head -1"
  probe "head -1" reject "$tmp/bad_head"

  fixture bad_headn a.sh "ls $pipe head -n 5"
  probe "head -n 5" reject "$tmp/bad_headn"

  fixture bad_bare a.sh "ls $pipe head"
  probe "bare head at end of line" reject "$tmp/bad_bare"

  mkdir -p "$tmp/bad_cont"
  printf '#!/usr/bin/env bash\nset -euo pipefail\nfoo \\\n  %s head -n1\n' "$pipe" >"$tmp/bad_cont/a.sh"
  probe "reader on a continuation line" reject "$tmp/bad_cont"

  mkdir -p "$tmp/bad_shebang"
  printf '#!/usr/bin/env bash\nset -euo pipefail\nls %s head -1\n' "$pipe" >"$tmp/bad_shebang/wt"
  probe "extensionless script found by its shebang" reject "$tmp/bad_shebang"

  fixture ok_comment a.sh "# uses \`x $pipe grep -q y\` in prose"
  probe "comment line" accept "$tmp/ok_comment"

  fixture ok_or a.sh "cmd || head -1 f"
  probe "OR-list, not a pipe" accept "$tmp/ok_or"

  fixture ok_sed a.sh "ls $pipe sed -n 1p"
  probe "draining reader (sed -n 1p)" accept "$tmp/ok_sed"

  fixture ok_grep_plain a.sh "ls $pipe grep foo"
  probe "grep without -q" accept "$tmp/ok_grep_plain"

  fixture ok_marker a.sh "echo hi $pipe grep -q hi # sigpipe-ok: one-word literal, far below PIPE_BUF"
  probe "sigpipe-ok marker with a reason" accept "$tmp/ok_marker"

  fixture bad_marker a.sh "echo hi $pipe grep -q hi # sigpipe-ok:"
  probe "sigpipe-ok marker with NO reason" reject "$tmp/bad_marker"

  mkdir -p "$tmp/ok_data"
  printf 'x %s grep -q y\n' "$pipe" >"$tmp/ok_data/notes.txt"
  printf '#!/usr/bin/env python3\nprint("x %s head")\n' "$pipe" >"$tmp/ok_data/tool.py"
  printf '#!/usr/bin/env bash\ntrue\n' >"$tmp/ok_data/a.sh"
  probe "non-shell files are not scanned" accept "$tmp/ok_data"

  mkdir -p "$tmp/empty"
  printf 'nothing\n' >"$tmp/empty/notes.txt"
  # run_scan returns 2 for "nothing scanned"; probe scores only 0/1, so assert 2 directly.
  local empty_rc=0
  run_scan "$tmp/empty" >/dev/null 2>&1 || empty_rc=$?
  if [ "$empty_rc" -eq 2 ]; then
    echo "SELF-TEST OK: empty scan exits 2 (never a vacuous pass)."
  else
    echo "SELF-TEST FAILED: empty scan expected exit 2, got $empty_rc." >&2
    rc=1
  fi
  return $rc
}

main() {
  case "${1:-}" in
    --self-test) self_test ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' ;;
    *) run_scan "${1:-$REPO_ROOT/scripts}" ;;
  esac
}

main "$@"
