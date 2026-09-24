#!/usr/bin/env bash
# scripts/tests/release-summary.test.sh
#
# Guards the release summary that opens every dated CHANGELOG section and that
# release:create publishes on the GitLab Release page (#4041).
#
# Every rotation leaves "_Nothing yet._" under a fresh [Unreleased]. Read as the
# default summary, that placeholder is non-empty, so `release.sh --yes` cut the
# release with it and a TTY run offered it as the Enter-to-accept default.
#   1. behaviorally — scripts/release-default-summary.py drops the placeholder,
#      keeps real prose, and stops at the first ### category;
#   2. structurally — release.sh resolves the summary before it bumps any
#      manifest, so a missing summary aborts on a clean tree.
#
# Run: bash scripts/tests/release-summary.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/release-default-summary.py"
RELEASE_SH="$REPO_ROOT/scripts/release.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

summary_of() { python3 "$HELPER" "$1"; }

# --- Case 1: an untouched [Unreleased] yields NO default summary -------------
echo "Case 1: the placeholder alone is not a summary"
cat >"$TMP/c1.md" <<'EOF'
# Changelog

## [Unreleased]

_Nothing yet._

### Fixed

- Something. (#1)

## [0.1.0] — 2026-01-01

Old summary.
EOF
out="$(summary_of "$TMP/c1.md")"
if [[ -z "$out" ]]; then r=0; else r=1; fi
check "placeholder + assembled categories → empty summary (got: '$out')" "$r"

# --- Case 2: real prose is kept, placeholder dropped, stops at ### ----------
echo "Case 2: real prose survives, placeholder is dropped"
cat >"$TMP/c2.md" <<'EOF'
## [Unreleased]

_Nothing yet._

TruePPM 0.2.0 — supersedes 0.1.0.

Second paragraph.

### Added

- Not part of the summary.
EOF
out="$(summary_of "$TMP/c2.md")"
expected="$(printf 'TruePPM 0.2.0 — supersedes 0.1.0.\n\nSecond paragraph.')"
if [[ "$out" == "$expected" ]]; then r=0; else r=1; fi
check "prose kept verbatim without the placeholder (got: '$out')" "$r"

# --- Case 3: prose with no placeholder is unchanged -------------------------
echo "Case 3: prose without a placeholder is unchanged"
cat >"$TMP/c3.md" <<'EOF'
## [Unreleased]

Only prose.
## [0.1.0] — 2026-01-01
EOF
out="$(summary_of "$TMP/c3.md")"
if [[ "$out" == "Only prose." ]]; then r=0; else r=1; fi
check "stops at the next ## [ section (got: '$out')" "$r"

# --- Case 4: structural — summary resolved before the first manifest bump ---
echo "Case 4: release.sh resolves the summary before modifying anything"
summary_line="$(grep -n -m1 'scripts/release-default-summary.py' "$RELEASE_SH" | cut -d: -f1)"
guard_line="$(grep -n -m1 'No release summary' "$RELEASE_SH" | cut -d: -f1)"
bump_line="$(grep -n -m1 '^bump_manifest ' "$RELEASE_SH" | cut -d: -f1)"
assemble_line="$(grep -n -m1 '^bash scripts/assemble-changelog.sh' "$RELEASE_SH" | cut -d: -f1)"
if [[ -n "$summary_line" && -n "$guard_line" && -n "$bump_line" && -n "$assemble_line" ]]; then r=0; else r=1; fi
check "release.sh calls the helper, has the guard, bumps, and assembles" "$r"
if [[ "${guard_line:-0}" -lt "${bump_line:-0}" && "${guard_line:-0}" -lt "${assemble_line:-0}" ]]; then r=0; else r=1; fi
check "summary guard (line $guard_line) precedes first bump ($bump_line) and assembly ($assemble_line)" "$r"
if [[ "${summary_line:-0}" -lt "${guard_line:-0}" ]]; then r=0; else r=1; fi
check "default summary computed before the guard" "$r"
grep -q 'DEFAULT_SUMMARY="$(python3 - ' "$RELEASE_SH" && r=1 || r=0
check "no second inline default-summary extractor left in release.sh" "$r"

# --- Case 5: Release page keeps paragraph breaks ------------------------------
# release:create used to delete every blank line, so a multi-paragraph summary
# rendered as ONE Markdown paragraph and a bolded upgrade warning disappeared
# into the text before it (v0.4.0-beta.3's Release page shows it).
PAGE="$REPO_ROOT/scripts/release-page-summary.sh"
CI_YML="$REPO_ROOT/.gitlab-ci.yml"
echo "Case 5: release-page-summary.sh keeps paragraphs, trims the edges"
cat >"$TMP/c5.md" <<'EOF'
## [Unreleased]

_Nothing yet._

## [0.2.0-beta.1] — 2026-01-02


First paragraph,
second line.



**Upgrading? Read this first.** Warning.

### Added

- Not on the Release page.

## [0.2.0-beta.10] — 2026-01-01

Wrong section.
EOF
out="$(sh "$PAGE" 0.2.0-beta.1 "$TMP/c5.md")"
expected="$(printf 'First paragraph,\nsecond line.\n\n**Upgrading? Read this first.** Warning.')"
if [[ "$out" == "$expected" ]]; then r=0; else r=1; fi
check "one blank line between paragraphs, none at the edges (got: '$out')" "$r"
out="$(sh "$PAGE" 0.2.0-beta.10 "$TMP/c5.md")"
if [[ "$out" == "Wrong section." ]]; then r=0; else r=1; fi
check "beta.1 does not prefix-match beta.10, and vice versa (got: '$out')" "$r"
out="$(sh "$PAGE" 0.2.0-beta.1X "$TMP/c5.md")"
if [[ -z "$out" ]]; then r=0; else r=1; fi
check "unknown version → empty output, so release:create links out (got: '$out')" "$r"
out="$(sh "$PAGE" 0.2.0.beta.1 "$TMP/c5.md")"
if [[ -z "$out" ]]; then r=0; else r=1; fi
check "dots in the version are literal, not regex wildcards (got: '$out')" "$r"

echo "Case 6: release:create uses the script, not the blank-line-deleting sed"
if grep -qF 'sh scripts/release-page-summary.sh "$VERSION" CHANGELOG.md' "$CI_YML"; then r=0; else r=1; fi
check "release:create calls release-page-summary.sh" "$r"
if grep -qF "| sed '/^[[:space:]]*\$/d' > /tmp/summary.md" "$CI_YML"; then r=1; else r=0; fi
check "the old sed that flattened paragraphs is gone" "$r"

echo ""
echo "release-summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
