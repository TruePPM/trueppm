#!/usr/bin/env bash
# scripts/tests/helm-sentinel-schema-experimental.test.sh
#
# Guards #3778 gap 2: every one of the six `valkey.sentinel.*` keys in
# packages/helm/values.schema.json must carry a `description` that marks it
# EXPERIMENTAL and says failover has not been exercised end to end. Before
# #3778, that caveat lived only in a `values.yaml` comment — invisible to
# `helm show values` and any schema-driven tooling, so an operator reading the
# schema saw six ordinary, validated keys indistinguishable from the stable
# surface. Nothing else re-checks the schema's prose, so a future edit that
# drops or waters down a description (e.g. a values.schema.json regeneration,
# or someone tidying up "long" descriptions) would silently ship the same gap
# again with a green pipeline.
#
# No cluster, no `helm template` needed — this only reads JSON. Wired into the
# `scripts:test` job (python:3.11-slim, which already installs jq for
# helm-celery-probe-overrides.test.sh) rather than helm:template, because it
# asserts schema metadata that never reaches a rendered manifest.
#
# Run: bash scripts/tests/helm-sentinel-schema-experimental.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMA="$REPO_ROOT/packages/helm/values.schema.json"

pass=0
fail_count=0
check() { # check "<description>" <0-or-1: condition true>
  local desc="$1" ok="$2"
  if [ "$ok" -eq 1 ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail_count=$((fail_count + 1))
  fi
  return 0
}
die() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$SCHEMA" ] || die "$SCHEMA not found"
command -v jq >/dev/null 2>&1 || die "jq not on PATH — this test cannot run without it"

python3 -c "import json; json.load(open('$SCHEMA'))" \
  || die "$SCHEMA is not valid JSON — every other check below would be meaningless"

# The six keys the issue named. Hard-coded rather than derived from the schema's
# own `properties` listing on purpose: deriving the key list from the same file
# whose content this test polices would let a key that got silently REMOVED from
# `properties` (taking its EXPERIMENTAL description with it) pass by vacuously
# iterating over zero keys instead of failing loud.
SENTINEL_KEYS=(enabled nodes masterName password sentinelPassword tls)

# --- 0. Self-check the extraction path before trusting any verdict below ----
# A jq filter that silently returned null for every path would make every
# "description missing" check below report a false PASS (null !~ EXPERIMENTAL
# is a fail, so that direction is safe) but a filter typo could just as easily
# always return "" and make every check fail regardless of the real schema —
# prove the walker resolves a key everyone agrees exists first.
known_desc="$(jq -r '.properties.valkey.properties.sentinel.properties.enabled.description // "MISSING"' "$SCHEMA")"
check "schema walker resolves valkey.sentinel.enabled.description" \
  "$([ "$known_desc" != "MISSING" ] && echo 1 || echo 0)"

# --- 1. The parent `sentinel` object itself is marked EXPERIMENTAL ----------
parent_desc="$(jq -r '.properties.valkey.properties.sentinel.description // ""' "$SCHEMA")"
case "$parent_desc" in
  *EXPERIMENTAL*) check "valkey.sentinel parent description contains EXPERIMENTAL" 1 ;;
  *) check "valkey.sentinel parent description contains EXPERIMENTAL (got: '$parent_desc')" 0 ;;
esac
case "$parent_desc" in
  *"shape"*"change"*|*"Shape"*"change"*) check "valkey.sentinel parent description warns the shape may change" 1 ;;
  *) check "valkey.sentinel parent description warns the shape may change (got: '$parent_desc')" 0 ;;
esac

# --- 2. Every one of the six child keys is marked EXPERIMENTAL --------------
# A description that mentions EXPERIMENTAL but not the specific "not verified /
# no exercised failover" caveat would still leave an operator unable to tell
# WHY it's experimental, so require both signals independently per key.
for key in "${SENTINEL_KEYS[@]}"; do
  desc="$(jq -r --arg k "$key" '.properties.valkey.properties.sentinel.properties[$k].description // ""' "$SCHEMA")"

  if [ -z "$desc" ]; then
    check "valkey.sentinel.$key has a description at all" 0
    continue
  fi

  case "$desc" in
    *EXPERIMENTAL*) check "valkey.sentinel.$key description contains EXPERIMENTAL" 1 ;;
    *) check "valkey.sentinel.$key description contains EXPERIMENTAL (got: '$desc')" 0 ;;
  esac
done

# --- 3. additionalProperties: false still holds ------------------------------
# Not this test's main subject, but a schema that stopped being closed would
# make the EXPERIMENTAL marker meaningless for a 7th key nobody documented.
closed="$(jq -r '.properties.valkey.properties.sentinel.additionalProperties' "$SCHEMA")"
check "valkey.sentinel stays additionalProperties: false" \
  "$([ "$closed" = "false" ] && echo 1 || echo 0)"

if [ "$fail_count" -gt 0 ]; then
  echo "helm-sentinel-schema-experimental: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "helm-sentinel-schema-experimental: ${pass} checks passed"
