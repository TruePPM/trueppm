#!/usr/bin/env bash
# Fail if a doc INSTRUCTS the reader to verify the Apache 2.0 boundary with the
# naive grep, which reports the invariant as broken on a clean tree (#2859).
#
# #2603 replaced `grep -r "trueppm_enterprise" packages/` with an import-syntax
# gate precisely because a string grep cannot distinguish prose from a dependency:
# the tree legitimately names the package in extension-point docstrings and ADR
# pointers, so that command returns 12 lines across 8 files on a clean 0.4 tree.
# What #2603 did not do was update the documents telling people to run it — so
# CONTRIBUTING.md, two agent skills, and two published website pages each handed
# a contributor a command that reports the project's sacred invariant as violated.
#
# Scope: surfaces where the command is an INSTRUCTION TO RUN.
#
#   CONTRIBUTING.md, .claude/skills/, docs/design/,
#   packages/website/src/content/docs/, packages/*/CLAUDE.md, CLAUDE.md
#
# docs/adr/ is deliberately EXEMPT. An ADR is a point-in-time decision record, and
# its "OSS or Enterprise: OSS (grep returns zero)" consequence lines are assertions
# about what was true when the decision was made, not instructions to a reader —
# the same carve-out the version-status gate gives ADRs. ~40 of them say this; the
# handful that are genuinely instructional were corrected by hand in #2859.
#
# A line that mentions the naive grep in order to say it is WRONG is allowed; that
# is the correction, not the defect.
#
# Exit codes:
#   0  no doc instructs the naive grep
#   1  at least one does
#   2  invocation error

set -euo pipefail

cd "${1:-.}" || { echo "ERROR: cannot cd to '${1:-.}'" >&2; exit 2; }

SEARCH_PATHS=(
  CONTRIBUTING.md
  CLAUDE.md
  .claude/skills
  docs/design
  packages/website/src/content/docs
)
# Per-package CLAUDE.md files, if any exist.
while IFS= read -r f; do SEARCH_PATHS+=("$f"); done < <(
  find packages -maxdepth 2 -name CLAUDE.md 2>/dev/null || true
)

PATTERN='grep -r "trueppm_enterprise" packages/'

# A mention that exists to correct the command is fine. Matched on the negation
# alone rather than "is not the check", because the corrective sentence often wraps
# and only "… is NOT the" lands on the line grep reports.
EXONERATING='is \*\*not\*\* the|is NOT the|previously named|would report|reports the invariant as broken'

hits=""
for path in "${SEARCH_PATHS[@]}"; do
  [ -e "$path" ] || continue
  found=$(grep -rn --fixed-strings "$PATTERN" "$path" 2>/dev/null || true)
  [ -n "$found" ] || continue
  found=$(echo "$found" | grep -vE "$EXONERATING" || true)
  [ -n "$found" ] && hits="${hits}${found}"$'\n'
done

hits=$(echo "$hits" | grep -v '^$' || true)

if [ -n "$hits" ]; then
  echo ""
  echo "STALE BOUNDARY COMMAND: these docs tell a reader to run the naive grep:"
  echo ""
  echo "$hits" | sed 's/^/  /'
  cat <<'MSG'

That command returns 12 lines on a clean tree — legitimate prose in extension-point
docstrings and ADR pointers — so it reports the Apache 2.0 boundary as violated when
it is intact. It was replaced by an import-syntax gate in #2603.

Use instead:

  make enterprise-boundary-check   # OK: no trueppm-enterprise imports in packages

(CI runs the same check as `boundary:imports`; it is also part of `make pre-push`.)

If you are deliberately quoting the old command in order to say it is wrong, phrase
it so this gate can tell — e.g. "a plain `grep …` is **not** the check".
MSG
  exit 1
fi

echo "OK: no doc instructs the stale boundary grep."
