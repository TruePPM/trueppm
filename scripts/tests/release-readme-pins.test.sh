#!/usr/bin/env bash
# scripts/tests/release-readme-pins.test.sh
#
# Guards the README version-pin bump in scripts/release.sh. The release script
# bumped every manifest but never the `trueppm-scheduler==X` pin in the package
# READMEs, so the 0.4.0-beta.4 release commit reddened scheduler:test on main and
# the tags could not be pushed. scripts/bump-readme-pins.sh is the fix; this
# checks it rewrites pins, leaves historical prose alone, fails loudly on a pin it
# could not move, and that release.sh actually calls and stages it.
#
# Run: bash scripts/tests/release-readme-pins.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUMP="$REPO_ROOT/scripts/bump-readme-pins.sh"
RELEASE_SH="$REPO_ROOT/scripts/release.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <exit-code>
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

mkfixture() { # mkfixture <dir>
  local d="$1"
  mkdir -p "$d/packages/scheduler" "$d/packages/api" "$d/packages/mcp"
  cat >"$d/packages/scheduler/README.md" <<'EOF'
Pin an exact version:

```
trueppm-scheduler==0.4.0b3
```
EOF
  cat >"$d/packages/api/README.md" <<'EOF'
dependencies = [
    "trueppm-api==0.4.0b3",
]
pip install "trueppm-api[c]==0.4.0b3"
`0.4.0b3` on PyPI corresponds to git tag `v0.4.0-beta.3` in the monorepo.
versions through `0.4.0-beta.3` predate attestation.
EOF
  cat >"$d/packages/mcp/README.md" <<'EOF'
Run it with uvx trueppm-mcp. No version pin here.
EOF
}

run_bump() { REPO_ROOT="$1" bash "$BUMP" 0.4.0b3 0.4.0b4 0.4.0-beta.3 0.4.0-beta.4; }

echo "Case 1: pins and the tag mapping move to the new version"
F1="$TMP/f1"; mkfixture "$F1"
run_bump "$F1" >/dev/null; rc=$?
check "bump exits 0" "$rc"
grep -q '^trueppm-scheduler==0.4.0b4$' "$F1/packages/scheduler/README.md"; check "scheduler pin bumped" $?
grep -q '"trueppm-api==0.4.0b4",' "$F1/packages/api/README.md"; check "api dependency pin bumped" $?
grep -q 'trueppm-api\[c\]==0.4.0b4' "$F1/packages/api/README.md"; check "api extras pin bumped" $?
grep -q '`0.4.0b4` on PyPI corresponds to git tag `v0.4.0-beta.4`' "$F1/packages/api/README.md"; check "tag mapping bumped" $?

echo "Case 2: historical prose that names the old version is untouched"
grep -q 'versions through `0.4.0-beta.3` predate attestation' "$F1/packages/api/README.md"; check "'through beta.3' prose kept" $?
! grep -q '0.4.0b3' "$F1/packages/scheduler/README.md"; check "no old pin left in scheduler README" $?

echo "Case 3: a second run is a no-op (idempotent)"
before="$(cat "$F1"/packages/*/README.md)"
run_bump "$F1" >/dev/null; rc=$?
check "second run exits 0" "$rc"
[[ "$before" == "$(cat "$F1"/packages/*/README.md)" ]]; check "second run changes nothing" $?

echo "Case 4: a pin in a shape it cannot move fails loudly"
F4="$TMP/f4"; mkfixture "$F4"
printf 'Install:\n\ntrueppm-scheduler==0.4.0b3\ntrueppm-api==0.4.0b1\n' >"$F4/packages/scheduler/README.md"
run_bump "$F4" >/dev/null 2>"$TMP/f4.err"; rc=$?
[[ "$rc" -ne 0 ]]; check "drifted pin (b1) makes the bump exit non-zero" $?
grep -q "still pins 'trueppm-api==0.4.0b1'" "$TMP/f4.err"; check "error names the stale pin" $?

echo "Case 5: the scheduler README must carry a pin at all"
F5="$TMP/f5"; mkfixture "$F5"
printf 'No install line at all.\n' >"$F5/packages/scheduler/README.md"
run_bump "$F5" >/dev/null 2>"$TMP/f5.err"; rc=$?
[[ "$rc" -ne 0 ]]; check "missing scheduler pin is an error, not a no-op" $?

echo "Case 6: release.sh calls the script and stages the READMEs"
grep -q 'bash scripts/bump-readme-pins.sh' "$RELEASE_SH"; check "release.sh runs bump-readme-pins.sh" $?
ADD_BLOCK="$(awk '/^git add \\$/{i=1} i{print} i&&!/\\$/{exit}' "$RELEASE_SH")"
for f in packages/scheduler/README.md packages/api/README.md packages/mcp/README.md; do
  grep -qF "$f" <<<"$ADD_BLOCK"; check "release commit stages $f" $?
done

echo "Case 7: the real READMEs are in the shape the script expects"
REAL_PIN="$(grep -cE '^trueppm-scheduler==[0-9]' "$REPO_ROOT/packages/scheduler/README.md" || true)"
[[ "$REAL_PIN" -ge 1 ]]; check "packages/scheduler/README.md carries a pin line" $?

echo "release-readme-pins: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
