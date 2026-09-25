#!/usr/bin/env bash
# Install trueppm-api the way a user would and import it (#4122).
#
#   scripts/api-wheel-install-probe.sh wheel   # build wheel, fresh venv, resolve from PyPI
#   scripts/api-wheel-install-probe.sh locked  # `uv sync --locked`, the reference install
#   scripts/api-wheel-install-probe.sh lowest  # every DIRECT dependency at its declared floor
#
# `lowest` resolves the wheel's own Requires-Dist rather than the wheel itself:
# `--resolution lowest-direct` only lowers what is named on the command line, so
# installing the wheel would leave every real dependency at its newest version.
# The `binary` extra supplies the DB driver Django needs to load.
# Needs network (PyPI). Optional: REPO_ROOT, PROBE_PYTHON (default 3.11).
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MODE="${1:?usage: $0 wheel|locked|lowest}"
PY="${PROBE_PYTHON:-3.11}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
VENV="$WORK/venv"
# Beside this script, not under REPO_ROOT: REPO_ROOT may point at another checkout
# (an older commit, to prove the probe fails there).
PROBE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-api-wheel-imports.py"

build_wheel() {
  uv build --wheel --out-dir "$WORK/dist" "$REPO_ROOT/packages/api" >/dev/null
  WHEEL="$(ls "$WORK"/dist/*.whl)"
}

case "$MODE" in
  wheel)
    build_wheel
    uv venv --python "$PY" "$VENV" >/dev/null
    uv pip install --python "$VENV/bin/python" "${WHEEL}[binary]"
    ;;
  lowest)
    build_wheel
    uv venv --python "$PY" "$VENV" >/dev/null
    "$VENV/bin/python" - "$WHEEL" "$WORK/reqs.txt" <<'PY'
import sys, zipfile
from email.parser import Parser
whl, out = sys.argv[1:]
with zipfile.ZipFile(whl) as z:
    meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
    msg = Parser().parsestr(z.read(meta).decode())
# A DB driver is a required extra (`binary` or `c`); no driver, no django.setup().
reqs = []
for r in msg.get_all("Requires-Dist") or []:
    if "extra ==" not in r:
        reqs.append(r)
    elif "extra == 'binary'" in r or 'extra == "binary"' in r:
        reqs.append(r.split(";")[0].strip())
open(out, "w").write("\n".join(reqs) + "\n")
PY
    uv pip install --python "$VENV/bin/python" --resolution lowest-direct -r "$WORK/reqs.txt"
    uv pip install --python "$VENV/bin/python" --no-deps "$WHEEL"
    ;;
  locked)
    (cd "$REPO_ROOT/packages/api" && UV_PROJECT_ENVIRONMENT="$VENV" uv sync --locked --no-dev --extra binary --python "$PY")
    ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac

# Run from outside the tree so the installed package is what gets imported.
cd "$WORK"
"$VENV/bin/python" "$PROBE"
