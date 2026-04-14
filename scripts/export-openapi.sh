#!/usr/bin/env bash
# Regenerate docs/api/openapi.json from the live DRF schema.
#
# Usage:
#   scripts/export-openapi.sh            # writes docs/api/openapi.json
#   scripts/export-openapi.sh --check    # exits non-zero if the committed
#                                        # schema has drifted from the live one
#
# The --check mode is what the CI `api:schema-check` job runs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${REPO_ROOT}/docs/api/openapi.json"
CHECK=0

if [[ "${1:-}" == "--check" ]]; then
    CHECK=1
fi

cd "${REPO_ROOT}/packages/api"

# Prefer the repo venv; fall back to whatever `python` is on PATH.
PYTHON_BIN="${REPO_ROOT}/packages/api/.venv/bin/python"
if [[ ! -x "${PYTHON_BIN}" ]]; then
    PYTHON_BIN="python"
fi

TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

"${PYTHON_BIN}" manage.py spectacular --format openapi-json --file "${TMP}" > /dev/null

if [[ "${CHECK}" -eq 1 ]]; then
    if ! diff -q "${TMP}" "${OUT}" > /dev/null 2>&1; then
        echo "ERROR: docs/api/openapi.json is out of date." >&2
        echo "Run scripts/export-openapi.sh and commit the result." >&2
        diff -u "${OUT}" "${TMP}" | head -80 >&2 || true
        exit 1
    fi
    echo "docs/api/openapi.json is up to date."
else
    mkdir -p "$(dirname "${OUT}")"
    mv "${TMP}" "${OUT}"
    trap - EXIT
    echo "Wrote ${OUT}"
fi
