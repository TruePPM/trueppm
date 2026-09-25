#!/usr/bin/env bash
# scripts/tests/release-unpublished.test.sh — the published-version guard (#4061).
# It must refuse on a remote tag, refuse on a PyPI 200, and FAIL CLOSED when it
# cannot read either; a guard that treats "cannot see" as "absent" is the bug.
# Run: bash scripts/tests/release-unpublished.test.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/release-unpublished-guard.sh"
RELEASE_SH="$REPO_ROOT/scripts/release.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [[ "$2" -eq 0 ]]; then :; else echo "  FAIL: $1"; fail=$((fail + 1)); fi; }

# Stubs. Each takes its arg and reads a behavior from an env var.
cat >"$TMP/lsr" <<'S'
#!/usr/bin/env bash
[[ "${LSR_FAIL:-}" == 1 ]] && exit 128
if [[ -n "${LSR_HAS:-}" && "$1" == "refs/tags/${LSR_HAS}" ]]; then
  printf 'fa65c19aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t%s\n' "$1"
fi
exit 0
S
cat >"$TMP/pypi" <<'S'
#!/usr/bin/env bash
[[ "${PYPI_FAIL:-}" == 1 ]] && exit 6
if [[ -n "${PYPI_HIT:-}" && "$1" == *"/${PYPI_HIT}/"* ]]; then echo "${PYPI_HIT_CODE:-200}"; else echo "${PYPI_DEFAULT:-404}"; fi
S
chmod +x "$TMP/lsr" "$TMP/pypi"

run() { # run <envassign...> ; returns guard exit code
  env RELEASE_LS_REMOTE_CMD="$TMP/lsr" RELEASE_PYPI_PROBE_CMD="$TMP/pypi" "$@" \
    bash "$GUARD" 0.4.0-beta.2 >"$TMP/out" 2>&1 && return 0 || return $?
}
expect() { # expect <desc> <want-rc> <grep> <env...>
  local desc="$1" want="$2" pat="$3"; shift 3
  local rc=0; run "$@" || rc=$?
  [[ "$rc" -eq "$want" ]]; check "$desc (rc=$rc, want $want)" $?
  [[ -z "$pat" ]] || { grep -q -- "$pat" "$TMP/out"; check "$desc: output names '$pat'" $?; }
}

expect "clean state passes" 0 "unpublished"
expect "origin has v<semver> -> refuse, naming its commit" 1 "fa65c19" LSR_HAS=v0.4.0-beta.2
expect "origin has scheduler tag -> refuse" 1 "scheduler-v0.4.0b2" LSR_HAS=scheduler-v0.4.0b2
expect "origin has mcp tag -> refuse" 1 "mcp-v0.4.0b2" LSR_HAS=mcp-v0.4.0b2
expect "ls-remote failure fails CLOSED (2), not absent" 2 "could not read origin" LSR_FAIL=1
expect "PyPI 200 for the PEP 440 version -> refuse" 1 "already exists on PyPI" PYPI_HIT=0.4.0b2
expect "PyPI 200 on trueppm-api alone -> refuse" 1 "trueppm-api" PYPI_HIT=0.4.0b2
expect "PyPI unreachable fails CLOSED (2)" 2 "could not reach PyPI" PYPI_FAIL=1
expect "PyPI 503 fails CLOSED (2)" 2 "unexpected HTTP 503" PYPI_DEFAULT=503
expect "skip switch is honored and loud" 0 "Skipping" RELEASE_SKIP_REMOTE_CHECK=1 LSR_FAIL=1

# Structural: release.sh calls the guard before touching any manifest.
g="$(grep -n -m1 'release-unpublished-guard.sh' "$RELEASE_SH" | cut -d: -f1)"
b="$(grep -n -m1 '^bump_manifest ' "$RELEASE_SH" | cut -d: -f1)"
[[ -n "$g" && -n "$b" && "$g" -lt "$b" ]]; check "release.sh runs the guard (line ${g:-?}) before the first bump (${b:-?})" $?
# shellcheck disable=SC2016  # literal match of release.sh source
grep -q 'grep -qxF "\$TAG" <<<"\$(git tag)"' "$RELEASE_SH"; check "release.sh keeps the local-tag check" $?

if [[ "$fail" -ne 0 ]]; then echo "release-unpublished: $fail FAILED"; exit 1; fi
echo "release-unpublished: all checks passed"
