#!/bin/sh
# scripts/resolve-prev-web-image.sh — pick the published web image whose hashed
# assets a new web image must also serve (ADR-1249, #4341), and print it pinned
# by digest.
#
# Why. A browser tab opened before an upgrade still holds the old release's
# index.html, which names that release's content-hashed chunks. The next lazy
# route it visits asks the NEW pods for an OLD chunk. ADR-1249 has every web
# image carry the previous release's assets/ so that request is served. This
# script decides what "the previous release" is. packages/web/Dockerfile copies
# from whatever it prints (build arg PREV_WEB_IMAGE).
#
# Rule (ADR-1249 Decision step 3). The highest published SemVer tag below HEAD.
# That is the latest tag in HEAD's own major.minor line when one exists
# (0.4.0-beta.8 -> 0.4.0-beta.7), else the latest tag of the previous line (the
# first 1.3.0 -> the last 1.2.x). Both cases fall out of one SemVer comparison,
# since every tag in a line outranks every tag of an older line. The log line
# says which case applied.
#
#   --below <v>        strictly below <v>. For a release publish: HEAD's own tag
#                      may already be on the registry (a re-run job), and an
#                      image must never inherit from itself.
#   --at-or-below <v>  <v> itself counts. For per-commit builds (MR/main drills,
#                      the smoke probes), where <v> is packages/web/package.json's
#                      version, which is the LAST cut release, so the commit under
#                      test is the release that will follow it. This matches
#                      scripts/helm-install-drill.sh's resolve_previous_chart_version,
#                      so the demo-upgrade drill's pre-upgrade release and the
#                      image's inherited assets are the same release.
#
# Withdrawn releases are dropped first (SKIP_PREV_WEB_VERSIONS, whitespace-
# separated). 0.4.0-beta.7 blank-screened every visitor and installs were rolled
# back to beta.6, so nobody holds beta.7's index.html; carrying its assets would
# help no one, while dropping beta.6's would strand every tab that is actually
# out there. Same list, same default, same reason as SKIP_PREV_CHART_VERSIONS in
# helm-install-drill.sh (#4346). `-` not `:-`, so a test can set it empty.
#
# Nothing published below HEAD (the first-ever release) prints nothing and
# exits 0 with a logged "no prior assets": the build then carries only its own
# assets, which is correct, not a failure. An UNREADABLE registry is different:
# it exits 1. Building without prior assets because a network call failed
# would silently ship the blank screen ADR-1249 exists to remove.
#
# Output: one line on stdout, "<registry>/<repo>@sha256:<digest>", or nothing.
# All logging goes to stderr, so `PREV=$(resolve-prev-web-image.sh ...)` works.
# The digest is the multi-arch index digest, so the amd64 and arm64 publish legs
# share one value and each build pulls its own platform from it.
#
# Env:  WEB_REGISTRY_HOST       default ghcr.io
#       WEB_IMAGE_REPO          default trueppm/web
#       SKIP_PREV_WEB_VERSIONS  default 0.4.0-beta.7 (set empty to disable)
#       WEB_TAGS                whitespace-separated tag list; skips the network
#                               tag read (tests)
#       WEB_DIGEST              skips the network digest read (tests)
#
# Portability: POSIX sh + curl + awk/sed/grep/tr. Runs in docker:27 (BusyBox)
# and on the macOS arm64 shell runner (BSD tools).
#
# Usage: scripts/resolve-prev-web-image.sh --below|--at-or-below <version>

set -eu

log() { echo "resolve-prev-web-image: $*" >&2; }
die() { echo "resolve-prev-web-image: ERROR: $*" >&2; exit 1; }

case "${1:-}" in
    --below) inclusive=0 ;;
    --at-or-below) inclusive=1 ;;
    *) die "usage: resolve-prev-web-image.sh --below|--at-or-below <version>" ;;
esac
head_version="${2:-}"
head_version="${head_version#v}"
printf '%s\n' "$head_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
    || die "'${2:-}' is not a SemVer version"

host="${WEB_REGISTRY_HOST:-ghcr.io}"
repo="${WEB_IMAGE_REPO:-trueppm/web}"
token=""

registry_token() {
    [ -n "$token" ] && return 0
    token="$(curl -fsS --max-time 30 --retry 3 \
        "https://${host}/token?scope=repository:${repo}:pull" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" \
        || die "could not get an anonymous pull token from ${host} for ${repo}"
    [ -n "$token" ] || die "empty pull token from ${host} for ${repo}"
}

