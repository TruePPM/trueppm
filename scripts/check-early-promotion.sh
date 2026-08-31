#!/usr/bin/env bash
# scripts/check-early-promotion.sh — refuse a release cut that would strip
# "Ships in 0.X" / "Coming in 0.X" docs callouts for a version whose line has
# not yet reached the maturity that version promises (#2824).
#
# ── The failure this exists to stop ───────────────────────────────────────
#
# scripts/release.sh calls scripts/remove-ships-in-callouts.sh with the
# MAJOR.MINOR of the version being cut, and that script's ONLY safety gate is
# a refusal (exit 2) while "0.X" is absent from the roadmap's "## Shipped"
# heading. That promotion is a hand edit to
# packages/website/src/content/docs/overview/roadmap.md, and until #2824
# nothing anywhere stated WHEN it is correct to make it.
#
# So the whole safety net was one undocumented human judgment. Promote "0.4"
# to "## Shipped" in order to cut an alpha, and the very next release.sh run
# deletes every 0.4 callout in the docs tree — 131 blocks across 78 pages as
# measured on 2026-08-30 — announcing features that do not exist as available.
# scripts/check-version-status.sh then PASSES, because it polices the other
# direction (a stale banner on a shipped version). Nothing fails the pipeline.
# The deletion is silent, destructive, and lands in the release commit.
#
# The 0.1 / 0.2 / 0.3 precedent actively teaches the wrong habit: each of those
# tagged X.Y.0-alpha.1 when that version's feature set was complete, so
# promoting at the alpha tag was correct all three times.
#
# ── The rule this enforces ────────────────────────────────────────────────
#
#   0.X moves into the roadmap's "## Shipped" section when the release LINE
#   REACHES THE MATURITY THAT VERSION PROMISES — for 0.4, the first `beta`
#   tag. Alpha prereleases on the way to that milestone do NOT promote it.
#
# (Stated in CLAUDE.md "Version-status tense" and in the roadmap's "## Shipped"
# section header, so the promotion has one source of truth rather than three.)
#
# ── Why this blocks `alpha` specifically, not every prerelease ────────────
#
# The rule's own operative sentence names alphas: an alpha is by construction a
# step BEFORE the maturity milestone on any line that has a beta or rc rung.
#
# Blocking `beta`/`rc` as well was considered and REJECTED. 0.4's promised
# maturity IS beta — the roadmap's "How the 0.4 line is numbered" (#2823) says
# the line has no 0.4.0-alpha.N step at all and that the first tag on it IS the
# beta. So at a legitimate `v0.4.0-beta.1` cut the roadmap is correctly promoted
# AND the callouts are still present — that is precisely the state in which
# release.sh is SUPPOSED to remove them. A guard that fired there would demand
# the override flag on the one cut that matters most, and an operator who learns
# to pass --allow-early-promotion at every beta will pass it at the next alpha
# out of muscle memory. That trades a silent deletion for a rubber stamp, which
# is not an improvement. Gate the dangerous rung; leave the legitimate one alone.
#
# A version whose promised maturity genuinely IS alpha (the 0.1–0.3 shape) is
# still releasable: pass --allow-early-promotion / RELEASE_ALLOW_EARLY_PROMOTION=1
# and say so on the record, the same "state it in the diff" pattern this repo
# already uses for `--update-baseline` and `# safe-constraint:`.
#
# ── What it does NOT claim ────────────────────────────────────────────────
#
# This cannot tell a correct promotion from an incorrect one — it reads the
# roadmap, not intent, and the override is one flag. What it removes is the
# SILENCE. Before it, promoting early and cutting an alpha produced no signal
# anywhere in the pipeline; the first evidence was published docs advertising
# absent features.
#
# Usage:
#   scripts/check-early-promotion.sh <semver> [--roadmap PATH] [--docs-root PATH]
#   scripts/check-early-promotion.sh --self-test
#
# Exit codes:
#   0  ok — nothing to stop (not an alpha, or not promoted, or no callouts left)
#   1  invocation error (bad args, malformed version, roadmap missing)
#   2  BLOCKED — alpha cut against an already-promoted version with live callouts
#   3  self-test failure

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROADMAP_DEFAULT="packages/website/src/content/docs/overview/roadmap.md"
DOCS_ROOT_DEFAULT="packages/website/src/content/docs"

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/check-early-promotion.sh <semver> [--roadmap PATH] [--docs-root PATH]
  scripts/check-early-promotion.sh --self-test
USAGE
}

# ── Roadmap parsing ───────────────────────────────────────────────────────
# Mirrors scripts/check-version-status.sh and scripts/remove-ships-in-callouts.sh
# exactly: "### 0.X" headers under "## Shipped", read to the next "## " heading.
# Same source of truth, same parse, so the three cannot disagree about what is
# shipped. Only that heading and the "### 0.X" header format are load-bearing —
# the Underway/Planned sections may be restructured freely.
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

