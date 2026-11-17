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

if [ "${1:-}" = "--self-test" ]; then
  out="$(printf '%s\n' '--- a/x.tsx' '+++ b/x.tsx' '-  <button aria-label="Delete task">Remove item</button>' '+  <button aria-label="Delete task">Archive item</button>' '-const x = 12;' | removed_literals | sort)"
  [ "${out}" = "Remove item" ] || { echo "self-test: expected 'Remove item', got '${out}'" >&2; exit 1; }
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

found=0
while IFS= read -r lit; do
  [ -n "${lit}" ] || continue
  hits="$(grep -rnF --include='*.ts' -- "${lit}" packages/web/e2e 2>/dev/null | sed -n 1,3p || true)"
  if [ -n "${hits}" ]; then
    if [ "${found}" -eq 0 ]; then
      echo "⚠️  e2e drift: strings removed from packages/web/src still appear in packages/web/e2e/ (warning only):" >&2
    fi
    found=1
    echo "  \"${lit}\"" >&2
    echo "${hits}" | sed 's/^/    /' >&2
  fi
done < <(printf '%s\n' "${diff_text}" | removed_literals | sort)

if [ "${found}" -eq 1 ]; then
  echo "  Update those specs in the same commit and run them: cd packages/web && npx playwright test e2e/<spec>.spec.ts" >&2
fi
exit 0
