#!/usr/bin/env sh
# scorecard-report.sh — human-readable summary + warn verdict for the
# security:scorecard CI job (#4644).
#
# Scorecard's own table is useful but it never says "this is bad": a job that
# scores 0 on SAST and 0 on Fuzzing still exits 0, and a green allow_failure
# job reads as a pass. This script reads Scorecard's `--format json` output,
# prints one line per check, and prints a loud banner naming every check below
# the threshold, so the log states the posture plainly.
#
# Exit-code contract (the CI job maps 2 to a non-blocking orange warning; the
# job is allow_failure: true, so no code here can block a pipeline):
#   0 -> every evaluable, non-waived check scored >= threshold.
#   2 -> one or more non-waived checks scored below the threshold (warning).
#   1 -> results file missing/empty/unparseable: the scan did not complete.
#   3 -> usage error.
# A check scoring -1 means "not applicable / could not be evaluated" (Scorecard
# prints it as "?"). It is listed as n/a and never counted as low.
# A check named in WAIVERS below is a known Scorecard blind spot on a
# GitLab-hosted repo: it is still printed (marked [waived: reason]) but does not
# count toward the exit-2 verdict. A waived check that scores >= threshold prints
# normally, so a future Scorecard that can see it is visible.
#
# Usage: sh scripts/scorecard-report.sh <scorecard.json> [threshold, default 5]
set -eu

# Known-blind waivers (#4681): check name -> reason. Adding or removing one is a
# one-line edit. Revisit on every Scorecard version bump (SCORECARD_VERSION in
# .gitlab-ci.yml): a waiver outlives its reason the moment detection improves.
WAIVERS='{
  "Fuzzing": "Hypothesis property-based fuzz suites in packages/scheduler/tests are not counted by Scorecard local-mode detection",
  "SAST": "semgrep and bandit run in GitLab CI and CodeQL on the GitHub mirror; Scorecard only detects SAST from GitHub workflow files and check runs"
}'

RESULTS="${1:-}"
THRESHOLD="${2:-5}"
if [ -z "$RESULTS" ]; then
  echo "scorecard-report: usage: sh scripts/scorecard-report.sh <scorecard.json> [threshold]" >&2
  exit 3
fi
if [ ! -s "$RESULTS" ] || ! jq -e '.checks | type == "array"' "$RESULTS" >/dev/null 2>&1; then
  echo "scorecard-report: $RESULTS is missing, empty, or not Scorecard JSON; the scan did not complete." >&2
  exit 1
fi

echo "OpenSSF Scorecard: $(jq -r '.repo.name' "$RESULTS") (scorecard $(jq -r '.scorecard.version' "$RESULTS"))"
echo "Aggregate score: $(jq -r '.score' "$RESULTS") / 10 (only evaluable checks contribute)"
echo
jq -r --argjson w "$WAIVERS" --argjson t "$THRESHOLD" '.checks | sort_by(.score)[]
  | (if .score < 0 then "  n/a" else (.score | tostring | ("    " + .) | .[-4:]) end)
    + "  " + .name + " - " + .reason
    + (if .score >= 0 and .score < $t and ($w[.name] != null) then " [waived: " + $w[.name] + "]" else "" end)' "$RESULTS"
echo

LOW="$(jq -r --argjson t "$THRESHOLD" --argjson w "$WAIVERS" \
  '.checks[] | select(.score >= 0 and .score < $t and ($w[.name] == null)) | "  " + (.score|tostring) + "/10  " + .name + " - " + .reason' "$RESULTS")"
WAIVED="$(jq -r --argjson t "$THRESHOLD" --argjson w "$WAIVERS" \
  '[.checks[] | select(.score >= 0 and .score < $t and ($w[.name] != null)) | .name] | join(", ")' "$RESULTS")"
NA="$(jq -r '[.checks[] | select(.score < 0) | .name] | join(", ")' "$RESULTS")"
if [ -n "$NA" ]; then echo "Not evaluable on this target: $NA"; fi
if [ -n "$WAIVED" ]; then echo "Waived (known Scorecard blind spot on GitLab, not counted): $WAIVED"; fi

if [ -n "$LOW" ]; then
  echo
  echo "################################################################"
  echo "WARNING: OpenSSF Scorecard checks scored below $THRESHOLD/10."
  echo "This job is report-only (allow_failure), so a non-green result here"
  echo "does NOT block the pipeline, and a green job is NOT a pass."
  echo "################################################################"
  echo "$LOW"
  exit 2
fi
echo "All evaluable, non-waived checks scored >= $THRESHOLD/10."
