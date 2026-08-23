#!/usr/bin/env bash
# Fail if packages/web/CLAUDE.md carries two rules under one number.
#
# Rule numbers are the file's addressing scheme: code comments, ADRs and MR
# descriptions cite "rule NNN" and expect one answer. Two branches in flight
# each pick the next free number, each is locally right, and nothing checks at
# merge — which is how 295 came to mean two different things for months (#2933),
# in the file that itself warns about this collision class.
#
# A duplicate cannot be caught by either branch's own pipeline: it exists only
# on the merged tree. So the check has to run on main and on every MR.
set -euo pipefail

# Self-test: this gate's passing output looks identical whether it is working or
# has been defeated by a pattern drift, so "it passed" is not evidence it can
# still fail. Prove it against a fixture carrying a known duplicate.
if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  printf '%s\n' \
    '12. **A real rule.** Body.' \
    '295. **First claimant.** Body.' \
    'Prose that is not a rule and must not be counted.' \
    '295. **Second claimant.** Body.' > "$tmp"
  if "$0" "$tmp" >/dev/null 2>&1; then
    echo "✖ self-test FAILED: the gate passed a file with a duplicate rule number" >&2
    exit 1
  fi
  echo "✓ self-test: the gate still detects a duplicate"
  exit 0
fi

FILE="${1:-packages/web/CLAUDE.md}"

if [[ ! -f "$FILE" ]]; then
  echo "check-web-rule-numbers: $FILE not found" >&2
  exit 1
fi

# A rule is a line starting `NNN. **`. Anything else (prose, tables, the
# decision-record pointer at the foot of the file) is not addressable.
numbers="$(grep -oE '^[0-9]{1,3}\. \*\*' "$FILE" | grep -oE '^[0-9]+' || true)"

if [[ -z "$numbers" ]]; then
  echo "check-web-rule-numbers: found no rules in $FILE — the pattern has drifted" >&2
  exit 1
fi

total="$(printf '%s\n' "$numbers" | wc -l | tr -d ' ')"
dupes="$(printf '%s\n' "$numbers" | sort -n | uniq -d || true)"

if [[ -n "$dupes" ]]; then
  echo "✖ packages/web/CLAUDE.md has rules sharing a number:" >&2
  while read -r n; do
    [[ -z "$n" ]] && continue
    echo "" >&2
    echo "  rule $n is claimed by:" >&2
    grep -nE "^${n}\. \*\*" "$FILE" | cut -c1-140 | sed 's/^/    /' >&2
  done <<< "$dupes"
  echo "" >&2
  echo "  Renumber the one with FEWER external citations — grep 'rule <N>' across" >&2
  echo "  packages/ and docs/ first. The number that other files already point at" >&2
  echo "  is load-bearing; the other one is free to move." >&2
  exit 1
fi

echo "✓ web rule numbers: $total rules, no duplicates"
