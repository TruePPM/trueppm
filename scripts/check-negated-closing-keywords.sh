#!/usr/bin/env bash
# scripts/check-negated-closing-keywords.sh — fail on a NEGATED GitLab closing keyword
# ("does not fix #4883") in an MR description or a branch commit message (#4926).
#
# Why: GitLab's closing pattern ignores negation. "Does not fix #4883" in !3327's
# description matched `fix #4883`, so the merge closed #4883 although the MR said it
# did not fix it; the close turned main red and marked an unfixed defect as done.
#
# What counts as a closing reference (GitLab's own shapes):
#   keyword  close[sd]/closing, fix/fixe[sd]/fixing, resolve[sd]/resolving,
#            implement[s|ed|ing] — case-insensitive, optional `:` and optional `issue`
#   target   #N, group/proj#N, or a full .../issues/N or .../work_items/N URL
#   lists    "Closes #1, #2 and #3" closes every ref in the list
# "fixes a bug in #4883's area" has no ref directly after the keyword phrase, so
# GitLab does not close anything and neither do we.
#
# Negation scope: the CLAUSE the keyword sits in. The scan runs backward from the keyword
# to the nearest boundary (. ! ? ; | newline , : " and " " but " " until "). A negation
# word (not, no, never, none, nothing, without, cannot, neither, nor, "instead of", the
# contraction n't, or an apostrophe-less one: wont cant dont doesnt didnt isnt arent wasnt
# hasnt wouldnt shouldnt) in that clause fails. Words that merely end in "nt" ("unit",
# "net", "knot") are not negations. "No new deps, closes #7" and "Not ready yet. Closes #5"
# pass: the negation is in another clause. The reference list AFTER a keyword is not
# split, so "Does not close #1, #2 and #3" still names all three.
#
# Known limits (the accepted cost of clause scoping, not bugs to chase):
#   - a negation AFTER the keyword ("fix #7 is not planned") is not detected;
#   - a comma-delimited aside or an " until " clause hides a negation, because both
#     are clause boundaries: "Does not, as far as we know, fix #7" and "Not until #8
#     lands does this fix #7" pass.
#
# Safe spelling: "Refs #N" or "#N is out of scope". Escape hatches, for a verified false
# positive only: the exact token `<!-- closing-ok -->` (an HTML comment, invisible in the
# rendered MR) exempts every ref on its line; `closing-ok:#N` exempts only that ref. The
# bare words "closing-ok" in prose exempt nothing.
#
# Modes:
#   check-negated-closing-keywords.sh                 description + title (env) + commits
#   check-negated-closing-keywords.sh --description  only $CI_MERGE_REQUEST_DESCRIPTION
#   check-negated-closing-keywords.sh --title         only $CI_MERGE_REQUEST_TITLE (GitLab
#                                                     closes from the title too)
#   check-negated-closing-keywords.sh --commits       only commits in the branch range
#   check-negated-closing-keywords.sh --file <path>   check a file as a description
#   check-negated-closing-keywords.sh --self-test
#
# Commit range: $CI_MERGE_REQUEST_DIFF_BASE_SHA..$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA in
# CI (HEAD of a merged-results pipeline is a synthetic merge that also carries main's
# newer commits, which are not this MR's), else ..HEAD when that SHA is unset, else
# merge-base(origin/main, HEAD)..HEAD. Merge commits are skipped (--no-merges): they
# carry GitLab's default text, not authored prose. No resolvable base => warn and skip
# (offline pre-push); CI always has one.
#
# The description comes from the pipeline-creation snapshot of the MR, so editing the
# description needs a new pipeline (not a job retry) to be re-checked.
#
# BusyBox-safe: bash + awk + sed + git only; no grep -P / --include, no bash-4 casing.
# Exit: 0 clean · 1 negated closing keyword found · 2 invocation error

set -euo pipefail

