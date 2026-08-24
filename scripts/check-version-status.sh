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
#   bash scripts/check-version-status.sh                  # scan the docs tree
#   bash scripts/check-version-status.sh --self-test      # synthesize fixtures, assert
#   bash scripts/check-version-status.sh --update-baseline # re-record the declaration
#                                                          # baseline (#2846, below)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROADMAP_DEFAULT="packages/website/src/content/docs/overview/roadmap.md"
DOCS_ROOT_DEFAULT="packages/website/src/content/docs"
BASELINE_DEFAULT="packages/website/docs-declaration-baseline.txt"
SIDEBAR_DEFAULT="packages/website/astro.config.mjs"

# Directories whose pages describe *user-visible product behavior*, and are
# therefore the ones a self-hoster reads as "what my install does". These are
# the only trees the declaration-coverage ratchet below applies to; explanation
# trees (architecture/, contributing/, overview/) describe design, not features.
DECLARATION_DIRS="features administration getting-started"

# Trees whose sidebar entries must mirror the page's own `documentedFor` as a
# version badge (#2908). A declaration + banner tells a reader the page is
# unreleased only AFTER they open it; the navigation that sent them there said
# nothing. Getting Started is the top of the adoption funnel — six of its eight
# pages declare 0.4 — so it is where a reader pays the most for that silence.
#
# Scoped deliberately, not universally: 60 more pages under features/ and
# administration/ declare 0.4, and badging all 66 sidebar entries is a
# navigation-density decision, not a correctness one. The reverse check below
# (a badge naming a shipped version, or one whose page declares nothing) runs
# over EVERY sidebar entry regardless of this list, so widening the list can
# only ever add work, never un-catch a stale badge.
BADGE_DIRS="getting-started"

# Portable sha256 of a file's contents. alpine/busybox has sha256sum; macOS has
# shasum only.
file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Does this page declare `documentedFor:` in its front matter?
page_declares() {
  sed -n '1,/^---[[:space:]]*$/{ /^documentedFor:/p; }' "$1" 2>/dev/null | grep -q .
}

# Every behavior page under DECLARATION_DIRS, relative to docs_root, sorted.
declaration_pages() {
  local docs_root="$1" d
  for d in $DECLARATION_DIRS; do
    [ -d "$docs_root/$d" ] || continue
    find "$docs_root/$d" -type f \( -name '*.md' -o -name '*.mdx' \) 2>/dev/null
  done | sed "s#^$docs_root/##" | sort
}

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

