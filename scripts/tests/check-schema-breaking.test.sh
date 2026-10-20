#!/usr/bin/env bash
# scripts/tests/check-schema-breaking.test.sh
#
# Self-test for scripts/check-schema-breaking.py (#4594). A gate only observed
# passing is indistinguishable from one that always passes, so every Breaking class
# must be shown to FAIL, and the Additive shapes shown to pass.
# Run: bash scripts/tests/check-schema-breaking.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-schema-breaking.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0; pass=0
check() { if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi; }

# schema <statuses-json> <widget-props-json> <required-json> <extra-top-level-json>
mk() { # mk <file> <status> <props> <req-in-request> <enum>
  python3 - "$@" <<'PY'
import json, sys
f, status, props, req, enum = sys.argv[1:6]
doc = {"openapi": "3.0.3", "paths": {"/w/": {"post": {
  "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Req"}}}},
  "responses": {status: {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Widget"}}}}, "400": {"description": "x"}}}}},
  "components": {"schemas": {
    "Widget": {"type": "object", "properties": json.loads(props)},
    "Req": {"type": "object", "properties": json.loads(props), "required": json.loads(req)}}}}
if enum != "-":
    doc["components"]["schemas"]["Widget"]["properties"]["kind"] = {"type": "string", "enum": json.loads(enum)}
    doc["components"]["schemas"]["Req"]["properties"]["kind"] = {"type": "string", "enum": json.loads(enum)}
json.dump(doc, open(f, "w"))
PY
}
BASE_PROPS='{"id":{"type":"integer"},"name":{"type":"string"}}'
mk "$TMP/base.json" 201 "$BASE_PROPS" '[]' '["a","b"]'

run() { # run <cand> -> exit code, output in $TMP/out
  python3 "$GATE" --candidate "$1" --baseline-file "$TMP/base.json" --allowlist "$TMP/none.txt" >"$TMP/out" 2>&1 && return 0 || return $?
}
expect_fail() { # expect_fail <desc> <rule>
  local rc=0; run "$TMP/cand.json" || rc=$?
  [[ $rc -eq 1 ]] && grep -q "$2" "$TMP/out"; check "$1 -> $2" $?
}

mk "$TMP/cand.json" 201 "$BASE_PROPS" '[]' '["a","b"]'
rc=0; run "$TMP/cand.json" || rc=$?; check "identical schema passes" "$rc"

mk "$TMP/cand.json" 201 '{"id":{"type":"integer"}}' '[]' '["a","b"]'
expect_fail "removed field" property-removed

mk "$TMP/cand.json" 201 '{"id":{"type":"string"},"name":{"type":"string"}}' '[]' '["a","b"]'
expect_fail "type change" type-changed

mk "$TMP/cand.json" 201 "$BASE_PROPS" '[]' '["a"]'
expect_fail "enum value removed" enum-value-removed

mk "$TMP/cand.json" 200 "$BASE_PROPS" '[]' '["a","b"]'
expect_fail "status code changed" status-removed

mk "$TMP/cand.json" 201 "$BASE_PROPS" '["name"]' '["a","b"]'
expect_fail "optional -> required request field" became-required

# Additive shapes must pass: new response/request field, new enum value, vendor marker.
mk "$TMP/cand.json" 201 '{"id":{"type":"integer"},"name":{"type":"string"},"extra":{"type":"string"}}' '[]' '["a","b","c"]'
rc=0; run "$TMP/cand.json" || rc=$?; check "additive field + enum value passes" "$rc"
python3 - "$TMP/cand.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["components"]["schemas"]["Widget"]["properties"]["kind"]["x-extensible-enum"] = True
json.dump(d, open(sys.argv[1], "w"))
PY
rc=0; run "$TMP/cand.json" || rc=$?; check "x-extensible-enum marker alone passes" "$rc"

# Endpoint removal.
python3 - "$TMP/cand.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["paths"] = {}
json.dump(d, open(sys.argv[1], "w"))
PY
expect_fail "endpoint removed" endpoint-removed

# Allowlist: an entry citing a real stability.md heading suppresses; a bogus anchor fails.
mk "$TMP/cand.json" 201 '{"id":{"type":"integer"}}' '[]' '["a","b"]'
cat >"$TMP/stab.md" <<'MD'
## Current deprecations

### Widget name removed (#1)
MD
echo 'property-removed | response #/Widget.name | widget-name-removed-1 | test' >"$TMP/ok.txt"
echo 'property-removed | * | no-such-heading | test' >"$TMP/bad.txt"
printf 'property-removed | request #/Req.name | widget-name-removed-1 | test\n' >>"$TMP/ok.txt"
rc=0; python3 "$GATE" --candidate "$TMP/cand.json" --baseline-file "$TMP/base.json" \
  --allowlist "$TMP/ok.txt" --stability "$TMP/stab.md" >"$TMP/out" 2>&1 || rc=$?
check "allowlist entry citing an existing row suppresses" "$rc"
rc=0; python3 "$GATE" --candidate "$TMP/cand.json" --baseline-file "$TMP/base.json" \
  --allowlist "$TMP/bad.txt" --stability "$TMP/stab.md" >"$TMP/out" 2>&1 || rc=$?
[[ $rc -eq 1 ]] && grep -q "no-such-heading" "$TMP/out"; check "allowlist entry citing a missing row fails" $?

# Tag resolution: prereleases count, a release outranks its prereleases, mcp-/scheduler- ignored.
python3 - "$REPO_ROOT/scripts" <<'PY'
import sys, importlib.util
spec = importlib.util.spec_from_file_location("g", sys.argv[1] + "/check-schema-breaking.py")
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
t = g.latest_release_tag
assert t(["v0.4.0-beta.9", "v0.4.0-beta.10", "v0.3.9", "mcp-v9.0.0", "scheduler-v9.9.9"]) == "v0.4.0-beta.10"
assert t(["v0.4.0", "v0.4.0-rc.1", "v0.4.0-beta.9"]) == "v0.4.0"
assert t(["mcp-v1.0.0"]) is None
PY
check "latest tag resolution" $?

echo "check-schema-breaking: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
