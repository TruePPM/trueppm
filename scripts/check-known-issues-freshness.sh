#!/usr/bin/env bash
# Known-issues freshness gate (#3628).
#
# packages/website/src/content/docs/overview/known-issues.md states its own
# contract in the intro: "Every entry names the issue tracking it and the
# release it is fixed in. When an issue closes, its entry comes off this
# page." Nothing enforced that. A 2026-09-08 sweep found ten of the page's 28
# issue references pointing at closed issues — this is the third recorded
# instance of the class (#2594, #3607, #3628), so a mechanical gate replaces
# the next persona-panel sweep instead of waiting for one.
#
# Rule: every GitLab issue reference (a `/-/issues/NNNN` URL) on the page must
# resolve to an OPEN issue, UNLESS the SAME physical line also carries the ack
# marker below. The marker is the escape hatch for a reference the page cites
# on purpose — context for a decision that already shipped (e.g. an engine
# restriction lifting), or a closed issue cited as evidence a fix landed
# (e.g. #2689). Adding the marker is a claim a human made after checking
# `main`, not a way to make the gate quiet — see CLAUDE.md's "a closed issue
# is evidence the work merged, not that the entry's claim is now false."
#
#   ACK_MARKER: <!-- known-issues-ack:closed -->
#
# Second rule (#4724): a line that carries ONE issue reference and a release
# claim ("planned for 0.X", "stretch goal for 0.X", "targeted at 0.X") must agree
# with that issue's tracker milestone. A mismatch, an issue with no milestone, or
# "planned for" on a `release::stretch` issue (stretch is not a plan) fails. The
# claim and the reference must share a physical line, so write them together.
# Pages scanned only for this rule (not for closed references) are listed in
# MILESTONE_ONLY_PAGES; a file passed explicitly gets both rules.
#
# Exit codes:
#   0  no violations
#   1  a reference resolves to a closed issue with no ack marker on its own
#      line, or (default) a lookup could not be resolved at all
#   2  invocation / setup error (page missing, CI_PROJECT_ID unset)
#
# Modes:
#   bash scripts/check-known-issues-freshness.sh              # scan the default page
#   bash scripts/check-known-issues-freshness.sh <file>        # scan a given file
#   bash scripts/check-known-issues-freshness.sh --self-test   # synthesize fixtures, assert
#
# Auth: same reasoning as check-todo-grep.sh (#3043) — CI_JOB_TOKEN cannot
# authenticate against the Issues API on any endpoint, so a JOB-TOKEN header
# only ever turns a public project's anonymous 200 into a guaranteed 401. No
# auth header is sent unless KNOWN_ISSUES_TOKEN or the shared ISSUES_API_TOKEN
# (a project/group access token with read_api) is set. The tracker is public,
# so the token is not needed for access — it is there for the authenticated
# rate limit: anonymous lookups share one per-IP budget across every runner
# job and 429'd main (#4452). All references resolve in one batched call with
# 429 retry; see scripts/lib/gitlab-issues.sh.
#
# A gate that cannot reach its oracle must go red, not silently pass.
# KNOWN_ISSUES_ALLOW_UNRESOLVED=1 is the explicit opt-out for a context where
# issue-state resolution is genuinely unavailable — a tracker-API timeout
# should retry the JOB, not be silenced (the same fail-closed caveat
# lint:todo-grep documents). It is not set anywhere in this repo's own CI.

set -euo pipefail