# ── Declaration coverage ratchet (#2846) ────────────────────────────────────
#
# The pairing check below is only armed on a page that DECLARES documentedFor.
# A page that documents an unreleased feature and declares nothing is invisible
# to it — the script's own comment says so. That residual hole is not
# theoretical: it produced #807, then #2608 (four pages, fixed 2026-07-30), then
# #2846 on features/board.md and features/interface.md seventeen days later. The
# pages got fixed each time; nothing ever asked the author the question.
#
# No regex can read prose and decide whether it describes shipped behavior — so
# this does not try. It makes *omission* loud instead of silent, by ratchet:
#
#   A page under DECLARATION_DIRS either declares `documentedFor`, or its exact
#   current contents are recorded in packages/website/docs-declaration-baseline.txt.
#
# Editing a non-declaring page changes its hash, which fails the gate until the
# author either declares the version the page documents, or re-baselines with
# `--update-baseline` — an explicit, one-line, reviewable statement in the diff
# that says "I checked; this edit documents nothing that is unreleased".
#
# Be clear about what this buys and what it does not. It cannot stop a wrong
# answer: `--update-baseline` is one command, and an author who rubber-stamps it
# gets exactly the outcome we have today. What it removes is the *silence* —
# under the old gate, adding four paragraphs of unreleased behavior to board.md
# produced no signal at any point in the pipeline. The seeded baseline is
# explicitly a grandfathered snapshot, NOT a review: nobody has verified that
# the pages in it describe only shipped behavior, and the file must not be read
# as if somebody had. It arms on the next edit to each of them.
#
# Sets RATCHET_VIOLATIONS. Returns 0 normally, 2 on a setup error (missing
# baseline file) — a count and an invocation error must not share an exit code.
RATCHET_VIOLATIONS=0
declaration_ratchet() {
  local docs_root="$1" baseline="$2"
  local viol=0 rel want have
  RATCHET_VIOLATIONS=0

  if [ ! -f "$baseline" ]; then
    echo "ERROR: declaration baseline not found at: $baseline" >&2
    echo "       Regenerate it with: bash scripts/check-version-status.sh --update-baseline" >&2
    return 2
  fi

  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    have="$(awk -v p="$rel" '$1==p{print $2}' "$baseline" | head -n 1)"
    if page_declares "$docs_root/$rel"; then
      # A declaring page is governed by the pairing check above; a leftover
      # baseline line for it would rot into a permanent allowlist entry.
      if [ -n "$have" ]; then
        echo "VIOLATION: $rel declares documentedFor but still has a baseline entry" >&2
        echo "    Drop its line from $baseline (or run --update-baseline)." >&2
        viol=$((viol + 1))
      fi
      continue
    fi
    want="$(file_hash "$docs_root/$rel")"
    if [ -z "$have" ]; then
      echo "VIOLATION: $rel has no \"documentedFor\" and no declaration baseline entry" >&2
      echo "    Every page under: $DECLARATION_DIRS describes what a reader's install does." >&2
      echo "    Declare the version it documents, or record it with --update-baseline." >&2
      viol=$((viol + 1))
    elif [ "$have" != "$want" ]; then
      echo "VIOLATION: $rel changed and does not declare \"documentedFor\"" >&2
      echo "    If this edit documents behavior that is NOT in the latest release, add" >&2
      echo "      documentedFor: \"0.X\"   plus a :::note[Ships in 0.X] callout." >&2
      echo "    If it documents only shipped behavior, re-record it:" >&2
      echo "      bash scripts/check-version-status.sh --update-baseline" >&2
      viol=$((viol + 1))
    fi
  done <<< "$(declaration_pages "$docs_root")"

  # A baseline line whose page is gone is dead weight that hides nothing but
  # makes the file harder to trust.
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    if [ ! -f "$docs_root/$rel" ]; then
      echo "VIOLATION: $baseline lists $rel, which no longer exists" >&2
      viol=$((viol + 1))
    fi
  done <<< "$(awk 'NF && $1 !~ /^#/ {print $1}' "$baseline")"

  RATCHET_VIOLATIONS="$viol"
  return 0
}

# Rewrite the baseline from the current tree. Deliberately a separate, explicit
# invocation: the one-line diff it produces is the whole signal.
update_baseline() {
  local docs_root="$1" baseline="$2" rel
  {
    echo "# Declaration-coverage baseline (#2846) — see scripts/check-version-status.sh."
    echo "#"
    echo "# Pages under: $DECLARATION_DIRS that carry NO \"documentedFor\" front-matter key,"
    echo "# with the sha256 of the contents they had when they were last recorded here."
    echo "# Editing one of these pages breaks its hash and fails docs:version-accuracy"
    echo "# until the author either declares the version the page documents or re-runs"
    echo "#   bash scripts/check-version-status.sh --update-baseline"
    echo "#"
    echo "# This file is a GRANDFATHERED SNAPSHOT, not a review. No one has verified that"
    echo "# these pages describe only shipped behavior. Its purpose is to arm the gate on"
    echo "# the NEXT edit to each of them. A page leaves this file for good the moment it"
    echo "# declares documentedFor."
    echo "#"
    echo "# Regenerate, never hand-edit."
    while IFS= read -r rel; do
      [ -z "$rel" ] && continue
      page_declares "$docs_root/$rel" && continue
      printf '%s %s\n' "$rel" "$(file_hash "$docs_root/$rel")"
    done <<< "$(declaration_pages "$docs_root")"
  } > "$baseline"
  echo "Wrote $(awk 'NF && $1 !~ /^#/' "$baseline" | wc -l | tr -d ' ') baseline entries to $baseline"
}

