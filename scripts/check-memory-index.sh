#!/usr/bin/env bash
# scripts/check-memory-index.sh — size and integrity check for the Claude memory index.
#
# Why this exists (#3577). The index at
# `~/.claude/projects/<encoded-repo-path>/memory/MEMORY.md` is loaded into context on
# EVERY turn and has a hard read limit of roughly 24.4 KB. Past it the harness loads
# only part of the file and says so once, in a system notice nobody is required to
# read — so indexed memories stop arriving with nothing failing anywhere.
#
# That limit was hit and hand-compacted five times in four weeks (the `## Archived`
# headings in MEMORY-archive.md date them: 2026-08-10, 08-17, 08-23, 08-31, 09-07).
# Each pass buys 1-2 KB and it refills in about eight days. A recurring manual ritual
# with no check is the exact shape every other scripts/check-*.sh in this repo was
# written to replace.
#
# Two silent failures, neither visible without looking:
#   1. Over the limit  -> truncated load, memories silently absent.
#   2. A dangling link -> the memory file still exists and is still rankable by its
#      `description:`, but nothing points at it.
#
# NOT A CI GATE, DELIBERATELY. Its input is a per-user, per-machine directory outside
# the repo: it does not exist for contributors who do not use Claude Code, nor on CI
# runners. It is absent from .gitlab-ci.yml on purpose, so ci:gate-selftest-parity and
# ci:prepush-parity correctly never see it. Run it by hand, or `make memory-check`, at
# dot-release close beside changelog assembly and migration squashing.
#
# What it cannot do: decide WHICH memories deserve the index. That is a judgment call
# and stays human. This removes the silence, not the possibility of a wrong answer.
#
# Usage:  scripts/check-memory-index.sh [--self-test] [--quiet]
# Exit:   0 healthy (or no memory dir — skipped) · 1 over budget or a dangling link

set -euo pipefail

# Budget sits below the ~24.4 KB read limit so there is room to notice before the
# harness starts truncating. Override for a one-off check at a different threshold.
MEMORY_MAX_BYTES="${TRUEPPM_MEMORY_MAX_BYTES:-23000}"

# Memory types whose whole purpose is to be reachable. `project_*` is exempt: per-issue
# records are file-only by design (see the memory-discipline section of the global
# CLAUDE.md), and 260 of them are correctly unindexed.
INDEXED_PREFIXES_RE='^(feedback|user|reference|env)[_-]'

resolve_memory_dir() {
  if [[ -n "${TRUEPPM_MEMORY_DIR:-}" ]]; then printf '%s\n' "$TRUEPPM_MEMORY_DIR"; return; fi
  local root
  # The store is keyed to the MAIN checkout's path, so resolving from $BASH_SOURCE
  # silently misses it in a worktree — which is this repo's default workflow, so the
  # naive form would skip exactly where it is most often run. `git worktree list`
  # prints the main worktree first; fall back to the script's own parent outside git.
  root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" worktree list 2>/dev/null | head -n1 | awk '{print $1}')"
  [[ -n "$root" ]] || root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  # Claude encodes the project path by replacing every '/' with '-'.
  printf '%s\n' "$HOME/.claude/projects/${root//\//-}/memory"
}

run_check() {
  local dir="$1" quiet="${2:-0}" rc=0
  local index="$dir/MEMORY.md" archive="$dir/MEMORY-archive.md"

  if [[ ! -d "$dir" || ! -f "$index" ]]; then
    [[ "$quiet" == "1" ]] || echo "check-memory-index: no memory store at $dir — skipped"
    return 0
  fi

  local bytes; bytes=$(wc -c < "$index" | tr -d ' ')
  if [[ "$bytes" -gt "$MEMORY_MAX_BYTES" ]]; then
    echo "FAIL: MEMORY.md is ${bytes}B, over the ${MEMORY_MAX_BYTES}B budget (~24.4KB is the hard read limit)."
    echo "      Demote entries to MEMORY-archive.md under a dated '## Archived' heading — do not delete."
    rc=1
  else
    [[ "$quiet" == "1" ]] || echo "ok: MEMORY.md ${bytes}B / ${MEMORY_MAX_BYTES}B budget"
  fi

  # Dangling links, in both the index and the archive.
  local f target dangling=0
  for f in "$index" "$archive"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r target; do
      [[ -n "$target" ]] || continue
      [[ "$target" == "MEMORY-archive.md" || "$target" == "MEMORY.md" ]] && continue
      if [[ ! -e "$dir/$target" ]]; then
        echo "FAIL: $(basename "$f") links a memory that does not exist: $target"
        dangling=$((dangling + 1))
      fi
    done < <(grep -oE '\]\([^)]+\.md\)' "$f" | sed -E 's/^\]\(//; s/\)$//')
  done
  [[ "$dangling" -eq 0 ]] || rc=1
  [[ "$quiet" == "1" || "$dangling" -ne 0 ]] || echo "ok: no dangling index links"

  # Unindexed durable memories — a warning, never a failure: an orphan is still
  # rankable by its `description:`, so this is lost discoverability, not lost data.
  local indexed orphans=0 name path base
  indexed="$(cat "$index" "$archive" 2>/dev/null | grep -oE '\]\([^)]+\.md\)' | sed -E 's/^\]\(//; s/\)$//' | sort -u)"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    grep -qxF "$name" <<< "$indexed" || orphans=$((orphans + 1))
  done < <(
    # A glob, not `ls | grep`: a memory whose filename begins with '-' would be read
    # as an option by ls (SC2035), and this store already carries one hyphen-named
    # file (feedback-oss-no-premature-upsell.md) that the underscore convention missed.
    for path in "$dir"/*.md; do
      [[ -e "$path" ]] || continue
      base="${path##*/}"
      [[ "$base" == "MEMORY.md" || "$base" == "MEMORY-archive.md" ]] && continue
      [[ "$base" =~ $INDEXED_PREFIXES_RE ]] && printf '%s\n' "$base"
    done
  )
  if [[ "$orphans" -gt 0 ]]; then
    echo "warn: $orphans durable (non-project_) memories are indexed by neither file — reachable only by description ranking"
  elif [[ "$quiet" != "1" ]]; then
    echo "ok: every durable memory is indexed"
  fi

  return "$rc"
}

