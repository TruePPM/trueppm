#!/usr/bin/env bash
# scripts/setup-hooks.sh — install git hooks via pre-commit
#
# Usage: bash scripts/setup-hooks.sh
#        make setup

set -euo pipefail

echo "Installing git hooks via pre-commit..."

if ! command -v pre-commit &>/dev/null; then
  echo "pre-commit not found. Installing..."
  pip install pre-commit --quiet
fi

pre-commit install
echo "Done. Hooks installed from .pre-commit-config.yaml"
