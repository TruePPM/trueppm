#!/usr/bin/env bash
# scripts/setup-hooks.sh — install git hooks via pre-commit
#
# Usage: bash scripts/setup-hooks.sh
#        make setup

set -euo pipefail

echo "Installing git hooks via pre-commit..."

# pre-commit refuses to install when core.hooksPath is set in git config
# (it prints "Cowardly refusing to install hooks with core.hooksPath set").
# IDEs and some tooling write this value explicitly — clear it so the
# install is idempotent across fresh clones and re-setups.
if git config --local --get core.hooksPath &>/dev/null; then
  git config --local --unset-all core.hooksPath
  echo "Cleared core.hooksPath from local git config."
fi

if ! command -v pre-commit &>/dev/null; then
  echo "pre-commit not found. Installing..."
  pip install pre-commit --quiet
fi

pre-commit install
echo "Done. Hooks installed from .pre-commit-config.yaml"
