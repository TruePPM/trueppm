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
#   0 -> every evaluable check scored >= threshold.
#   2 -> one or more checks scored below the threshold (warning).
#   1 -> results file missing/empty/unparseable: the scan did not complete.
#   3 -> usage error.
# A check scoring -1 means "not applicable / could not be evaluated" (Scorecard
# prints it as "?"). It is listed as n/a and never counted as low.
#
# Usage: sh scripts/scorecard-report.sh <scorecard.json> [threshold, default 5]
set -eu

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
jq -r '.checks | sort_by(.score)[]
  | (if .score < 0 then "  n/a" else (.score | tostring | ("    " + .) | .[-4:]) end)
    + "  " + .name + " - " + .reason' "$RESULTS"
echo

LOW="$(jq -r --argjson t "$THRESHOLD" \
  '.checks[] | select(.score >= 0 and .score < $t) | "  " + (.score|tostring) + "/10  " + .name + " - " + .reason' "$RESULTS")"
NA="$(jq -r '[.checks[] | select(.score < 0) | .name] | join(", ")' "$RESULTS")"
[ -n "$NA" ] && echo "Not evaluable on this target: $NA"

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
echo "All evaluable checks scored >= $THRESHOLD/10."
