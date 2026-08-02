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
# Usage:  scripts/check-adr-status.sh
# Exit:   0 all cited ADRs decided · 1 at least one cited ADR still Proposed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

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
CITED="$(
  grep -rhoE 'ADR-[0-9]{4}' packages/*/src 2>/dev/null \
    --exclude-dir=content \
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
  printf '%s\n' "$ADR_STATUS_ALLOWLIST" | grep -qE "^[[:space:]]*$1([[:space:]]|\$)"
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
# ---------------------------------------------------------------------------
INDEX="packages/website/src/content/docs/architecture/decisions.md"
stats_violations=0

if [ -f "$INDEX" ]; then
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
    # $1 human label, $2 expected value, $3 grep -oE pattern capturing the claim
    local found
    found="$(grep -ohE "$3" "$INDEX" | head -1 | grep -oE '[0-9]+' | head -1)"
    if [ -n "$found" ] && [ "$found" != "$2" ]; then
      echo "check-adr-status: FAIL  ${INDEX} says ${1} is ${found}; the tree has ${2}"
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
violations=$((violations + stats_violations))

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
  exit 1
fi

exit 0
