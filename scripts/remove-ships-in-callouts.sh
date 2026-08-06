#!/usr/bin/env bash
# scripts/remove-ships-in-callouts.sh — release-time removal of stale
# "Ships in 0.X" / "Coming in 0.X" docs callouts (#2694).
#
# CLAUDE.md's "Version-status tense" rule states the other half of the
# version-tense discipline that scripts/check-version-status.sh enforces:
# once a version ships, a "Ships in 0.X" callout left on the page is the same
# misinformation reversed — "'Ships in 0.4' banner on a page whose
# documentedFor has moved into Shipped is ... the failure mode a release
# actually produces." At the time this script was written there were 57 such
# callouts across 44 pages, in the `:::note[Ships in 0.X]` / `:::caution[...]`
# and "Coming in 0.X" forms described in that section. Doing that by hand
# during a release cut is exactly how it gets skipped — hence a script.
#
# Scope (deliberately narrow — see CLAUDE.md "Version-status tense"):
#   REMOVED (mechanical, unambiguous):
#     A fenced Starlight aside block whose OPENING line is
#       :::note[Ships in 0.X ...]     or   :::caution[Ships in 0.X ...]
#       :::note[Coming in 0.X ...]    or   :::caution[Coming in 0.X ...]
#     for the exact major.minor version passed on the command line, through
#     its matching closing `:::` line (same leading indentation — these
#     blocks are self-delimited, so the boundary is unambiguous). A trailing
#     qualifier in the bracket ("Ships in 0.4 (beta)") is allowed.
#
#   FLAGGED, never auto-removed (dry-run and --apply alike):
#     - A literal "Coming in 0.X" occurrence that is NOT a fenced-block
#       opening line — a heading ("## Coming in 0.4 (preview)") or inline
#       prose ("**Coming in 0.4** (#993), a non-mutating ..."). Deleting a
#       fragment of a sentence or a section heading needs editorial
#       judgment, not string surgery — flagged for a human instead of
#       guessed at.
#     - A fenced aside whose opening line matches but no closing `:::` is
#       found within a bounded window. Rather than guess where the block
#       ends and risk deleting real content, this is reported and left
#       alone.
#     - getting-started/try-it.md, ALWAYS — its "Coming in 0.4" callout
#       requires flipping the whole page from preview language to live
#       usage instructions (tracked separately by #1487 / #2271), not a
#       mechanical delete. This script intentionally does not attempt that
#       rewrite; the page is reported like any other match so the release
#       operator sees it, but neither --dry-run nor --apply ever touches it.
#
#   OUT OF SCOPE (not scanned for at all):
#     The much larger, pre-existing population of lowercase "(ships in 0.X)"
#     parenthetical / inline annotations threaded through ordinary prose and
#     table cells across dozens of other pages (e.g. "the column-mapping
#     wizard is not live yet (ships in 0.4)"). These are a different,
#     far more numerous pattern than the 57/44 callouts #2694 scoped this
#     script to, and are themselves ordinary future-tense claims that
#     scripts/check-version-status.sh already treats as legitimate
#     (`future_re`). Rewriting that population is a separate, much larger
#     editorial task, not a mechanical deletion — out of scope here.
#
# Safety gate: refuses to run (non-zero exit) unless the given version
# already appears under the roadmap's "## Shipped" section:
#   packages/website/src/content/docs/overview/roadmap.md
# This mirrors scripts/check-version-status.sh's roadmap parsing (same
# source of truth, same "### 0.X headers under ## Shipped" approach) rather
# than reinventing it. The gate is what makes it safe to call this script
# unconditionally from scripts/release.sh on every pre-1.0 alpha/beta/rc cut:
# before the roadmap is actually promoted, the call is a harmless refusal
# (exit 2), not a mistaken deletion.
#
# Modes:
#   bash scripts/remove-ships-in-callouts.sh <0.X>              # dry-run (default)
#   bash scripts/remove-ships-in-callouts.sh <0.X> --dry-run    # same, explicit
#   bash scripts/remove-ships-in-callouts.sh <0.X> --apply      # mutate files
#   bash scripts/remove-ships-in-callouts.sh --self-test        # fixture-based tests
#
# Exit codes:
#   0  ok (report printed / apply succeeded, no invocation problem)
#   1  invocation error (bad args, malformed version, roadmap missing)
#   2  refused: <0.X> is not (yet) listed under the roadmap's "## Shipped"
#   3  self-test failure

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROADMAP_DEFAULT="packages/website/src/content/docs/overview/roadmap.md"
DOCS_ROOT_DEFAULT="packages/website/src/content/docs"

