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

# --- differ cases: (name, mutator, expected rule, expected direction or "") ----------
# Request and response shapes live in SEPARATE components (Req / Widget), so disabling
# one direction's rule turns exactly that direction's cases red.
python3 - "$GATE" <<'PY'
import copy, importlib.util, sys

spec = importlib.util.spec_from_file_location("g", sys.argv[1])
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

def shape():
    props = {
        "name": {"type": "string"},
        "kind": {"type": "string", "enum": ["a", "b"]},
        "nested": {"type": "object", "properties": {"deep": {"type": "integer"}}},
        "rows": {"type": "array", "items": {"type": "object", "properties": {"x": {"type": "integer"}}}},
        "merged": {"allOf": [{"$ref": "#/components/schemas/Mixin"}]},
    }
    d = {"type": "object", "properties": props, "required": ["name"]}
    return d

BASE = {
    "openapi": "3.0.3",
    "paths": {"/w/": {"post": {
        "parameters": [{"name": "q", "in": "query", "schema": {"type": "string"}}],
        "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Req"}}}},
        "responses": {
            "201": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Widget"}}}},
            "400": {"description": "x", "content": {"application/json": {"schema": {"type": "object"}}}},
        }}}},
    "components": {"schemas": {
        "Req": shape(), "Widget": shape(),
        "Mixin": {"type": "object", "properties": {"m": {"type": "string"}}},
    }},
}
OP = lambda d: d["paths"]["/w/"]["post"]
S = lambda d, n: d["components"]["schemas"][n]

def drop(n, *path):
    def m(d):
        o = S(d, n)
        for k in path[:-1]: o = o[k]
        del o[path[-1]]
    return m
def setv(n, path, v):
    def m(d):
        o = S(d, n)
        for k in path[:-1]: o = o[k]
        o[path[-1]] = v
    return m
def both(*ms):
    return lambda d: [f(d) for f in ms]

NESTED = ("properties", "nested", "properties", "deep")
ROWS = ("properties", "rows", "items", "properties", "x")
CASES = [
    # (name, mutator, rule, direction)
    ("req field removed", drop("Req", "properties", "name"), "property-removed", "request"),
    ("resp field removed", drop("Widget", "properties", "name"), "property-removed", "response"),
    ("req type", setv("Req", ("properties", "name", "type"), "integer"), "type-changed", "request"),
    ("resp type", setv("Widget", ("properties", "name", "type"), "integer"), "type-changed", "response"),
    ("req enum value removed", setv("Req", ("properties", "kind", "enum"), ["a"]), "enum-value-removed", "request"),
    ("resp enum value removed", setv("Widget", ("properties", "kind", "enum"), ["a"]), "enum-value-removed", "response"),
    ("nested req prop removed", drop("Req", *NESTED), "property-removed", "request"),
    ("nested resp type", setv("Widget", NESTED[:-1] + ("deep", "type"), "string"), "type-changed", "response"),
    ("array items req removed", drop("Req", *ROWS), "property-removed", "request"),
    ("array items resp type", setv("Widget", ROWS[:-1] + ("x", "type"), "string"), "type-changed", "response"),
    ("allOf member prop removed (resp)", drop("Mixin", "properties", "m"), "property-removed", ""),
    ("req optional->required", setv("Req", ("required",), ["name", "kind"]), "became-required", "request"),
    ("resp required->optional", setv("Widget", ("required",), []), "became-optional", "response"),
    ("body optional->required", lambda d: OP(d)["requestBody"].__setitem__("required", True), "body-required", ""),
    ("status removed", lambda d: OP(d)["responses"].__delitem__("201"), "status-removed", ""),
    ("media type removed", lambda d: OP(d)["responses"]["400"].__setitem__("content", {}), "media-type-removed", ""),
    ("param removed", lambda d: OP(d).__setitem__("parameters", []), "param-removed", ""),
    ("param became required", lambda d: OP(d)["parameters"][0].__setitem__("required", True), "param-required", ""),
    ("new required param", lambda d: OP(d)["parameters"].append({"name": "z", "in": "query", "required": True, "schema": {"type": "string"}}), "param-required", ""),
    ("endpoint removed", lambda d: d["paths"].clear(), "endpoint-removed", ""),
]
# Passing shapes: additive changes, and relaxations that are not Breaking.
PASSES = [
    ("added req field", lambda d: S(d, "Req")["properties"].__setitem__("extra", {"type": "string"})),
    ("added resp field", lambda d: S(d, "Widget")["properties"].__setitem__("extra", {"type": "string"})),
    ("added enum value (both)", both(setv("Req", ("properties", "kind", "enum"), ["a", "b", "c"]), setv("Widget", ("properties", "kind", "enum"), ["a", "b", "c"]))),
    ("vendor marker", lambda d: S(d, "Widget")["properties"]["kind"].__setitem__("x-extensible-enum", True)),
    ("req required->optional", setv("Req", ("required",), [])),
    ("resp optional->required", setv("Widget", ("required",), ["name", "kind"])),
    ("added optional param", lambda d: OP(d)["parameters"].append({"name": "z", "in": "query", "schema": {"type": "string"}})),
    ("added status", lambda d: OP(d)["responses"].__setitem__("202", {"description": "ok"})),
]

