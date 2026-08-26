#!/usr/bin/env bash
# Lint gate for stale stub markers in source.
#
# Three rules (per #350):
#   1. STUB: and WIP: markers fail unconditionally — they never ship.
#   2. TODO(#NNN) markers must reference an OPEN issue in THIS project. A
#      reference to a closed issue means the work landed but the placeholder
#      stayed. TODO(upstream#NNN) is a distinct, deliberate spelling for a
#      foreign/third-party tracker reference (#3043) — it is never resolved
#      against this project's API and is never a violation.
#   3. Bare TODO (no #NNN reference, and not the upstream# form) emits a
#      warning only — sometimes valid during work-in-progress on a branch.
#
# Excludes packages/web/e2e (Playwright TODOs for follow-up specs are valid),
# docs/, *.md, and common build/vendor dirs.
#
# Auth for rule 2 (#3043): the CI job token (CI_JOB_TOKEN) cannot
# authenticate against the GitLab Issues API at all — that endpoint is not
# in the job-token-supported list. The previous version of this script sent
# it anyway as a `JOB-TOKEN` header, and that is actively worse than sending
# no auth at all: GitLab treats *any* `JOB-TOKEN` header, valid or not, as an
# auth attempt for an unsupported endpoint and returns 401 — even on a
# project whose issue tracker is public and would otherwise serve the same
# request anonymously with a 200 (verified against this project's own API:
# `curl https://gitlab.com/api/v4/projects/trueppm%2Ftrueppm/issues/311`
# returns the real closed state with zero auth headers). So when
# TODO_GREP_TOKEN is not set, this script sends NO auth header — anonymous —
# rather than a JOB-TOKEN header that can only ever make things worse.
#
# TODO_GREP_TOKEN (a masked, protected CI/CD variable holding a project- or
# group-level access token with `read_api`) is the correct mechanism for a
# private project or a self-hosted fork whose issue tracker is not publicly
# readable. It is not required for trueppm/trueppm itself today, because this
# project's issue tracker is public — and it must NOT be declared as a
# self-referencing `variables:` entry on the job to document that dependency:
# with nothing defining it, the job receives the literal `$TODO_GREP_TOKEN`
# rather than an empty string, which is non-empty, gets sent as a
# PRIVATE-TOKEN header, and 401s every lookup.
#
# A gate that cannot reach its oracle must go red, not silently skip — so by
# default an issue lookup that fails (network error, API error, a private
# project with no token configured) is a hard failure alongside an actual
# closed-issue hit. TODO_GREP_ALLOW_UNRESOLVED=1 is the explicit, opt-in
# escape hatch for a context where issue-state resolution is genuinely
# unavailable — it downgrades an unresolved lookup back to a WARN and does
# not fail the job. It is not set anywhere in this repo's own CI.
#
# Exit codes:
#   0  no violations (warnings may have been emitted)
#   1  STUB:/WIP: marker found, TODO(#NNN) references a closed issue, or a
#      TODO(#NNN) issue lookup could not be resolved and
#      TODO_GREP_ALLOW_UNRESOLVED was not set
#   2  invocation / error unrelated to a specific reference (no roots exist)
#
# Modes:
#   bash scripts/check-todo-grep.sh             # scan default ROOTS
#   bash scripts/check-todo-grep.sh path1 ...   # scan given paths (used by --self-test)
#   bash scripts/check-todo-grep.sh --self-test # synthesize fixtures and assert each
#                                                # of rules 1 and 2 (open/closed/
#                                                # unresolved/opt-out/upstream#) behaves

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  # --- STUB: marker (rule 1) ---
  mkdir -p "$tmp/stub"
  cat >"$tmp/stub/bad.py" <<'PY'
def f() -> None:
    # STUB: replace with real implementation
    return None
PY
  if bash "$0" "$tmp/stub" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: script accepted a fixture containing 'STUB:'." >&2
    exit 1
  fi
  echo "SELF-TEST OK: STUB: marker correctly rejected."

  # A fake `curl` ahead of PATH lets the remaining scenarios drive the REAL
  # fetch/parse/decide code path in rule 2 (the curl call, the jq state
  # parse, the closed/unresolved branches) without hitting the network. It
  # emulates the `-w '\n%{http_code}'` contract the caller relies on: body,
  # then the status on its own trailing line. TODO_GREP_MOCK_MODE=fail
  # simulates a 401 so the unresolved-lookup path is exercised for real too.
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
iid=$(printf '%s' "$url" | grep -oE '[0-9]+$')
if [ "${TODO_GREP_MOCK_MODE:-}" = "fail" ]; then
  printf '{"message":"401 Unauthorized"}\n401'
  exit 0
fi
if [ "$iid" = "1" ]; then
  printf '{"state":"closed","title":"Closed fixture issue"}\n200'
else
  printf '{"state":"opened","title":"Open fixture issue"}\n200'