self_test() {
  # Proves the check can still FAIL — a gate that only ever passes is
  # indistinguishable from one that does not work (see check-gate-selftest-parity.sh).
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  local fail=0 pass=0
  t() { if [[ "$2" -eq 0 ]]; then pass=$((pass+1)); else echo "  FAIL: $1"; fail=$((fail+1)); fi; }
  # run_check returns non-zero BY DESIGN in the detection cases below. Under `set -e`
  # a bare call would abort the whole self-test at the first one — which is how this
  # function silently printed nothing on its first run. rc() captures instead.
  rc() { local c=0; "$@" >/dev/null 2>&1 || c=$?; printf '%s' "$c"; }

  # 1. absent store -> skip, exit 0
  t "absent memory dir exits 0" "$([[ "$(rc run_check "$tmp/nope" 1)" == 0 ]] && echo 0 || echo 1)"

  # 2. healthy store -> exit 0
  mkdir -p "$tmp/ok"
  printf -- '- [hook](feedback_a.md)\n' > "$tmp/ok/MEMORY.md"
  : > "$tmp/ok/MEMORY-archive.md"; : > "$tmp/ok/feedback_a.md"
  t "healthy store exits 0" "$([[ "$(rc run_check "$tmp/ok" 1)" == 0 ]] && echo 0 || echo 1)"

  # 3. over budget -> exit 1  (the detection that matters)
  mkdir -p "$tmp/big"
  head -c 24000 /dev/zero | tr '\0' 'x' > "$tmp/big/MEMORY.md"
  : > "$tmp/big/MEMORY-archive.md"
  t "over-budget index FAILS" "$([[ "$(rc run_check "$tmp/big" 1)" == 1 ]] && echo 0 || echo 1)"

  # 4. dangling link -> exit 1
  mkdir -p "$tmp/dangle"
  printf -- '- [hook](feedback_missing.md)\n' > "$tmp/dangle/MEMORY.md"
  : > "$tmp/dangle/MEMORY-archive.md"
  t "dangling index link FAILS" "$([[ "$(rc run_check "$tmp/dangle" 1)" == 1 ]] && echo 0 || echo 1)"

  # 5. orphaned durable memory -> warns, still exit 0
  mkdir -p "$tmp/orph"
  printf -- '- [hook](feedback_a.md)\n' > "$tmp/orph/MEMORY.md"
  : > "$tmp/orph/MEMORY-archive.md"; : > "$tmp/orph/feedback_a.md"; : > "$tmp/orph/feedback_orphan.md"
  local out ec=0
  out="$(run_check "$tmp/orph" 1 2>&1)" || ec=$?
  t "orphan warns but does not fail" "$([[ "$ec" -eq 0 ]] && grep -q "indexed by neither" <<< "$out" && echo 0 || echo 1)"

  # 6. project_ files are exempt from the orphan warning
  mkdir -p "$tmp/proj"
  printf -- '- [hook](feedback_a.md)\n' > "$tmp/proj/MEMORY.md"
  : > "$tmp/proj/MEMORY-archive.md"; : > "$tmp/proj/feedback_a.md"; : > "$tmp/proj/project_orphan.md"
  ec=0; out="$(run_check "$tmp/proj" 1 2>&1)" || ec=$?
  t "project_* orphan is exempt" "$(! grep -q "indexed by neither" <<< "$out" && echo 0 || echo 1)"

  echo "self-test: $pass passed, $fail failed"
  [[ "$fail" -eq 0 ]]
}

main() {
  local quiet=0
  for a in "$@"; do
    case "$a" in
      --self-test) self_test; exit $? ;;
      --quiet) quiet=1 ;;
      -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
      *) echo "unknown argument: $a" >&2; exit 2 ;;
    esac
  done
  run_check "$(resolve_memory_dir)" "$quiet"
}

main "$@"
