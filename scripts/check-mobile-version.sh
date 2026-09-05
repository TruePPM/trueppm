#!/usr/bin/env bash
# packages/mobile must stay at version 0.0.0 until it ships (#3367).
#
# The package is a scaffold: a navigation shell over placeholder screens, typed
# boundaries with nothing behind them, no native android/ or ios/ projects, and
# no test suite. It cannot be built, installed, or published. Any version string
# on it is a claim it cannot back.
#
# It read "0.4.0-beta.1" from 2026-07-18 to 2026-09-04 and every reader of the
# manifest took it for a beta artifact. `scripts/release.sh` was NOT the cause —
# packages/mobile has never been in its bump list. The cause was a hand-run
# manifest bump (913ec927d, "chore: bump main release version to 0.4.0-beta.1")
# that swept mobile in beside api and web because they sit next to each other.
#
# That is why this gate exists rather than a comment in release.sh: a comment
# lives in the file the defect did not come from, and cannot stop the next
# hand-run sweep. This runs on every push and every MR, so the sweep reds
# immediately instead of six weeks later.
#
# Both version fields in package-lock.json are checked too — `npm ci` reads the
# lock, and leaving it behind is the drift shape #2797 turned on the same class.
#
# WHEN MOBILE ACTUALLY SHIPS (native Android, roadmap 0.6, #1599): delete this
# gate and add packages/mobile/package.json to release.sh's bump_manifest list.
# Do not "fix" it by editing EXPECTED to the new version — the point is that a
# shipping package belongs on the release train, not on a pin.
#
# Modes:
#   bash scripts/check-mobile-version.sh             # check the tree
#   bash scripts/check-mobile-version.sh --self-test # prove the check can fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PKG="packages/mobile/package.json"
LOCK="packages/mobile/package-lock.json"
EXPECTED="0.0.0"

run_check() {
  local root="$1" fail=0

  _note() { echo "  VIOLATION: $1"; fail=1; }

  for f in "$PKG" "$LOCK"; do
    if [ ! -f "$root/$f" ]; then
      echo "ERROR: pinned file not found: $f" >&2
      echo "       If it moved, update the path list in $0 — do not delete the guard." >&2
      return 2
    fi
  done

  # package.json: the top-level "version".
  local pkg_v
  pkg_v="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1])).get('version', ''))
" "$root/$PKG")"

  if [ -z "$pkg_v" ]; then
    _note "$PKG declares no \"version\" (expected \"$EXPECTED\")"
  elif [ "$pkg_v" != "$EXPECTED" ]; then
    _note "$PKG is \"$pkg_v\", expected \"$EXPECTED\""
  fi

  # package-lock.json carries the same version TWICE — the top level and the
  # root package entry. npm ci reads the lock, so a half-updated pair is the
  # state that actually reaches an installer.
  local lock_top lock_root
  lock_top="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1])).get('version', ''))
" "$root/$LOCK")"
  lock_root="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1])).get('packages', {}).get('', {}).get('version', ''))
" "$root/$LOCK")"

  [ "$lock_top" = "$EXPECTED" ] \
    || _note "$LOCK top-level version is \"$lock_top\", expected \"$EXPECTED\""
  [ "$lock_root" = "$EXPECTED" ] \
    || _note "$LOCK packages[\"\"].version is \"$lock_root\", expected \"$EXPECTED\""

  # release.sh must not start bumping mobile. bump_manifest is the function that
  # rewrites a version in place; matching on it (rather than on any mention of
  # the package) keeps the deliberate explanatory comment there from self-failing.
  local release="scripts/release.sh"
  if [ -f "$root/$release" ] \
     && grep -qE '^[[:space:]]*bump_manifest[[:space:]]+packages/mobile/' "$root/$release"; then
    _note "$release now bumps packages/mobile — mobile is not on the release train (see #1599)"
  fi

  if [ "$fail" -ne 0 ]; then
    cat <<EOF

packages/mobile carries a version it cannot back.

It is a scaffold — no native projects, no test suite, nothing published — so a
release version on it tells every reader of the manifest that a shipping mobile
artifact exists. That is what #3367 was opened to undo.

If a hand-run version bump swept it in beside api/web, revert those four values:
  $PKG           -> "version": "$EXPECTED"
  $LOCK  -> both "version" fields

If mobile is genuinely shipping now, this gate is what should be deleted — along
with adding the manifest to release.sh's bump list. See packages/mobile/README.md.
EOF
    return 1
  fi

  echo "✅ packages/mobile pinned at $EXPECTED (manifest + both lockfile fields); release.sh does not bump it"
  return 0
}

