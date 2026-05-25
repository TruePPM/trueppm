#!/usr/bin/env bash
# Pre-commit hook: regenerate docs/api/openapi.json whenever packages/api/src
# changes, and re-stage the result.
#
# Why this exists (#642): the CI `api:schema-drift` job only checks that the
# committed schema is *self-consistent* with the branch code. It does NOT fail
# when you simply forget to regenerate after touching a serializer or adding an
# @action — the stale schema is internally consistent, so it passes locally and
# only trips the regression guard at merge time. Regenerating on every api-source
# commit closes that gap (~3-5s tax on API commits only).
#
# export-openapi.sh already pins generation to this checkout's source via
# PYTHONPATH, so this is worktree-safe.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
bash "${repo_root}/scripts/export-openapi.sh"

if ! git diff --quiet -- docs/api/openapi.json; then
    git add docs/api/openapi.json
    echo "openapi.json was stale; regenerated from api source and re-staged." >&2
fi