# Emit "<slug><TAB><badge-version-or-empty>" for every sidebar entry in an
# Astro/Starlight config. Written in python because the association is
# structural, not textual: a badge belongs to the object that directly contains
# its slug, and a `{ text, variant }` badge nests braces inside that object. A
# line-oriented grep cannot tell that nesting from a sibling entry, and would
# silently pair a slug with the next entry's badge.
sidebar_entries() {
  python3 - "$1" <<'PYEOF'
import re, sys

src = open(sys.argv[1], encoding="utf-8").read()

# Object extents, skipping string literals and comments so a brace inside
# either never moves the depth.
spans, stack, i, n = [], [], 0, len(src)
while i < n:
    c = src[i]
    if c in "\"'`":
        q, i = c, i + 1
        while i < n:
            if src[i] == "\\":
                i += 2
                continue
            if src[i] == q:
                break
            i += 1
        i += 1
        continue
    if c == "/" and i + 1 < n and src[i + 1] == "/":
        j = src.find("\n", i)
        i = n if j < 0 else j
        continue
    if c == "/" and i + 1 < n and src[i + 1] == "*":
        j = src.find("*/", i)
        i = n if j < 0 else j + 2
        continue
    if c == "{":
        stack.append(i)
    elif c == "}" and stack:
        spans.append((stack.pop(), i))
    i += 1


def innermost(pos):
    """The tightest object span containing pos, or None."""
    best = None
    for s, e in spans:
        if s < pos < e and (best is None or s > best[0]):
            best = (s, e)
    return best


# A badge is claimed by the object that directly contains its key.
badges = {}
for m in re.finditer(r"\bbadge\s*:", src):
    owner = innermost(m.start())
    if owner is None:
        continue
    ver = re.search(r"0\.[0-9]+", src[m.end() : m.end() + 200])
    badges.setdefault(owner, ver.group(0) if ver else "?")

for m in re.finditer(r"""\bslug\s*:\s*["'`]([^"'`]+)["'`]""", src):
    owner = innermost(m.start())
    print("%s\t%s" % (m.group(1), badges.get(owner, "") if owner else ""))
PYEOF
}

