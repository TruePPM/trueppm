#!/usr/bin/env bash
# scripts/check-adr-status.sh — an ADR cited by shipped code must not say "Proposed".
#
# Why this exists (#2685): nothing validated ADR status against the tree. #2539 was a
# one-off manual sweep in July 2026; within a month twelve ADRs had drifted back to
# `Proposed` while their decisions were fully implemented and cited by name in the
# source. The ADR corpus is the project's own record of what shipped — if it says
# `Proposed` for shipped work, it misrepresents the release.
#
# The rule is deliberately crude, because a crude rule that runs every pipeline beats a
# careful audit that runs twice a year:
#
#   if a comment or docstring under packages/*/src names ADR-NNNN,
#   then docs/adr/NNNN-*.md must not have Status `Proposed`.
#
# Citing an ADR from shipped source is the author asserting "this decision is in effect
# here". That is incompatible with `Proposed`, which means "not decided yet".
#
# Escape hatch: an ADR that is genuinely still proposed but must be named in source
# (an extension-point stub, a forward reference) can be listed in ADR_STATUS_ALLOWLIST
# below, with a reason. Prefer flipping the status — the allowlist is for the rare case
# where the citation is genuinely forward-looking.
#
# Usage:  scripts/check-adr-status.sh [ROOT]
#         scripts/check-adr-status.sh --self-test
#
#   ROOT        directory to scan, defaulting to the repository root. Everything
#               below is relative to it: docs/adr, packages/*/src, and the
#               published index at packages/website/src/content/docs/architecture/
#               decisions.md. The only caller that passes it is --self-test, which
#               runs THIS script against fixture trees so there is no second copy
#               of the detection rules to drift out of sync with the gate (#3195).
#   --self-test assert the gate can still fail: fixture trees carrying a planted
#               violation must be rejected, and clean ones accepted. Runs first in
#               the same CI job as the real scan, because a gate's failure mode is
#               a green pipeline — "it passed" is not evidence that it can fail.
#
# Exit:   0 all cited ADRs decided · 1 at least one cited ADR still Proposed
#         (or an index statistic that is stale, missing, or whose page was deleted)
#         · 2 invocation error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Sourced before the `cd` below, and resolved from BASH_SOURCE rather than $0:
# once the scan root is injectable, the cwd at this point is not the repo root.
# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/git-ignored.sh"

if [ "${1:-}" = "--self-test" ]; then
  # Detection proof (#3195). This gate was opted out of ci:gate-selftest-parity as
  # PENDING: its detection had been verified once, by hand, and nothing repeated it.
  # #3172 is what that costs — boundary:imports passed a real Apache-2.0 violation
  # for its entire life, on green pipelines, because the CI image's grep rejected an
  # option and the empty result read as "no violations". This gate greps with the
  # same option family (`-I`, `--exclude-dir`) and its status parser has four header
  # shapes to keep straight, so both are asserted here rather than assumed.
  #
  # Every case runs the REAL script against a fixture root. Both directions are
  # asserted: a self-test that only checks the happy path proves nothing.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0

  st_probe() { # <name> <expect-pass|expect-fail> <root>
    if bash "$0" "$3" >/dev/null 2>&1; then
      if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
      else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi
    else
      if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
      else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi
    fi
  }

  st_src() { # <root> <adr-number…> — shipped source citing each ADR by name
    mkdir -p "$1/packages/api/src"
    local root="$1"; shift
    : > "$root/packages/api/src/thing.py"
    for n in "$@"; do
      printf '# Implements the decision recorded in ADR-%s.\n' "$n" \
        >> "$root/packages/api/src/thing.py"
    done
    printf 'def f():\n    return 1\n' >> "$root/packages/api/src/thing.py"
  }

  st_adr() { # <root> <adr-number> <status-header-block>
    mkdir -p "$1/docs/adr"
    printf '# ADR-%s — self-test probe\n\n%s\n\n## Context\nfixture\n' "$2" "$3" \
      > "$1/docs/adr/$2-probe.md"
  }

  st_index() { # <root> <index-body>
    mkdir -p "$1/packages/website/src/content/docs/architecture"
    printf '%s\n' "$2" \
      > "$1/packages/website/src/content/docs/architecture/decisions.md"
  }

  st_ok_index() { # <root> <count> <lo> <hi> <unused> <gaps>
    # An index stating all four statistics correctly for the fixture's own tree.
    # Every fixture needs one now that a missing index fails rather than skips
    # Part 2 (#3379) — without it the Part 1 fixtures would fail for a Part 2
    # reason, which is exactly the kind of cross-talk that makes a self-test lie.
    st_index "$1" "The corpus holds $2 numbered ADRs spanning $3-$4; $5 numbers are unused across $6 gap ranges."
  }

  # --- Part 1: an ADR cited from shipped source must not say "Proposed". -----
  d="$st_tmp/accepted"; st_src "$d" 9998
  st_adr "$d" 9998 '## Status
