#!/usr/bin/env bash
# scripts/check-compose-ports.sh — every `ports:` entry in every tracked compose
# file binds loopback or the TRUEPPM_DEV_BIND_ADDR knob (#4648).
#
# docker-compose.yml runs settings.dev (DEBUG, AllowAny, public SECRET_KEY). A
# bare "8000:8000" publishes on 0.0.0.0, and Docker-published ports bypass most
# host firewalls. #3189 fixed db/mailpit per service; api/web were missed.
#
# EXEMPT BY NAME (intentionally public, no dev settings behind them):
#   docker-compose.demo.yml  80:80       public read-only demo
#   docker-compose.prod.yml  80:80 443:443  production TLS front door
#
# Line-oriented awk, not a YAML parse, so it FAILS CLOSED: a `ports:` form it
# cannot read (inline flow list, long-form mapping, anything unexpected) is a
# violation, never a pass. BusyBox-awk compatible; no grep --include.
# Usage:  scripts/check-compose-ports.sh [--self-test]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXEMPT_NAMES="docker-compose.demo.yml docker-compose.prod.yml"

# Print one message per offending line of $1.
scan() {
  awk '
    function indent(s) { match(s, /^[ \t]*/); return RLENGTH }
    function bad(msg) { print "line " NR ": " msg; n++ }
    {
      line = $0
      sub(/[ \t]+#.*$/, "", line)          # trailing comment
      if (line ~ /^[ \t]*#/ || line ~ /^[ \t]*$/) next
    }
    inblock {
      if (line ~ /^[ \t]*-/ && indent(line) >= kind) {   # same-indent dash is valid YAML
        e = line; sub(/^[ \t]*-[ \t]*/, "", e); gsub(/["\047]/, "", e)
        if (e ~ /^[A-Za-z_]+:/ || e ~ /^[{\[]/) { bad("long-form or flow ports entry cannot be verified: " e) }
        else if (e !~ /^127\.0\.0\.1:/ && e !~ /^\[::1\]:/ && e !~ /^\$\{TRUEPPM_DEV_BIND_ADDR(:-[^}]*)?\}:/) { bad("publishes on all interfaces: " e) }
        next
      }
      inblock = 0
    }
    line ~ /^[ \t]*ports:/ {
      rest = line; sub(/^[ \t]*ports:[ \t]*/, "", rest)
      sub(/^!(override|reset)[ \t]*/, "", rest)
      seen++
      if (rest == "") { inblock = 1; kind = indent(line); next }
      bad("ports: not a block list (" rest "), cannot be verified")
    }
    END { if (n == 0 && seen == 0) print "NOPORTS" }
  ' "$1"
}

run_check() {
  local f out rc=0
  for f in "$@"; do
    out="$(scan "$f")"
    [[ "$out" == "NOPORTS" ]] && out=""
    if [[ -n "$out" ]]; then
      printf '  %s\n' "$f"; printf '%s\n' "$out" | sed 's/^/    /'; rc=1
    fi
  done
  return $rc
}

tracked_files() {
  local root="$1" f
  find "$root" -type f \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o -name 'compose*.yml' \) \
    -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' | sort | while read -r f; do
    case " $EXEMPT_NAMES " in *" $(basename "$f") "*) continue ;; esac
    printf '%s\n' "$f"
  done
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  expect_fail() { # name, ports-snippet
    printf 'services:\n  a:\n    image: x\n%s\n' "$2" >"$tmp/t.yml"
    if run_check "$tmp/t.yml" >/dev/null 2>&1; then echo "SELF-TEST FAILED: not caught: $1" >&2; exit 1; fi
  }
  expect_pass() {
    printf 'services:\n  a:\n    image: x\n%s\n' "$2" >"$tmp/t.yml"
    if ! run_check "$tmp/t.yml" >/dev/null 2>&1; then echo "SELF-TEST FAILED: false positive: $1" >&2; exit 1; fi
  }
  expect_pass loopback $'    ports:\n      - "127.0.0.1:1:1"\n      - "${TRUEPPM_DEV_BIND_ADDR:-127.0.0.1}:2:2"\n      - "${TRUEPPM_DEV_BIND_ADDR}:3:3"'
  expect_pass same-indent-loopback $'    ports:\n    - "127.0.0.1:1:1"'
  expect_fail bare $'    ports:\n      - "8000:8000"'
  expect_fail bind-all $'    ports:\n      - "0.0.0.0:8000:8000"'
  expect_fail inline-list '    ports: ["8000:8000"]'
  expect_fail inline-empty-tag '    ports: !override ["8000:8000"]'
  expect_fail same-indent-dash $'    ports:\n    - "8000:8000"'
  expect_fail override-list $'    ports: !override\n      - "8000:8000"'
  expect_fail prefix-no-brace $'    ports:\n      - "${TRUEPPM_DEV_BIND_ADDR_X}:9:9"'
  expect_fail long-form $'    ports:\n      - target: 80\n        published: 80'
  expect_fail second-entry $'    ports:\n      - "127.0.0.1:1:1"\n      - "5432:5432"'
  echo "self-test OK: clean forms pass; bare, 0.0.0.0, inline, !override, same-indent, prefix and long-form are caught."
  exit 0
fi

files=()
while IFS= read -r f; do files+=("$f"); done < <(tracked_files "$REPO_ROOT")
if (( ${#files[@]} == 0 )); then echo "ERROR: no compose files found - the gate scanned nothing" >&2; exit 1; fi
echo "compose ports - ${#files[@]} compose file(s) must publish loopback only"
if run_check "${files[@]}"; then
  echo "OK: every published port is loopback or TRUEPPM_DEV_BIND_ADDR."
else
  echo "FAIL: bind to 127.0.0.1 or \${TRUEPPM_DEV_BIND_ADDR:-127.0.0.1} (#4648). Exempt by name only: $EXEMPT_NAMES." >&2
  exit 1
fi