ACK_MARKER='<!-- known-issues-ack:closed -->'
PAGE_DEFAULT="packages/website/src/content/docs/overview/known-issues.md"
D=packages/website/src/content/docs
MILESTONE_ONLY_PAGES_DEFAULT="$D/getting-started/bring-your-plan-in.md $D/features/monte-carlo.md $D/administration/backup-restore.md $D/administration/durability.md $D/administration/admin-password.md"
# Knowingly unchecked (this is a docs-claim gate, not a markdown parser):
#   - lines with 0 issue refs ("per ADR-NNNN" prose, milestone-column tables);
#     headings are covered separately by heading_consistency (no tracker call);
#   - lines with 2+ distinct refs get the closed-state check only, since a claim
#     cannot be pinned to one issue;
#   - a claim wrapped onto the line after its link (reference and claim must
#     share a physical line);
#   - a closed issue with a MATCHING claim still passes on the milestone-only
#     pages and when ack-marked (the closed rule owns that case);
#   - only trueppm/trueppm issue URLs resolve; links into other projects
#     (e.g. trueppm-enterprise) are ignored, never read as OSS numbers.
# Emphasis markers (`*`), repeated spaces and a `v` prefix are normalized away
# before matching, and EVERY claim on a line must agree with the issue.
CLAIM_RE='(planned for|stretch goal for|targeted at|ships in) v?0\.[0-9]+'
ISSUE_URL_RE='trueppm/trueppm/-/issues/[0-9]+'

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  # A fake `curl` ahead of PATH drives the real fetch/parse/decide code below
  # without hitting the network. It answers the batched list call
  # (`issues?iids[]=…`, #4452) with one issue per requested iid.
  # KNOWN_ISSUES_MOCK_MODE picks the response:
  #   open      -> every iid "opened"
  #   closed    -> every iid "closed"
  #   unfetchable -> curl "fails" (no output, matching a real network error)
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
iids=$(printf '%s' "$url" | grep -oE 'iids\[\]=[0-9]+' | cut -d= -f2)
case "${KNOWN_ISSUES_MOCK_MODE:-open}" in
  open | closed)
    state=opened
    [ "$KNOWN_ISSUES_MOCK_MODE" = closed ] && state=closed
    printf '%s\n' $iids | jq -R --arg s "$state" --arg m "${KNOWN_ISSUES_MOCK_MILESTONE:-0.5}" --arg l "${KNOWN_ISSUES_MOCK_LABEL:-release::committed}" \
      '{iid: tonumber, state: $s, title: "an issue", milestone: (if $m == "-" then null else {title: $m} end), labels: [$l]}' | jq -sc .
    printf '200 \n'
    ;;
  unfetchable)
    printf '\n%s\n' "000"
    ;;
esac
CURLMOCK
  chmod +x "$tmp/bin/curl"
  export PATH="$tmp/bin:$PATH"
  export CI_PROJECT_ID="1"
  export GITLAB_ISSUES_SLEEP_OVERRIDE=0

  # --- Case 1: an open issue reference passes ---
  cat >"$tmp/open.md" <<'EOF'
