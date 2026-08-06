#!/usr/bin/env bash
# scripts/tests/check-enterprise-imports.test.sh
#
# Unit test for scripts/check-enterprise-imports.sh — the source-tree half of the
# Apache 2.0 boundary gate (#2603). The gate is only worth having if it FAILS on
# a real import, so the cases below are weighted toward proving that: a gate that
# has only ever been observed passing on a clean tree is indistinguishable from a
# gate that always passes.
#
# The second thing it must prove is the opposite: prose that NAMES the enterprise
# package stays legal. The codebase deliberately carries ~6 such references
# (extension-point docstrings, ADR pointers) and a gate that fails on those would
# be reverted within a day, taking the real protection with it.
#
# Each case stages a throwaway tree and runs the gate against it.
#
# Run: bash scripts/tests/check-enterprise-imports.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-enterprise-imports.sh"

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

# stage <relative-path> — start a fresh tree and create the named file from stdin.
stage() {
  local rel="$1"
  rm -rf "$TMP/tree"
  mkdir -p "$TMP/tree/$(dirname "$rel")"
  cat > "$TMP/tree/$rel"
}

run_gate() { # sets $OUT and $RC; never aborts under `set -e`
  set +e
  OUT="$(bash "$GATE" "$TMP/tree" 2>&1)"
  RC=$?
  set -e
}

# --- Must FAIL: the four import shapes that create a real dependency ---------

stage api/apps/portfolio/views.py <<'PY'
from django.db import models

from trueppm_enterprise.portfolio import RollupService
PY
run_gate
check "python from-import fails" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "python from-import names the file" "$(echo "$OUT" | grep -q 'views.py' && echo 0 || echo 1)"

stage api/apps/portfolio/services.py <<'PY'
    import trueppm_enterprise.audit as audit
PY
run_gate
check "indented plain import fails" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

stage api/settings/base.py <<'PY'
INSTALLED_APPS = [
    "django.contrib.auth",
    "trueppm_enterprise.audit",
]
PY
run_gate
check "quoted INSTALLED_APPS entry fails" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

stage api/apps/core/loader.py <<'PY'
mod = importlib.import_module("trueppm_enterprise.slots")
PY
run_gate
check "importlib.import_module fails" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

stage web/src/main.tsx <<'TSX'
import { registerSlots } from '@trueppm-enterprise/overlay'
TSX
run_gate
check "typescript static import fails" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

stage web/src/main.tsx <<'TSX'
const overlay = await import('../../trueppm-enterprise/src/overlay')
TSX
run_gate
check "typescript dynamic import fails" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Must PASS: prose naming the package, which the boundary permits ---------

stage api/apps/workspace/signals.py <<'PY'
"""Workspace signals.

OSS never imports ``trueppm_enterprise`` (ADR-0157, #859). The receiver lives in
enterprise and registers here at startup:

    # trueppm_enterprise/audit/apps.py
"""
PY
run_gate
check "docstring + comment prose passes" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"

stage web/src/features/schedule/sections/index.ts <<'TS'
/**
 * Slot registry. Enterprise fills these from `trueppm_enterprise`.
 */
export const SECTIONS = []
TS
run_gate
check "typescript block-comment prose passes" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"

stage api/apps/core/notes.py <<'PY'
# from trueppm_enterprise.audit import AuditLog  # <- what NOT to write
PY
run_gate
check "commented-out import passes (it is inert)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"

# --- The real tree must be clean --------------------------------------------
# Regression guard for the gate's own premise: it was added while OSS had zero
# imports, so a failure here means either a violation landed or the gate drifted
# into false positives against live prose.
set +e
REAL_OUT="$(bash "$GATE" "$REPO_ROOT/packages" 2>&1)"
REAL_RC=$?
set -e
check "live packages/ tree is clean" "$([ "$REAL_RC" -eq 0 ] && echo 0 || echo 1)"
[ "$REAL_RC" -eq 0 ] || echo "$REAL_OUT"

# --- Invocation errors -------------------------------------------------------
set +e
bash "$GATE" "$TMP/does-not-exist" >/dev/null 2>&1
MISSING_RC=$?
set -e
check "missing directory exits 2 (invocation error, not a clean pass)" \
  "$([ "$MISSING_RC" -eq 2 ] && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "check-enterprise-imports.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-enterprise-imports.test.sh: $fail failed, $pass passed"
  exit 1
fi
