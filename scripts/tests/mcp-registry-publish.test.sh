#!/usr/bin/env bash
# scripts/tests/mcp-registry-publish.test.sh
#
# Unit test for scripts/mcp-registry-publish.sh, the step that lists
# trueppm-mcp on the official MCP registry from the mcp-v* tag pipeline (#4682).
# That job runs only on a tag, so this is the only place its decisions run
# before one: skip an already-listed version, refuse to guess on an unreadable
# registry, wait for PyPI's README marker, and fail closed without the key.
# `curl` and `mcp-publisher` are stubs; the registry's listing is a state file
# the stub publisher writes, so a publish is observable as a later 200.
#
# Run: bash scripts/tests/mcp-registry-publish.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/mcp-registry-publish.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

cat > "$TMP/server.json" <<'EOF'
{"name": "com.trueppm/mcp-server", "version": "0.5.0-alpha.1",
 "packages": [{"registryType": "pypi", "identifier": "trueppm-mcp", "version": "0.5.0a1"}]}
EOF

mkdir -p "$TMP/bin"
# curl stub: honors -o and -w '%{http_code}', answers from $STATE.
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
out=/dev/null; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */v0/servers/*)
    if [[ -f "$STATE/listed" ]]; then code=200; else code="$(cat "$STATE/registry_code")"; fi
    echo '{}' > "$out" ;;
  */pypi/*)
    code="$(cat "$STATE/pypi_code")"
    jq -n --arg d "$(cat "$STATE/pypi_desc")" '{info: {description: $d}}' > "$out" ;;
  *) code=000 ;;
esac
printf '%s' "$code"
[[ "$code" != 000 ]]
EOF
# mcp-publisher stub: logs each call; `publish` makes the version listed.
cat > "$TMP/bin/mcp-publisher" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STATE/calls"
if [[ "$1" == publish ]]; then touch "$STATE/listed"; fi
EOF
chmod +x "$TMP/bin/curl" "$TMP/bin/mcp-publisher"

# scenario <registry_code> <pypi_code> <pypi_desc> -> fresh $STATE
scenario() {
  STATE="$(mktemp -d "$TMP/state.XXXX")"
  printf '%s' "$1" > "$STATE/registry_code"
  printf '%s' "$2" > "$STATE/pypi_code"
  printf '%s' "$3" > "$STATE/pypi_desc"
  : > "$STATE/calls"
}

# run <key> -> $OUT, $RC (never aborts under set -e)
run() {
  set +e
  OUT="$(PATH="$TMP/bin:$PATH" STATE="$STATE" MCP_PUBLISHER="$TMP/bin/mcp-publisher" \
    MCP_REGISTRY_PRIVATE_KEY="$1" PYPI_WAIT_SECONDS=0 POLL_SECONDS=0 \
    bash "$SCRIPT" publish "$TMP/server.json" 2>&1)"
  RC=$?
  set -e
}

MARKER='<!-- mcp-name: com.trueppm/mcp-server -->'

# 1. Happy path: not listed, PyPI live with marker -> login, validate, publish, verified.
scenario 404 200 "$MARKER"
run deadbeef
check "happy path exits 0 (got $RC: $OUT)" "$([[ $RC -eq 0 ]]; echo $?)"
check "logs in by DNS for trueppm.com" "$(grep -q '^login dns --domain trueppm.com --private-key deadbeef$' "$STATE/calls"; echo $?)"
check "publishes the manifest" "$(grep -q '^publish ' "$STATE/calls"; echo $?)"
check "validates before publishing" "$(awk '/^validate/{v=NR} /^publish/{p=NR} END{exit !(v && p && v < p)}' "$STATE/calls"; echo $?)"

# 2. Already listed -> exit 0 without calling the publisher (idempotent retry).
scenario 200 200 "$MARKER"
run deadbeef
check "already-listed exits 0" "$([[ $RC -eq 0 ]]; echo $?)"
check "already-listed never calls mcp-publisher" "$([[ ! -s "$STATE/calls" ]]; echo $?)"

# 3. Registry unreadable -> fail closed, no publish.
scenario 503 200 "$MARKER"
run deadbeef
check "registry 503 fails" "$([[ $RC -ne 0 ]]; echo $?)"
check "registry 503 names the status" "$(grep -q 'HTTP 503' <<<"$OUT"; echo $?)"
check "registry 503 never publishes" "$([[ ! -s "$STATE/calls" ]]; echo $?)"

# 4. PyPI live but README lacks the marker -> fail, no publish.
scenario 404 200 "no marker here"
run deadbeef
check "missing marker fails" "$([[ $RC -ne 0 ]]; echo $?)"
check "missing marker is named" "$(grep -q "lacks 'mcp-name: com.trueppm/mcp-server'" <<<"$OUT"; echo $?)"
check "missing marker never publishes" "$([[ ! -s "$STATE/calls" ]]; echo $?)"

# 5. PyPI version not served yet -> fail after the wait, no publish.
scenario 404 404 ""
run deadbeef
check "PyPI 404 fails" "$([[ $RC -ne 0 ]]; echo $?)"
check "PyPI 404 is named" "$(grep -q 'trueppm-mcp 0.5.0a1 returned HTTP 404' <<<"$OUT"; echo $?)"

# 6. No key -> fail closed naming the variable, after the cheap checks.
scenario 404 200 "$MARKER"
run ""
check "missing key fails" "$([[ $RC -ne 0 ]]; echo $?)"
check "missing key names the variable" "$(grep -q 'MCP_REGISTRY_PRIVATE_KEY is not set' <<<"$OUT"; echo $?)"
check "missing key never calls mcp-publisher" "$([[ ! -s "$STATE/calls" ]]; echo $?)"

# 7. Bad mode -> usage error.
set +e
bash "$SCRIPT" bogus >/dev/null 2>&1
rc=$?
set -e
check "unknown mode exits 2" "$([[ $rc -eq 2 ]]; echo $?)"

echo "mcp-registry-publish: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
