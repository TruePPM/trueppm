#!/usr/bin/env bash
# scripts/tests/assemble-changelog.test.sh
#
# Unit test for scripts/assemble-changelog.sh — the release-tooling step that
# folds changelog.d/ fragments into the [Unreleased] section before a tag is
# cut. Release tooling has no other harness, and a break here aborts the whole
# release mid-bump (#1383), so guard it directly.
#
# The script under test derives its own REPO_ROOT and operates on CHANGELOG.md /
# changelog.d/ relative to it, so each case stages a throwaway "repo root" in a
# temp dir, drops a copy of the real script into it, and runs that.
#
# Run: bash scripts/tests/assemble-changelog.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/assemble-changelog.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $1"
    fail=$((fail + 1))
  fi
}
has() { grep -qF "$1" "$2"; }      # literal substring present
hasnt() { ! grep -qF "$1" "$2"; }  # literal substring absent

# stage_sandbox <dir> — a self-contained repo root with the script under test.
stage_sandbox() {
  local d="$1"
  mkdir -p "$d/scripts" "$d/changelog.d"
  cp "$SCRIPT" "$d/scripts/assemble-changelog.sh"
}

write_changelog() {
  # The prior release section is intentionally heading-free (prose only) so the
  # ### category assertions below see ONLY the freshly assembled block, not a
  # category that happens to also live in an older release.
  cat > "$1" <<'EOF'
# Changelog

## [Unreleased]

**Summary prose that must stay above the generated category lists.**

## [0.1.0] - 2026-05-15

- Initial release.
EOF
}

# --- Case 1: one fragment of each type assembles in order ------------------
echo "Case 1: populated assembly"
D1="$TMP/case1"
stage_sandbox "$D1"
write_changelog "$D1/CHANGELOG.md"
printf -- '- An added thing (#10).\n'    > "$D1/changelog.d/10.added.md"
printf -- '- A changed thing (#20).\n'   > "$D1/changelog.d/20.changed.md"
printf -- '- A fixed thing (#30).\n'     > "$D1/changelog.d/30.fixed.md"
printf -- '- A security thing (#40).\n'  > "$D1/changelog.d/40.security.md"
# README.md must never be consumed.
printf 'not a fragment\n' > "$D1/changelog.d/README.md"
( cd "$D1" && bash scripts/assemble-changelog.sh >/dev/null )
CL1="$D1/CHANGELOG.md"

check "Added heading present"               "$(has '### Added' "$CL1"; echo $?)"
check "Changed heading present"             "$(has '### Changed' "$CL1"; echo $?)"
check "Fixed heading present"               "$(has '### Fixed' "$CL1"; echo $?)"
check "Security heading present"            "$(has '### Security' "$CL1"; echo $?)"
check "added content carried"               "$(has 'An added thing (#10).' "$CL1"; echo $?)"
check "security content carried"            "$(has 'A security thing (#40).' "$CL1"; echo $?)"
check "summary prose preserved"             "$(has 'Summary prose that must stay above' "$CL1"; echo $?)"
check "prior release section untouched"     "$(has '## [0.1.0] - 2026-05-15' "$CL1"; echo $?)"
check "added fragment consumed"             "$([[ ! -f "$D1/changelog.d/10.added.md" ]]; echo $?)"
check "security fragment consumed"          "$([[ ! -f "$D1/changelog.d/40.security.md" ]]; echo $?)"
check "README.md NOT consumed"              "$([[ -f "$D1/changelog.d/README.md" ]]; echo $?)"

# Keep a Changelog order: Added < Changed < Fixed < Security, and all of them
# sit between [Unreleased] and the next dated release heading.
order_ok="$(awk '
  /^### Added/{a=NR} /^### Changed/{c=NR} /^### Fixed/{f=NR} /^### Security/{s=NR}
  /^## \[0.1.0\]/{rel=NR}
  END { print (a<c && c<f && f<s && s<rel) ? 0 : 1 }
' "$CL1")"
check "categories ordered Added<Changed<Fixed<Security, above release" "$order_ok"

# Summary prose stays above the first generated category.
prose_above="$(awk '
  /Summary prose that must stay above/{p=NR} /^### Added/{a=NR}
  END { print (p>0 && a>0 && p<a) ? 0 : 1 }
' "$CL1")"
check "summary prose ordered above ### Added" "$prose_above"

# --- Case 2: only some types present -> only those headings emitted ---------
echo "Case 2: partial types"
D2="$TMP/case2"
stage_sandbox "$D2"
write_changelog "$D2/CHANGELOG.md"
printf -- '- Just a fix (#99).\n' > "$D2/changelog.d/99.fixed.md"
( cd "$D2" && bash scripts/assemble-changelog.sh >/dev/null )
CL2="$D2/CHANGELOG.md"
check "Fixed heading present for partial set"  "$(has '### Fixed' "$CL2"; echo $?)"
check "no spurious Added heading"              "$(hasnt '### Added' "$CL2"; echo $?)"
check "no spurious Security heading"           "$(hasnt '### Security' "$CL2"; echo $?)"

# --- Case 3: empty changelog.d is a no-op success --------------------------
echo "Case 3: no fragments"
D3="$TMP/case3"
stage_sandbox "$D3"
write_changelog "$D3/CHANGELOG.md"
before="$(cat "$D3/CHANGELOG.md")"
( cd "$D3" && bash scripts/assemble-changelog.sh >/dev/null )
after="$(cat "$D3/CHANGELOG.md")"
[[ "$before" == "$after" ]] && r=0 || r=1
check "empty changelog.d leaves CHANGELOG unchanged" "$r"

# --- Case 4: portability guard — no bash 4+ constructs ---------------------
# CI runs on bash 5, so a functional test cannot catch a bash-3.2 regression
# (associative arrays / ${var^}). Assert their absence statically instead, so
# the macOS-release-machine contract holds under any interpreter (#1383). Strip
# comment lines first so the doc comment naming the forbidden constructs doesn't
# trip the guard against itself.
echo "Case 4: bash 3.2 portability guard"
CODE="$(grep -vE '^[[:space:]]*#' "$SCRIPT")"
if printf '%s\n' "$CODE" | grep -qF 'declare -A'; then r=1; else r=0; fi
check "no associative-array declare -A" "$r"
if printf '%s\n' "$CODE" | grep -qE '\$\{[A-Za-z_][A-Za-z0-9_]*\^'; then
  echo "  found \${var^} construct in code"; r=1
else
  r=0
fi
check "no \${var^} case-conversion expansion" "$r"

echo ""
echo "assemble-changelog: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