# ── Roadmap parsing (mirrors scripts/check-version-status.sh) ──────────────
# Extract the set of shipped major.minor versions from the roadmap's
# "## Shipped" section. Reads "### 0.X" headers until the next "## " heading.
shipped_versions() {
  local roadmap="$1"
  sed -n '/^## Shipped[[:space:]]*$/,/^## /p' "$roadmap" \
    | grep -E '^###[[:space:]]+[0-9]+\.[0-9]+' \
    | sed -E 's/^###[[:space:]]+([0-9]+\.[0-9]+).*/\1/' \
    | head -n 100
}

is_shipped() {
  local version="$1" roadmap="$2"
  shipped_versions "$roadmap" | grep -qxF "$version"
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/remove-ships-in-callouts.sh <0.X> [--dry-run|--apply]
  scripts/remove-ships-in-callouts.sh --self-test
USAGE
}

# ── Core scan/removal, in Python (line-range surgery is impractical in
# portable bash; release.sh already shells to python3 for this class of
# text rewrite — see its CHANGELOG rotation). ────────────────────────────
run_scan() {
  local version="$1" mode="$2" docs_root="$3"
  VERSION="$version" MODE="$mode" DOCS_ROOT="$docs_root" python3 - <<'PY'
import os
import re
import sys

version = os.environ["VERSION"]
mode = os.environ["MODE"]  # "dry-run" or "apply"
docs_root = os.environ["DOCS_ROOT"]

# `version` is already the full "0.4"-shaped major.minor string; do not
# prepend another literal "0." or the pattern doubles up to "0.0.4".
version_re = re.escape(version)
OPEN_RE = re.compile(
    r'^(?P<indent>[ \t]*):::(?:note|caution|tip|danger)'
    r'\[(?P<phrase>Ships in|Coming in) ' + version_re + r'(?!\d)[^\]]*\]\s*$'
)
COMING_BARE_RE = re.compile(r'Coming in ' + version_re + r'(?!\d)')
TRY_IT_SUFFIX = os.path.join("getting-started", "try-it.md")

CLOSE_WINDOW = 80  # lines to search forward for a matching closing ':::'


def find_docs(root):
    out = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.endswith(".md") or fn.endswith(".mdx"):
                out.append(os.path.join(dirpath, fn))
    return sorted(out)


def scan_file(path, lines):
    """Return (blocks, ambiguous) for one file.

    blocks: list of (start_idx, end_idx, label) — inclusive 0-based line
      range of a fenced block that is safe to remove mechanically.
    ambiguous: list of (line_no_1based, text, reason) — flagged, never
      auto-removed.
    """
    is_try_it = path.replace("\\", "/").endswith(TRY_IT_SUFFIX.replace("\\", "/"))

    blocks = []
    ambiguous = []
    claimed = set()  # 0-based line indices already accounted for

    i = 0
    n = len(lines)
    while i < n:
        m = OPEN_RE.match(lines[i])
        if m:
            indent = m.group("indent")
            label = lines[i].strip()
            close_re = re.compile(r'^' + re.escape(indent) + r':::\s*$')
            close_idx = None
            for j in range(i + 1, min(n, i + 1 + CLOSE_WINDOW)):
                if close_re.match(lines[j]):
                    close_idx = j
                    break
            if close_idx is None:
                ambiguous.append(
                    (i + 1, label, "no matching closing ':::' found within "
                     f"{CLOSE_WINDOW} lines — left untouched")
                )
                claimed.add(i)
                i += 1
                continue

            for k in range(i, close_idx + 1):
                claimed.add(k)

            if is_try_it:
                ambiguous.append(
                    (i + 1, label,
                     "excluded — try-it.md's flip to live prose is tracked "
                     "separately (#1487 / #2271), not a mechanical delete")
                )
            else:
                blocks.append((i, close_idx, label))
            i = close_idx + 1
            continue
        i += 1

    # Bare "Coming in 0.X" occurrences not already part of a claimed block —
    # headings, inline prose. Never auto-removed.
    for idx, line in enumerate(lines):
        if idx in claimed:
            continue
        if COMING_BARE_RE.search(line):
            reason = (
                "excluded — try-it.md's flip to live prose is tracked "
                "separately (#1487 / #2271), not a mechanical delete"
                if is_try_it else
                "not a fenced block (heading or inline prose) — needs "
                "editorial judgment, left for manual review"
            )
            ambiguous.append((idx + 1, line.strip(), reason))

    return blocks, ambiguous


def remove_blocks(lines, blocks):
    """Remove the given inclusive 0-based ranges, collapsing a blank line
    directly before AND after a removed range down to a single blank (avoids
    doubled blank lines at the deletion site; leaves blank-line runs
    elsewhere in the file untouched)."""
    remove = set()
    extra = set()
    for start, end, _label in blocks:
        for k in range(start, end + 1):
            remove.add(k)
        before = start - 1
        after = end + 1
        if (
            before >= 0
            and after < len(lines)
            and lines[before].strip() == ""
            and lines[after].strip() == ""
        ):
            extra.add(after)
    keep = [ln for idx, ln in enumerate(lines) if idx not in remove and idx not in extra]
    return keep


def main():
    files = find_docs(docs_root)
    total_blocks = 0
    total_ambiguous = 0
    files_with_blocks = 0
    files_with_ambiguous = 0

    for path in files:
        with open(path, encoding="utf-8") as fh:
            content = fh.read()
        lines = content.split("\n")
        # split("\n") on a trailing-newline file yields a trailing "" entry;
        # keep it so join reproduces the file exactly.
        blocks, ambiguous = scan_file(path, lines)
        if not blocks and not ambiguous:
            continue

        rel = os.path.relpath(path, docs_root)
        print(f"\n{rel}")
        for start, end, label in blocks:
            verb = "REMOVED" if mode == "apply" else "would remove"
            print(f"  REMOVE  lines {start + 1}-{end + 1}  {label}  [{verb}]")
        for line_no, text, reason in ambiguous:
            snippet = text if len(text) <= 90 else text[:87] + "..."
            print(f"  FLAG    line {line_no}  {snippet}")
            print(f"          -> {reason}")

        if blocks:
            files_with_blocks += 1
            total_blocks += len(blocks)
        if ambiguous:
            files_with_ambiguous += 1
            total_ambiguous += len(ambiguous)

        if mode == "apply" and blocks:
            new_lines = remove_blocks(lines, blocks)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(new_lines))

    print("")
    verb = "Removed" if mode == "apply" else "Would remove"
    print(
        f"{verb} {total_blocks} callout block(s) in {files_with_blocks} file(s) "
        f"for version {version}."
    )
    print(
        f"Flagged {total_ambiguous} occurrence(s) in {files_with_ambiguous} file(s) "
        "for manual review (not touched)."
    )


