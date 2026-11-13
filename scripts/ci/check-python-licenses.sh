#!/usr/bin/env bash
# Allow-list license gate for the Python dependency closure (#4108).
#
# Replaces `pip-licenses --fail-on=<GPLv2;GPLv3;AGPLv3>`, a deny-list of three
# exact classifier strings: a BUSL, SSPL, Commons Clause, EUPL or other
# non-GPL copyleft license in a transitive dependency passed silently. The npm
# gates already use --onlyAllow; this makes the Python gates deny-by-default too.
#
# Usage:
#   scripts/ci/check-python-licenses.sh [pip-licenses-binary] [extra pip-licenses args...]
#   scripts/ci/check-python-licenses.sh --self-test [pip-licenses-binary]
#
# Strings are what pip-licenses prints: a mix of Trove classifier text
# ("MIT License", "BSD License") and SPDX identifiers ("MIT", "BSD-3-Clause"),
# depending on how each package declares itself. An SPDX *expression*
# ("Apache-2.0 OR BSD-3-Clause") is matched whole, so each one in the closure
# is listed; a ";"-joined multi-license string is split by pip-licenses itself. A new string failing here is the gate working: confirm the license
# is permissive and add the exact string; do not add a copyleft one.
#
# Per-package exceptions (weak copyleft, justified, NOT in the allow-list so a
# new package carrying the same license still fails):
#   psycopg, psycopg-binary, psycopg-c  LGPL-3.0-only  dynamically linked library use
#   certifi                             MPL-2.0        data file (CA bundle), file-level copyleft
#   hypothesis, hypothesis-jsonschema,  MPL-2.0        dev-only test dependencies, never shipped
#   pathspec

set -euo pipefail

ALLOWED="MIT;MIT-0;MIT License;BSD;BSD License;BSD-2-Clause;BSD-3-Clause;3-Clause BSD License;0BSD;\
Apache-2.0;Apache Software License;ISC;ISC License (ISCL);PSF-2.0;Python Software Foundation License;\
DFSG approved;Apache-2.0 OR BSD-2-Clause;Apache-2.0 OR BSD-3-Clause;BSD 3-Clause OR Apache-2.0;\
BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0"
IGNORED=(psycopg psycopg-binary psycopg-c certifi hypothesis hypothesis-jsonschema pathspec)

run() { # run <pip-licenses> [args...]
  local bin="$1"
  shift
  "$bin" --allow-only="$ALLOWED" --ignore-packages "${IGNORED[@]}" "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  bin="${2:-pip-licenses}"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fake() { # fake <name> <license>: a dist-info that pip-licenses discovers via PYTHONPATH
    mkdir -p "$tmp/$1-1.0.dist-info"
    printf 'Metadata-Version: 2.1\nName: %s\nVersion: 1.0\nLicense: %s\n' "$1" "$2" >"$tmp/$1-1.0.dist-info/METADATA"
  }
  fake fakecopyleft "SSPL-1.0"
  fake fakepermissive "MIT"
  fake certifi "MPL-2.0"
  if PYTHONPATH="$tmp" run "$bin" --packages fakecopyleft >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a package licensed SSPL-1.0 passed the allow-list." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an SSPL-licensed package is rejected."
  if ! PYTHONPATH="$tmp" run "$bin" --packages fakepermissive >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an MIT-licensed package was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an MIT-licensed package is accepted."
  if ! PYTHONPATH="$tmp" run "$bin" --packages certifi >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: the justified certifi (MPL-2.0) exception was not honored." >&2
    exit 1
  fi
  echo "SELF-TEST OK: the per-package certifi exception is honored."
  exit 0
fi

bin="${1:-pip-licenses}"
[ "$#" -gt 0 ] && shift
run "$bin" "$@"
