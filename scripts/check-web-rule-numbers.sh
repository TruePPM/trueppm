#!/usr/bin/env bash
# Fail if the packages/web/CLAUDE.md rule index is inconsistent.
#
# Two checks, one per way the index can lie.
#
# 1. DUPLICATE NUMBERS. Rule numbers are the file's addressing scheme: code
#    comments, ADRs and MR descriptions cite "rule NNN" and expect one answer.
#    Two branches in flight each pick the next free number, each is locally
#    right, and nothing checks at merge — which is how 295 came to mean two
#    different things for months (#2933). Since #3744 the index is also
#    `merge=union`, whose one failure mode (both sides edited the same line, so
#    both copies are kept) surfaces here as a duplicate too.
#
# 2. INDEX <-> BODY PAIRING (#3744). The file is one line per invariant, linking
#    to its full text under docs/design/invariants/. An index line whose body is
#    missing sends a reader to a 404; a body no line indexes is a rule nobody
#    holds. Neither is visible from either file alone.
#
# A duplicate or a dangling pair cannot be caught by either branch's own
# pipeline: it exists only on the merged tree. So this runs on main and every MR.
set -euo pipefail

INV_LINK='../../docs/design/invariants/'

check() {
  local file="$1"
  local inv_dir
  inv_dir="$(dirname "$file")/../../docs/design/invariants"

  if [[ ! -f "$file" ]]; then
    echo "check-web-rule-numbers: $file not found" >&2
    return 1
  fi

  # A rule is a line starting `NNN. **` (letters allowed: 8a, 22a). Anything else
  # — prose, section intros, the decision-record pointer — is not addressable.
  local rule_lines
  rule_lines="$(grep -E '^[0-9]{1,3}[a-z]?\. \*\*' "$file" || true)"

  if [[ -z "$rule_lines" ]]; then
    echo "check-web-rule-numbers: found no rules in $file — the pattern has drifted" >&2
    return 1
  fi

  local numbers total dupes
  numbers="$(sed -E 's/^([0-9]+[a-z]?)\. .*/\1/' <<< "$rule_lines")"
  total="$(wc -l <<< "$numbers" | tr -d ' ')"
  dupes="$(sort <<< "$numbers" | uniq -d || true)"

  if [[ -n "$dupes" ]]; then
    echo "✖ $file has rules sharing a number:" >&2
    while read -r n; do
      [[ -z "$n" ]] && continue
      echo "" >&2
      echo "  rule $n is claimed by:" >&2
      grep -nE "^${n}\. \*\*" "$file" | cut -c1-140 | sed 's/^/    /' >&2
    done <<< "$dupes"
    echo "" >&2
    echo "  If the two lines are the same rule edited on both sides, a union merge" >&2
    echo "  kept both copies: delete the stale one. Otherwise renumber the one with" >&2
    echo "  FEWER external citations — grep 'rule <N>' across packages/ and docs/" >&2
    echo "  first; the number other files already point at is load-bearing." >&2
    echo "" >&2
    echo "  Next time: 'scripts/wt reserve rule' claims the number up front, across" >&2
    echo "  worktrees AND against origin/main (#3284)." >&2
    return 1
  fi

  # Pairing applies once the index links bodies. A file with no body links at
  # all is a pre-#3744 layout (or the duplicate-only fixture) and is exempt.
  if ! grep -qF "]($INV_LINK" <<< "$rule_lines"; then
    echo "✓ web rule numbers: $total rules, no duplicates"
    return 0
  fi

  if [[ ! -d "$inv_dir" ]]; then
    echo "✖ $file links rule bodies but $inv_dir does not exist" >&2
    return 1
  fi

  local fails=0 linked="" line n target f b
  while IFS= read -r line; do
    n="${line%%.*}"
    target="$(grep -oE '\]\(\.\./\.\./docs/design/invariants/[^)]+\.md\)$' <<< "$line" || true)"
    target="${target#"]($INV_LINK"}"
    target="${target%)}"
    if [[ -z "$target" ]]; then
      echo "✖ rule $n: index line does not end with a link to its body" >&2
      fails=1
      continue
    fi
    case "$target" in
      "$n"-*) ;;
      *) echo "✖ rule $n: links $target — a body file must be named <N>-<slug>.md" >&2; fails=1 ;;
    esac
    if [[ ! -f "$inv_dir/$target" ]]; then
      echo "✖ rule $n: links $target, which does not exist" >&2
      fails=1
    fi
    linked+="$target"$'\n'
  done <<< "$rule_lines"

  for f in "$inv_dir"/*.md; do
    [[ -e "$f" ]] || continue
    b="$(basename "$f")"
    [[ "$b" == "README.md" ]] && continue
    if ! grep -qxF "$b" <<< "$linked"; then
      echo "✖ docs/design/invariants/$b is not indexed by any line in $file" >&2
      fails=1
    fi
  done

  if (( fails )); then
    echo "" >&2
    echo "  Each invariant is one index line plus one body file (#3744)." >&2
    return 1
  fi

  echo "✓ web rule numbers: $total rules, no duplicates, every rule paired with its body"
}

# Self-test: this gate's passing output looks identical whether it is working or
# has been defeated by a pattern drift, so "it passed" is not evidence it can
# still fail. Every case runs the REAL check() against a fixture tree.
if [[ "${1:-}" == "--self-test" ]]; then
  root="$(mktemp -d)"
  trap 'rm -rf "$root"' EXIT
  rc=0

  fixture() { # <case-dir> — lays out packages/web/CLAUDE.md + docs/design/invariants/
    mkdir -p "$1/packages/web" "$1/docs/design/invariants"
  }
  expect() { # <name> <pass|fail> <case-dir>
    local got=fail
    if check "$3/packages/web/CLAUDE.md" >/dev/null 2>&1; then got=pass; fi
    if [[ "$got" == "$2" ]]; then
      echo "✓ self-test: $1 → $got as expected"
    else
      echo "✖ self-test FAILED: $1 → $got, expected $2" >&2
      rc=1
    fi
  }

  c="$root/dup"; fixture "$c"
  printf '%s\n' '12. **A real rule.** Body.' '295. **First claimant.** Body.' \
    'Prose that is not a rule.' '295. **Second claimant.** Body.' > "$c/packages/web/CLAUDE.md"
  expect "duplicate number" fail "$c"

  c="$root/ok"; fixture "$c"
  printf '%s\n' "12. **A rule.** → [rule](${INV_LINK}12-a-rule.md)" \
    "8a. **Lettered.** → [rule](${INV_LINK}8a-lettered.md)" > "$c/packages/web/CLAUDE.md"
  touch "$c/docs/design/invariants/12-a-rule.md" "$c/docs/design/invariants/8a-lettered.md" \
    "$c/docs/design/invariants/README.md"
  expect "paired index" pass "$c"

  c="$root/missing"; fixture "$c"
  printf '%s\n' "12. **A rule.** → [rule](${INV_LINK}12-a-rule.md)" > "$c/packages/web/CLAUDE.md"
  expect "index line with no body" fail "$c"

  c="$root/orphan"; fixture "$c"
  printf '%s\n' "12. **A rule.** → [rule](${INV_LINK}12-a-rule.md)" > "$c/packages/web/CLAUDE.md"
  touch "$c/docs/design/invariants/12-a-rule.md" "$c/docs/design/invariants/13-unindexed.md"
  expect "body with no index line" fail "$c"

  c="$root/unlinked"; fixture "$c"
  printf '%s\n' "12. **A rule.** → [rule](${INV_LINK}12-a-rule.md)" '13. **No link.** Body.' > "$c/packages/web/CLAUDE.md"
  touch "$c/docs/design/invariants/12-a-rule.md"
  expect "index line without a link" fail "$c"

  c="$root/misnamed"; fixture "$c"
  printf '%s\n' "12. **A rule.** → [rule](${INV_LINK}13-a-rule.md)" > "$c/packages/web/CLAUDE.md"
  touch "$c/docs/design/invariants/13-a-rule.md"
  expect "body named for another number" fail "$c"

  exit "$rc"
fi

check "${1:-packages/web/CLAUDE.md}"