fi
CURLMOCK
  chmod +x "$tmp/bin/curl"

  # --- TODO(#NNN) referencing a CLOSED issue (rule 2) ---
  mkdir -p "$tmp/closed"
  cat >"$tmp/closed/bad.py" <<'PY'
def f() -> None:
    # TODO(#1): this references a closed issue in the mock
    return None
PY
  if PATH="$tmp/bin:$PATH" CI_PROJECT_ID=999999 TODO_GREP_TOKEN=fake-token \
    bash "$0" "$tmp/closed" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: script accepted a TODO(#NNN) referencing a closed issue." >&2
    exit 1
  fi
  echo "SELF-TEST OK: TODO(#NNN) referencing a closed issue correctly rejected."

  # --- TODO(#NNN) referencing an OPEN issue passes cleanly ---
  mkdir -p "$tmp/open"
  cat >"$tmp/open/good.py" <<'PY'
def f() -> None:
    # TODO(#2): this references an open issue in the mock
    return None
PY
  if ! PATH="$tmp/bin:$PATH" CI_PROJECT_ID=999999 TODO_GREP_TOKEN=fake-token \
    bash "$0" "$tmp/open" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: script rejected a TODO(#NNN) referencing an open issue." >&2
    exit 1
  fi
  echo "SELF-TEST OK: TODO(#NNN) referencing an open issue correctly accepted."

  # --- An unresolvable lookup fails closed by default ---
  if PATH="$tmp/bin:$PATH" CI_PROJECT_ID=999999 TODO_GREP_TOKEN=fake-token \
    TODO_GREP_MOCK_MODE=fail \
    bash "$0" "$tmp/open" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an unresolvable issue lookup did not fail the job." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an unresolvable issue lookup fails closed by default."

  # --- TODO_GREP_ALLOW_UNRESOLVED=1 is the explicit opt-out ---
  if ! PATH="$tmp/bin:$PATH" CI_PROJECT_ID=999999 TODO_GREP_TOKEN=fake-token \
    TODO_GREP_MOCK_MODE=fail TODO_GREP_ALLOW_UNRESOLVED=1 \
    bash "$0" "$tmp/open" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: TODO_GREP_ALLOW_UNRESOLVED=1 did not opt out of the failure." >&2
    exit 1
  fi
  echo "SELF-TEST OK: TODO_GREP_ALLOW_UNRESOLVED=1 opts out of an unresolvable lookup."

  # --- TODO(upstream#NNN) is never resolved against this project. The mock
  #     stays in "fail" mode: if the script mistakenly tried to resolve this
  #     reference it would hit the fake curl's failure branch and this
  #     assertion would (correctly) fail, so a pass here proves curl was
  #     never called for it, not merely that the outcome was lenient. ---
  mkdir -p "$tmp/upstream"
  cat >"$tmp/upstream/foreign.py" <<'PY'
def f() -> None:
    # TODO(upstream#99999): tracked in a third-party repo, not ours
    return None
PY
  if ! PATH="$tmp/bin:$PATH" CI_PROJECT_ID=999999 TODO_GREP_TOKEN=fake-token \
    TODO_GREP_MOCK_MODE=fail \
    bash "$0" "$tmp/upstream" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: TODO(upstream#NNN) was resolved against this project (it must never be)." >&2
    exit 1
  fi
  echo "SELF-TEST OK: TODO(upstream#NNN) is skipped, never resolved against this project."

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

#   Deliberately no `-n` here (#3043): `-n` still prefixes every match with
#   `linenum:` even under `-h -o`, which corrupts the two `-hoE` extraction
#   calls below — piping "47:TODO(#1306)" through `grep -oE '[0-9]+'` to
#   pull the issue id yields TWO numbers ("47" and "1306"), not one, and the
#   resulting id is unusable as a URL path segment. `-n` is added back
#   explicitly on the two calls (STUB:/WIP: and the bare-TODO warning) that
#   print a human-readable line locator instead of parsing the match.
GREP_OPTS=(
  -r
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

# 1. Hard-fail STUB: / WIP: markers. -n: print the line locator for the fix.
if stub_hits=$(grep "${GREP_OPTS[@]}" -nE '(STUB|WIP):' "${EXISTING_ROOTS[@]}" 2>/dev/null); then
  {
    echo "ERROR: STUB:/WIP: marker(s) found in source — these must not ship:"
    echo "$stub_hits"
    echo ""
  } >&2
  violations=$((violations + 1))
fi

# 2. TODO(#NNN) — every referenced issue must still be open on GitLab.
#    TODO(upstream#NNN) is a deliberate escape hatch (see header) and is
#    reported for visibility only — never resolved, never a violation.
todo_refs=$(grep "${GREP_OPTS[@]}" -hoE 'TODO\(#[0-9]+\)' "${EXISTING_ROOTS[@]}" 2>/dev/null | sort -u || true)
upstream_refs=$(grep "${GREP_OPTS[@]}" -hoE 'TODO\(upstream#[0-9]+\)' "${EXISTING_ROOTS[@]}" 2>/dev/null | sort -u || true)

if [ -n "$upstream_refs" ]; then
  {
    echo "INFO: foreign-tracker reference(s) — not checked against this project's issues:"
    echo "$upstream_refs"
    echo ""
  } >&2
fi

ALLOW_UNRESOLVED="${TODO_GREP_ALLOW_UNRESOLVED:-0}"

if [ -n "$todo_refs" ]; then
  API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
  PROJECT="${CI_PROJECT_ID:-}"
  if [ -z "$PROJECT" ]; then
    echo "WARN: CI_PROJECT_ID not set — skipping TODO(#NNN) open/closed check." >&2
    echo "      (This script is intended to run in CI; locally, only STUB:/WIP: are checked.)" >&2
  else
    CURL_AUTH_ARGS=()
    if [ -n "${TODO_GREP_TOKEN:-}" ]; then
      CURL_AUTH_ARGS=(--header "PRIVATE-TOKEN: ${TODO_GREP_TOKEN}")
    fi
    # No `else` branch: see the header comment. A JOB-TOKEN header cannot
    # authenticate against this endpoint and only turns a potential
    # anonymous 200 (public project) into a guaranteed 401, so the
    # no-token case sends no auth header at all.
    closed_count=0
    unresolved_count=0
    while IFS= read -r ref; do
      iid=$(printf '%s' "$ref" | grep -oE '[0-9]+')
      [ -z "$iid" ] && continue
      url="${API}/projects/${PROJECT}/issues/${iid}"
      # The status code is appended on its own line rather than relying on
      # `curl -f`'s exit status: "could not fetch" alone cannot distinguish a
      # 401 (an auth header is being sent that should not be) from a 404
      # (wrong project id) or a 000 (no egress), and that ambiguity is what
      # makes a red gate expensive to diagnose. 000 is what curl reports when
      # the request never completed.
      #
      # The "+" expansion (not a bare "${CURL_AUTH_ARGS[@]}") is required so
      # this does not trip "unbound variable" under `set -u` on bash 3.2
      # (macOS's default /usr/bin/env bash) when the array is empty.
      resp=$(curl -s -w $'\n%{http_code}' "${CURL_AUTH_ARGS[@]+"${CURL_AUTH_ARGS[@]}"}" "$url" || true)
      http_code="${resp##*$'\n'}"
      body="${resp%$'\n'*}"
      if [ "$http_code" != "200" ]; then
        if [ "$ALLOW_UNRESOLVED" = "1" ]; then
          echo "WARN: could not fetch issue #${iid} from GitLab API (HTTP ${http_code:-000}) — skipping (TODO_GREP_ALLOW_UNRESOLVED=1)." >&2
        else
          echo "ERROR: could not fetch issue #${iid} from GitLab API (HTTP ${http_code:-000}) — cannot verify TODO(#${iid})." >&2
          unresolved_count=$((unresolved_count + 1))
        fi
        continue
      fi
      state=$(printf '%s' "$body" | jq -r '.state // "unknown"')
      if [ "$state" = "closed" ]; then
        title=$(printf '%s' "$body" | jq -r '.title // ""')
        echo "ERROR: TODO(#${iid}) references a closed issue: ${title}" >&2
        closed_count=$((closed_count + 1))
      fi
    done <<<"$todo_refs"
    if [ "$closed_count" -gt 0 ]; then
      {
        echo ""
        echo "Either remove the TODO (the work is done) or reopen the issue."
        echo ""
      } >&2
      violations=$((violations + 1))
    fi
    if [ "$unresolved_count" -gt 0 ]; then
      {
        echo ""
        echo "${unresolved_count} TODO(#NNN) reference(s) could not be verified against the GitLab"
        echo "API. A gate that cannot reach its oracle must go red, not skip silently. Set"
        echo "TODO_GREP_TOKEN (a masked, protected project/group access token with read_api)"
        echo "so this check can actually run, or set TODO_GREP_ALLOW_UNRESOLVED=1 to"
        echo "explicitly accept the risk (do not set that in this repo's own CI)."
        echo ""
      } >&2
      violations=$((violations + 1))
    fi
  fi
fi

# 3. Warn-only — bare TODO with no #NNN reference (and not the upstream# form).
#    -n: print the line locator so a developer can find and link it.
bare_hits=$(grep "${GREP_OPTS[@]}" -nE 'TODO[: (]' "${EXISTING_ROOTS[@]}" 2>/dev/null |
  grep -vE 'TODO\(#[0-9]+\)' | grep -vE 'TODO\(upstream#[0-9]+\)' || true)
if [ -n "$bare_hits" ]; then
  {
    echo "WARNING: bare TODO(s) found — consider linking with TODO(#NNN):"
    echo "$bare_hits"
    echo ""
  } >&2
fi

if [ "$violations" -gt 0 ]; then
  exit 1
fi

echo "OK: no STUB:/WIP: markers; TODO(#NNN) references all point at open issues."