Accepted — status corrected 2026-01-01 after ADR audit (#9998, verified: shipped).'
  st_ok_index "$d" 1 9998 9998 0 0
  st_probe "citation of an Accepted ADR" expect-pass "$d"

  # All FOUR header shapes the corpus uses must be parsed. An unparseable header
  # degrades to a WARN, so a parser that stops recognizing one of these is a
  # silent hole in the gate rather than a visible failure.
  d="$st_tmp/proposed-block"; st_src "$d" 9999
  st_adr "$d" 9999 '## Status
Proposed'
  st_ok_index "$d" 1 9999 9999 0 0
  st_probe "Proposed ADR cited from source — '## Status' block header" expect-fail "$d"

  d="$st_tmp/proposed-inline"; st_src "$d" 9999
  st_adr "$d" 9999 '## Status: Proposed'
  st_ok_index "$d" 1 9999 9999 0 0
  st_probe "Proposed ADR cited from source — '## Status:' inline header" expect-fail "$d"

  d="$st_tmp/proposed-bullet"; st_src "$d" 9999
  st_adr "$d" 9999 '- **Status:** Proposed'
  st_ok_index "$d" 1 9999 9999 0 0
  st_probe "Proposed ADR cited from source — bullet front-matter header" expect-fail "$d"

  d="$st_tmp/proposed-bold"; st_src "$d" 9999
  st_adr "$d" 9999 '**Status:** Proposed'
  st_ok_index "$d" 1 9999 9999 0 0
  st_probe "Proposed ADR cited from source — bold inline header" expect-fail "$d"

  # The documented non-failure: a citation pointing at no ADR is a broken
  # reference, a different defect from status drift, and is WARNed not failed.
  # Asserting it keeps a future "tighten the gate" from changing the contract by
  # accident rather than on purpose.
  # ADR-0001 exists only so the corpus is non-empty; the cited number (9999) is
  # still the one with no file, which is what this case is about.
  d="$st_tmp/unresolved"; st_src "$d" 9999
  st_adr "$d" 0001 '## Status
Accepted'
  st_ok_index "$d" 1 0001 0001 0 0
  st_probe "ADR-9999 cited with no ADR file (unresolved reference, WARN only)" expect-pass "$d"

  # The escape hatch has to hold too, or the gate becomes noisy enough to get
  # disabled — which is how the protection is really lost.
  d="$st_tmp/allowlisted"; st_src "$d" 0096
  st_adr "$d" 0096 '## Status
Proposed'
  st_ok_index "$d" 1 0096 0096 0 0
  st_probe "Proposed ADR cited but present in ADR_STATUS_ALLOWLIST (0096)" expect-pass "$d"

  # --- Part 2: the published index must not misstate the corpus statistics. --
  # Two ADRs (0001, 0003) spanning 0001-0003 → 1 unused number in 1 gap range.
  st_stats_tree() { # <root>
    st_src "$1" 0001
    st_adr "$1" 0001 '## Status
Accepted'
    st_adr "$1" 0003 '## Status
Accepted'
  }

  d="$st_tmp/stats-ok"; st_stats_tree "$d"
  st_index "$d" 'The corpus holds 2 numbered ADRs spanning 0001-0003; 1 numbers are unused across 1 gap ranges.'
  st_probe "index statistics matching the tree" expect-pass "$d"

  d="$st_tmp/stats-stale"; st_stats_tree "$d"
  st_index "$d" 'The corpus holds 301 numbered ADRs spanning 0001-0003; 1 numbers are unused across 1 gap ranges.'
  st_probe "index quoting a stale ADR count" expect-fail "$d"

  # One "the sentence is gone" fixture per statistic. Until #3379 only the span
  # had one, and only the span failed closed: the other three compared the index
  # against the tree *only when a number was found*, so rewording the sentence out
  # of existence was the one edit Part 2 could not see. Each of these four must
  # stay expect-fail — a statistic that can be deleted is a statistic that is not
  # checked.
  d="$st_tmp/stats-nocount"; st_stats_tree "$d"
  st_index "$d" 'The corpus holds a couple of ADRs spanning 0001-0003; 1 numbers are unused across 1 gap ranges.'
  st_probe "index that never states the ADR count" expect-fail "$d"

  d="$st_tmp/stats-nounused"; st_stats_tree "$d"
  st_index "$d" 'The corpus holds 2 numbered ADRs spanning 0001-0003, with 1 gap ranges.'
  st_probe "index that never states the unused-number count" expect-fail "$d"

  d="$st_tmp/stats-nogaps"; st_stats_tree "$d"
  st_index "$d" 'The corpus holds 2 numbered ADRs spanning 0001-0003; 1 numbers are unused.'
  st_probe "index that never states the gap-range count" expect-fail "$d"

  d="$st_tmp/stats-nospan"; st_stats_tree "$d"
  st_index "$d" 'The corpus holds 2 numbered ADRs; 1 numbers are unused across 1 gap ranges.'
  st_probe "index that never states the current ADR span" expect-fail "$d"

  # Deleting the page entirely was the strongest form of the same drift and the
  # only form that exited 0, because Part 2 was wrapped in `[ -f "$INDEX" ]`.
  d="$st_tmp/stats-noindex"; st_stats_tree "$d"
  st_probe "published index deleted altogether" expect-fail "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-$REPO_ROOT}"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: '$ROOT' is not a directory. Run from the repository root." >&2
  exit 2
fi

cd "$ROOT"

ADR_DIR="docs/adr"

# ADRs that may be cited from source while still `Proposed`. One "NNNN reason" per line.
#
# These are the gate's known false-positive shape: an ADR that is *partially* implemented,
# or merely named for naming-consistency, while its headline decision is genuinely still
# proposed. Both entries below were checked by reading the ADR's Decision section against
# the tree — not inferred from the citation. Keep this list short; prefer flipping the
# status. Re-check an entry whenever its ADR's milestone lands.
ADR_STATUS_ALLOWLIST="
0096 only Part 1 (the history diff, apps/projects/views.py) shipped; the unified activity timeline that names the ADR is still future — the citing comment says so
0099 the Release model is 0.7 work and does not exist; the single citation is a note that Task.type matches ADR-0099's committed field shape
"

# ---------------------------------------------------------------------------
# Collect ADR numbers cited from source.
# ---------------------------------------------------------------------------
# Only shipped source. Two exclusions, both deliberate:
#
#   docs/                       — ADRs cross-reference each other constantly, and a
#                                 Proposed ADR citing another Proposed ADR is normal.
#   packages/website/src/content — the documentation site. `known-issues.md` naming the
#                                 ADR that will fix an issue, and `decisions.md` indexing
#                                 the whole corpus, are legitimately forward-looking.
#                                 Including it flagged ADR-0125 and ADR-0711 as drift
#                                 when both are correctly Proposed.
#
# Newline-delimited rather than a bash array: macOS ships bash 3.2, which has no
# `mapfile`, and this script has to run identically on a developer laptop and in CI.
# -l + -I, not -ho: without -I, grep emits "Binary file <path> matches" for the
# gitignored __pycache__/*.pyc under packages/*/src, and the unquoted
# `for num in $CITED` below word-splits that sentence into four bogus ADR ids.
# That is why this reported 2489 cited / 2176 unresolved locally against CI's
# 313 / 0 — 544 binary notices, ~2170 fake references, and any genuinely broken
# reference invisible among them (#3178). Listing files first also gives
# drop_ignored_lines a path to judge, which -ho does not.
# (lib/git-ignored.sh is sourced at the top of this script, before the `cd`.)

CITED="$(
  grep -rlIE 'ADR-[0-9]{4}' packages/*/src 2>/dev/null \
    --exclude-dir=content \
    | drop_ignored_lines \
    | while IFS= read -r adr_file; do
        [ -n "$adr_file" ] && grep -hoE 'ADR-[0-9]{4}' "$adr_file"
      done \
    | sed 's/^ADR-//' \
    | sort -u
)"

if [ -z "$CITED" ]; then
  echo "check-adr-status: no ADR references found under packages/*/src — nothing to check."
  exit 0
fi

# ---------------------------------------------------------------------------
# Read an ADR's status. FOUR header shapes are in use across the 312-ADR corpus, and
# all four must parse — an unparseable header is a silent hole in the gate, not a
# harmless warning. All four were found in the tree; do not drop one as hypothetical:
#
#   "## Status\nAccepted ..."          block form, the most common
#   "## Status: Accepted ..."          inline heading form
#   "- **Status:** Accepted"           front-matter bullet list (ADR-0620, 0624, 0634…)
#   "**Status:** Accepted ..."         bold inline (ADR-0191)
# ---------------------------------------------------------------------------
adr_status() {
  local file="$1" value

  # "## Status: <value>"
  value="$(sed -n 's/^## Status:[[:space:]]*//p' "$file" | head -1)"
  [ -n "$value" ] && { printf '%s' "$value"; return; }

  # "- **Status:** <value>"  /  "**Status:** <value>"  (optional leading bullet)
  value="$(sed -n 's/^[[:space:]]*[-*][[:space:]]*\*\*Status:\*\*[[:space:]]*//p;s/^\*\*Status:\*\*[[:space:]]*//p' "$file" | head -1)"
  [ -n "$value" ] && { printf '%s' "$value"; return; }

  # Block form: first non-blank line after a bare "## Status"
  awk '/^## Status[[:space:]]*$/ {found=1; next}
       found && NF {print; exit}' "$file"
}

is_allowlisted() {
  local adr="$1"
  printf '%s\n' "$ADR_STATUS_ALLOWLIST" | grep -qE "^[[:space:]]*$adr([[:space:]]|\$)"
}

violations=0
missing=0
cited_count=0

for num in $CITED; do
  cited_count=$((cited_count + 1))
  # shellcheck disable=SC2086,SC2012  # deliberate glob; ADR filenames are ASCII by convention
  file="$(ls ${ADR_DIR}/${num}-*.md 2>/dev/null | head -1 || true)"

  if [ -z "$file" ]; then
    # A citation pointing at no ADR is a broken reference, but it is a different defect
    # from status drift and often a typo in a comment. Report it, don't fail on it.
    echo "check-adr-status: WARN  ADR-${num} is cited in source but ${ADR_DIR}/${num}-*.md does not exist"
    missing=$((missing + 1))
    continue
  fi

  status="$(adr_status "$file")"

  if [ -z "$status" ]; then
    echo "check-adr-status: WARN  ADR-${num} has no parseable '## Status' section (${file})"
    missing=$((missing + 1))
    continue
  fi

  case "$status" in
    Proposed*)
      if is_allowlisted "$num"; then
        continue
      fi
      echo "check-adr-status: FAIL  ADR-${num} is cited by shipped source but Status is '${status}'"
      echo "                        ${file}"
      echo "                        cited in: $(grep -rl "ADR-${num}" packages/*/src 2>/dev/null | head -3 | tr '\n' ' ')"
      violations=$((violations + 1))
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Part 2 — the published ADR index must not misstate the size of the corpus.
#
# decisions.md quoted "301 numbered ADRs (spanning 0001-0689) … 388 numbers unused
# across 64 gap ranges" while the tree held 314 spanning 0001-0766 with 452 unused
# across 74 ranges. Those four figures are the kind that are written once and never
# revisited, so they are checked rather than regenerated (#2685).
#
# All four fail closed on *absence* as well as on drift (#3379). The earlier form
# compared only when a number was found and skipped the whole part when the page was
# missing, so the two edits that remove a statistic outright — rewording the sentence,
# and deleting decisions.md — were the two this part could not see. An absent figure is
# not "nothing to check": it is the published description of the corpus going away.
# ---------------------------------------------------------------------------
INDEX="packages/website/src/content/docs/architecture/decisions.md"
stats_violations=0