# A gate observed only passing is indistinguishable from one with a broken
# pattern. These are the real failure shapes: the hand-run sweep that caused
# #3367, a half-updated lockfile, and release.sh growing the entry.
self_test() {
  local tmp status
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  mkdir -p "$tmp/packages/mobile" "$tmp/scripts"

  _fixture() {  # $1 = package.json version, $2 = lock top, $3 = lock root
    printf '{"name":"@trueppm/mobile","version":"%s"}\n' "$1" > "$tmp/$PKG"
    printf '{"name":"@trueppm/mobile","version":"%s","packages":{"":{"version":"%s"}}}\n' \
      "$2" "$3" > "$tmp/$LOCK"
    printf '#!/usr/bin/env bash\nbump_manifest packages/web/package.json\n' \
      > "$tmp/scripts/release.sh"
  }

  # Case 1: pinned everywhere. Must pass.
  _fixture "0.0.0" "0.0.0" "0.0.0"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a correctly pinned tree was reported as drifted (exit $status)" >&2
    return 1
  fi

  # Case 2: #3367 exactly — a hand-run bump swept all three fields.
  _fixture "0.4.0-beta.1" "0.4.0-beta.1" "0.4.0-beta.1"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a swept-in release version was not caught (exit $status)" >&2
    return 1
  fi

  # Case 3: manifest reverted, lockfile left behind. npm ci reads the lock, so
  # this half-fixed state must still fail.
  _fixture "0.0.0" "0.4.0-beta.1" "0.4.0-beta.1"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a stale lockfile version was not caught (exit $status)" >&2
    return 1
  fi

  # Case 4: only ONE of the lockfile's two version fields moved.
  _fixture "0.0.0" "0.0.0" "0.5.0"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a half-updated lockfile was not caught (exit $status)" >&2
    return 1
  fi

  # Case 5: release.sh grows the entry — the "for consistency" change.
  _fixture "0.0.0" "0.0.0" "0.0.0"
  printf '#!/usr/bin/env bash\nbump_manifest packages/mobile/package.json \\\n' \
    > "$tmp/scripts/release.sh"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: release.sh bumping mobile was not caught (exit $status)" >&2
    return 1
  fi

  # Case 6: release.sh merely NAMING packages/mobile in a comment (which it does
  # deliberately) must not fail — a gate that reds on its own explanation gets
  # disabled.
  _fixture "0.0.0" "0.0.0" "0.0.0"
  printf '#!/usr/bin/env bash\n# packages/mobile is deliberately absent from this list.\n' \
    > "$tmp/scripts/release.sh"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a comment naming packages/mobile was treated as a bump (exit $status)" >&2
    return 1
  fi

  # Case 7: a pinned file that has moved must error, not silently pass.
  _fixture "0.0.0" "0.0.0" "0.0.0"
  rm "$tmp/$LOCK"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 2 ]; then
    echo "SELF-TEST FAIL: a missing pinned file exited $status, expected 2" >&2
    return 1
  fi

  echo "SELF-TEST OK: a pinned tree and a comment-only release.sh pass; a swept-in version, a stale lockfile, a half-updated lockfile, a real bump_manifest entry, and a missing file are all caught."
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "$REPO_ROOT"
fi
