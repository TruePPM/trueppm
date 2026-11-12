#!/usr/bin/env bash
# scripts/check-nginx-location-parity.sh — fail when a top-level `location` that
# one SPA-serving nginx server block has is missing from another (#4392).
#
# The SPA is fronted by nginx config in five places: the image's baked
# packages/web/nginx.conf, the three Compose templates under nginx/, and three
# server blocks in packages/helm/templates/web/configmap.yaml. #4350 made them
# agree; #4359 then added `location = /asset-manifest.json` to the Helm blocks
# only, so a non-Helm deployment of a build missing its manifest answered 200
# with index.html and defeated the readiness-probe invariant. Nothing enforced
# parity, so this does.
#
# Rule: take every server block that carries the SPA fallback (`/index.html;`),
# collect its depth-1 `location` signatures (modifier + path), and require each
# block to have every signature any other block has — except those in
# ALLOWLIST below, which are surface-specific on purpose. Pure text parse, no
# network, <1s. A parse that finds fewer than the expected blocks fails closed,
# so a reformat cannot turn the check into a silent no-op.
#
# Usage: check-nginx-location-parity.sh [--self-test]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

FILES=(
    packages/web/nginx.conf
    nginx/app.conf.template
    nginx/app-http.conf.template
    nginx/demo.conf.template
    packages/helm/templates/web/configmap.yaml
)
# Total SPA-serving server blocks across FILES (1+1+1+1+3).
EXPECTED_BLOCKS=7

run_check() {
    local root="$1"
    python3 - "$root" "$EXPECTED_BLOCKS" "${FILES[@]}" <<'PY'
import re, sys

root, expected = sys.argv[1], int(sys.argv[2])
files = sys.argv[3:]

# signature -> why it legitimately exists on only some surfaces.
ALLOWLIST = {
    "= /robots.txt": "demo surfaces only; production indexing is the operator's call",
    "= /": "demo share-link mode redirect",
    "^~ /api/v1/share/": "demo surfaces expose only the public share read",
    "= /api/v1/health/": "demo surfaces proxy health only",
    "= /api/v1/auth/token/": "interactive demo auth allowlist",
    "= /api/v1/auth/token/refresh/": "interactive demo auth allowlist",
    "= /api/v1/auth/logout/": "interactive demo auth allowlist",
    "@demo_read_only": "interactive demo write fence",
}

def clean(line):
    line = re.sub(r"\{\{.*?\}\}", "", line)
    line = re.sub(r"\$\{[^}]*\}", "X", line)
    return line.split("#", 1)[0]

blocks = []  # (label, set of signatures)
for f in files:
    cur = None
    depth = 0
    n = 0
    spa = False
    sigs = set()
    for line in open(f"{root}/{f}", encoding="utf-8"):
        c = clean(line)
        if cur is None:
            if re.match(r"\s*server\s*\{", c):
                cur, depth, spa, sigs = True, 0, False, set()
                n += 1
            else:
                continue
        if depth == 1:
            m = re.match(r"\s*location\s+(.*?)\s*\{", c)
            if m:
                sigs.add(m.group(1))
        if re.search(r"/index\.html\s*;", c):
            spa = True
        depth += c.count("{") - c.count("}")
        if depth <= 0:
            if spa:
                blocks.append((f"{f}#{n}", sigs))
            cur = None

if len(blocks) != expected:
    print(f"check-nginx-location-parity: FAIL  parsed {len(blocks)} SPA server blocks, expected {expected} — "
          "the parser or a surface changed shape; update EXPECTED_BLOCKS or the parser", file=sys.stderr)
    sys.exit(1)

union = set().union(*(s for _, s in blocks)) - set(ALLOWLIST)
bad = 0
for label, sigs in blocks:
    for sig in sorted(union - sigs):
        have = [l for l, s in blocks if sig in s]
        print(f"check-nginx-location-parity: FAIL  {label} has no `location {sig}` "
              f"(present in: {', '.join(have)})", file=sys.stderr)
        bad += 1
if bad:
    print("Add the location to every surface, or allowlist it with a reason in this script.", file=sys.stderr)
    sys.exit(1)
print(f"check-nginx-location-parity: ok  {len(blocks)} SPA server blocks agree on {len(union)} locations")
PY
}

if [ "${1:-}" = "--self-test" ]; then
    bash "$ROOT/scripts/tests/check-nginx-location-parity.test.sh"
    exit $?
fi

run_check "${NGINX_PARITY_ROOT:-$ROOT}"