failed = 0
def check(ok, desc):
    global failed
    if not ok:
        print("  FAIL:", desc); failed += 1

check(g.diff_schemas(BASE, copy.deepcopy(BASE)) == [], "identical schema passes")
for name, mut, rule, direction in CASES:
    cand = copy.deepcopy(BASE); mut(cand)
    found = g.diff_schemas(BASE, cand)
    hit = [f for f in found if f[0] == rule and (not direction or f[1].startswith(direction))]
    check(bool(hit), f"{name} -> {rule} {direction} (got {found})")
    # the OTHER direction's rule must not be what fired (separation of the fixtures)
    if direction:
        other = "response" if direction == "request" else "request"
        check(not any(f[1].startswith(other) for f in found), f"{name} leaked into {other}")
for name, mut in PASSES:
    cand = copy.deepcopy(BASE); mut(cand)
    check(g.diff_schemas(BASE, cand) == [], f"{name} passes (got {g.diff_schemas(BASE, cand)})")
print(f"differ cases: {len(CASES)} breaking + {len(PASSES)} passing, {failed} failed")
sys.exit(1 if failed else 0)
PY
check "differ cases (see output above)" $?

# --- CLI: exit codes, allowlist, anchors ---------------------------------------------
python3 - "$TMP" <<'PY'
import json, sys
t = sys.argv[1]
base = {"openapi": "3.0.3", "paths": {}, "components": {"schemas": {
    "Widget": {"type": "object", "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}}}}}
base["paths"]["/w/"] = {"get": {"responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Widget"}}}}}}}
cand = json.loads(json.dumps(base)); del cand["components"]["schemas"]["Widget"]["properties"]["name"]
json.dump(base, open(f"{t}/base.json", "w")); json.dump(cand, open(f"{t}/cand.json", "w"))
PY
rc=0; python3 "$GATE" --candidate "$TMP/base.json" --baseline-file "$TMP/base.json" --allowlist "$TMP/none.txt" >"$TMP/out" 2>&1 || rc=$?
check "CLI: identical schema exits 0" "$rc"
rc=0; python3 "$GATE" --candidate "$TMP/cand.json" --baseline-file "$TMP/base.json" --allowlist "$TMP/none.txt" >"$TMP/out" 2>&1 || rc=$?
[[ $rc -eq 1 ]] && grep -q property-removed "$TMP/out"; check "CLI: breaking change exits 1" $?

# Allowlist: an entry citing a real stability.md heading suppresses; a bogus anchor fails.
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
