#!/usr/bin/env bash
# Self-test for scripts/check-nginx-location-parity.sh (#4392): the real tree
# passes, and removing the asset-manifest block from any one surface fails.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$ROOT/scripts/check-nginx-location-parity.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

bash "$CHECK" > /dev/null || { echo "FAIL: real tree should pass" >&2; exit 1; }

mkdir -p "$TMP/packages/web" "$TMP/packages/helm/templates/web" "$TMP/nginx"
fresh() {
    cp "$ROOT/packages/web/nginx.conf" "$TMP/packages/web/"
    cp "$ROOT/packages/helm/templates/web/configmap.yaml" "$TMP/packages/helm/templates/web/"
    cp "$ROOT"/nginx/*.template "$TMP/nginx/"
}
strip_block() {  # remove the 3-line asset-manifest location from $1
    python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s2 = re.sub(r"[ \t]*location = /asset-manifest\.json \{\n[^}]*\}\n", "", s, count=1)
assert s != s2, p
open(p, "w").write(s2)
PY
}

for victim in packages/web/nginx.conf nginx/app.conf.template nginx/app-http.conf.template \
    nginx/demo.conf.template packages/helm/templates/web/configmap.yaml; do
    fresh
    strip_block "$TMP/$victim"
    if NGINX_PARITY_ROOT="$TMP" bash "$CHECK" > /dev/null 2>&1; then
        echo "FAIL: removing the block from $victim was not caught" >&2
        exit 1
    fi
done
echo "check-nginx-location-parity self-test: ok"