main()
PY
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time.
  trap "rm -rf '$tmp'" EXIT
  local failures=0

  # ── Roadmap guard ─────────────────────────────────────────────────────
  local roadmap="$tmp/roadmap.md"
  cat >"$roadmap" <<'MD'
## Shipped

### 0.1 — first release

### 0.2 — second release

### 0.3 — hybrid delivery

## Underway

### 0.4 — first beta
MD

  if is_shipped "0.4" "$roadmap"; then
    echo "SELF-TEST FAILED: 0.4 (Underway) was treated as shipped." >&2
    failures=$((failures + 1))
  else
    echo "SELF-TEST OK: unshipped version correctly refused by the guard."
  fi

  if is_shipped "0.3" "$roadmap"; then
    echo "SELF-TEST OK: shipped version correctly accepted by the guard."
  else
    echo "SELF-TEST FAILED: 0.3 (Shipped) was rejected by the guard." >&2
    failures=$((failures + 1))
  fi

  # A roadmap that has since promoted 0.4 to Shipped — used by every fixture
  # below, so the scan itself is exercised against a version the guard would
  # actually allow.
  local shipped_roadmap="$tmp/roadmap-shipped.md"
  cat >"$shipped_roadmap" <<'MD'
## Shipped

### 0.1 — first release

### 0.2 — second release

### 0.3 — hybrid delivery

### 0.4 — first beta

## Underway

