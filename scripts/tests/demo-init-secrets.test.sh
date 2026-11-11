#!/usr/bin/env bash
# Unit test for scripts/demo-init-secrets.sh (#4946): the demo compose stack's
# first-boot secret generator. Proves the properties the fix depends on —
# generated, per-install-unique, stable across restarts, 0600, never logged,
# and acceptable to settings/prod.py's validate_secret_key.
#
# Run: bash scripts/tests/demo-init-secrets.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$REPO_ROOT/scripts/demo-init-secrets.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() {
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}
run() { # run <dir> [VAR=val ...]
  local dir="$1"; shift
  env -u SECRET_KEY -u INTEGRATION_ENCRYPTION_KEY SECRETS_DIR="$dir" SECRETS_OWNER= "$@" sh "$GEN"
}
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

A="$TMP/a"; B="$TMP/b"
out_a="$(run "$A")"
key_a="$(cat "$A/secret_key")"
fernet_a="$(cat "$A/integration_encryption_key")"

# First boot generates both secrets.
[[ -n "$key_a" && -n "$fernet_a" ]]; check "first boot generates both secrets" $?

# Idempotent: second run keeps the stored values.
run "$A" >/dev/null
[[ "$(cat "$A/secret_key")" == "$key_a" && "$(cat "$A/integration_encryption_key")" == "$fernet_a" ]]
check "second run reuses stored secrets" $?

# Two installs differ.
run "$B" >/dev/null
[[ "$(cat "$B/secret_key")" != "$key_a" && "$(cat "$B/integration_encryption_key")" != "$fernet_a" ]]
check "two installs get different secrets" $?

# SECRET_KEY shape: >=50 chars, no django-insecure- prefix, not the old baked value.
[[ ${#key_a} -ge 50 && "$key_a" != django-insecure-* && "$key_a" != trueppm-public-demo* ]]
check "SECRET_KEY long enough, no insecure prefix" $?
[[ "$key_a" =~ ^[A-Za-z0-9_-]+$ ]]; check "SECRET_KEY is URL-safe" $?

# Fernet key: 44 chars, decodes to exactly 32 bytes.
n="$(printf '%s' "$fernet_a" | tr '_-' '/+' | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
[[ ${#fernet_a} -eq 44 && "$n" -eq 32 ]]; check "Fernet key is 32 bytes urlsafe base64" $?

# Permissions: 0600 files, 0700 dir.
ok=0
for f in secret_key integration_encryption_key env; do [[ "$(mode "$A/$f")" == 600 ]] || ok=1; done
[[ "$(mode "$A")" == 700 ]] || ok=1
check "files are 0600 and the directory is 0700" $ok

# Never logged.
[[ "$out_a" != *"$key_a"* && "$out_a" != *"$fernet_a"* ]]; check "values are not printed" $?

# The sourced env file exports exactly the stored values.
got="$(sh -c ". '$A/env'; printf '%s|%s' \"\$SECRET_KEY\" \"\$INTEGRATION_ENCRYPTION_KEY\"")"
[[ "$got" == "$key_a|$fernet_a" ]]; check "env file exports the stored values" $?

# Operator override wins over a stored value and is persisted.
override="$(printf "%s" ovr ovr ovr ovr ovr ovr ovr ovr ovr ovr ovr)"
run "$A" "SECRET_KEY=$override" >/dev/null
[[ "$(cat "$A/secret_key")" == "$override" ]]
check "operator-supplied SECRET_KEY overrides" $?

# A value with a single quote is refused (it would inject into the sourced env file).
rc=0; run "$B" "SECRET_KEY=a'b" >/dev/null 2>&1 || rc=$?
[[ "$rc" -ne 0 && "$(cat "$B/secret_key")" != "a'b" ]]; check "override containing a quote is rejected" $?

echo "demo-init-secrets: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
