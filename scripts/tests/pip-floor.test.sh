#!/usr/bin/env bash
# scripts/tests/pip-floor.test.sh
#
# Unit test for scripts/ci/pip-floor.sh (#4643).
#
# The script's job is to refuse an unauthenticated wheel. A green run that has
# never seen the refusal path proves nothing, so the load-bearing case here is
# the mismatch: a wrong SHA256 must exit non-zero AND leave the target pip
# untouched (a script that exits 1 AFTER installing would still fail a bare
# exit-code check).
#
# Case 1 is offline (file:// URL). Case 2 needs files.pythonhosted.org and is
# skipped, loudly, when the network is unreachable.
#
# Run: bash scripts/tests/pip-floor.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOOR="$REPO_ROOT/scripts/ci/pip-floor.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() {
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

python3 -m venv "$TMP/venv"
VPY="$TMP/venv/bin/python"
before="$("$VPY" -m pip --version)"

echo "Case 1: SHA256 mismatch is refused and pip is left unchanged"
# A VALID wheel that replaces pip with a stub: if the hash check were skipped it
# would install cleanly, so the exit-code and unchanged-version checks below can
# only pass because the script refused it.
python3 - "$TMP/pip-99.0.0-py3-none-any.whl" <<'PYEOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("pip/__init__.py", "")
    z.writestr("pip/__main__.py", "print('pip 99.0.0 (stub)')\n")
    z.writestr("pip-99.0.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: pip\nVersion: 99.0.0\n")
    z.writestr("pip-99.0.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: t\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
    z.writestr("pip-99.0.0.dist-info/RECORD", "")
PYEOF
set +e
OUT="$(PIP_FLOOR_URL="file://$TMP/pip-99.0.0-py3-none-any.whl" bash "$FLOOR" "$VPY" 2>&1)"
RC=$?
set -e
check "mismatch exits non-zero"            "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "mismatch names the SHA256 problem"  "$(grep -q 'SHA256 mismatch' <<<"$OUT" && echo 0 || echo 1)"
after="$("$VPY" -m pip --version)"
check "pip version unchanged after refusal" "$([[ "$before" == "$after" ]] && echo 0 || echo 1)"

echo "Case 2: pinned wheel installs and reports >= 26.2.2 (network)"
reachable() {
  python3 - <<'PYEOF' 2>/dev/null
import urllib.error, urllib.request
try:
    urllib.request.urlopen("https://files.pythonhosted.org/", timeout=10)
except urllib.error.HTTPError:
    pass  # an HTTP status still proves the host is reachable
PYEOF
}
if reachable; then
  set +e
  OUT="$(bash "$FLOOR" "$VPY" 2>&1)"
  RC=$?
  set -e
  check "happy path exits zero"           "$RC"
  check "pip --version reports 26.2.2"    "$(grep -q '^pip 26\.2\.2 ' <<<"$OUT" && echo 0 || echo 1)"
else
  echo "  SKIP: files.pythonhosted.org unreachable; happy path not exercised"
fi

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "pip-floor.test.sh: all $pass checks passed."
else
  echo "pip-floor.test.sh: $fail of $((pass + fail)) checks FAILED." >&2
  exit 1
fi