### 0.5 — next
MD
  if ! is_shipped "0.4" "$shipped_roadmap"; then
    echo "SELF-TEST FAILED: fixture roadmap setup is broken (0.4 should be shipped)." >&2
    failures=$((failures + 1))
  fi

  # ── Scan/removal fixtures ────────────────────────────────────────────
  # scan_case NAME CONTENT EXPECT_BLOCKS EXPECT_AMBIGUOUS [EXPECT_UNCHANGED=0]
  # Builds docs/<name>/page.md, runs the scan in dry-run then apply, and
  # asserts on the block/ambiguous counts and (optionally) that --apply left
  # the file byte-for-byte unchanged.
  scan_case() {
    local name="$1" content="$2" expect_blocks="$3" expect_ambiguous="$4" expect_unchanged="${5:-0}"
    local case_docs="$tmp/docs-$name"
    mkdir -p "$case_docs/sub"
    printf '%s' "$content" > "$case_docs/sub/page.md"

    local dry_out before_sum after_sum
    before_sum="$(shasum "$case_docs/sub/page.md" | awk '{print $1}')"
    dry_out="$(run_scan "0.4" "dry-run" "$case_docs")"
    after_sum="$(shasum "$case_docs/sub/page.md" | awk '{print $1}')"

    if [ "$before_sum" != "$after_sum" ]; then
      echo "SELF-TEST FAILED: $name — dry-run mutated the file." >&2
      failures=$((failures + 1))
    fi

    local got_blocks got_ambiguous
    got_blocks="$(printf '%s\n' "$dry_out" | grep -c '  REMOVE  ' || true)"
    got_ambiguous="$(printf '%s\n' "$dry_out" | grep -c '  FLAG    ' || true)"

    if [ "$got_blocks" = "$expect_blocks" ]; then
      echo "SELF-TEST OK: $name — dry-run found $expect_blocks removable block(s)."
    else
      echo "SELF-TEST FAILED: $name — expected $expect_blocks removable block(s), got $got_blocks." >&2
      failures=$((failures + 1))
    fi

    if [ "$got_ambiguous" = "$expect_ambiguous" ]; then
      echo "SELF-TEST OK: $name — dry-run flagged $expect_ambiguous ambiguous occurrence(s)."
    else
      echo "SELF-TEST FAILED: $name — expected $expect_ambiguous ambiguous occurrence(s), got $got_ambiguous." >&2
      failures=$((failures + 1))
    fi

    run_scan "0.4" "apply" "$case_docs" >/dev/null
    after_sum="$(shasum "$case_docs/sub/page.md" | awk '{print $1}')"

    if [ "$expect_unchanged" = "1" ]; then
      if [ "$before_sum" = "$after_sum" ]; then
        echo "SELF-TEST OK: $name — apply left the file unchanged as expected."
      else
        echo "SELF-TEST FAILED: $name — apply modified a file it should have left alone." >&2
        failures=$((failures + 1))
      fi
    else
      if [ "$before_sum" != "$after_sum" ]; then
        echo "SELF-TEST OK: $name — apply modified the file."
      else
        echo "SELF-TEST FAILED: $name — apply left the file unchanged; expected a removal." >&2
        failures=$((failures + 1))
      fi
      # Re-scanning after apply must find zero remaining removable blocks.
      local rescan
      rescan="$(run_scan "0.4" "dry-run" "$case_docs")"
      local remaining
      remaining="$(printf '%s\n' "$rescan" | grep -c '  REMOVE  ' || true)"
      if [ "$remaining" = "0" ]; then
        echo "SELF-TEST OK: $name — no removable blocks remain after apply."
      else
        echo "SELF-TEST FAILED: $name — $remaining removable block(s) still present after apply." >&2
        failures=$((failures + 1))
      fi
    fi
  }

  # 1. Simple top-level fenced block, blank line before and after.
  scan_case "simple" '---
title: Example
---

:::note[Ships in 0.4]
This behavior ships in TruePPM 0.4, the first beta.
:::

Ordinary paragraph that follows.
' 1 0

  # 2. Bracket carries a trailing qualifier, e.g. "(beta)".
  scan_case "beta-qualifier" '---
title: Example
---

:::note[Ships in 0.4 (beta)]
The surface lands in TruePPM 0.4, the first beta.
:::

Ordinary paragraph that follows.
' 1 0

  # 3. Indented block nested under a bullet, with blank-line collapse check.
  scan_case "indented" '- A bullet with more detail below.

  :::note[Ships in 0.4]
  Windowing detail that ships in 0.4.
  :::

  Continuation paragraph at the same indent.
' 1 0

  # 4. :::caution[Coming in 0.4] fenced form.
  scan_case "caution-coming" ':::caution[Coming in 0.4 — not yet available]
