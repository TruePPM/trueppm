#!/usr/bin/env bash
# Static half of the CLAUDE.md "grep packages/web/e2e/ before you commit a UI
# change" recipe (#1450). `make pre-push` does not run Playwright, so a spec
# asserting on a label this branch removed or reworded only fails in CI.
#
# For every string literal / JSX text node REMOVED from packages/web/src
# (non-test files) and not re-added in the same diff, grep packages/web/e2e/
# for it verbatim and WARN where it still appears. Warning-level on purpose:
# copy legitimately lives in both trees and a spec may match it in a way this
# cannot see (regex locators, keybinds, role names built from variables) — a
# clean run is NOT proof the specs still pass. Never fails the push.
#
# PARTIAL implementation of #1450: it covers removed string literals and JSX
# text only. It does NOT cover keybinds, ARIA role/accessible-name assertions
# built from variables, regex locators, or section/item counts - the manual
# grep recipe in CLAUDE.md is still required for those. Only e2e `*.ts` files
# are searched (no `.tsx` specs exist under packages/web/e2e; add a
# --include='*.tsx' if one is ever introduced).
#
# Usage: check-e2e-drift.sh [--self-test]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

# Print removed-literal candidates (one per line) read from a unified diff on
# stdin: quoted literals and >JSX text< nodes of >= 6 chars containing a letter,
# minus any that also appear on an added line.
removed_literals() {
  awk '
    function grab(line, store,   s, m) {
      s = line
      while (match(s, /"[^"\\]{6,}"|'"'"'[^'"'"'\\]{6,}'"'"'|>[^<>{}]{6,}</)) {
        m = substr(s, RSTART + 1, RLENGTH - 2)
        sub(/^[ \t]+/, "", m); sub(/[ \t]+$/, "", m)
        if (m ~ /[A-Za-z]/ && length(m) >= 6 && m !~ /^(\.|\/|@|#|[a-z]+:)/ && m !~ /^[a-z0-9_.-]+$/) store[m] = 1
        s = substr(s, RSTART + RLENGTH)
      }
    }
    /^\+\+\+|^---/ { next }
    /^-/ { grab(substr($0, 2), rem) }
    /^\+/ { grab(substr($0, 2), add) }
    END { for (m in rem) if (!(m in add)) print m }
  '
}

# Read removed literals on stdin, grep $1 (an e2e dir) for each, print warnings
# to stderr. Returns 0 always.
warn_for_literals() {
  local e2e_dir="$1" found=0 lit hits
  while IFS= read -r lit; do
    [ -n "${lit}" ] || continue
    hits="$(grep -rnF --include='*.ts' -- "${lit}" "${e2e_dir}" 2>/dev/null | sed -n 1,3p || true)"
    if [ -n "${hits}" ]; then
      if [ "${found}" -eq 0 ]; then
        echo "WARNING e2e drift: strings removed from packages/web/src still appear in packages/web/e2e/ (warning only):" >&2
      fi
      found=1
      echo "  \"${lit}\"" >&2
      echo "${hits}" | sed 's/^/    /' >&2
    fi
  done
  if [ "${found}" -eq 1 ]; then
    echo "  Update those specs in the same commit and run them: cd packages/web && npx playwright test e2e/<spec>.spec.ts" >&2
  fi
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  out="$(printf '%s\n' '--- a/x.tsx' '+++ b/x.tsx' '-  <button aria-label="Delete task">Remove item</button>' '+  <button aria-label="Delete task">Archive item</button>' '-const x = 12;' | removed_literals | sort)"
  [ "${out}" = "Remove item" ] || { echo "self-test: expected 'Remove item', got '${out}'" >&2; exit 1; }
  # Warning branch: a removed literal still present in an e2e file warns; a
  # re-added one never reaches warn_for_literals, and an absent one is silent.
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT
  printf "await page.getByText('Remove item').click();\n" >"${tmp}/a.spec.ts"
  warned="$(printf '%s\n' 'Remove item' | warn_for_literals "${tmp}" 2>&1)"
  case "${warned}" in
    *"Remove item"*"a.spec.ts"*) ;;
    *) echo "self-test: expected a warning naming a.spec.ts, got '${warned}'" >&2; exit 1 ;;
  esac
  quiet="$(printf '%s\n' 'Never used text' | warn_for_literals "${tmp}" 2>&1)"
  [ -z "${quiet}" ] || { echo "self-test: expected silence, got '${quiet}'" >&2; exit 1; }
  readded="$(printf '%s\n' '--- a/x.tsx' '+++ b/x.tsx' '-<b>Remove item</b>' '+<i>Remove item</i>' | removed_literals | warn_for_literals "${tmp}" 2>&1)"
  [ -z "${readded}" ] || { echo "self-test: re-added literal must not warn, got '${readded}'" >&2; exit 1; }
  echo "check-e2e-drift self-test OK"
  exit 0
fi

[ -d packages/web/e2e ] || exit 0
base="${TRUEPPM_E2E_DRIFT_BASE:-$(git merge-base origin/main HEAD 2>/dev/null || true)}"
if [ -z "${base}" ]; then
  echo "check-e2e-drift: origin/main unavailable; skipping" >&2
  exit 0
fi

diff_text="$(git diff -U0 "${base}" -- 'packages/web/src' \
  ':(exclude)*.test.ts' ':(exclude)*.test.tsx' ':(exclude)packages/web/src/test' 2>/dev/null || true)"
[ -n "${diff_text}" ] || exit 0

printf '%s\n' "${diff_text}" | removed_literals | sort | warn_for_literals packages/web/e2e
exit 0
