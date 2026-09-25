#!/usr/bin/env bash
# Fail when packages/api/uv.lock resolves trueppm-scheduler to an older release
# LINE than the scheduler this tree ships (#4080).
#
# The API imports scheduler symbols (derive.Quantity, engine privates) that only
# exist in the scheduler it is tagged with. `uv lock --check` cannot see this: it
# proves the lock satisfies pyproject.toml, and a floor of >=0.1.0a0 let the lock
# sit at 0.2.0a1 - a locked install that cannot even import the app.
#
# Compared on (major, minor) only, not the pre-release segment. A release commit
# bumps the scheduler to a version that is not on PyPI yet, and the api lock cannot
# resolve it until it is published - which happens only after this pipeline is
# green (tag:wait-for-main). Comparing the full version would red main on every
# release. Pre-1.0 minors are where private symbols move, so the minor is the
# boundary that matters; the api's own `>=X,<0.(minor+1)` range holds the rest.
#
#   bash scripts/check-api-scheduler-lock.sh             # check the tree
#   bash scripts/check-api-scheduler-lock.sh --self-test # prove it can fail
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

line_of() { # "0.4.0b4" -> "0.4"
  printf '%s\n' "$1" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/'
}

check() {
  local root="$1" want have
  want="$(sed -nE 's/^version = "([^"]+)".*/\1/p' "$root/packages/scheduler/pyproject.toml" | sed -n 1p)"
  have="$(awk '/^name = "trueppm-scheduler"$/ {f=1; next} f && /^version = / {gsub(/[" ]|version=/, "", $0); sub(/^version=/, "", $0); print; exit}' \
    "$root/packages/api/uv.lock" | tr -d '"' | sed 's/^version *= *//')"
  if [ -z "$want" ] || [ -z "$have" ]; then
    echo "FAIL: could not read scheduler version ('$want') or api lock entry ('$have')" >&2
    return 1
  fi
  if [ "$(line_of "$want")" != "$(line_of "$have")" ] &&
     [ "$(printf '%s\n%s\n' "$(line_of "$have")" "$(line_of "$want")" | sort -V | sed -n 1p)" = "$(line_of "$have")" ]; then
    echo "FAIL: packages/api/uv.lock pins trueppm-scheduler $have but the tree ships $want." >&2
    echo "      Run: cd packages/api && uv lock --upgrade-package trueppm-scheduler" >&2
    return 1
  fi
  echo "OK: api lock trueppm-scheduler $have covers scheduler $want"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/packages/scheduler" "$tmp/packages/api"
  printf 'version = "0.4.0b4"\n' >"$tmp/packages/scheduler/pyproject.toml"
  mk() { printf '[[package]]\nname = "trueppm-scheduler"\nversion = "%s"\n' "$1" >"$tmp/packages/api/uv.lock"; }
  mk 0.2.0a1; check "$tmp" >/dev/null 2>&1 && { echo "self-test FAIL: 0.2.0a1 lock passed" >&2; exit 1; }
  mk 0.3.0a3; check "$tmp" >/dev/null 2>&1 && { echo "self-test FAIL: 0.3.0a3 lock passed" >&2; exit 1; }
  mk 0.4.0b3; check "$tmp" >/dev/null 2>&1 || { echo "self-test FAIL: same-line lock rejected" >&2; exit 1; }
  mk 0.4.0b4; check "$tmp" >/dev/null 2>&1 || { echo "self-test FAIL: exact lock rejected" >&2; exit 1; }
  echo "self-test OK"
  exit 0
fi
check "$REPO_ROOT"