Placeholder text describing the unreleased path.
:::

More prose.
' 1 0

  # 5. Ambiguous inline prose sentence — never removed.
  scan_case "inline-prose" 'Some lead-in text.

**Coming in 0.4** (#993), a non-mutating what-if endpoint will answer that.

More prose after.
' 0 1 1

  # 6. Ambiguous heading — never removed.
  scan_case "heading" '## Coming in 0.4 (preview)

Some preview content describing what will land.
' 0 1 1

  # 7. Unclosed fence — flagged, left untouched even on apply.
  scan_case "unclosed" ':::note[Ships in 0.4]
This block never closes, on purpose, to exercise the bounded window.
' 0 1 1

  # 8. Multiple blocks in one file, one of each of the two labels.
  scan_case "multiple" ':::note[Ships in 0.4]
First block.
:::

Some prose in between.

:::caution[Ships in 0.4]
Second block.
:::
' 2 0

  # 9. try-it.md is always flagged, never removed, even with a well-formed
  # closed fence.
  scan_case_try_it() {
    local case_docs="$tmp/docs-try-it"
    mkdir -p "$case_docs/getting-started"
    printf '%s' ':::caution[Coming in 0.4 — not yet available]
This whole page needs a prose rewrite once 0.4 tags, not a callout delete.
:::

Rest of the page.
' > "$case_docs/getting-started/try-it.md"

    local before after dry_out
    before="$(shasum "$case_docs/getting-started/try-it.md" | awk '{print $1}')"
    dry_out="$(run_scan "0.4" "dry-run" "$case_docs")"
    if printf '%s\n' "$dry_out" | grep -q '  REMOVE  '; then
      echo "SELF-TEST FAILED: try-it.md — a block was reported as removable; it must always be excluded." >&2
      failures=$((failures + 1))
    else
      echo "SELF-TEST OK: try-it.md — no block reported as removable."
    fi
    if ! printf '%s\n' "$dry_out" | grep -q 'excluded — try-it.md'; then
      echo "SELF-TEST FAILED: try-it.md — expected an explicit exclusion reason in the report." >&2
      failures=$((failures + 1))
    else
      echo "SELF-TEST OK: try-it.md — exclusion reason present in the report."
    fi

    run_scan "0.4" "apply" "$case_docs" >/dev/null
    after="$(shasum "$case_docs/getting-started/try-it.md" | awk '{print $1}')"
    if [ "$before" = "$after" ]; then
      echo "SELF-TEST OK: try-it.md — --apply left the file byte-for-byte unchanged."
    else
      echo "SELF-TEST FAILED: try-it.md — --apply modified the excluded file." >&2
      failures=$((failures + 1))
    fi
  }
  scan_case_try_it

  return $failures
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    if self_test; then
      echo ""
      echo "SELF-TEST: all checks passed."
      return 0
    else
      echo ""
      echo "SELF-TEST: one or more checks FAILED (see above)." >&2
      return 3
    fi
  fi

  local version="" mode="dry-run"
  if [ $# -eq 0 ]; then
    usage
    return 1
  fi
  version="$1"
  shift || true
  case "${1:-}" in
    ""|--dry-run) mode="dry-run" ;;
    --apply) mode="apply" ;;
    *)
      echo "error: unrecognized argument '$1'" >&2
      usage
      return 1
      ;;
  esac

  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "error: '$version' is not a major.minor version (expected e.g. '0.4')" >&2
    usage
    return 1
  fi

  cd "$REPO_ROOT"
  local roadmap="$ROADMAP_DEFAULT"
  local docs_root="$DOCS_ROOT_DEFAULT"

  if [ ! -f "$roadmap" ]; then
    echo "ERROR: roadmap source of truth not found at: $roadmap" >&2
    return 1
  fi

  if ! is_shipped "$version" "$roadmap"; then
    echo "REFUSED: $version is not listed under '## Shipped' in $roadmap." >&2
    echo "This script only removes callouts for a version that has actually" >&2
    echo "tagged. Promote the roadmap entry to '## Shipped' first, or if you" >&2
    echo "are running this ahead of that edit, this refusal is expected and" >&2
    echo "safe — nothing was touched." >&2
    return 2
  fi

  echo "Scanning $docs_root for 'Ships in $version' / 'Coming in $version' callouts (mode: $mode)..."
  run_scan "$version" "$mode" "$docs_root"
}

main "$@"