if [ ! -f "$INDEX" ]; then
  echo "check-adr-status: FAIL  ${INDEX} does not exist; the published ADR index is the"
  echo "                        only place the corpus statistics are stated, and this part"
  echo "                        of the gate has nothing left to check."
  stats_violations=$((stats_violations + 1))
else
  stats="$(python3 - "$ADR_DIR" <<'PY'
import glob, re, sys
adr_dir = sys.argv[1]
nums = sorted({int(re.match(r"(\d{4})-", f.split("/")[-1]).group(1))
               for f in glob.glob(f"{adr_dir}/[0-9][0-9][0-9][0-9]-*.md")})
lo, hi = nums[0], nums[-1]
present = set(nums)
gaps, start = 0, None
for n in range(lo, hi + 1):
    if n not in present:
        start = n if start is None else start
    elif start is not None:
        gaps += 1
        start = None
if start is not None:
    gaps += 1
print(len(nums), f"{lo:04d}", f"{hi:04d}", sum(1 for n in range(lo, hi + 1) if n not in present), gaps)
PY
)"
  # shellcheck disable=SC2086  # intentional word-split: $stats is five space-separated ints
  set -- $stats
  a_count="$1"; a_lo="$2"; a_hi="$3"; a_unused="$4"; a_gaps="$5"

  check_stat() {
    local label="$1" expected="$2" pattern="$3"
    local found
    # `|| true` is load-bearing twice over: grep exits 1 when the sentence is gone,
    # and `| head -1` can SIGPIPE the producer to 141 — either one would abort the
    # script under `set -euo pipefail` before the branch below could report anything.
    # That is what the old form actually did: a deleted statistic exited 1 with no
    # message at all, skipping the span check and the summary line (#3379).
    found="$(grep -ohE "$pattern" "$INDEX" | grep -oE '[0-9]+' | head -1 || true)"
    if [ -z "$found" ]; then
      echo "check-adr-status: FAIL  ${INDEX} no longer states ${label}; the tree has ${expected}"
      stats_violations=$((stats_violations + 1))
    elif [ "$found" != "$expected" ]; then
      echo "check-adr-status: FAIL  ${INDEX} says ${label} is ${found}; the tree has ${expected}"
      stats_violations=$((stats_violations + 1))
    fi
  }

  check_stat "the ADR count"   "$a_count"  '[0-9]+ numbered ADRs'
  check_stat "the unused count" "$a_unused" '[0-9]+ numbers are unused'
  check_stat "the gap-range count" "$a_gaps" '[0-9]+ gap ranges'

  if ! grep -q "${a_lo}–${a_hi}\|${a_lo}-${a_hi}" "$INDEX"; then
    echo "check-adr-status: FAIL  ${INDEX} does not state the current ADR span ${a_lo}–${a_hi}"
    stats_violations=$((stats_violations + 1))
  fi