# Prints "<ref>\t<sentence>" for each ref closed by a negated keyword, reading stdin.
scan_text() {
  sed "s/’/'/g" | awk '
    BEGIN {
      kw    = "(^|[^a-z0-9_])(closes|closed|close|closing|fixes|fixed|fix|fixing|resolves|resolved|resolve|resolving|implements|implemented|implement|implementing)"
      sep   = ":?[ \t]+(issues?[ \t]+)?"
      ref   = "(https?://[^ \t)]+/(issues|work_items)/[0-9]+|[a-z0-9_./-]*#[0-9]+)"
      neg   = "(^|[^a-z])(not|no|never|none|nothing|without|cannot|neither|nor|instead of|wont|cant|dont|doesnt|didnt|isnt|arent|wasnt|hasnt|wouldnt|shouldnt)([^a-z]|$)|n\047t([^a-z]|$)"
      cont  = "^[ \t]*(,|&)?[ \t]*(and[ \t]+)?" ref
    }
    {
      line = tolower($0)
      if (index(line, "<!-- closing-ok -->")) next
      delete ex
      rest = line
      while (match(rest, /closing-ok:#[0-9]+/)) {
        ex[substr(rest, RSTART + 11, RLENGTH - 11)] = 1
        rest = substr(rest, RSTART + RLENGTH)
      }
      gsub(/[.!?;][ \t]+/, "\n", line)
      gsub(/[.!?;]$/, "\n", line)
      gsub(/\|/, "\n", line)
      ns = split(line, sents, "\n")
      for (i = 1; i <= ns; i++) scan(sents[i])
    }
    # Keep only the text after the last clause boundary of p.
    function clause(p,    m) {
      while (match(p, /[,:]| and | but | until /)) p = substr(p, RSTART + RLENGTH)
      return p
    }
    function scan(s,    base, tail, start, mlen, matched, prefix, refs, after, consumed, r, n, ra, j) {
      base = 0
      while (base < length(s)) {
        tail = substr(s, base + 1)
        if (!match(tail, kw sep ref)) break
        start = base + RSTART
        mlen = RLENGTH
        matched = substr(s, start, mlen)
        prefix = clause(substr(s, 1, start))
        match(matched, ref "$")
        refs = substr(matched, RSTART)
        after = substr(s, start + mlen)
        consumed = 0
        while (match(after, cont)) {
          r = substr(after, RSTART, RLENGTH)
          match(r, ref "$")
          refs = refs " " substr(r, RSTART)
          consumed += length(r)
          after = substr(after, length(r) + 1)
        }
        if (prefix ~ neg) {
          n = split(refs, ra, " ")
          for (j = 1; j <= n; j++) {
            if (match(ra[j], /#[0-9]+$/) && (substr(ra[j], RSTART) in ex)) continue
            printf "%s\t%s\n", ra[j], s
          }
        }
        base = start + mlen + consumed
      }
    }'
}

# check_text <label>   (text on stdin) -> prints errors, returns 1 if any
check_text() {
  local label="$1" out rc=0 ref sentence
  out="$(scan_text)"
  [ -n "$out" ] || return 0
  while IFS="$(printf '\t')" read -r ref sentence; do
    echo "ERROR: ${label}: negated closing keyword for ${ref}: \"${sentence}\"" >&2
    echo "       GitLab ignores negation and WILL close ${ref} on merge." >&2
    echo "       Write 'Refs ${ref}' or '${ref} is out of scope' instead (or, for a verified false positive, add <!-- closing-ok --> to the line, or closing-ok:${ref} to exempt only this ref)." >&2
    rc=1
  done <<EOF
$out
EOF
  return $rc
}

check_commits() {
  local repo="${1:-.}" range="${2:-}" base="" tip="" sha shas rc=0 derived=0
  if [ -z "$range" ]; then
    derived=1
    base="${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}"
    tip="HEAD"
    if [ -z "$base" ]; then
      base="$(git -C "$repo" merge-base origin/main HEAD 2>/dev/null || true)"
    fi
    if [ -z "$base" ]; then
      echo "WARN: no merge base (CI_MERGE_REQUEST_DIFF_BASE_SHA / origin/main); range <base>..${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-HEAD} is unresolved, so NO commits were scanned." >&2
      return 0
    fi
    if [ -n "${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-}" ]; then
      tip="$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"
      git -C "$repo" cat-file -e "${tip}^{commit}" 2>/dev/null \
        || git -C "$repo" fetch -q origin "$tip" 2>/dev/null || true
    fi
    range="${base}..${tip}"
  fi
  # Capture first: a `for sha in $(git log ...)` swallows a failed log and scans nothing,
  # which would pass silently on an unresolvable range.
  if ! shas="$(git -C "$repo" log --no-merges --format=%H "$range" 2>/dev/null)"; then
    if [ "$derived" -eq 1 ] && [ "$tip" != "HEAD" ]; then
      echo "WARN: range ${range} is unresolvable; falling back to ${base}..HEAD." >&2
      if ! shas="$(git -C "$repo" log --no-merges --format=%H "${base}..HEAD" 2>/dev/null)"; then
        echo "ERROR: cannot resolve commit range ${range} or ${base}..HEAD; commits were NOT scanned." >&2
        return 1
      fi
    else
      echo "ERROR: cannot resolve commit range ${range}; commits were NOT scanned." >&2
      return 1
    fi
  fi
  for sha in $shas; do
    git -C "$repo" log -1 --format=%B "$sha" | check_text "commit ${sha}" || rc=1
  done
  return $rc
}

check_title() {
  if [ -z "${CI_MERGE_REQUEST_TITLE:-}" ]; then
    echo "note: no CI_MERGE_REQUEST_TITLE; title check skipped."
    return 0
  fi
  printf '%s\n' "$CI_MERGE_REQUEST_TITLE" | check_text "MR title"
}

check_description() {
  if [ -z "${CI_MERGE_REQUEST_DESCRIPTION:-}" ]; then
    echo "note: no CI_MERGE_REQUEST_DESCRIPTION; description check skipped."
    return 0
  fi
  printf '%s\n' "$CI_MERGE_REQUEST_DESCRIPTION" | check_text "MR description"
}

self_test() {
  local fails=0 tmp
  # git hooks (pre-push) export GIT_DIR; left set, every scratch-repo git call below would act on
  # the real repository and the self-test would die silently inside the hook.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
  expect() { # expect <fail|pass> <ref-that-must-be-named|-> <text>
    local want="$1" ref="$2" text="$3" err rc=0
    err="$(printf '%s\n' "$text" | check_text "self-test" 2>&1)" || rc=$?
    if [ "$want" = fail ]; then
      if [ "$rc" -ne 1 ] || { [ "$ref" != "-" ] && ! grep -qF "for ${ref}:" <<<"$err"; }; then
        echo "FAIL (expected failure naming ${ref}): $text" >&2; fails=$((fails + 1))
      fi
    elif [ "$rc" -ne 0 ]; then
      echo "FAIL (expected pass): $text" >&2; fails=$((fails + 1))
    fi
  }
  # must fail, naming the issue
  expect fail '#4883' 'Does not fix #4883'
  expect fail '#12'   "doesn't close #12"
  expect fail '#9'    "This won't resolve #9"
  expect fail '#7'    'We will never close: #7'
  expect fail '#7'    'Without fixing issue #7'
  expect fail '#7'    'Instead of closing #7 we defer it'
  expect fail '#4883' "$(printf 'Summary\nThis MR does NOT FIXES #4883 here')"
  expect fail '#2'    'Does not close #1, #2 and #3'
  expect fail '#3'    'Does not close #1, #2 and #3'
  expect fail 'https://gitlab.com/trueppm/trueppm/-/issues/55' 'Does not fix https://gitlab.com/trueppm/trueppm/-/issues/55'
  expect fail 'trueppm/trueppm#8' 'Does not resolve trueppm/trueppm#8'
  expect fail '#7' 'wont fix #7'
  expect fail '#7' 'Cant fix #7'
  expect fail '#7' 'Nothing here fixes #7'
  expect fail '#7' 'None of this fixes #7'
  expect fail 'https://gitlab.com/trueppm/trueppm/-/work_items/55' 'Does not fix https://gitlab.com/trueppm/trueppm/-/work_items/55'
  expect fail '#7' 'Does not close #7 <!-- closing -->'
  expect fail '#7' 'Does not close #7 (closing-ok is not set)'
  expect fail '#8' 'Does not close #7 and #8 closing-ok:#7'
  expect fail '#7' 'This hasnt been tested and wasnt reviewed so it fixes #7'
  # must pass
  expect pass - 'Closes #4922'
  expect pass - 'Refs #4883'
  expect pass - "fixes a bug in #4883's area"
  expect pass - 'Not ready yet. Closes #5'
  expect pass - "$(printf 'Not ready yet\nCloses #5')"
  expect pass - 'Closes #1, #2 and #3'
  expect pass - 'Fixes https://gitlab.com/trueppm/trueppm/-/issues/55'
  expect pass - 'Closes: #6'
  expect pass - '#4883 is out of scope'
  expect pass - 'No regression; closes #5'
  expect pass - 'No new deps, closes #7'
  expect pass - 'This is not a refactor and closes #7'
  expect pass - 'Do not merge until this closes #7'
  expect pass - 'No: Closes #7'
  expect pass - 'Does not close #7 <!-- closing-ok -->'
  expect pass - 'Does not close #7 closing-ok:#7'
  expect pass - 'Adds a unit test that fixes #7'
  expect pass - 'Uses a net client that fixes #7'
  expect pass - 'Knot fixes #7'
  expect pass - 'Adds a planet view that fixes #7'
  expect pass - 'Closes #5 (no changelog needed)'
  expect pass - "Merge branch 'fix/4883-thing' into 'main'"
  # commit range: a merge commit carrying negated default text is skipped; an
  # authored negated message fails.
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    git init -q -b trunk . && git config user.email t@t && git config user.name t
    git commit -q --allow-empty -m base
    git checkout -q -b topic
    git commit -q --allow-empty -m "chore: ok" -m "Closes #1"
    git checkout -q -b side
    git commit -q --allow-empty -m "side work"
    git checkout -q topic
    git merge -q --no-ff side -m "Merge branch 'side' into 'topic'" -m "does not fix #999"
  ) >/dev/null 2>&1
  if ! check_commits "$tmp" "trunk..topic" >/dev/null 2>&1; then
    echo "FAIL: clean commits (merge commit skipped) should pass" >&2; fails=$((fails + 1))
  fi
  git -C "$tmp" commit -q --allow-empty -m "fix: thing" -m "This does not fix #4883."
  if check_commits "$tmp" "trunk..topic" >/dev/null 2>&1; then
    echo "FAIL: negated commit message should fail" >&2; fails=$((fails + 1))
  fi
  rm -rf "$tmp"
  # merged-results range: HEAD is a synthetic merge carrying main's newer (negated)
  # commit; with SOURCE_BRANCH_SHA only the MR's own commits are scanned.
  tmp="$(mktemp -d)"
  local mbase mtip
  (
    cd "$tmp"
    git init -q -b trunk . && git config user.email t@t && git config user.name t
    git commit -q --allow-empty -m base
    git checkout -q -b topic
    git commit -q --allow-empty -m "feat: mine" -m "Closes #1"
    git checkout -q trunk
    git commit -q --allow-empty -m "other author" -m "This does not fix #4883."
    git checkout -q -b merged
    git merge -q --no-ff topic -m "Merge refs/merge-requests/1/head"
  ) >/dev/null 2>&1
  mbase="$(git -C "$tmp" rev-parse trunk~1)"; mtip="$(git -C "$tmp" rev-parse topic)"
  if CI_MERGE_REQUEST_DIFF_BASE_SHA="$mbase" CI_MERGE_REQUEST_SOURCE_BRANCH_SHA="$mtip" check_commits "$tmp" >/dev/null 2>&1; then :; else
    echo "FAIL: source-branch-sha range must exclude main's newer commit" >&2; fails=$((fails + 1))
  fi
  if CI_MERGE_REQUEST_DIFF_BASE_SHA="$mbase" check_commits "$tmp" >/dev/null 2>&1; then
    echo "FAIL: without SOURCE_BRANCH_SHA the HEAD range should include main's commit" >&2; fails=$((fails + 1))
  fi
  # unresolvable SOURCE_BRANCH_SHA: falls back to base..HEAD, which still catches main's negated commit
  if CI_MERGE_REQUEST_DIFF_BASE_SHA="$mbase" CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=1111111111111111111111111111111111111111 check_commits "$tmp" >/dev/null 2>&1; then
    echo "FAIL: unknown SOURCE_BRANCH_SHA must fall back and still catch a negated commit" >&2; fails=$((fails + 1))
  fi
  # nothing resolvable at all must fail closed, not pass
  if CI_MERGE_REQUEST_DIFF_BASE_SHA=2222222222222222222222222222222222222222 CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=1111111111111111111111111111111111111111 check_commits "$tmp" >/dev/null 2>&1; then
    echo "FAIL: unresolvable base and tip must fail, not pass silently" >&2; fails=$((fails + 1))
  fi
  rm -rf "$tmp"
  if [ "$fails" -ne 0 ]; then echo "self-test: ${fails} failure(s)" >&2; return 1; fi
  echo "self-test: all cases passed"
}

case "${1:-}" in
  --self-test)   self_test ;;
  --description) check_description ;;
  --title)       check_title ;;
  --commits)     check_commits "." ;;
  --file)        [ -f "${2:-}" ] || { echo "usage: --file <path>" >&2; exit 2; }
                 check_text "${2}" < "$2" ;;
  "")            rc=0; check_description || rc=1; check_title || rc=1; check_commits "." || rc=1; exit $rc ;;
  *)             echo "usage: $0 [--description|--title|--commits|--file F|--self-test]" >&2; exit 2 ;;
esac