if [ "${WEB_TAGS+set}" = set ]; then
    # shellcheck disable=SC2086 # splitting the whitespace-separated list is the point
    tags="$(printf '%s\n' $WEB_TAGS)"
else
    registry_token
    body="$(curl -fsS --max-time 30 --retry 3 -H "Authorization: Bearer ${token}" \
        "https://${host}/v2/${repo}/tags/list?n=1000")" \
        || die "could not read the tag list for ${host}/${repo}"
    tags="$(printf '%s' "$body" | sed -n 's/.*"tags":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '"')"
fi

# Release tags only. The per-arch legs (`0.4.0-beta.6-amd64`) are SemVer-shaped
# too, as prerelease "beta.6-amd64", so they are dropped by name; so are cosign
# `sha256-*` tags and the smoke/latest tags, which are not SemVer at all.
versions="$(printf '%s\n' "$tags" \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
    | grep -Ev -- '-(amd64|arm64)$' || true)"

# TODO(#4347): drop this default together with SKIP_PREV_CHART_VERSIONS'. The
# two must change in the same commit: the demo-upgrade drill asserts HEAD serves
# the assets of the release it installed first, so they must name the same one.
skip="${SKIP_PREV_WEB_VERSIONS-0.4.0-beta.7}"
for v in $skip; do
    versions="$(printf '%s\n' "$versions" | grep -vxF -- "$v" || true)"
done

# SemVer 2.0.0 precedence in POSIX awk, the same function as
# helm-install-drill.sh: GNU `sort -V` ranks 0.4.0 below 0.4.0-beta.1, and
# BusyBox sort has no -V at all.
prev="$(printf '%s\n' "$versions" | awk -v head="$head_version" -v incl="$inclusive" '
    function isnum(s) { return s ~ /^[0-9]+$/ }
    function cmp(a, b,    ac, bc, ap, bp, i, n, x, y, na, nb, xa, ya) {
      ac = a; ap = ""; if ((i = index(a, "-")) > 0) { ac = substr(a, 1, i - 1); ap = substr(a, i + 1) }
      bc = b; bp = ""; if ((i = index(b, "-")) > 0) { bc = substr(b, 1, i - 1); bp = substr(b, i + 1) }
      split(ac, x, "."); split(bc, y, ".")
      for (i = 1; i <= 3; i++) { if (x[i] + 0 != y[i] + 0) return (x[i] + 0 < y[i] + 0) ? -1 : 1 }
      if (ap == bp) return 0
      if (ap == "") return 1
      if (bp == "") return -1
      na = split(ap, xa, "."); nb = split(bp, ya, ".")
      n = (na < nb) ? na : nb
      for (i = 1; i <= n; i++) {
        if (xa[i] == ya[i]) continue
        if (isnum(xa[i]) && isnum(ya[i])) return (xa[i] + 0 < ya[i] + 0) ? -1 : 1
        if (isnum(xa[i])) return -1
        if (isnum(ya[i])) return 1
        return (xa[i] < ya[i]) ? -1 : 1
      }
      return (na < nb) ? -1 : (na > nb) ? 1 : 0
    }
    NF { c = cmp($0, head); if ((c < 0 || (incl == 1 && c == 0)) && (best == "" || cmp($0, best) > 0)) best = $0 }
    END { print best }
')"

if [ -z "$prev" ]; then
    if [ "$inclusive" -eq 1 ]; then rel="at or below"; else rel="below"; fi
    log "no prior assets: no published web image ${rel} ${head_version} in ${host}/${repo} (skipped: ${skip:-none}) — building with no prior assets"
    exit 0
fi

line() { printf '%s\n' "$1" | cut -d. -f1-2; }
if [ "$(line "$prev")" = "$(line "$head_version")" ]; then
    which="same $(line "$head_version").x line"
else
    which="previous-line fallback: nothing in $(line "$head_version").x below HEAD"
fi

if [ -n "${WEB_DIGEST:-}" ]; then
    digest="$WEB_DIGEST"
else
    registry_token
    digest="$(curl -fsS --max-time 30 --retry 3 -o /dev/null -D - \
        -H "Authorization: Bearer ${token}" \
        -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
        "https://${host}/v2/${repo}/manifests/${prev}" \
        | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest:[[:space:]]*//p')" \
        || die "could not read the manifest digest of ${host}/${repo}:${prev}"
fi
printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' \
    || die "registry returned no usable digest for ${host}/${repo}:${prev} (got '${digest}')"

log "prior web image = ${host}/${repo}:${prev} (${which}; skipped: ${skip:-none}) -> ${digest}"
printf '%s/%s@%s\n' "$host" "$repo" "$digest"
