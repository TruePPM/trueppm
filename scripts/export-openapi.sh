#!/usr/bin/env bash
# Regenerate docs/api/openapi.json from the live DRF schema.
#
# Usage:
#   scripts/export-openapi.sh            # writes docs/api/openapi.json
#   scripts/export-openapi.sh --check    # exits non-zero if the committed
#                                        # schema has drifted from the live one,
#                                        # OR if it regresses paths/schemas vs main
#
# The --check mode is what the CI `api:schema-drift` job runs.

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

# settings/dev.py refuses to load outside pytest/mypy unless this opt-in is set
# (see #256 — guard prevents AllowAny from leaking into staging/prod by accident).
export TRUEPPM_ALLOW_DEV_SETTINGS=1

# Force *this checkout's* source onto PYTHONPATH before generating the schema.
# The venv's editable install resolves trueppm_api from wherever `pip install -e`
# first ran; in a per-issue worktree that shares the main checkout's venv
# (scripts/wt symlinks packages/api/.venv) that's the MAIN tree, not this one —
# so a bare `spectacular` run regenerates main's schema into the worktree,
# producing self-consistent garbage the api:schema-drift check is happy with (#642).
# REPO_ROOT is this script's own tree, so this pins generation to the committed
# source. No-op in the main checkout (same path the editable install resolves).
export PYTHONPATH="${REPO_ROOT}/packages/api/src${PYTHONPATH:+:${PYTHONPATH}}"

"${PYTHON_BIN}" manage.py spectacular --format openapi-json --file "${TMP}" > /dev/null

if [[ "${CHECK}" -eq 1 ]]; then
    if ! diff -q "${TMP}" "${OUT}" > /dev/null 2>&1; then
        echo "ERROR: docs/api/openapi.json is out of date." >&2
        echo "Run scripts/export-openapi.sh and commit the result." >&2
        diff -u "${OUT}" "${TMP}" | head -80 >&2 || true
        exit 1
    fi
    echo "docs/api/openapi.json is up to date."

    # Regression guard: fail if the committed schema drops paths or schemas
    # that exist on main. Catches branches that are behind main and would
    # silently remove endpoints when merged.
    #
    # This guard must NOT run on the default branch itself. It compares against
    # the *live* origin/main tip, which is only meaningful for a branch that
    # diverged from main. On main, when several MRs merge in quick succession
    # each older main commit's pipeline runs after origin/main has already
    # advanced; any schema *added* by an interim merge is then reported as
    # "removed" from the older commit — a false positive that fails main even
    # though every MR was individually green. A main commit is authoritative
    # and the self-consistency check above already guards genuine drift, so we
    # skip the vs-main comparison on the default branch.
    if [[ -n "${CI_COMMIT_BRANCH:-}" && "${CI_COMMIT_BRANCH}" == "${CI_DEFAULT_BRANCH:-main}" ]]; then
        echo "On the default branch (${CI_COMMIT_BRANCH}); skipping the regression-vs-main guard."
    else
        MAIN_SCHEMA="$(git show origin/main:docs/api/openapi.json 2>/dev/null || true)"
        if [[ -n "${MAIN_SCHEMA}" ]]; then
            MAIN_TMP="$(mktemp)"
            trap 'rm -f "${TMP}" "${MAIN_TMP}"' EXIT
            echo "${MAIN_SCHEMA}" > "${MAIN_TMP}"
            "${PYTHON_BIN}" "${REPO_ROOT}/scripts/check-schema-regression.py" "${OUT}" "${MAIN_TMP}"
        fi
    fi
else
    mkdir -p "$(dirname "${OUT}")"
    mv "${TMP}" "${OUT}"
    trap - EXIT
    echo "Wrote ${OUT}"
fi
