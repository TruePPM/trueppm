#!/usr/bin/env bash
# Pre-flight for `make pre-push` (#1368): fail fast with an actionable message
# when the shell's node is older than packages/web's `engines.node`, instead of
# letting web-lint/vitest die with an opaque ABI/syntax error that reads as a
# code failure and invites `git push --no-verify` (which skips every gate).
#
# The floor is read from packages/web/package.json so it cannot drift from the
# real requirement; .nvmrc only names the version `nvm use` should select.
# Skips (exit 0, with a note) when node is absent: the web gates then fail on
# their own with a clear "command not found".
#
# Usage: check-node-version.sh [--self-test]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# version_ge A B -> 0 when A >= B (dotted numeric, missing parts = 0).
version_ge() {
  local IFS=. i
  local -a a b
  read -ra a <<<"$1"
  read -ra b <<<"$2"
  for i in 0 1 2; do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    if ((x > y)); then return 0; fi
    if ((x < y)); then return 1; fi
  done
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  version_ge 24.14.0 22.22.0 || { echo "self-test: 24.14.0 >= 22.22.0 failed" >&2; exit 1; }
  version_ge 22.22.0 22.22.0 || { echo "self-test: equal failed" >&2; exit 1; }
  version_ge 22.21.9 22.22.0 && { echo "self-test: 22.21.9 should be < 22.22.0" >&2; exit 1; }
  version_ge 17.9.1 22.22.0 && { echo "self-test: 17.9.1 should be < 22.22.0" >&2; exit 1; }
  echo "check-node-version self-test OK"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "check-node-version: node not on PATH; skipping (web gates will report it)" >&2
  exit 0
fi

have="$(node -v | sed 's/^v//')"
want="$(sed -n 's/.*"node": *">=\([0-9.]*\)".*/\1/p' "${root}/packages/web/package.json" | sed -n 1p)"
if [ -z "${want}" ]; then
  echo "check-node-version: could not read engines.node from packages/web/package.json" >&2
  exit 1
fi

if ! version_ge "${have}" "${want}"; then
  nvmrc="$(tr -d '[:space:]' <"${root}/.nvmrc" 2>/dev/null || echo "?")"
  echo "node v${have} detected; packages/web needs >= ${want} (.nvmrc: ${nvmrc})." >&2
  echo "Run 'nvm use' (or 'fnm use') in the repo root, then re-run. Do not use --no-verify: it skips every gate." >&2
  exit 1
fi
