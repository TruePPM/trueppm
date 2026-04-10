#!/usr/bin/env bash
# scripts/doctor.sh — verify prerequisites for TruePPM development
#
# Usage: bash scripts/doctor.sh
#        make doctor

set -euo pipefail

PASS=0
FAIL=0

ok()   { echo "  [ok] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [!!] $1"; FAIL=$((FAIL + 1)); }
info() { echo "       $1"; }

check_version() {
  local name="$1" cmd="$2" min_major="$3" min_minor="${4:-0}"
  if ! command -v "$cmd" &>/dev/null; then
    fail "$name not found"
    return
  fi
  ok "$name installed"
}

echo ""
echo "TruePPM development environment check"
echo "======================================"
echo ""

# --- Required tools ---

check_version "Git" git 2 30
check_version "Docker" docker 24 0
check_version "Docker Compose" docker 24 0  # compose ships as `docker compose` in v2

if docker compose version &>/dev/null 2>&1; then
  ok "Docker Compose v2 (docker compose)"
else
  fail "Docker Compose v2 not available — run: docker compose version"
fi

check_version "Node.js" node 20 0
check_version "npm" npm 10 0
check_version "Python 3" python3 3 12

if python3 -c "import sys; assert sys.version_info >= (3,12)" 2>/dev/null; then
  ok "Python 3.12+"
else
  fail "Python 3.12+ required — found: $(python3 --version 2>&1)"
fi

check_version "glab (GitLab CLI)" glab 1 0

# --- Optional but recommended ---

echo ""
echo "Optional:"

if command -v pre-commit &>/dev/null; then
  ok "pre-commit installed"
else
  info "pre-commit not found — run: pip install pre-commit && pre-commit install"
fi

if command -v uv &>/dev/null; then
  ok "uv installed (fast Python package manager)"
else
  info "uv not found (optional) — https://docs.astral.sh/uv/"
fi

# --- Environment files ---

echo ""
echo "Config:"

if [[ -f "docker-compose.override.yml" ]]; then
  ok "docker-compose.override.yml present"
else
  info "No docker-compose.override.yml — copy from docker-compose.override.yml.example if needed"
fi

# --- Summary ---

echo ""
echo "======================================"
echo "  Pass: $PASS   Fail: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "Fix the issues above, then re-run: make doctor"
  exit 1
else
  echo "All checks passed. Run 'docker compose up -d' to start the stack."
fi
