#!/usr/bin/env bash
# Fail if OSS source imports from the proprietary trueppm-enterprise package.
#
# The Apache 2.0 boundary's single non-negotiable rule — "the community edition
# NEVER imports from trueppm-enterprise; the dependency is one-way" — is stated
# in CLAUDE.md, CONTRIBUTING.md, five agent skills and ~30 ADRs, and until #2603
# was enforced by nothing. `boundary:check` guards the *issue tracker* half of
# the rule (no OSS issue describing enterprise scope) and never reads the source
# tree. This script is the source-tree half.
#
# Why it greps for imports and not for the string: the boundary permits — and
# the codebase relies on — prose that NAMES the enterprise package. Extension
# points document which enterprise module registers against them, and ADR
# references cite enterprise paths. Those are the contract being described, not
# a dependency being taken. So the patterns below match only the syntactic forms
# that create a real link:
#
#   Python   `import trueppm_enterprise…` / `from trueppm_enterprise… import …`
#            at line start (leading whitespace allowed)
#   Python   a quoted module path — importlib.import_module("trueppm_enterprise…"),
#            __import__("…"), or an INSTALLED_APPS / MIDDLEWARE string entry.
#            A settings entry is as binding as an import statement.
#   TS/TSX   `from '…trueppm-enterprise…'`, `import('…')`, `require('…')`
#   Manifest a dependency entry naming the package in pyproject.toml,
#            package.json, Cargo.toml, or requirements*.txt (#2859). This is a
#            HARDER violation than an import statement: it makes the proprietary
#            package a declared dependency of the Apache 2.0 distribution, so
#            `pip install` / `npm install` pulls it whether or not any line of
#            OSS code imports it. Manifests match none of the source globs
#            above, so the gate did not see them at all.
#
# Comment lines are stripped before matching, so `# trueppm_enterprise/audit/apps.py`
# in a docstring or an ADR pointer stays legal. Repo prose convention is to write
# the package name in ``double backticks`` rather than "quotes", which keeps the
# quoted-path pattern free of false positives.
#
# Exit codes:
#   0  no enterprise imports in OSS source
#   1  at least one import found (CI fails; see output)
#   2  invocation error

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  # This gate never detected anything. The CI image's BusyBox grep rejects
  # --include outright, the `|| true` below swallowed the option error, and an
  # empty result read as "no violations" -- so a real
  # `from trueppm_enterprise.portfolio import RollupService` passed, exit 0
  # (#3172). Installing GNU grep is the fix; this is the alarm. A base-image
  # bump, a slimmed package list, or an option rename that silently disarms the
  # filters again must red the pipeline instead of passing it.
  #
  # Every case runs the REAL script against a fixture root, so there is no
  # second copy of the patterns to drift.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_probe() { # <name> <expect-pass|expect-fail> <dir>
    if bash "$0" "$3" >/dev/null 2>&1; then
      if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
      else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi
    else
      if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
      else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi
    fi
  }

  d="$st_tmp/clean"; mkdir -p "$d/api/src"
  printf 'from trueppm_api.core import thing\n' > "$d/api/src/ok.py"
  st_probe "clean tree" expect-pass "$d"

  d="$st_tmp/py"; mkdir -p "$d/api/src"
  printf 'from trueppm_enterprise.portfolio import RollupService\n' > "$d/api/src/v.py"
  st_probe "python import" expect-fail "$d"

  d="$st_tmp/ts"; mkdir -p "$d/web/src"
  printf 'import { X } from "@trueppm/trueppm-enterprise";\n' > "$d/web/src/v.ts"
  st_probe "typescript import" expect-fail "$d"

  d="$st_tmp/manifest"; mkdir -p "$d/api"
  printf '[project]\ndependencies = ["trueppm-enterprise>=1.0"]\n' > "$d/api/pyproject.toml"
  st_probe "manifest dependency" expect-fail "$d"

  # The documented exemption has to hold too, or the gate becomes noisy enough
  # to get disabled -- which is how the protection is really lost.
  d="$st_tmp/prose"; mkdir -p "$d/api/src"
  printf '# See ``trueppm_enterprise`` for the proprietary half.\n' > "$d/api/src/doc.py"
  st_probe "package named in prose (double backticks)" expect-pass "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-packages}"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: '$ROOT' is not a directory. Run from the repository root." >&2
  exit 2
fi

# Python: an import statement at the head of a line, or any quoted module path.
PY_PATTERN='(^[[:space:]]*(from|import)[[:space:]]+trueppm_enterprise)|(["'"'"']trueppm_enterprise([."'"'"']|$))'
# TS/TSX/JS: a module specifier in an import / dynamic import / require.
TS_PATTERN='(from|import|require)[[:space:]]*\(?[[:space:]]*["'"'"'][^"'"'"']*trueppm[-_]enterprise'
# Dependency manifests: any mention of the package name. Unlike source, a manifest
# has no legitimate reason to name the proprietary package in prose, so the match
# is deliberately broad — a commented-out dependency line is still dropped by
# strip_comments below, which is the only exemption a manifest gets.
MANIFEST_PATTERN='trueppm[-_]enterprise'

# `|| true` on each grep: no match is exit 1, which `set -e` would treat as fatal.
py_hits=$(grep -rnE "$PY_PATTERN" "$ROOT" --include='*.py' 2>/dev/null || true)
ts_hits=$(grep -rnE "$TS_PATTERN" "$ROOT" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' 2>/dev/null || true)
manifest_hits=$(grep -rnE "$MANIFEST_PATTERN" "$ROOT" \
  --include='pyproject.toml' --include='package.json' --include='Cargo.toml' \
  --include='requirements*.txt' 2>/dev/null || true)

# Drop comment lines. grep -n output is `path:line:content`, so the comment
# marker is tested after the second colon — a path containing a `#` cannot
# masquerade as a comment.
strip_comments() {
  # shellcheck disable=SC2016  # the awk program is deliberately single-quoted
  awk -F: '{
    content = $0
    sub(/^[^:]*:[0-9]+:/, "", content)
    sub(/^[[:space:]]+/, "", content)
    if (content ~ /^(#|\/\/|\*|\/\*)/) next
    print $0
  }'
}

hits=$(printf '%s\n%s\n%s\n' "$py_hits" "$ts_hits" "$manifest_hits" \
  | grep -v '^$' | strip_comments || true)

if [ -n "$hits" ]; then
  echo ""
  echo "BOUNDARY VIOLATION: OSS depends on trueppm-enterprise:"
  echo ""
  echo "$hits" | sed 's/^/  /'
  cat <<'MSG'

The community edition must remain fully functional without the enterprise repo.
The dependency is one-way: enterprise → core, never core → enterprise. An import
in this direction is a licensing problem, not a style problem — Apache 2.0 code
cannot depend on the proprietary package.

Remediation:
  - If OSS genuinely needs the behavior, it belongs in OSS. Move it.
  - If enterprise needs to extend OSS, invert it: OSS publishes an extension
    point (settings include, URL pattern, signal hook, slot registration per
    ADR-0029) and enterprise registers against it at startup.
  - If you are only naming the package in documentation, write it in
    ``double backticks`` rather than "quotes" and this gate will pass.
  - A hit in pyproject.toml / package.json / Cargo.toml / requirements*.txt is
    the most serious form: it declares the proprietary package as a dependency
    of the Apache 2.0 distribution. There is no documentation exemption for a
    manifest — remove the entry.

See CLAUDE.md § Two-Repo Rule.
MSG
  exit 1
fi

echo "OK: no trueppm-enterprise imports or dependency entries in $ROOT."
