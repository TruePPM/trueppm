#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-config-doc-links.sh — every doc link in a configuration file must
# resolve to a page and anchor that exist (#3190).
#
# The two files an operator edits — packages/helm/values.yaml and .env.example —
# carried ZERO documentation links between them. Their only `https://` strings
# were example values, and the one pointer that existed read
# `Full variable list: docs/administration/configuration.` — no scheme, no host,
# and a trailing period that reads as part of the path. From inside a values
# file on someone's disk, a site-relative path resolves to nothing.
#
# Now that they carry absolute links, the failure mode moves: a link to an
# anchor that does not exist is worse than no link, because it looks
# authoritative. This checks every one against the actual Markdown.
#
# Anchors are derived the way Starlight/GitHub derive them: lowercase, strip
# anything that is not alphanumeric/space/hyphen, spaces to hyphens.
#
# Exit codes:
#   0  every link resolves
#   1  a link points at a missing page or anchor
#   2  invocation / setup error
#
# Modes:
#   bash scripts/check-config-doc-links.sh             # check
#   bash scripts/check-config-doc-links.sh --self-test # prove it can fail
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_ROOT="packages/website/src/content/docs"
SITE="https://docs.trueppm.com"

CHECKED_FILES=(
  "packages/helm/values.yaml"
  ".env.example"
)

# Derive every anchor a page defines, one per line, on stdout.
#
# Deliberately a command substitution feeding a pure-bash match rather than a
# `... | grep -qx` pipeline: `grep -q` exits the moment it matches, which SIGPIPEs
# the upstream `sed` mid-write, and under `set -o pipefail` that 141 became the
# pipeline's status — reporting a *present* anchor as missing. It only fired when
# the match came early enough that sed still had output left to write, so it hit
# anchors near the top of a long page and not the ones near the bottom, and the
# outcome depended on pipe-buffer timing rather than on the input (#3190).
page_anchors() {
  sed -n 's/^#\{1,6\} \(.*\)$/\1/p' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/`//g; s/[^a-z0-9 -]//g; s/ /-/g'
}

run_check() {
  local root="$1" violations=0 links=0 file url path anchor md
  local cached_md="" cached_anchors=""

  for file in "${CHECKED_FILES[@]}"; do
    [ -f "$root/$file" ] || { echo "ERROR: $file not found" >&2; return 2; }
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      links=$((links + 1))
      path="${url#"$SITE"}"
      anchor=""
      case "$path" in
        *\#*) anchor="${path#*#}"; path="${path%%#*}" ;;
      esac
      path="${path#/}"; path="${path%/}"
      md="$root/$DOCS_ROOT/$path.md"
      if [ ! -f "$md" ]; then
        echo "VIOLATION: $file links to $url — no such page ($DOCS_ROOT/$path.md)"
        violations=$((violations + 1))
        continue
      fi
      [ -n "$anchor" ] || continue
      # Anchors are derived per page and cached: the same page is linked many
      # times, and re-deriving per link is what made the pipeline above hot
      # enough for the SIGPIPE race to show.
      if [ "$md" != "$cached_md" ]; then
        cached_anchors="$(page_anchors "$md")"
        cached_md="$md"
      fi
      # Pure-bash membership test — no pipeline, so nothing can exit early and
      # turn a found anchor into a signal.
      case $'\n'"$cached_anchors"$'\n' in
        *$'\n'"$anchor"$'\n'*) ;;
        *)
          echo "VIOLATION: $file links to $url — the page exists, the anchor '#$anchor' does not"
          violations=$((violations + 1))
          ;;
      esac
    done < <(grep -oh "${SITE}[A-Za-z0-9/#_-]*" "$root/$file" || true)
  done

  if [ "$violations" -gt 0 ]; then
    echo >&2
    echo "ERROR: $violations broken documentation link(s) in configuration files." >&2
    echo "A link that looks authoritative and 404s is worse than no link (#3190)." >&2
    return 1
  fi
  echo "OK: all $links documentation link(s) in ${#CHECKED_FILES[@]} configuration file(s) resolve."
  return 0
}

self_test() {
  local tmp status
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  mkdir -p "$tmp/$DOCS_ROOT/administration" "$tmp/packages/helm"

  # The FIRST heading is the one that matters: the anchor a link resolves to
  # early in a long page is the case the old `grep -q` pipeline got wrong, so the
  # fixture needs enough trailing headings that an early match leaves the
  # upstream `sed` still writing. A three-line page cannot reproduce it — which
  # is why the self-test passed while the real gate failed on real pages (#3190).
  {
    printf '# Configuration\n\n## Required in production\n'
    for i in $(seq 1 200); do printf '\n## Filler section %s\n' "$i"; done
    printf '\n## Object storage (S3 / MinIO)\n'
  } > "$tmp/$DOCS_ROOT/administration/configuration.md"

  # Case 1: a good page + anchor must pass.
  printf '# %s/administration/configuration/#object-storage-s3--minio\n' "$SITE" \
    > "$tmp/packages/helm/values.yaml"
  : > "$tmp/.env.example"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  [ "$status" -eq 0 ] || { echo "SELF-TEST FAIL: a valid link was rejected (exit $status)" >&2; return 1; }

  # Case 1b: the same, but for an anchor at the TOP of the page. This is the
  # regression: a present anchor reported missing because the match came early.
  # Run it repeatedly — the old failure was a pipe-timing race, not a constant.
  printf '# %s/administration/configuration/#required-in-production\n' "$SITE" \
    > "$tmp/packages/helm/values.yaml"
  for _ in 1 2 3 4 5; do
    status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
    [ "$status" -eq 0 ] || {
      echo "SELF-TEST FAIL: a valid link to the page's FIRST heading was rejected (exit $status) — the SIGPIPE race is back (#3190)" >&2
      return 1
    }
  done

  # Case 2: a missing anchor must fail.
  printf '# %s/administration/configuration/#no-such-section\n' "$SITE" \
    > "$tmp/packages/helm/values.yaml"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  [ "$status" -eq 1 ] || { echo "SELF-TEST FAIL: a missing anchor exited $status, expected 1" >&2; return 1; }

  # Case 3: a missing page must fail.
  printf '# %s/administration/nonexistent/\n' "$SITE" > "$tmp/packages/helm/values.yaml"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  [ "$status" -eq 1 ] || { echo "SELF-TEST FAIL: a missing page exited $status, expected 1" >&2; return 1; }

  # Case 4: a checked file that has moved must ERROR, not silently pass.
  rm "$tmp/.env.example"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  [ "$status" -eq 2 ] || { echo "SELF-TEST FAIL: a missing config file exited $status, expected 2" >&2; return 1; }

  echo "SELF-TEST OK: valid link accepted (including a first-heading anchor, 5x); missing anchor, missing page, and missing file all caught."
}

case "${1:-}" in
  --self-test) self_test ;;
  "")          run_check "$REPO_ROOT" ;;
  *)           echo "usage: $0 [--self-test]" >&2; exit 2 ;;
esac