Tracked on [#100](https://gitlab.com/trueppm/trueppm/-/issues/100).
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=open bash "$0" "$tmp/open.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an open issue reference was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an open issue reference passes."

  # --- Case 2: a closed issue reference with no ack marker fails ---
  cat >"$tmp/closed_unmarked.md" <<'EOF'
Tracked on [#101](https://gitlab.com/trueppm/trueppm/-/issues/101).
EOF
  if KNOWN_ISSUES_MOCK_MODE=closed bash "$0" "$tmp/closed_unmarked.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an unmarked closed-issue reference was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an unmarked closed-issue reference is rejected."

  # --- Case 3: a closed issue reference WITH the ack marker on its own line passes ---
  cat >"$tmp/closed_marked.md" <<'EOF'
Tracked on [#102](https://gitlab.com/trueppm/trueppm/-/issues/102). <!-- known-issues-ack:closed -->
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=closed bash "$0" "$tmp/closed_marked.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an ack-marked closed-issue reference was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an ack-marked closed-issue reference passes."

  # --- Case 4: the marker on a DIFFERENT line from the reference does not launder it ---
  cat >"$tmp/closed_marked_wrong_line.md" <<'EOF'
Tracked on [#103](https://gitlab.com/trueppm/trueppm/-/issues/103).
<!-- known-issues-ack:closed -->
EOF
  if KNOWN_ISSUES_MOCK_MODE=closed bash "$0" "$tmp/closed_marked_wrong_line.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a marker on a different line laundered a closed reference." >&2
    exit 1
  fi
  echo "SELF-TEST OK: the ack marker must sit on the reference's own line."

  # --- Case 5: an unresolvable lookup fails closed by default ---
  cat >"$tmp/unfetchable.md" <<'EOF'
Tracked on [#104](https://gitlab.com/trueppm/trueppm/-/issues/104).
EOF
  if KNOWN_ISSUES_MOCK_MODE=unfetchable bash "$0" "$tmp/unfetchable.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an unresolvable lookup was silently accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an unresolvable lookup fails closed by default."

  # --- Case 6: KNOWN_ISSUES_ALLOW_UNRESOLVED=1 opts out of the failure ---
  if ! KNOWN_ISSUES_MOCK_MODE=unfetchable KNOWN_ISSUES_ALLOW_UNRESOLVED=1 \
      bash "$0" "$tmp/unfetchable.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: KNOWN_ISSUES_ALLOW_UNRESOLVED=1 did not opt out." >&2
    exit 1
  fi
  echo "SELF-TEST OK: KNOWN_ISSUES_ALLOW_UNRESOLVED=1 opts out of an unresolvable lookup."

  # --- Cases 7-11: the milestone-claim rule (#4724) ---
  cat >"$tmp/claim_ok.md" <<'EOF'
- **Fix planned for 0.5** — [#105](https://gitlab.com/trueppm/trueppm/-/issues/105).
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.5 bash "$0" "$tmp/claim_ok.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a claim matching the issue milestone was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a release claim matching the tracker milestone passes."

  if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.6 bash "$0" "$tmp/claim_ok.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a claim naming the wrong milestone was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a release claim contradicting the tracker milestone is rejected."

  if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=- bash "$0" "$tmp/claim_ok.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a claim on a milestone-less issue was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a release claim on an issue with no milestone is rejected."

  if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_LABEL=release::stretch bash "$0" "$tmp/claim_ok.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: 'planned for' on a release::stretch issue was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: 'planned for' on a release::stretch issue is rejected."

  cat >"$tmp/claim_stretch.md" <<'EOF'
- **Stretch goal for 0.6, not committed** — [#106](https://gitlab.com/trueppm/trueppm/-/issues/106).
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.6 KNOWN_ISSUES_MOCK_LABEL=release::stretch \
      bash "$0" "$tmp/claim_stretch.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an honest stretch-goal claim was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a 'stretch goal for' claim on a matching release::stretch issue passes."

  # Capitalized sentence-initial claim must still be checked (case-insensitive).
  cat >"$tmp/claim_cap.md" <<'EOF'
- **Stretch goal for 0.6, not committed** — [#107](https://gitlab.com/trueppm/trueppm/-/issues/107).
EOF
  if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.5 KNOWN_ISSUES_MOCK_LABEL=release::stretch \
      bash "$0" "$tmp/claim_cap.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a capitalized claim naming the wrong milestone was skipped." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a capitalized 'Stretch goal for' claim is checked, not skipped."

  # --- #4724 review round: branch coverage and phrasing variants ---
  # Two distinct refs on one line: the claim cannot be pinned, so it is not judged.
  cat >"$tmp/two_refs.md" <<'EOF'
- Planned for 0.9 — [#108](https://gitlab.com/trueppm/trueppm/-/issues/108) and [#109](https://gitlab.com/trueppm/trueppm/-/issues/109).
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.5 bash "$0" "$tmp/two_refs.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a claim on a two-reference line was judged against one issue." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a claim on a two-distinct-reference line is not attributed to either issue."

  printf 'No references here.\n' >"$tmp/empty.md"
  # Milestone-only pages: no closed check, but the claim is judged.
  cat >"$tmp/extra_closed.md" <<'EOF'
Cited at [#110](https://gitlab.com/trueppm/trueppm/-/issues/110), planned for 0.5.
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=closed KNOWN_ISSUES_MOCK_MILESTONE=0.5 \
      KNOWN_ISSUES_MILESTONE_ONLY_PAGES="$tmp/extra_closed.md" bash "$0" "$tmp/empty.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a milestone-only page got the closed-reference check." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a milestone-only page is not subject to the closed-reference rule."
  if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.6 \
      KNOWN_ISSUES_MILESTONE_ONLY_PAGES="$tmp/extra_closed.md" bash "$0" "$tmp/empty.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a wrong claim on a milestone-only page was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a wrong claim on a milestone-only page is rejected."

  # Phrasing variants, each paired with a mismatching mock milestone (0.5).
  n=0
  while IFS= read -r variant; do
    n=$((n + 1))
    printf '%s\n' "$variant [#111](https://gitlab.com/trueppm/trueppm/-/issues/111)." >"$tmp/variant.md"
    if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.5 bash "$0" "$tmp/variant.md" >/dev/null 2>&1; then
      echo "SELF-TEST FAILED: phrasing variant was not judged: ${variant}" >&2
      exit 1
    fi
  done <<'EOF'
Fix planned for **0.6**
Fix *planned for* 0.6
Fix planned  for 0.6
Fix planned for v0.6
**Ships in 0.6**
Fix planned for 0.5 and stretch goal for 0.6
EOF
  echo "SELF-TEST OK: ${n} phrasing variants (emphasis, spacing, v-prefix, ships in, second claim) are judged."

  # Links into another project are not read as OSS issue numbers.
  cat >"$tmp/foreign.md" <<'EOF'
See [#112](https://gitlab.com/trueppm/trueppm-enterprise/-/issues/112), planned for 0.9.
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=closed KNOWN_ISSUES_MOCK_MILESTONE=0.5 bash "$0" "$tmp/foreign.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: another project's issue link was resolved as an OSS issue." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a link to another project's issue is ignored."

  # Heading claim must match its section's claim bullet (no tracker call).
  cat >"$tmp/head_bad.md" <<'EOF'
### Thing is broken — planned for 0.6

- **Fix planned for 0.5** — [#113](https://gitlab.com/trueppm/trueppm/-/issues/113).
EOF
  if KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.5 bash "$0" "$tmp/head_bad.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a heading contradicting its section's claim was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a heading whose claim differs from its section's bullet is rejected."
  cat >"$tmp/head_ok.md" <<'EOF'
### Thing is broken — planned for 0.5

- **Fix planned for 0.5** — [#114](https://gitlab.com/trueppm/trueppm/-/issues/114).
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=open KNOWN_ISSUES_MOCK_MILESTONE=0.5 bash "$0" "$tmp/head_ok.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a consistent heading was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: a heading matching its section's bullet passes."

  echo "ALL SELF-TESTS PASSED"
  exit 0
fi

PAGE="${1:-$PAGE_DEFAULT}"
if [ -n "${1:-}" ]; then
  MILESTONE_ONLY_PAGES="${KNOWN_ISSUES_MILESTONE_ONLY_PAGES:-}"
else
  MILESTONE_ONLY_PAGES="${KNOWN_ISSUES_MILESTONE_ONLY_PAGES:-$MILESTONE_ONLY_PAGES_DEFAULT}"
fi

if [ ! -f "$PAGE" ]; then
  echo "ERROR: page not found: $PAGE" >&2
  exit 2
fi

PROJECT="${CI_PROJECT_ID:-}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
# shellcheck source-path=SCRIPTDIR source=lib/gitlab-issues.sh
. "$(dirname "$0")/lib/gitlab-issues.sh"
# No JOB-TOKEN fallback: it cannot authenticate against this endpoint (#3043).
TOKEN="${KNOWN_ISSUES_TOKEN:-${ISSUES_API_TOKEN:-}}"

ALLOW_UNRESOLVED="${KNOWN_ISSUES_ALLOW_UNRESOLVED:-0}"

export GITLAB_ISSUES_WITH_PLAN=1
violations=0
line_no=0
# One `line<TAB>iid<TAB>has_marker` row per reference, resolved in one batched
# call below rather than one request per reference (#4452).
ref_rows=""

# scan_page <file> <check_closed 1|0>: append rows
# `file<TAB>line<TAB>iid<TAB>has_marker<TAB>claim_kind<TAB>claim_version`.
# The claim is only taken from a line with exactly one distinct reference, so a
# claim is never attributed to the wrong issue.
scan_page() {
  local file="$1" check_closed="$2" ln=0 line refs distinct marker norm claims iid
  while IFS= read -r line || [ -n "$line" ]; do
    ln=$((ln + 1))
    refs=$(printf '%s' "$line" | grep -oE "$ISSUE_URL_RE" | grep -oE '[0-9]+$' || true)
    [ -z "$refs" ] && continue
    marker=0
    case "$line" in *"$ACK_MARKER"*) marker=1 ;; esac
    [ "$check_closed" = "0" ] && marker=1
    claims="-"
    distinct=$(printf '%s\n' "$refs" | sort -u | wc -l | tr -d ' ')
    if [ "$distinct" = "1" ]; then
      # Normalize emphasis markers and runs of spaces, lowercase, then take
      # EVERY claim as `kind:version` (underscores for spaces, no `v`).
      norm=$(printf '%s' "$line" | tr -d '*' | tr -s ' ' | tr '[:upper:]' '[:lower:]')
      claims=$(printf '%s' "$norm" | grep -oE "$CLAIM_RE" | sed -e 's/ v\{0,1\}0\./:0./' -e 's/ /_/g' | paste -sd, - || true)
      [ -z "$claims" ] && claims="-"
    fi
    while IFS= read -r iid; do
      [ -z "$iid" ] && continue
      ref_rows+="${file}"$'\t'"${ln}"$'\t'"${iid}"$'\t'"${marker}"$'\t'"${claims}"$'\n'
    done <<<"$refs"
  done <"$file"
}

# heading_consistency <file>: a heading carrying a release claim must agree with
# the claim(s) in its own section's issue-linked bullets. Needs no tracker call,
# so a re-milestoned issue turns the bullet red and cannot leave the heading
# silently stale. A section with no issue-linked claim is not judged.
heading_consistency() {
  awk -v f="$1" -v cre="$CLAIM_RE" '
    function norm(x) { gsub(/\*/, "", x); gsub(/[ \t]+/, " ", x); return tolower(x) }
    function vers(x, out,   n, c) {
      n = 0
      while (match(x, cre)) {
        c = substr(x, RSTART, RLENGTH); x = substr(x, RSTART + RLENGTH)
        match(c, /0\.[0-9]+/); out[++n] = substr(c, RSTART, RLENGTH)
      }
      return n
    }
    function flush(   i, ok) {
      if (hver != "" && nsec > 0) {
        ok = 0
        for (i = 1; i <= nsec; i++) if (sec[i] == hver) ok = 1
        if (!ok) {
          printf "ERROR: %s:%d heading says %s but its section claims %s — edit the heading to match the section bullet (docs-vs-tracker drift).\n", f, hline, hver, sec[1] > "/dev/stderr"
          bad++
        }
      }
      hver = ""; nsec = 0
    }
    /^#+ / { flush(); h = norm($0); n = vers(h, a); if (n > 0) { hver = a[1]; hline = NR } ; next }
    /trueppm\/trueppm\/-\/issues\/[0-9]+/ { n = vers(norm($0), a); for (i = 1; i <= n; i++) sec[++nsec] = a[i] }
    END { flush(); exit(bad > 0) }
  ' "$1"
}

scan_page "$PAGE" 1
for extra in $MILESTONE_ONLY_PAGES; do
  [ -f "$extra" ] || { echo "ERROR: page not found: $extra" >&2; exit 2; }
  scan_page "$extra" 0
done
heading_consistency "$PAGE" || violations=$((violations + 1))

if [ -n "$ref_rows" ]; then
  unique_iids=$(printf '%s' "$ref_rows" | cut -f3 | sort -un)
  states_ok=1
  # shellcheck disable=SC2086
  states=$(gitlab_issue_states "$API" "$PROJECT" "$TOKEN" $unique_iids) || states_ok=0

  while IFS=$'\t' read -r file line_no iid has_marker claims; do
    [ -z "$iid" ] && continue
    if [ "$states_ok" -ne 1 ]; then
      if [ "$ALLOW_UNRESOLVED" = "1" ]; then
        echo "WARN: could not fetch issue #${iid} — skipping (KNOWN_ISSUES_ALLOW_UNRESOLVED=1)." >&2
      else
        echo "ERROR: could not fetch issue #${iid} from GitLab API — cannot verify line ${line_no}." >&2
        violations=$((violations + 1))
      fi
      continue
    fi
    row=$(printf '%s\n' "$states" | awk -F'\t' -v i="$iid" '$1 == i && !f { print; f = 1 }' || true)
    if [ -z "$row" ]; then
      echo "ERROR: issue #${iid} (line ${line_no}) does not exist or is not readable (deleted, moved, or confidential)." >&2
      violations=$((violations + 1))
      continue
    fi
    state=$(printf '%s' "$row" | cut -f2)
    if [ "$state" = "closed" ] && [ "$has_marker" -ne 1 ]; then
      title=$(printf '%s' "$row" | cut -f3)
      echo "ERROR: ${file}:${line_no} references closed issue #${iid} (${title}) with no ack marker." >&2
      echo "  Either verify the entry against main and remove/reword it, or — only if the" >&2
      echo "  reference is a deliberate closed-issue citation, verified against main — add" >&2
      echo "  ${ACK_MARKER} to the SAME line." >&2
      violations=$((violations + 1))
    fi
    if [ "$claims" != "-" ]; then
      ms=$(printf '%s' "$row" | cut -f4)
      labels=$(printf '%s' "$row" | cut -f5)
      for claim in ${claims//,/ }; do
        claim_kind="${claim%%:*}"
        claim_ver="${claim##*:}"
        if [ "$ms" != "$claim_ver" ]; then
          echo "ERROR: ${file}:${line_no} says '${claim_kind//_/ } ${claim_ver}' but #${iid} is in milestone '${ms}' on the tracker." >&2
          echo "  Docs-vs-tracker drift: if the issue was re-milestoned, edit that claim on ${file}:${line_no} (and its section heading) to match." >&2
          violations=$((violations + 1))
        elif [ "$claim_kind" != "targeted_at" ] && [[ ",${labels}," == *",release::stretch,"* ]] &&
          { [ "$claim_kind" = "planned_for" ] || [ "$claim_kind" = "ships_in" ]; }; then
          echo "ERROR: ${file}:${line_no} says '${claim_kind//_/ } ${claim_ver}' but #${iid} is release::stretch — word it 'stretch goal for ${claim_ver}'." >&2
          violations=$((violations + 1))
        fi
      done
    fi
  done <<<"$ref_rows"
fi

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "${violations} docs reference(s) need attention (see CLAUDE.md" >&2
  echo "'do not delete on issue state alone' before removing any entry)." >&2
  exit 1
fi

echo "OK: every issue reference on ${PAGE} is open or ack-marked, and every release claim on it${MILESTONE_ONLY_PAGES:+ and on ${MILESTONE_ONLY_PAGES}} matches the tracker."