# ── Callout counting ──────────────────────────────────────────────────────
# Counts the callout OPENING lines that scripts/remove-ships-in-callouts.sh
# would actually delete, so the number this script reports is the number of
# blocks at risk — not a looser "mentions the version" count.
#
# KEEP THE PATTERN IN LOCKSTEP with OPEN_RE in remove-ships-in-callouts.sh. It
# is duplicated rather than shared because that script embeds it inside a
# heredoc'd python program with its own hard-coded roots, which this script's
# fixtures need to override. The self-test below exercises every phrasing form
# so a drift in either copy shows up as a failing case rather than a silent
# undercount.
#
# getting-started/try-it.md is excluded for the same reason the removal script
# never edits it (its flip to live prose is tracked by #1487 / #2271): its
# callouts survive every release, so counting them would make this guard report
# "callouts still exist" forever, including after a wholly correct removal.
count_callouts() {
  local version="$1" docs_root="$2"
  VERSION="$version" DOCS_ROOT="$docs_root" python3 - <<'PY'
import os
import re

version_re = re.escape(os.environ["VERSION"])
docs_root = os.environ["DOCS_ROOT"]

OPEN_RE = re.compile(
    r'^(?P<indent>[ \t]*):::(?:note|caution|tip|danger)'
    r'\[(?P<phrase>Ships in|Coming in) ' + version_re + r'(?!\d)[^\]]*\]\s*$'
)
TRY_IT_SUFFIX = os.path.join("getting-started", "try-it.md").replace("\\", "/")

total = 0
files = set()
for dirpath, _dirnames, filenames in os.walk(docs_root):
    for fn in sorted(filenames):
        if not (fn.endswith(".md") or fn.endswith(".mdx")):
            continue
        path = os.path.join(dirpath, fn)
        if path.replace("\\", "/").endswith(TRY_IT_SUFFIX):
            continue
        with open(path, encoding="utf-8") as fh:
            hits = sum(1 for line in fh.read().split("\n") if OPEN_RE.match(line))
        if hits:
            total += hits
            files.add(path)

print(f"{total} {len(files)}")
PY
}

# ── Guard ─────────────────────────────────────────────────────────────────
# check_promotion <semver> <roadmap> <docs_root> -> 0 ok / 2 blocked
check_promotion() {
  local new_version="${1#v}" roadmap="$2" docs_root="$3"

  local core="${new_version%%-*}"
  local pre=""
  [[ "$new_version" == *-* ]] && pre="${new_version#*-}"

  local major minor _patch
  IFS='.' read -r major minor _patch <<< "$core"
  local mm="${major}.${minor}"

  local stage=""
  [[ -n "$pre" ]] && stage="${pre%%.*}"

  # Only an alpha can be "early" — see the header. A beta/rc/stable cut against
  # a promoted roadmap is the intended, correct state.
  if [[ "$stage" != "alpha" ]]; then
    return 0
  fi

  if [ ! -f "$roadmap" ]; then
    echo "ERROR: roadmap source of truth not found at: $roadmap" >&2
    return 1
  fi

  # Not promoted: this is the CORRECT state for an alpha. release.sh's callout
  # removal will refuse (exit 2) and print its expected no-op line.
  if ! is_shipped "$mm" "$roadmap"; then
    return 0
  fi

  local counts total files
  counts="$(count_callouts "$mm" "$docs_root")"
  total="${counts%% *}"
  files="${counts##* }"

  # Promoted, but nothing left to strip — a re-cut after a legitimate removal.
  if [ "$total" -eq 0 ]; then
    return 0
  fi

  cat >&2 <<EOF

BLOCKED: cutting the ALPHA tag v${new_version} would strip ${total} docs callout(s)
across ${files} page(s) for version ${mm}.

  ${mm} is listed under '## Shipped' in
    ${roadmap}
  but the tag being cut is an ALPHA — a rung BELOW the maturity that version
  promises. Per CLAUDE.md "Version-status tense" and the roadmap's '## Shipped'
  section header:

    0.X moves into '## Shipped' when the release line reaches the maturity
    that version promises — for 0.4, the first 'beta' tag. Alpha prereleases
    on the way to that milestone do NOT promote it.

  Proceeding would run scripts/remove-ships-in-callouts.sh --apply and DELETE
  those ${total} callouts in the release commit, publishing ~unshipped features as
  available. scripts/check-version-status.sh would then pass — it polices the
  reverse direction — so nothing downstream would catch it.

What to do:
  • If ${mm} is NOT yet at its promised maturity (the usual case), demote it back
    under '## Underway' in the roadmap and re-run. The callout removal will then
    refuse harmlessly and print:
      Skipped callout removal — ${mm} is not yet in the roadmap's '## Shipped' section
  • If ${mm}'s promised maturity genuinely IS alpha (the 0.1-0.3 shape) and this
    promotion is deliberate, re-run with --allow-early-promotion (or
    RELEASE_ALLOW_EARLY_PROMOTION=1) to proceed and say so on the record.

EOF
  return 2
}

# ── Self-test ─────────────────────────────────────────────────────────────
self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time.
  trap "rm -rf '$tmp'" EXIT
  local failures=0

  local shipped="$tmp/roadmap-shipped.md"
  cat >"$shipped" <<'MD'
