#!/usr/bin/env sh
# osv-severity-gate.sh — severity gate for the security:osv CI job.
#
# OSV-Scanner has no native severity threshold (confirmed on v2.3.8: no
# --severity / --fail-on / --audit-level flag), so it exits non-zero on *any*
# non-ignored advisory. That let a single fixable LOW (e.g. dompurify
# GHSA-c2j3-45gr-mqc4, CVSS 2.1) red-wall the whole pipeline (#2261).
#
# This gate reads OSV-Scanner's `--format json` output and classifies each
# advisory group:
#   - FAIL (exit 1)  → HIGH / CRITICAL: CVSS base score >= 7.0, or — when no
#                      CVSS score is published — the GitHub advisory label
#                      (database_specific.severity) is HIGH or CRITICAL.
#   - WARN (exit 2)  → MEDIUM / LOW / unscored: printed, non-blocking. The CI job
#                      maps exit 2 to `allow_failure` so the pipeline shows a
#                      yellow warning (surfacing dependency debt) instead of a
#                      silent green pass (#2358).
#
# Exit-code contract (the whole pipeline's OSV verdict):
#   0 → clean, no advisories survived suppression (green).
#   1 → HIGH/CRITICAL present, OR fail-safe (missing/empty/unparseable results):
#       the scan verdict is bad or the scan itself did not complete — block.
#   2 → only MEDIUM/LOW/unscored advisories — non-blocking warning (allow_failure).
#   3 → usage error (bad invocation). A hard block, kept distinct from 2 so a
#       misconfigured gate can never be mistaken for a benign warning.
#
# Accepted risks are still suppressed the same way as before, via per-directory
# osv-scanner.toml `IgnoredVulns`: OSV-Scanner drops those before writing the
# JSON, so a suppressed advisory never reaches this gate. This gate only decides
# *severity banding* for the advisories that survive suppression.
#
# Fail-safe: a missing or unparseable results file means the scan itself did not
# complete — that must block, not silently pass.
#
# Usage: sh scripts/osv-severity-gate.sh <osv-results.json>
set -eu

RESULTS="${1:-}"
if [ -z "$RESULTS" ]; then
  echo "osv-severity-gate: usage: sh scripts/osv-severity-gate.sh <osv-results.json>" >&2
  # exit 3 (not 2): a usage error must hard-block. Exit 2 is reserved for the
  # non-blocking MEDIUM/LOW warning the CI job allows to fail.
  exit 3
fi
if [ ! -s "$RESULTS" ]; then
  echo "osv-severity-gate: results file '$RESULTS' is missing or empty — treating as scan failure." >&2
  exit 1
fi

# Suppression-expiry warning (#4391). NON-BLOCKING: it prints to stderr and never
# changes the exit code. A suppression that has ALREADY expired is not listed as a
# pass here: OSV-Scanner stops honoring it, so its advisory reappears in the results
# and this gate fails it on severity below, exactly as before. This only tells
# people ahead of the date, instead of every pipeline going red on the same morning.
#
# Reads every `effectiveUntil` (PackageOverrides) and `ignoreUntil` (IgnoredVulns)
# date in packages/*/osv-scanner.toml, which covers web, website, mobile, api and
# scheduler. Knobs, mainly for the self-test: OSV_SUPPRESSION_ROOT (default ".")
# is the repo root, OSV_TODAY (YYYY-MM-DD) overrides the clock, and
# OSV_EXPIRY_WARN_DAYS (default 30) is the warning window.
warn_expiring_suppressions() {
  root="${OSV_SUPPRESSION_ROOT:-.}"
  today="${OSV_TODAY:-$(date -u +%Y-%m-%d)}"
  window="${OSV_EXPIRY_WARN_DAYS:-30}"
  found=""
  for toml in "$root"/packages/*/osv-scanner.toml; do
    [ -f "$toml" ] || continue
    # One "<line>\t<key>\t<date>\t<package or id>" record per dated entry; the
    # label is the nearest preceding name/id inside the same [[table]] block.
    entries="$(awk '
      /^\[\[/ { label = "" }
      /^(name|id)[ \t]*=/ { split($0, a, "\""); label = a[2] }
      /^(effectiveUntil|ignoreUntil)[ \t]*=[ \t]*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ {
        key = $1; d = $0; sub(/^[^=]*=[ \t]*/, "", d); sub(/[^0-9-].*$/, "", d)
        printf "%d\t%s\t%s\t%s\n", NR, key, d, label
      }' "$toml")"
    [ -n "$entries" ] || continue
    rel="${toml#"$root"/}"
    report="$(printf '%s\n' "$entries" | jq -Rr --arg today "$today" --argjson window "$window" --arg file "$rel" '
      split("\t") as $f
      | (($f[2] + "T00:00:00Z" | fromdate) - ($today + "T00:00:00Z" | fromdate)) / 86400 | floor as $days
      | select($days <= $window)
      | (if $days < 0 then "EXPIRED \(-$days)d ago" else "expires in \($days)d" end) as $when
      | "  \($file):\($f[0])  \($f[3])  \($f[1]) = \($f[2])  (\($when))"' 2>/dev/null)" || report=""
    [ -z "$report" ] || found="${found}${report}