fi

echo
echo "check-adr-status: ${cited_count} ADRs cited from packages/*/src; ${violations} still marked Proposed; ${missing} unresolved reference(s); ${stats_violations} stale index statistic(s)."

# Print only the remedy for the part that actually failed. Now that a missing statistic
# is reachable rather than an abort, a stats-only failure used to be answered with
# advice about ADR Status headers, which sends the reader to the wrong file.
if [ "$violations" -gt 0 ]; then
  cat <<'EOF'

An ADR cited from shipped source must not say "Proposed" — citing it is the author
asserting the decision is in effect. Fix by flipping the ADR's Status to Accepted with
a dated correction, matching the convention established by the #2539 audit:

    ## Status
    Accepted — status corrected YYYY-MM-DD after ADR audit (#NNNN, verified: <evidence>).

If the citation really is forward-looking, add the ADR to ADR_STATUS_ALLOWLIST in this
script with a reason.
EOF
fi

if [ "$stats_violations" -gt 0 ]; then
  cat <<'EOF'

The published ADR index must state four figures about the corpus and keep them true:
the ADR count, the span, the unused-number count, and the gap-range count. Update the
sentences in packages/website/src/content/docs/architecture/decisions.md to the numbers
this run reported. Deleting a sentence — or the page — is not a fix: an absent figure
fails here for the same reason a wrong one does.
EOF
fi

if [ "$((violations + stats_violations))" -gt 0 ]; then
  exit 1
fi

exit 0
