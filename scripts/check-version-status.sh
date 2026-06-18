#!/usr/bin/env bash
# Version-status tense gate (#807).
#
# A version-anchored past/present-tense claim in the docs ("shipped in 0.X",
# "added in 0.X", "landed in 0.X", "In 0.X the Y is …") may only reference a
# version that has actually shipped. If it references a version that is still
# Underway or Planned, a reader will hunt for behavior that does not exist yet.
# This is a user-facing accuracy bug (the 2026-05-28 "0.2 shipped" regression),
# so it fails the pipeline.
#
# Single source of truth for shipped-vs-unshipped is the roadmap's "## Shipped"
# section in:
#   packages/website/src/content/docs/overview/roadmap.md
# Every "### 0.X" header under "## Shipped" (and above "## Underway") is a
# shipped version. Anything else (Underway / Planned) is unshipped.
#
# Exemptions (per the CLAUDE.md "Version-status tense" rule):
#   - overview/roadmap.md itself — it is the source and legitimately describes
#     Underway / Planned versions.
#   - docs/adr/** — ADRs are design-decision artifacts; forward-tense
#     statements like "0.X will ship Y" are correct there.
#
# Future-tense claims about unshipped versions are fine and must NOT be flagged
# ("ships in 0.X", "lands in 0.X", "planned for 0.X", "In 0.X the Y *will* Z").
# The matcher targets only past/present-tense anchors and skips any line whose
# anchor is qualified by a future-tense modal ("will", "plans to", etc.).
#
# Exit codes:
#   0  no violations
#   1  a past/present-tense claim references an unshipped version
#   2  invocation / setup error (e.g. roadmap missing)
#
# Modes:
#   bash scripts/check-version-status.sh             # scan the docs tree
#   bash scripts/check-version-status.sh --self-test # synthesize fixtures, assert

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROADMAP_DEFAULT="packages/website/src/content/docs/overview/roadmap.md"
DOCS_ROOT_DEFAULT="packages/website/src/content/docs"

# Extract the set of shipped major.minor versions from the roadmap's
# "## Shipped" section. Reads "### 0.X" headers until the next "## " heading.
# Uses sed to slice the section (portable across BSD/busybox awk, neither of
# which supports the gawk 3-arg match()), then grep to pull the version token.
shipped_versions() {
  local roadmap="$1"
  sed -n '/^## Shipped[[:space:]]*$/,/^## /p' "$roadmap" \
    | grep -E '^###[[:space:]]+[0-9]+\.[0-9]+' \
    | sed -E 's/^###[[:space:]]+([0-9]+\.[0-9]+).*/\1/' \
    | head -n 100
}

# Compare two "X.Y" versions. Echoes 1 if $1 > $2, else 0.
version_gt() {
  local a="$1" b="$2"
  local a_maj="${a%%.*}" a_min="${a##*.}"
  local b_maj="${b%%.*}" b_min="${b##*.}"
  if [ "$a_maj" -gt "$b_maj" ]; then echo 1; return; fi
  if [ "$a_maj" -lt "$b_maj" ]; then echo 0; return; fi
  if [ "$a_min" -gt "$b_min" ]; then echo 1; else echo 0; fi
}

