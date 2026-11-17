#!/usr/bin/env bash
# Staleness signal for the vendored Semgrep packs (#3103).
#
# security:semgrep runs offline against .semgrep/*.yml, so a pack that stops
# being refreshed fails nothing and reports clean: the gate is green *because*
# the rules stopped moving. This turns that silence into a signal.
#
#   age <= WARN_DAYS            exit 0
#   WARN_DAYS < age <= FAIL_DAYS exit 77  (job is allow_failure on 77: orange, not red)
#   age > FAIL_DAYS             exit 1
#
# The date comes from .semgrep/REFRESHED, which scripts/update-semgrep-rules.sh
# rewrites on every refresh. Not `git log`: CI clones are shallow, and file
# mtimes are the checkout time, so neither can say when the rules were fetched.
#
# Usage: scripts/check-semgrep-freshness.sh [--today YYYY-MM-DD]   |   --self-test
set -euo pipefail

WARN_DAYS="${SEMGREP_WARN_DAYS:-45}"
FAIL_DAYS="${SEMGREP_FAIL_DAYS:-90}"

to_days() { # YYYY-MM-DD -> days since epoch (GNU or BSD date)
  local s
  s=$(date -u -d "$1" +%s 2>/dev/null || date -u -j -f %Y-%m-%d "$1" +%s)
  echo $((s / 86400))
}

check() { # check <stamp-file> <today>
  local stamp="$1" today="$2" d
  [ -f "$stamp" ] || { echo "FAIL: $stamp missing — run scripts/update-semgrep-rules.sh" >&2; return 1; }
  d="$(tr -d '[:space:]' < "$stamp")"
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "FAIL: $stamp is not YYYY-MM-DD: '$d'" >&2; return 1; }
  local age=$(( $(to_days "$today") - $(to_days "$d") ))
  if [ "$age" -gt "$FAIL_DAYS" ]; then
    echo "FAIL: vendored Semgrep packs were refreshed $d ($age days ago, limit $FAIL_DAYS). Run scripts/update-semgrep-rules.sh and commit .semgrep/." >&2
    return 1
  fi
  if [ "$age" -gt "$WARN_DAYS" ]; then
    echo "WARN: vendored Semgrep packs were refreshed $d ($age days ago, warn at $WARN_DAYS, fail at $FAIL_DAYS). Run scripts/update-semgrep-rules.sh." >&2
    return 77
  fi
  echo "ok: vendored Semgrep packs refreshed $d ($age days ago)"
}

self_test() {
  local tmp rc
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo 2026-01-01 > "$tmp/s"
  expect() { # expect <want-rc> <today>
    rc=0; check "$tmp/s" "$2" >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq "$1" ] || { echo "self-test FAILED: today=$2 rc=$rc want=$1" >&2; exit 1; }
  }
  expect 0 2026-01-20
  expect 77 2026-03-01
  expect 1 2026-06-01
  rc=0; check "$tmp/missing" 2026-01-02 >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || { echo "self-test FAILED: missing stamp must fail" >&2; exit 1; }
  echo "semgrep-freshness self-test ok"
}

case "${1:-}" in
  --self-test) self_test ;;
  --today) check "$(dirname "$0")/../.semgrep/REFRESHED" "$2" ;;
  *) check "$(dirname "$0")/../.semgrep/REFRESHED" "$(date -u +%Y-%m-%d)" ;;
esac