# Sidebar badge pairing (#2908). Both directions, for the same reason the
# documentedFor/callout pairing runs both ways: a badge that never appears and
# a badge that outlives its release are the same misinformation, and the second
# is the one a release actually produces.
BADGE_VIOLATIONS=0
badge_check() { # badge_check <sidebar_file> <docs_root> <highest_shipped>
  local sidebar="$1" docs_root="$2" highest="$3"
  BADGE_VIOLATIONS=0

  if [ ! -f "$sidebar" ]; then
    echo "ERROR: sidebar config not found at: $sidebar" >&2
    return 2
  fi

  local entries
  if ! entries="$(sidebar_entries "$sidebar")"; then
    echo "ERROR: could not parse sidebar entries from $sidebar" >&2
    return 2
  fi
  if [ -z "$entries" ]; then
    echo "ERROR: parsed zero sidebar entries from $sidebar — has the config" >&2
    echo "       moved off literal { slug: \"…\" } entries (autogenerate)?" >&2
    return 2
  fi

  local slug badge page declared d want tab
  tab="$(printf '\t')"
  while IFS="$tab" read -r slug badge; do
    [ -z "$slug" ] && continue
    page=""
    for d in "$docs_root/$slug.md" "$docs_root/$slug.mdx"; do
      [ -f "$d" ] && page="$d" && break
    done
    declared=""
    if [ -n "$page" ]; then
      declared="$(sed -n '1,/^---[[:space:]]*$/{ /^documentedFor:/p; }' "$page" 2>/dev/null \
        | head -n 1 | sed -E 's/^documentedFor:[[:space:]]*["'"'"']?([0-9]+\.[0-9]+).*/\1/')"
    fi

    # Forward: a page in a badged tree that declares an unshipped version must
    # carry that badge in the nav.
    want=""
    for d in $BADGE_DIRS; do
      case "$slug" in "$d"/*) want=1 ;; esac
    done
    if [ -n "$want" ] && [ -n "$declared" ] && [ "$(version_gt "$declared" "$highest")" = "1" ]; then
      if [ -z "$badge" ]; then
        echo "VIOLATION: $sidebar: '$slug' has no badge, but the page declares documentedFor: $declared (unshipped)" >&2
        echo "    Add   badge: { text: \"$declared\", variant: \"caution\" }   to its sidebar entry."
        BADGE_VIOLATIONS=$((BADGE_VIOLATIONS + 1))
        continue
      elif [ "$badge" != "$declared" ]; then
        echo "VIOLATION: $sidebar: '$slug' is badged $badge but the page declares documentedFor: $declared" >&2
        BADGE_VIOLATIONS=$((BADGE_VIOLATIONS + 1))
        continue
      fi
    fi

    # Reverse: every version badge in the nav, in any tree, must be backed by a
    # matching unshipped declaration. This is the branch that turns red on the
    # release which ships 0.X — the badge has to come off with the callout.
    [ -z "$badge" ] && continue
    # A non-version badge ("New", "Deprecated") is not this gate's business.
    [ "$badge" = "?" ] && continue
    if [ -z "$page" ]; then
      echo "VIOLATION: $sidebar: '$slug' is badged $badge but no page was found for that slug" >&2
      BADGE_VIOLATIONS=$((BADGE_VIOLATIONS + 1))
    elif [ -z "$declared" ]; then
      echo "VIOLATION: $sidebar: '$slug' is badged $badge but the page declares no documentedFor" >&2
      echo "    A version badge is a claim about the page; the page has to make it too."
      BADGE_VIOLATIONS=$((BADGE_VIOLATIONS + 1))
    elif [ "$badge" != "$declared" ]; then
      echo "VIOLATION: $sidebar: '$slug' is badged $badge but the page declares documentedFor: $declared" >&2
      BADGE_VIOLATIONS=$((BADGE_VIOLATIONS + 1))
    elif [ "$(version_gt "$badge" "$highest")" != "1" ]; then
      echo "VIOLATION: $sidebar: '$slug' is badged $badge, which has shipped" >&2
      echo "    Delete the badge — $badge is released, so the nav now understates the product."
      BADGE_VIOLATIONS=$((BADGE_VIOLATIONS + 1))
    fi
  done <<< "$entries"

  return 0
}

# Run the scan. Args: <roadmap> <docs_root> [baseline] [sidebar].
# Returns 1 on violations. Both optional args are opt-in so the tense/pairing
# fixtures in self_test keep exercising exactly what they were written for.
run_scan() {
  local roadmap="$1" docs_root="$2" baseline="${3:-}" sidebar="${4:-}"

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
  local anchor_re='(shipped in|added in|landed in|introduced in|available in|released in|new in|as of|since|In) 0\.[0-9]+'

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
          echo "VIOLATION: $f:$lineno references unshipped version $ver in past/present tense" >&2
          echo "    $line" >&2
          violations=$((violations + 1))
        fi
      done < <(printf '%s\n' "$line" \
        | grep -oE "$anchor_re" \
        | grep -oE '0\.[0-9]+')
    done <<< "$hits"
  done <<< "$files"

  # ── Front-matter pairing (#2608) ────────────────────────────────────────────
  #
  # The regex above can only see a claim that ANCHORS ITSELF to a version. It is
  # structurally blind to a page describing an unreleased feature in plain
  # present tense with no version mentioned anywhere — which is what four pages
  # did while this gate reported clean, telling a 0.3 self-hoster to use a
  # Share button that did not exist in their install. No regex decides that
  # question; the page has to say which version it documents.
  #
  # So: `documentedFor: "0.X"` in front matter, paired against the roadmap.
  #   unshipped 0.X  → the page MUST carry a "Ships in 0.X" callout
  #   shipped   0.X  → it must NOT (a callout left behind after the release is
  #                    the same lie in the other direction, and is the failure
  #                    mode a release will actually produce)
  #
  # Honest about the limit: this cannot catch a page that documents an
  # unreleased feature and declares nothing. It converts "did the author pick
  # the right tense" — unenforceable — into "the author named a version once,
  # and the banner is guaranteed to match it". Nor does it see a bare
  # ":::note[0.X]" badge naming an unshipped version, for the reason given at
  # callout_re below — declare documentedFor on such a page and the pairing
  # check will demand a real banner.
  #
  # Which banner forms count (#2818). This originally accepted exactly one
  # literal prefix, ":::note[Ships in 0.X". A banner phrased any other way was
  # invisible in BOTH directions — the pairing check could not confirm it, and
  # the post-release reverse check could not flag it once 0.X shipped. Seventeen
  # 0.4 banners had drifted into "Coming in 0.4", "Single sign-on lands in 0.4",
  # "Task CSV / Excel import ships in 0.4" (title text before the verb), and a
  # bare ":::note[0.4]" badge before anyone noticed. So any aside whose title
  # carries a future-tense verb immediately followed by the version counts, with
  # arbitrary title text allowed before the verb.
  #
  # Deliberately NOT recognized: the bare ":::note[0.X]" / ":::note[Added in
  # 0.X]" badges that mark SHIPPED behavior on dozens of pages. Reading those as
  # pre-release banners would fire the stale-banner branch below on every one of
  # them. A pre-release banner has to name its verb — which is why the drifted
  # bare-version 0.4 badges were retitled rather than matched here.
  local callout_re=':::(note|caution|tip|danger)\[[^]]*(ship(s|ping)?|com(e|es|ing)|land(s|ing)?|chang(e|es|ing)) in 0\.[0-9]+'

  local fm_violations=0
  local declared callout_vers v
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Read the key only from the front-matter block (line 1 to the closing ---).
    declared="$(sed -n '1,/^---[[:space:]]*$/{ /^documentedFor:/p; }' "$f" 2>/dev/null \
      | head -n 1 | sed -E 's/^documentedFor:[[:space:]]*["'"'"']?([0-9]+\.[0-9]+).*/\1/')"
    # EVERY version named by a pre-release banner on the page, not just the
    # first: a page can legitimately carry banners for two versions, and taking
    # only the first made the pairing check depend on document order.
    callout_vers="$(grep -oEi "$callout_re" "$f" 2>/dev/null \
      | grep -oE '0\.[0-9]+' | sort -u || true)"

    # Pre-release pairing: an unshipped declaration needs a matching banner.
    if [ -n "$declared" ] && [ "$(version_gt "$declared" "$highest")" = "1" ]; then
      if [ -z "$callout_vers" ]; then
        echo "VIOLATION: $f declares documentedFor: $declared (unshipped) but carries no \"Ships in $declared\" callout" >&2
        echo "    A reader on $highest would take this page as describing their install."
        fm_violations=$((fm_violations + 1))
      elif ! printf '%s\n' "$callout_vers" | grep -qxF "$declared"; then
        echo "VIOLATION: $f declares documentedFor: $declared but its callout says \"Ships in $(printf '%s' "$callout_vers" | head -n 1)\"" >&2
        fm_violations=$((fm_violations + 1))
      fi
    fi

    # Post-release reverse check — the branch that turns red on the release
    # which promotes 0.X into the roadmap's "## Shipped" section. It runs
    # whether or not the page declares documentedFor, because the banner alone
    # is the misinformation: a "not yet available" note on a shipped feature.
    while IFS= read -r v; do
      [ -z "$v" ] && continue
      if [ "$(version_gt "$v" "$highest")" != "1" ]; then
        if [ -n "$declared" ] && [ "$v" = "$declared" ]; then
          echo "VIOLATION: $f carries a \"Ships in $v\" callout, but documentedFor: $declared has shipped" >&2
          echo "    Delete the callout — $declared is released, so the banner now misinforms."
        else
          echo "VIOLATION: $f carries a \"Ships in $v\" callout for a version that has shipped" >&2
        fi
        fm_violations=$((fm_violations + 1))
      fi
    done <<< "$callout_vers"
  done <<< "$files"
  violations=$((violations + fm_violations))

  # Declaration coverage (#2846) — only when a baseline path is supplied, so the
  # tense/pairing fixtures above keep testing exactly what they were written for.
  if [ -n "$baseline" ]; then
    if ! declaration_ratchet "$docs_root" "$baseline"; then
      return 2
    fi
    violations=$((violations + RATCHET_VIOLATIONS))
  fi

  # Sidebar badge pairing (#2908) — only when a sidebar path is supplied.
  if [ -n "$sidebar" ]; then
    if ! badge_check "$sidebar" "$docs_root" "$highest"; then
      return 2
    fi
    violations=$((violations + BADGE_VIOLATIONS))
  fi

  echo ""
  echo "Shipped versions (from roadmap): $(echo "$shipped" | tr '\n' ' ')(highest: $highest)"
  if [ "$violations" -gt 0 ]; then
    {
      echo ""
      echo "ERROR: $violations version-tense violation(s) found."
      echo "Past/present-tense version claims must reference a SHIPPED version."
      echo "For unshipped versions use future tense (\"ships in 0.X\", \"lands in 0.X\")."
      echo ""
      echo "If a page documents behavior that has not been released, declare it:"
      echo "  documentedFor: \"0.X\"   in front matter, plus a :::note[Ships in 0.X] callout."
      echo "Once 0.X ships, delete the callout — the roadmap move is what makes it stale."
      echo "Source of truth: $roadmap"
    } >&2
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

  # ── documentedFor pairing (#2608) ──────────────────────────────────────────
  # These four cases are the whole reason the key exists: none of them mentions
  # a version in prose, so the regex above sees nothing in any of them. Each
  # fixture goes in its own directory so one verdict cannot mask another.
  local case_dir
  fm_case() { # fm_case <name> <expect-pass|expect-fail> <page-body>
    local name="$1" expect="$2" body="$3"
    case_dir="$tmp/fm-$name"
    mkdir -p "$case_dir"
    cp "$docs/overview/roadmap.md" "$case_dir/"
    printf '%s\n' "$body" > "$case_dir/page.md"
    if run_scan "$case_dir/roadmap.md" "$case_dir" >/dev/null 2>&1; then
      if [ "$expect" = "expect-pass" ]; then
        echo "SELF-TEST OK: $name accepted."
      else
        echo "SELF-TEST FAILED: $name was accepted and should not be." >&2
        return 1
      fi
    else
      if [ "$expect" = "expect-fail" ]; then
        echo "SELF-TEST OK: $name correctly rejected."
      else
        echo "SELF-TEST FAILED: $name was rejected and should not be." >&2
        return 1
      fi
    fi
  }

  # Unshipped (0.3 is Underway in the fixture roadmap) and unbannered — the
  # exact shape of the four pages this gate reported clean.
  fm_case "unshipped-without-callout" expect-fail '---
title: Sharing
documentedFor: "0.3"
---

Click **Share** to generate a public link.' || return 1

  fm_case "unshipped-with-callout" expect-pass '---
title: Sharing
documentedFor: "0.3"
---

:::note[Ships in 0.3]
Not in the latest release.
:::

Click **Share** to generate a public link.' || return 1

  # The failure a release actually produces: the version ships, the banner stays.
  fm_case "shipped-with-stale-callout" expect-fail '---
title: Sharing
documentedFor: "0.2"
---

:::note[Ships in 0.2]
Not in the latest release.
:::

Click **Share** to generate a public link.' || return 1

  # A page documenting long-shipped behavior needs no key at all.
  fm_case "no-key-no-callout" expect-pass '---
title: Sharing
---

Click **Share** to generate a public link.' || return 1

  # ── Widened banner phrasings (#2818) ───────────────────────────────────────
  # Each of these is a real phrasing found in the docs tree that the original
  # literal ":::note[Ships in 0.X" matcher could not see. They are paired: the
  # pre-release case proves the phrasing SATISFIES the pairing check, and the
  # post-release case proves the same phrasing gets FLAGGED once the version
  # moves into "## Shipped". The second half is the whole point — a banner the
  # gate cannot see is a banner that survives the tag as misinformation.
  fm_case "unshipped-coming-in" expect-pass '---
title: Sharing
documentedFor: "0.3"
---

:::note[Coming in 0.3]
Not in the latest release.
:::' || return 1

  fm_case "unshipped-lands-in" expect-pass '---
title: Single sign-on
documentedFor: "0.3"
---

:::note[Single sign-on lands in 0.3]
Not in the latest release.
:::' || return 1

  fm_case "unshipped-changing-in" expect-pass '---
title: Offline sync
documentedFor: "0.3"
---

:::caution[Changing in 0.3]
The watermark changes with the next tag.
:::' || return 1

  # Title text BEFORE the verb — the csv-import-export.md form.
  fm_case "unshipped-text-before-verb" expect-pass '---
title: CSV import
documentedFor: "0.3"
---

:::note[Task CSV / Excel import ships in 0.3]
Not in the latest release.
:::' || return 1

  fm_case "shipped-stale-coming-in" expect-fail '---
title: Sharing
documentedFor: "0.2"
---

:::note[Coming in 0.2]
Not in the latest release.
:::' || return 1

  # No documentedFor key at all — the banner alone must still be flagged.
  fm_case "shipped-stale-lands-in-no-key" expect-fail '---
title: Single sign-on
---

:::note[Single sign-on lands in 0.2]
Not in the latest release.
:::' || return 1

  fm_case "shipped-stale-changing-in-no-key" expect-fail '---
title: Offline sync
---

:::caution[Changing in 0.2]
The watermark changed with that tag.
:::' || return 1

  fm_case "shipped-stale-text-before-verb-no-key" expect-fail '---
title: CSV import
---

:::note[Task CSV / Excel import ships in 0.2]
Not in the latest release.
:::' || return 1

  # ── Exclusions that must keep working ──────────────────────────────────────
  # The shipped-version badge conventions used across dozens of pages. If the
  # widened matcher read these as pre-release banners, the reverse check would
  # fire on every one of them and the gate would be permanently red.
  fm_case "shipped-bare-version-badge" expect-pass '---
title: Calendars
---

:::note[0.1]
Calendars shipped in 0.1 and are part of the **Community (OSS)** edition.
:::' || return 1

  fm_case "shipped-added-in-badge" expect-pass '---
title: Email
---

:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**.
:::' || return 1

  # -- Declaration coverage ratchet (#2846) ----------------------------------
  # The hole the two checks above cannot see: a page that documents unreleased
  # behavior in plain present tense and declares NOTHING. Three occurrences so
  # far (#807, #2608, #2846). These cases assert the ratchet arms on the edit.
  ratchet_case() { # ratchet_case <name> <expect-pass|expect-fail> <setup-fn>
    local name="$1" expect="$2" setup="$3"
    local dir="$tmp/rt-$name"
    mkdir -p "$dir/features"
    cp "$docs/overview/roadmap.md" "$dir/"
    "$setup" "$dir"
    if run_scan "$dir/roadmap.md" "$dir" "$dir/baseline.txt" >/dev/null 2>&1; then
      if [ "$expect" = "expect-pass" ]; then
        echo "SELF-TEST OK: ratchet $name accepted."
      else
        echo "SELF-TEST FAILED: ratchet $name was accepted and should not be." >&2
        return 1
      fi
    else
      if [ "$expect" = "expect-fail" ]; then
        echo "SELF-TEST OK: ratchet $name correctly rejected."
      else
        echo "SELF-TEST FAILED: ratchet $name was rejected and should not be." >&2
        return 1
      fi
    fi
  }

  # A behavior page with no documentedFor, recorded exactly as it stands.
  _rt_recorded() {
    printf 'Click **Share** to generate a public link.\n' > "$1/features/page.md"
    printf '# baseline\nfeatures/page.md %s\n' "$(file_hash "$1/features/page.md")" \
      > "$1/baseline.txt"
  }
  ratchet_case "recorded-unchanged" expect-pass _rt_recorded || return 1

  # The whole point: the SAME page, edited. The edit is what arms the gate.
  _rt_edited() {
    _rt_recorded "$1"
    printf 'Click **Share** to generate a public link.\nNow with cross-program search.\n' \
      > "$1/features/page.md"
  }
  ratchet_case "recorded-then-edited" expect-fail _rt_edited || return 1

  # A brand-new behavior page that declares nothing and was never recorded.
  _rt_unrecorded() {
    printf 'Click **Share** to generate a public link.\n' > "$1/features/page.md"
    printf '# baseline\n' > "$1/baseline.txt"
  }
  ratchet_case "unrecorded" expect-fail _rt_unrecorded || return 1

  # Declaring a version is the way OUT of the baseline -- and a page must not be
  # in both, or the entry rots into a permanent allowlist line.
  _rt_declared_clean() {
    printf -- '---\ntitle: Sharing\ndocumentedFor: "0.2"\n---\n\nShare links.\n' \
      > "$1/features/page.md"
    printf '# baseline\n' > "$1/baseline.txt"
  }
  ratchet_case "declared-not-in-baseline" expect-pass _rt_declared_clean || return 1

  _rt_declared_stale_entry() {
    printf -- '---\ntitle: Sharing\ndocumentedFor: "0.2"\n---\n\nShare links.\n' \
      > "$1/features/page.md"
    printf '# baseline\nfeatures/page.md %s\n' "$(file_hash "$1/features/page.md")" \
      > "$1/baseline.txt"
  }
  ratchet_case "declared-with-stale-entry" expect-fail _rt_declared_stale_entry || return 1

  # A line for a page that no longer exists is dead weight.
  _rt_orphan_entry() {
    printf '# baseline\nfeatures/gone.md deadbeef\n' > "$1/baseline.txt"
  }
  ratchet_case "orphan-baseline-entry" expect-fail _rt_orphan_entry || return 1

  # -- Sidebar badge pairing (#2908) ------------------------------------------
  # A declaration plus a banner tells a reader the page is unreleased only after
  # they open it. These cases assert the nav says it too, and — the branch that
  # matters — that the badge cannot outlive the release, which is the failure a
  # tag actually produces. `getting-started/` because that is BADGE_DIRS.
  badge_case() { # badge_case <name> <expect-pass|expect-fail> <page-fm> <sidebar-entry>
    local name="$1" expect="$2" fm="$3" entry="$4"
    local dir="$tmp/bg-$name"
    mkdir -p "$dir/getting-started"
    cp "$docs/overview/roadmap.md" "$dir/"
    printf '%s\n' "$fm" > "$dir/getting-started/page.md"
    printf 'export default { sidebar: [ { label: "Getting Started", items: [ %s ] } ] };\n' \
      "$entry" > "$dir/astro.config.mjs"
    if run_scan "$dir/roadmap.md" "$dir" "" "$dir/astro.config.mjs" >/dev/null 2>&1; then
      if [ "$expect" = "expect-pass" ]; then
        echo "SELF-TEST OK: badge $name accepted."
      else
        echo "SELF-TEST FAILED: badge $name was accepted and should not be." >&2
        return 1
      fi
    else
      if [ "$expect" = "expect-fail" ]; then
        echo "SELF-TEST OK: badge $name correctly rejected."
      else
        echo "SELF-TEST FAILED: badge $name was rejected and should not be." >&2
        return 1
      fi
    fi
  }

  local unshipped_page shipped_page plain_page
  unshipped_page='---
title: Try it
documentedFor: "0.3"
---

:::note[Ships in 0.3]
Not in the latest release.
:::'
  shipped_page='---
title: Try it
documentedFor: "0.2"
---

Available today.'
  plain_page='---
title: Try it
---

Available today.'

  badge_case "unshipped-badged" expect-pass "$unshipped_page" \
    '{ slug: "getting-started/page", badge: { text: "0.3", variant: "caution" } }' || return 1

  badge_case "unshipped-unbadged" expect-fail "$unshipped_page" \
    '{ slug: "getting-started/page" }' || return 1

  badge_case "badge-disagrees-with-declaration" expect-fail "$unshipped_page" \
    '{ slug: "getting-started/page", badge: { text: "0.4", variant: "caution" } }' || return 1

  badge_case "badged-page-declares-nothing" expect-fail "$plain_page" \
    '{ slug: "getting-started/page", badge: "0.3" }' || return 1

  # THE release case: 0.2 has shipped, so the badge is now a false "not yet".
  # This is the branch that reds on the tag and forces the badge off with the
  # callout, instead of leaving the nav understating the product.
  badge_case "badge-outlived-its-release" expect-fail "$shipped_page" \
    '{ slug: "getting-started/page", badge: { text: "0.2", variant: "caution" } }' || return 1

  # A non-version badge is somebody else's convention, not this gate's business.
  badge_case "non-version-badge-ignored" expect-pass "$plain_page" \
    '{ slug: "getting-started/page", badge: "New" }' || return 1

  # A badge on a slug with no page at all is a nav entry pointing at nothing.
  badge_case "badged-slug-has-no-page" expect-fail "$plain_page" \
    '{ slug: "getting-started/gone", badge: "0.3" }' || return 1

  # Scope: BADGE_DIRS is getting-started, so an undeclared-badge page in another
  # tree must NOT be demanded. 60 pages under features/ + administration/ ride
  # on this staying true — if it ever stops, the gate reds on all of them.
  local scope_dir="$tmp/bg-scope"
  mkdir -p "$scope_dir/features"
  cp "$docs/overview/roadmap.md" "$scope_dir/"
  printf '%s\n' "$unshipped_page" > "$scope_dir/features/page.md"
  printf 'export default { sidebar: [ { label: "Features", items: [ { slug: "features/page" } ] } ] };\n' \
    > "$scope_dir/astro.config.mjs"
  if run_scan "$scope_dir/roadmap.md" "$scope_dir" "" "$scope_dir/astro.config.mjs" >/dev/null 2>&1; then
    echo "SELF-TEST OK: badge scope respected outside BADGE_DIRS."
  else
    echo "SELF-TEST FAILED: badge check fired outside BADGE_DIRS." >&2
    return 1
  fi

  # The parser's own failure mode: a config it cannot read must ERROR, not pass
  # silently. A zero-entry parse reading as "no violations" is how this whole
  # class of gate dies quietly when the config moves to autogenerate.
  local empty_dir="$tmp/bg-empty"
  mkdir -p "$empty_dir/getting-started"
  cp "$docs/overview/roadmap.md" "$empty_dir/"
  printf 'export default { sidebar: [ { label: "X", autogenerate: { directory: "x" } } ] };\n' \
    > "$empty_dir/astro.config.mjs"
  if run_scan "$empty_dir/roadmap.md" "$empty_dir" "" "$empty_dir/astro.config.mjs" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a sidebar with zero parsed entries was accepted." >&2
    return 1
  else
    echo "SELF-TEST OK: unparseable sidebar correctly errored."
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
  local baseline="${BASELINE_OVERRIDE:-$BASELINE_DEFAULT}"
  local sidebar="${SIDEBAR_OVERRIDE:-$SIDEBAR_DEFAULT}"
  if [ "${1:-}" = "--update-baseline" ]; then
    update_baseline "$docs_root" "$baseline"
    return $?
  fi
  run_scan "$roadmap" "$docs_root" "$baseline" "$sidebar"
}

main "$@"
