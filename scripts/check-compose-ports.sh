#!/usr/bin/env bash
# scripts/check-compose-ports.sh — every `ports:` entry in the dev compose file
# binds loopback or the TRUEPPM_DEV_BIND_ADDR knob (#4648).
#
# docker-compose.yml runs settings.dev (DEBUG, AllowAny, public SECRET_KEY). A
# bare "8000:8000" publishes on 0.0.0.0, and Docker-published ports bypass most
# host firewalls. #3189 fixed db/mailpit per service; api/web were missed. This
# gate applies the rule to the whole file. docker-compose.demo.yml's public
# read-only `80:80` is intentionally out of scope (only docker-compose.yml is
# scanned), exempt by name.
#
# Text scan, not a YAML parse; portable to BusyBox (no grep --include).
# Usage:  scripts/check-compose-ports.sh [--self-test]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Print offending `- "<mapping>"` lines inside any `ports:` block of $1.
scan() {
  awk '
    /^[[:space:]]*ports:[[:space:]]*$/ { inports=1; match($0,/^[[:space:]]*/); ind=RLENGTH; next }
    inports {
      if ($0 ~ /^[[:space:]]*#/ || $0 ~ /^[[:space:]]*$/) next
      match($0,/^[[:space:]]*/)
      if ($0 !~ /^[[:space:]]*-/ || RLENGTH <= ind) { inports=0; next }
      line=$0; sub(/[[:space:]]+#.*$/,"",line); sub(/^[[:space:]]*-[[:space:]]*/,"",line); gsub(/["\047]/,"",line)
      if (line !~ /^127\.0\.0\.1:/ && line !~ /^\[::1\]:/ && line !~ /^\$\{TRUEPPM_DEV_BIND_ADDR/) print NR": "line
    }
  ' "$1"
}

run_check() {
  local f="$1" bad
  [[ -f "$f" ]] || { echo "ERROR: $f not found" >&2; return 1; }
  grep -q 'ports:' "$f" || { echo "ERROR: no ports: in $f - the gate scanned nothing" >&2; return 1; }
  bad="$(scan "$f")"
  if [[ -n "$bad" ]]; then
    printf '  %s publishes on all interfaces:\n%s\n' "$(basename "$f")" "$bad" | sed 's/^\([0-9]\)/    line \1/'
    return 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  cp "$REPO_ROOT/docker-compose.yml" "$tmp/c.yml"
  run_check "$tmp/c.yml" >/dev/null 2>&1 || { echo "SELF-TEST FAILED: clean file should pass" >&2; exit 1; }
  sed 's|"\${TRUEPPM_DEV_BIND_ADDR:-127.0.0.1}:8000:8000"|"8000:8000"|' "$tmp/c.yml" >"$tmp/bad1.yml"
  run_check "$tmp/bad1.yml" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: planted \"8000:8000\" not caught" >&2; exit 1; }
  sed 's|"127.0.0.1:5432:5432"|"0.0.0.0:5432:5432"|' "$tmp/c.yml" >"$tmp/bad2.yml"
  run_check "$tmp/bad2.yml" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: planted 0.0.0.0 bind not caught" >&2; exit 1; }
  echo "self-test OK: catches a bare mapping and an explicit 0.0.0.0 bind."
  exit 0
fi

echo "compose ports — docker-compose.yml publishes loopback only"
if run_check "$REPO_ROOT/docker-compose.yml"; then
  echo "OK: every published port is loopback or TRUEPPM_DEV_BIND_ADDR."
else
  echo "FAIL: bind to 127.0.0.1 or \${TRUEPPM_DEV_BIND_ADDR:-127.0.0.1}. The dev stack runs DEBUG + AllowAny (#4648)." >&2
  exit 1
fi
