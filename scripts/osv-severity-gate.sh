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
#   - WARN (exit 0)  → MEDIUM / LOW / unscored: printed but non-blocking.
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
  exit 2
fi
if [ ! -s "$RESULTS" ]; then
  echo "osv-severity-gate: results file '$RESULTS' is missing or empty — treating as scan failure." >&2
  exit 1
fi

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

echo "osv-severity-gate: PASS — only MEDIUM/LOW advisories present (non-blocking)."
exit 0