## Shipped

### 0.3 — hybrid delivery

### 0.4 — the self-hosting PM's beta

## Underway

### 0.5 — plan & people
MD

  local underway="$tmp/roadmap-underway.md"
  cat >"$underway" <<'MD'
## Shipped

### 0.3 — hybrid delivery

## Underway

### 0.4 — the self-hosting PM's beta
MD

  # Docs fixture carrying one of every removable phrasing form, plus decoys
  # that must NOT be counted.
  local docs="$tmp/docs"
  mkdir -p "$docs/features" "$docs/getting-started"
  cat >"$docs/features/a.md" <<'MD'
:::note[Ships in 0.4]
Not available yet.
:::

:::caution[Coming in 0.4 — the writable page]
Nor this.
:::
MD
  cat >"$docs/features/b.md" <<'MD'
:::tip[Ships in 0.4 (beta)]
A trailing qualifier is allowed.
:::

:::note[Ships in 0.5]
Different version — must not count.
:::

:::note[Ships in 0.40]
Digit-boundary decoy — must not count.
:::

Inline prose "Coming in 0.4" is not a fenced opening line — must not count.
MD
  # Never removable, so never counted (#1487 / #2271).
  cat >"$docs/getting-started/try-it.md" <<'MD'
:::note[Ships in 0.4]
try-it is excluded.
:::
MD

  local empty_docs="$tmp/docs-empty"
  mkdir -p "$empty_docs"
  printf 'Nothing here.\n' > "$empty_docs/x.md"

  expect_count() {
    local label="$1" want="$2" got
    got="$(count_callouts "0.4" "$docs" | awk '{print $1}')"
    if [ "$got" = "$want" ]; then
      echo "SELF-TEST OK: $label (counted $got)."
    else
      echo "SELF-TEST FAILED: $label — expected $want, got $got." >&2
      failures=$((failures + 1))
    fi
  }
  expect_count "counts only removable 0.4 callout openings, excluding try-it.md" 3

  # case NAME VERSION ROADMAP DOCS EXPECTED_EXIT
  case_check() {
    local label="$1" version="$2" roadmap="$3" docs_dir="$4" want="$5"
    local got=0
    check_promotion "$version" "$roadmap" "$docs_dir" >/dev/null 2>&1 || got=$?
    if [ "$got" = "$want" ]; then
      echo "SELF-TEST OK: $label (exit $got)."
    else
      echo "SELF-TEST FAILED: $label — expected exit $want, got $got." >&2
      failures=$((failures + 1))
    fi
  }

  # THE BAD COMBINATION — the whole reason this script exists.
  case_check "BLOCKS alpha + promoted + live callouts" \
    "0.4.0-alpha.1" "$shipped" "$docs" 2

  # Legitimate cases — each must NOT fire.
  case_check "allows alpha when 0.4 is still under Underway" \
    "0.4.0-alpha.1" "$underway" "$docs" 0
  case_check "allows the first beta against a promoted roadmap" \
    "0.4.0-beta.1" "$shipped" "$docs" 0
  case_check "allows a later beta against a promoted roadmap" \
    "0.4.0-beta.2" "$shipped" "$docs" 0
  case_check "allows an rc against a promoted roadmap" \
    "0.4.0-rc.1" "$shipped" "$docs" 0
  case_check "allows a stable tag against a promoted roadmap" \
    "0.4.0" "$shipped" "$docs" 0
  case_check "allows alpha when promoted but no callouts remain" \
    "0.4.0-alpha.1" "$shipped" "$empty_docs" 0
  case_check "allows an alpha on a DIFFERENT, unpromoted line" \
    "0.5.0-alpha.1" "$shipped" "$docs" 0
  case_check "leading 'v' on the tag is tolerated" \
    "v0.4.0-alpha.1" "$shipped" "$docs" 2

  return $failures
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    if self_test; then
      echo ""
      echo "SELF-TEST: all checks passed."
      return 0
    fi
    echo ""
    echo "SELF-TEST: one or more checks FAILED (see above)." >&2
    return 3
  fi

  if [ $# -eq 0 ]; then
    usage
    return 1
  fi

  local version="$1"
  shift || true
  local roadmap="" docs_root=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --roadmap)
        [ $# -ge 2 ] || { echo "error: --roadmap needs a path" >&2; return 1; }
        roadmap="$2"; shift 2 ;;
      --docs-root)
        [ $# -ge 2 ] || { echo "error: --docs-root needs a path" >&2; return 1; }
        docs_root="$2"; shift 2 ;;
      *)
        echo "error: unrecognized argument '$1'" >&2
        usage
        return 1 ;;
    esac
  done

  if ! [[ "${version#v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+\.[0-9]+)?$ ]]; then
    echo "error: '$version' is not a valid semver (expected x.y.z or x.y.z-alpha|beta|rc.N)" >&2
    usage
    return 1
  fi

  cd "$REPO_ROOT"
  check_promotion "$version" "${roadmap:-$ROADMAP_DEFAULT}" "${docs_root:-$DOCS_ROOT_DEFAULT}"
}

main "$@"
