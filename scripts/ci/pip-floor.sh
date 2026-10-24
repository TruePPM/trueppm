#!/usr/bin/env bash
# Raise pip to >= 26.2.2 from a hash-checked wheel (#4643).
#
# Why this exists: pip older than 26.2.2 keeps trusting the compromised emSign
# intermediates through its vendored certifi (emudhra/emSign CA incident). The
# digest-pinned python:3.11-slim image carries an affected pip, and CPython's
# ensurepip fix (GH-159910) will not reach a pinned 3.11 image on a schedule we
# control, so bumping the base digest is not the fix. Do NOT remove this step as
# redundant once the base image catches up without first checking `pip --version`
# in the job log on the new digest.
#
# Bootstrapping with the old pip is fine: the SHA256 check below, not TLS trust,
# is what authenticates the wheel. Stdlib urllib is used because slim has no curl.
#
# Usage: pip-floor.sh [python-executable]   (default: python)
#   Pass /tmp/venv/bin/python to upgrade the pip seeded into a venv.
set -euo pipefail

PIP_FLOOR_VERSION="26.2.2"
PIP_FLOOR_URL="https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl"
PIP_FLOOR_SHA256="fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"

PY="${1:-python}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
WHEEL="$WORK/pip-${PIP_FLOOR_VERSION}-py3-none-any.whl"

"$PY" - "$PIP_FLOOR_URL" "$PIP_FLOOR_SHA256" "$WHEEL" <<'PYEOF'
import hashlib
import sys
import urllib.request

url, want, dest = sys.argv[1:4]
with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 - fixed https URL
    data = resp.read()
got = hashlib.sha256(data).hexdigest()
if got != want:
    sys.exit(f"pip-floor: SHA256 mismatch for {url}: got {got}, want {want}")
with open(dest, "wb") as fh:
    fh.write(data)
PYEOF

"$PY" -m pip install --quiet --no-index --no-deps --root-user-action=ignore \
  --disable-pip-version-check "$WHEEL"
"$PY" -m pip --version
