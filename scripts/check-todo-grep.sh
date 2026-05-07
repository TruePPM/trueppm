#!/usr/bin/env bash
# Lint gate for stale stub markers in source.
#
# Three rules (per #350):
#   1. STUB: and WIP: markers fail unconditionally — they never ship.
#   2. TODO(#NNN) markers must reference an OPEN issue. A reference to a
#      closed issue means the work landed but the placeholder stayed.
#   3. Bare TODO (no #NNN reference) emits a warning only — sometimes valid
#      during work-in-progress on a branch.
#
# Excludes packages/web/e2e (Playwright TODOs for follow-up specs are valid),
# docs/, *.md, and common build/vendor dirs.
#
# Exit codes:
#   0  no violations (warnings may have been emitted)
#   1  STUB:/WIP: marker found, or TODO(#NNN) references a closed issue
#   2  invocation / API error
#
# Modes:
#   bash scripts/check-todo-grep.sh             # scan default ROOTS
#   bash scripts/check-todo-grep.sh path1 ...   # scan given paths (used by --self-test)
#   bash scripts/check-todo-grep.sh --self-test # synthesize a fixture, assert exit 1

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  cat >"$tmp/bad.py" <<'PY'
def f() -> None:
    # STUB: replace with real implementation
    return None
PY
  if bash "$0" "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: script accepted a fixture containing 'STUB:'." >&2
    exit 1
  fi
  echo "SELF-TEST OK: STUB: marker correctly rejected."
  exit 0
fi

if [ "$#" -gt 0 ]; then
  ROOTS=("$@")
else
  ROOTS=(
    packages/api/src
    packages/api/tests
    packages/web/src
    packages/scheduler/src
    packages/scheduler/tests
    packages/helm
  )
fi

# Filter to roots that exist — keeps the self-test (single tempdir) and CI
# (full set) both happy without hard-coding either case.
EXISTING_ROOTS=()
for r in "${ROOTS[@]}"; do
  [ -e "$r" ] && EXISTING_ROOTS+=("$r")
done
if [ "${#EXISTING_ROOTS[@]}" -eq 0 ]; then
  echo "ERROR: none of the requested roots exist: ${ROOTS[*]}" >&2
  exit 2
fi

GREP_OPTS=(
  -rn
  --include='*.py'
  --include='*.ts'
  --include='*.tsx'
  --include='*.js'
  --include='*.jsx'
  --include='*.yaml'
  --include='*.yml'
  --include='*.tpl'
  --include='*.sh'
  --exclude-dir=node_modules
  --exclude-dir=.venv
  --exclude-dir=venv
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=__pycache__
  --exclude-dir=e2e
  --exclude-dir=.next
)

violations=0

# 1. Hard-fail STUB: / WIP: markers.
if stub_hits=$(grep "${GREP_OPTS[@]}" -E '(STUB|WIP):' "${EXISTING_ROOTS[@]}" 2>/dev/null); then
  echo "ERROR: STUB:/WIP: marker(s) found in source — these must not ship:"
  echo "$stub_hits"
  echo ""
  violations=$((violations + 1))
fi

# 2. TODO(#NNN) — every referenced issue must still be open on GitLab.
todo_refs=$(grep "${GREP_OPTS[@]}" -hoE 'TODO\(#[0-9]+\)' "${EXISTING_ROOTS[@]}" 2>/dev/null | sort -u || true)

if [ -n "$todo_refs" ]; then
  API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
  PROJECT="${CI_PROJECT_ID:-}"
  if [ -z "$PROJECT" ]; then
    echo "WARN: CI_PROJECT_ID not set — skipping TODO(#NNN) open/closed check."
    echo "      (This script is intended to run in CI; locally, only STUB:/WIP: are checked.)"
  else
    if [ -n "${TODO_GREP_TOKEN:-}" ]; then
      AUTH_HEADER="PRIVATE-TOKEN: ${TODO_GREP_TOKEN}"
    else
      AUTH_HEADER="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
    fi
    closed_count=0
    while IFS= read -r ref; do
      iid=$(printf '%s' "$ref" | grep -oE '[0-9]+')
      [ -z "$iid" ] && continue
      url="${API}/projects/${PROJECT}/issues/${iid}"
      if ! body=$(curl -sf --header "$AUTH_HEADER" "$url"); then
        echo "WARN: could not fetch issue #${iid} from GitLab API — skipping."
        continue
      fi
      state=$(printf '%s' "$body" | jq -r '.state // "unknown"')
      if [ "$state" = "closed" ]; then
        title=$(printf '%s' "$body" | jq -r '.title // ""')
        echo "ERROR: TODO(#${iid}) references a closed issue: ${title}"
        closed_count=$((closed_count + 1))
      fi
    done <<< "$todo_refs"
    if [ "$closed_count" -gt 0 ]; then
      echo ""
      echo "Either remove the TODO (the work is done) or reopen the issue."
      echo ""
      violations=$((violations + 1))
    fi
  fi
fi

# 3. Warn-only — bare TODO with no #NNN reference.
bare_hits=$(grep "${GREP_OPTS[@]}" -E 'TODO[: (]' "${EXISTING_ROOTS[@]}" 2>/dev/null | grep -vE 'TODO\(#[0-9]+\)' || true)
if [ -n "$bare_hits" ]; then
  echo "WARNING: bare TODO(s) found — consider linking with TODO(#NNN):"
  echo "$bare_hits"
  echo ""
fi

if [ "$violations" -gt 0 ]; then
  exit 1
fi

echo "OK: no STUB:/WIP: markers; TODO(#NNN) references all point at open issues."