# Run the scan. Args: <roadmap> <docs_root>. Returns 1 on violations.
run_scan() {
  local roadmap="$1" docs_root="$2"

  if [ ! -f "$roadmap" ]; then
    echo "ERROR: roadmap source of truth not found at: $roadmap" >&2
    return 2
  fi

  # Build the shipped set.
  local shipped
  shipped="$(shipped_versions "$roadmap")"
  if [ -z "$shipped" ]; then
    echo "ERROR: no shipped versions parsed from $roadmap — has the" >&2
    echo "       '## Shipped' section / '### 0.X' header format changed?" >&2
    return 2
  fi

  # Highest shipped version, for the human-readable summary.
  local highest=""
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    if [ -z "$highest" ] || [ "$(version_gt "$v" "$highest")" = "1" ]; then
      highest="$v"
    fi
  done <<< "$shipped"

  # Past/present-tense version anchors (ERE, used with grep -E). Each phrase is
  # an anchor immediately followed by a "0.X" token. We deliberately do NOT
  # match bare "in 0.X" or "for 0.X" — those are almost always forward-looking
  # ("planned for 0.6", "sequenced for 0.6"). The "In 0.X the …" form is the
  # present-tense framing the regression used ("In 0.2 the reaction allow-list
  # is …").
  local anchor_re='(shipped in|added in|landed in|introduced in|available in|released in|In) 0\.[0-9]+'

  # Future-tense modal qualifiers — if a matched line also carries one of these,
  # the claim is forward-looking ("In 0.3 My Work will group …") and is allowed.
  local future_re='(will |wo n.t |won.t |plans to |plan to |is planned|are planned|ships in|lands in|coming|expected to|is sequenced|are sequenced|sequenced for|planned for)'

  # Files to scan: .md / .mdx under docs_root, excluding the roadmap itself.
  # (ADRs live under docs/adr, outside docs_root, so they are excluded already.)
  local files
  files="$(find "$docs_root" -type f \( -name '*.md' -o -name '*.mdx' \) \
    ! -path "$roadmap" 2>/dev/null | sort)"

  local violations=0
  local f hits lineno line ver
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # grep -nE gives "lineno:content" for every line carrying an anchor.
    hits="$(grep -nE "$anchor_re" "$f" 2>/dev/null || true)"
    [ -z "$hits" ] && continue
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      lineno="${hit%%:*}"
      line="${hit#*:}"
      # Skip future-tense lines.
      if printf '%s' "$line" | grep -qE "$future_re"; then
        continue
      fi
      # Pull every version token that directly follows an anchor phrase and
      # check each against the highest shipped version.
      while read -r ver; do
        [ -z "$ver" ] && continue
        if [ "$(version_gt "$ver" "$highest")" = "1" ]; then
          echo "VIOLATION: $f:$lineno references unshipped version $ver in past/present tense"
          echo "    $line"
          violations=$((violations + 1))
        fi
      done < <(printf '%s\n' "$line" \
        | grep -oE "$anchor_re" \
        | grep -oE '0\.[0-9]+')
    done <<< "$hits"
  done <<< "$files"

  echo ""
  echo "Shipped versions (from roadmap): $(echo "$shipped" | tr '\n' ' ')(highest: $highest)"
  if [ "$violations" -gt 0 ]; then
    echo ""
    echo "ERROR: $violations version-tense violation(s) found."
    echo "Past/present-tense version claims must reference a SHIPPED version."
    echo "For unshipped versions use future tense (\"ships in 0.X\", \"lands in 0.X\")."
    echo "Source of truth: $roadmap"
    return 1
  fi
  echo "OK: no past/present-tense claims reference an unshipped version."
  return 0
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time.
  trap "rm -rf '$tmp'" EXIT
  local docs="$tmp/docs"
  mkdir -p "$docs/overview" "$docs/features"

  cat >"$docs/overview/roadmap.md" <<'MD'
## Shipped

### 0.1 — first release

### 0.2 — second release

## Underway

### 0.3 — agile team
MD

  # Good page: shipped reference (0.2) past-tense + unshipped future-tense.
  cat >"$docs/features/good.md" <<'MD'
The feature shipped in 0.2.
In 0.3 My Work will group your tasks differently.
The full picker ships in 0.3.
MD

  # Bad page: unshipped reference (0.3) in past tense.
  cat >"$docs/features/bad.md" <<'MD'
The emoji picker shipped in 0.3.
MD

  # run_scan scans a directory; isolate good vs bad into separate dirs so a
  # violation in one fixture can't mask a false-positive in the other.
  local gdir="$tmp/g" bdir="$tmp/b"
  mkdir -p "$gdir" "$bdir"
  cp "$docs/overview/roadmap.md" "$gdir/"; cp "$docs/features/good.md" "$gdir/"
  cp "$docs/overview/roadmap.md" "$bdir/"; cp "$docs/features/bad.md" "$bdir/"

  if run_scan "$gdir/roadmap.md" "$gdir" >/dev/null 2>&1; then
    echo "SELF-TEST OK: good content accepted."
  else
    echo "SELF-TEST FAILED: good content was rejected." >&2
    return 1
  fi

  if run_scan "$bdir/roadmap.md" "$bdir" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: unshipped past-tense claim was accepted." >&2
    return 1
  else
    echo "SELF-TEST OK: unshipped past-tense claim correctly rejected."
  fi
  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  cd "$REPO_ROOT"
  local roadmap="${ROADMAP_OVERRIDE:-$ROADMAP_DEFAULT}"
  local docs_root="${DOCS_ROOT_OVERRIDE:-$DOCS_ROOT_DEFAULT}"
  run_scan "$roadmap" "$docs_root"
}

main "$@"