"
  done
  if [ -n "$found" ]; then
    {
      echo "osv-severity-gate: WARNING — OSV suppressions expiring within ${window} days (or already expired):"
      printf '%s' "$found"
      echo "  Re-triage each: drop it if the lockfile now resolves a patched version, else extend it"
      echo "  with a fresh date tied to its tracking issue. Expired entries stop suppressing and fail"
      echo "  this gate when the advisory is HIGH/CRITICAL."
      echo ""
    } >&2
  fi
}
warn_expiring_suppressions

# jq filter: flatten OSV JSON to one record per advisory group. The numeric
# severity is group.max_severity (a CVSS base score string, "" when unscored).
# The fallback label is the max database_specific.severity across the group's
# member vulnerabilities (matched by id OR alias). A group FAILs when the CVSS
# score is >= 7.0, or (unscored) the label is HIGH/CRITICAL.
# shellcheck disable=SC2016  # $-vars below are jq variables, not shell — single-quote intentionally.
FILTER='
[ .results[]
  | .source.path as $src
  | .packages[]
  | .package as $pkg
  | (.vulnerabilities // []) as $vulns
  | (.groups // [])[]
  | . as $g
  | ((.max_severity // "") | if . == "" then null else tonumber end) as $cvss
  | ([ $vulns[]
       | select(([.id] + (.aliases // [])) as $names
                | ($g.ids // []) | any(. as $id | $names | index($id)))
       | (.database_specific.severity // "" | ascii_upcase) ]) as $labels
  | (($cvss != null and $cvss >= 7.0)
     or ($labels | any(. == "HIGH" or . == "CRITICAL"))) as $fail
  | { src: $src, pkg: $pkg.name, version: $pkg.version,
      ids: ($g.ids | join(",")),
      cvss: ($cvss // "n/a"),
      label: ($labels | map(select(. != "")) | (first // "UNSCORED")),
      bucket: (if $fail then "FAIL" else "WARN" end) }
]'

FINDINGS="$(jq -c "$FILTER" "$RESULTS")" || {
  echo "osv-severity-gate: could not parse '$RESULTS' as OSV-Scanner JSON." >&2
  exit 1
}

TOTAL="$(printf '%s' "$FINDINGS" | jq 'length')"
FAILS="$(printf '%s' "$FINDINGS" | jq '[.[] | select(.bucket == "FAIL")] | length')"
WARNS="$(printf '%s' "$FINDINGS" | jq '[.[] | select(.bucket == "WARN")] | length')"

if [ "$TOTAL" -eq 0 ]; then
  echo "osv-severity-gate: no advisories — clean."
  exit 0
fi

echo "osv-severity-gate: $TOTAL advisory group(s) — $FAILS blocking (HIGH/CRITICAL), $WARNS warning (MEDIUM/LOW)."
echo ""
printf '%-6s  %-9s  %-24s  %-6s  %-9s  %s\n' "BUCKET" "SEVERITY" "PACKAGE@VERSION" "CVSS" "SOURCE" "ADVISORY"
printf '%s' "$FINDINGS" | jq -r '
  sort_by(.bucket == "WARN", .cvss)
  | .[]
  | [ .bucket, .label, (.pkg + "@" + .version),
      (.cvss | tostring), (.src | sub(".*/"; "")), .ids ]
  | @tsv' \
  | while IFS="$(printf '\t')" read -r bucket label pv cvss src ids; do
      printf '%-6s  %-9s  %-24s  %-6s  %-9s  %s\n' "$bucket" "$label" "$pv" "$cvss" "$src" "$ids"
    done
echo ""

if [ "$FAILS" -gt 0 ]; then
  echo "osv-severity-gate: FAIL — $FAILS HIGH/CRITICAL advisory group(s) block the pipeline." >&2
  echo "Fix the dependency, or (only for an accepted risk) add a documented, expiring" >&2
  echo "IgnoredVulns entry to the relevant packages/*/osv-scanner.toml." >&2
  exit 1
fi

echo "osv-severity-gate: WARN — only MEDIUM/LOW advisories present (non-blocking)." >&2
# exit 2: the CI job maps this to allow_failure, so the pipeline shows a yellow
# warning rather than a green pass — the debt is visible but does not block.
exit 2
