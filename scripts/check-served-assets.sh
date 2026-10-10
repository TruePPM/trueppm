#!/bin/sh
# scripts/check-served-assets.sh — prove a running web tier serves every asset
# its own index.html asks the browser to load (#4338).
#
# Why this exists. nginx's SPA fallback (`try_files $uri $uri/ /index.html`)
# answers a request for a file that is not there with index.html, status 200,
# Content-Type text/html. A browser loading that "file" as an ES module or a
# stylesheet refuses it under strict MIME checking, the module graph never
# resolves, and the app blank-screens for every visitor. Every signal short of a
# browser reads green: the status is 200, the pod is Ready, the image scanned
# clean. try.trueppm.com blank-screened this way on the 0.4.0-beta.7 rollout,
# and nothing in web:publish (build -> Trivy -> SBOM -> push) or any drill
# ever fetched an asset from a running web tier.
#
# What it checks. Fetch <base_url>/, collect every same-origin
#   <script src>, <link rel="modulepreload" href>, <link rel="stylesheet" href>
# and fetch each one. An asset passes only if it returns HTTP 2xx, a non-empty
# body, and the content type the browser will insist on: JavaScript for a
# script or modulepreload, text/css for a stylesheet. So the SPA fallback (200,
# text/html) fails, which is the whole point. A page that references NO assets
# also fails — an empty list would otherwise pass vacuously against, say, a JSON
# error page.
#
# index.html only names what it eagerly loads. A route rendered behind a lazy
# `import()` — and never `modulepreload`d — is never named there, so the checks
# above cannot see a missing lazy chunk either (#4341 residual gap, filed against
# #4338). To close that, also fetch <base_url>/asset-manifest.json — Vite's
# `build.manifest` output (packages/web/vite.config.ts), which lists every chunk
# and asset the build produced regardless of how it is loaded — and fetch every
# "assets/…" path named in it (entry `file`, `css[]`, and any other referenced
# asset), deduplicated against what the index.html pass already fetched. A
# missing or unparseable manifest, or one naming zero files, is a FAIL, not a
# vacuous pass: it means this check can no longer see lazy chunks at all. A
# manifest entry that is neither JS nor CSS (a font, an image) passes on 2xx +
# non-empty + a non-HTML content type, since its real MIME type is not something
# this script can predict from the manifest alone.
#
# SERVED_ASSETS_MANIFEST=0 skips the manifest fetch/verify step entirely,
# leaving the index.html pass and the missing-path 404 probe in place. This
# exists for exactly one caller: a drill leg that points this script at a
# previously-published image predating the manifest feature (#4341) itself —
# that image never had an asset-manifest.json to find, which is a fact about
# the fixed point in history being probed, not a regression this script
# should report (scripts/helm-install-drill.sh's demo-upgrade PRE-upgrade
# leg). Every other caller leaves it at the default (on).
#
# Prior-release pass (ADR-1249). A tab opened before an upgrade still holds the
# PREVIOUS release's index.html and asks the new tier for that release's
# hashed chunks; the web image carries them so the request is served. Set
# SERVED_ASSETS_PRIOR_DIR to a local copy of the previous release's html root
# and every file it names must also be served by THIS tier, with the same
# per-type checks as above. What it names: the files in its asset-files.json
# (every file that build put under assets/, from vite.config.ts); or, for a
# release built before that list existed (0.4.0-beta.6 and beta.7), the files
# under its assets/ (names are all that is read, so empty placeholder files are
# fine). Its asset-manifest.json is deliberately NOT the reference: Vite's
# manifest omits the CPM worker chunk, so a tab open before the upgrade would
# lose its worker unseen. A directory with neither, or
# SERVED_ASSETS_PRIOR_DIR set but empty (no prior release resolved), logs the
# pass as SKIPPED with the reason, never as passed. SERVED_ASSETS_PRIOR_REQUIRED=1
# turns that skip into a FAIL, for a caller that knows a prior release exists.
# Unset, the pass does not run and prints nothing.
#
# Cross-origin references are skipped and counted, never fetched.
#
# Mixed-version serving. A tier where some replicas serve one build and some
# another (a stuck or in-flight rolling update) passes or fails this check by
# load-balancer luck. SERVED_ASSETS_ROUNDS=N repeats the whole check N times —
# index.html included, since the index can come from either build — which turns
# that luck into a probability a drill can drive toward certainty. Driven for
# real against a live Service (not FIXTURE_DIR), each round is a fresh
# connection that kube-proxy can route to a different backend pod, so this is
# also what scripts/helm-install-drill.sh's demo-upgrade leg uses, from an
# in-cluster pod, to observe a rolling update mid-flight (#4353).
#
# Portability. POSIX sh + tr/sed/grep/sort/wc only, no GNU-only flags: it runs
# in docker:27 (BusyBox), on the macOS arm64 shell runner (BSD tools), inside
# the Helm drill environment's own job container, AND inside the chart's API
# image via `kubectl exec` (#4353) — which has no curl, only the python3 every
# container here already needs to boot Django. fetch_url therefore prefers
# curl when present and falls back to python3's urllib otherwise; see
# SERVED_ASSETS_FETCHER below to force one or the other.
#
# Usage:  scripts/check-served-assets.sh <base_url>
#         scripts/check-served-assets.sh --self-test
# Env:    SERVED_ASSETS_ROUNDS    repeat the full check N times (default 1)
#         SERVED_ASSETS_TIMEOUT   per-request timeout in seconds, curl
#                                 --max-time or the python3 fallback's
#                                 urlopen(timeout=) (default 20)
#         SERVED_ASSETS_MANIFEST  set to 0 to skip the asset-manifest.json pass,
#                                 for probing a pre-#4341 image with no manifest
#                                 (default 1)
#         SERVED_ASSETS_MISSING_PROBE  0 skips the missing-/assets/-path 404 probe
#                                 (default 1). Only for a tier known to predate
#                                 #4341, e.g. a drill's previously published chart.
#         SERVED_ASSETS_PRIOR_DIR the previous release's html root; enables the
#                                 prior-release pass (ADR-1249)
#         SERVED_ASSETS_PRIOR_REQUIRED  1 fails, rather than skips, a prior-release
#                                 pass with nothing to check (default 0)
#         SERVED_ASSETS_FETCHER   "curl" or "python3" to force that HTTP client
#                                 in fetch_url instead of the curl-else-python3
#                                 auto-detect (default unset = auto). Exists so
#                                 --self-test can exercise both backends
#                                 deterministically regardless of which the
#                                 calling environment happens to have; a real
#                                 caller should leave it unset.
# Exit:   0 every asset served correctly · 1 at least one asset failed, or the
#         page referenced none · 2 usage error, or index.html not fetchable

set -eu

TIMEOUT="${SERVED_ASSETS_TIMEOUT:-20}"
MISSING_PROBE="${SERVED_ASSETS_MISSING_PROBE:-1}"

# The fixture directory, set only by --self-test. When non-empty, fetch_url
# answers from files on disk with nginx-SPA semantics instead of the network, so
# the verdict logic is exercised in the job's own image with no server.
FIXTURE_DIR=""
FIXTURE_ORIGIN="http://fixture.invalid"
# Mixed-release fixture (self-test only). When FIXTURE_B_DIR is set, a request
# counter in FIXTURE_COUNTER picks the "replica": the first FIXTURE_SKEW_AFTER
# requests all land on build A (FIXTURE_DIR), and every request after that
# alternates B, A, B, ... — a load balancer that a single pass happened to pin
# to one replica, and the next pass did not. A file, not a variable: fetch_url
# runs inside $(...), so a shell counter would never advance.
FIXTURE_B_DIR=""
FIXTURE_COUNTER=""
FIXTURE_SKEW_AFTER=0
# Self-test only: when 1, a missing /assets/ path gets the SPA fallback (200
# text/html) instead of a real 404 — the pre-#4341 nginx behavior.
FIXTURE_SPA_FALLBACK=0

# fetch_url <url> <body-file> — writes the body, prints "<status>|<content-type>".
fetch_url() {
    if [ -n "$FIXTURE_DIR" ]; then
        _p="${1#"$FIXTURE_ORIGIN"}"
        [ -n "$_p" ] && [ "$_p" != "/" ] || _p="/index.html"
        _root="$FIXTURE_DIR"
        if [ -n "$FIXTURE_B_DIR" ]; then
            _n=$(($(cat "$FIXTURE_COUNTER") + 1))
            echo "$_n" > "$FIXTURE_COUNTER"
            if [ "$_n" -gt "$FIXTURE_SKEW_AFTER" ] && [ $(((_n - FIXTURE_SKEW_AFTER) % 2)) -eq 1 ]; then
                _root="$FIXTURE_B_DIR"
            fi
        fi
        _f="$_root$_p"
        case "$_p" in
            /assets/does-not-exist-*)
                if [ "$FIXTURE_SPA_FALLBACK" -ne 1 ]; then : > "$2"; echo "404|text/html"; return 0; fi
                ;;
            # A real `try_files $uri =404` — what a correct /assets/ block does.
            */gone-*) : > "$2"; echo "404|text/html"; return 0 ;;
        esac
        if [ -f "$_f" ]; then
            cp "$_f" "$2"
            case "$_p" in
                *wrongtype*) echo "200|text/plain" ;;
                *.js | *.mjs) echo "200|application/javascript" ;;
                *.css) echo "200|text/css" ;;
                *.json) echo "200|application/json" ;;
                # A manifest-only asset type (font/image) reached only through
                # a dynamic import, never modulepreloaded (#4341) — simulated
                # here as svg. Anything that exists and is none of the above
                # gets a generic non-HTML type: only a MISSING file (the else
                # branch below) ever simulates the SPA fallback's text/html.
                *.svg) echo "200|image/svg+xml" ;;
                *.html) echo "200|text/html" ;;
                *) echo "200|application/octet-stream" ;;
            esac
        else
            # The SPA fallback this script exists to catch.
            cp "$_root/index.html" "$2"
            echo "200|text/html"
        fi
        return 0
    fi
    # Read fresh, like SERVED_ASSETS_MANIFEST/_ROUNDS above, so --self-test can
    # force each backend in turn without re-execing the script (#4353).
    case "${SERVED_ASSETS_FETCHER:-auto}" in
        curl) curl -sS --max-time "$TIMEOUT" -o "$2" -w '%{http_code}|%{content_type}' "$1" 2>/dev/null || true ;;
        python3) _fetch_url_python3 "$1" "$2" ;;
        *)
            # -w after the body is written; a transport failure prints status 000.
            if command -v curl > /dev/null 2>&1; then
                curl -sS --max-time "$TIMEOUT" -o "$2" -w '%{http_code}|%{content_type}' "$1" 2>/dev/null || true
            else
                _fetch_url_python3 "$1" "$2"
            fi
            ;;
    esac
}

# _fetch_url_python3 <url> <body-file> — fetch_url's curl-less fallback
# (#4353): the chart's API image has no curl, only the python3 every
# container already needs to boot Django, and that is the only image
# available to an in-cluster probe pod (no new registry to pull one with
# curl just for this). Mirrors curl's own `-o body -w
# '%{http_code}|%{content_type}'` contract exactly: write the body to $2
# (empty on a transport failure, same as curl's -o on a failed connection)
# and print "status|content-type" with no trailing newline, including on an
# HTTP error status — urllib raises HTTPError for 4xx/5xx where curl just
# returns the code, so it is caught and read like any other response rather
# than treated as a transport failure. A genuine transport failure (DNS,
# refused, timeout) reports as "000|", matching curl's own documented
# convention one line above.
_fetch_url_python3() {
    python3 - "$1" "$2" "$TIMEOUT" <<'PYEOF' 2>/dev/null
import sys
import urllib.error
import urllib.request

url, outfile, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
try:
    try:
        resp = urllib.request.urlopen(url, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    body = resp.read()
    status = resp.status if hasattr(resp, "status") else resp.code
    content_type = resp.headers.get("Content-Type", "")
except Exception:
    body, status, content_type = b"", "000", ""
with open(outfile, "wb") as f:
    f.write(body)
sys.stdout.write("%s|%s" % (status, content_type))
PYEOF
}

# extract_refs <html-file> — prints "<kind> <ref>" per referenced asset, where
# kind is "js" or "css". Tags may span lines (Vite emits one per line, but the
# hand-written <link rel="preload"> blocks in index.html span several), so the
# document is flattened and re-split on '<' to give one tag per line.
extract_refs() {
    # The trailing `echo` terminates the last tag: flattening removed every
    # newline, and `read` drops a final line that has none — so a document
    # ending on an asset tag (no </html> after it) silently lost that asset.
    { tr '\r\n\t' '   ' < "$1" | tr '<' '\n'; echo; } | while IFS= read -r tag; do
        case "$tag" in
            script\ *)
                _ref="$(printf '%s\n' "$tag" | sed -n -e "s/.*[[:space:]]src=\"\\([^\"]*\\)\".*/\\1/p" -e "s/.*[[:space:]]src='\\([^']*\\)'.*/\\1/p" | sed -n 1p)"
                [ -n "$_ref" ] && echo "js $_ref"
                ;;
            link\ *)
                _rel="$(printf '%s\n' "$tag" | sed -n -e "s/.*[[:space:]]rel=\"\\([^\"]*\\)\".*/\\1/p" -e "s/.*[[:space:]]rel='\\([^']*\\)'.*/\\1/p" | sed -n 1p)"
                _ref="$(printf '%s\n' "$tag" | sed -n -e "s/.*[[:space:]]href=\"\\([^\"]*\\)\".*/\\1/p" -e "s/.*[[:space:]]href='\\([^']*\\)'.*/\\1/p" | sed -n 1p)"
                [ -n "$_ref" ] || continue
                _kind=""
                for _tok in $_rel; do
                    case "$_tok" in
                        modulepreload) _kind="js" ;;
                        stylesheet) _kind="css" ;;
                    esac
                done
                [ -n "$_kind" ] && echo "$_kind $_ref"
                ;;
        esac
        # `case` with no match leaves the last status 0; an `&& echo` that did
        # not fire must not leak a 1 out of the loop body under `set -e`.
        :
    done
}

# extract_manifest_refs <manifest-file> — prints one "assets/…" path per line,
# deduplicated, for every such string anywhere in the manifest JSON (the entry
# `file`, each `css[]` entry, each `assets[]` entry — and anything else shaped
# like it, since matching the string rather than a specific key survives a Vite
# manifest-shape change). No JSON parser is available in the BusyBox/BSD
# environments this script runs in (#4341), so the document is split on every
# structural character a JSON object/array/pair can use — '{', '}', '[', ']',
# ',', ':' — which puts every quoted string on its own line, the same
# flatten-then-grep technique extract_refs above uses for HTML tags.
extract_manifest_refs() {
    tr '{}[],:' '\n\n\n\n\n\n' < "$1" | sed -n 's/^[[:space:]]*"\(assets\/[^"]*\)"[[:space:]]*$/\1/p' | sort -u
}

# verify_asset <kind> <url> — fetch one asset and record the verdict into the
# caller's _ok/_bad counters (check_once's locals — this is a helper called
# only from inside check_once, never standalone, so sharing them is deliberate,
# not an accident of POSIX sh having no local scoping). Also appends the URL to
# "$_tmp/checked_urls" so a second reference to the same file — one path can
# legitimately appear in both index.html and the manifest — is not fetched or
# reported twice.
#
# kind is "js" or "css" (checked against the content type the browser would
# enforce) or "any" — a manifest asset that is neither, such as a font or an
# image reached only through a dynamic import, whose real MIME type this
# script has no way to predict from the manifest alone. "any" passes on 2xx +
# non-empty + NOT text/html, which still catches the one failure mode that
# matters: the SPA fallback answering for a file that is not there.
verify_asset() {
    _va_kind="$1"
    _va_url="$2"
    printf '%s\n' "$_va_url" >> "$_tmp/checked_urls"

    _body="$_tmp/body"
    _meta="$(fetch_url "$_va_url" "$_body")"
    _status="${_meta%%|*}"
    _ctype="${_meta#*|}"
    _size=0
    [ -f "$_body" ] && _size="$(wc -c < "$_body" | tr -d ' ')"
    rm -f "$_body"

    _why=""
    case "$_status" in
        2??) ;;
        *) _why="HTTP ${_status:-000}" ;;
    esac
    if [ -z "$_why" ]; then
        # Lower-case without GNU sed's I flag or bash's ${,,}.
        _lc="$(printf '%s' "$_ctype" | tr '[:upper:]' '[:lower:]')"
        case "$_va_kind:$_lc" in
            js:*javascript*) ;;
            css:text/css*) ;;
            any:*text/html*) _why="content-type '${_ctype:-none}', expected a non-HTML asset" ;;
            any:*) ;;
            js:*) _why="content-type '${_ctype:-none}', expected JavaScript" ;;
            css:*) _why="content-type '${_ctype:-none}', expected text/css" ;;
        esac
    fi
    if [ -z "$_why" ] && [ "$_size" -eq 0 ]; then
        _why="empty body"
    fi

    if [ -n "$_why" ]; then
        echo "check-served-assets: FAIL  $_va_url — $_why"
        _bad=$((_bad + 1))
    else
        _ok=$((_ok + 1))
    fi
}

# check_once <base_url> — one full pass. Prints failures; returns 0/1/2.
check_once() {
    _base="${1%/}"
    # scheme://host[:port] — everything before the first '/' after "//".
    _scheme="${_base%%://*}"
    _rest="${_base#*://}"
    _origin="$_scheme://${_rest%%/*}"
    _tmp="$(mktemp -d)"
    _index="$_tmp/index.html"
    : > "$_tmp/checked_urls"

    _meta="$(fetch_url "$_base/" "$_index")"
    _status="${_meta%%|*}"
    case "$_status" in
        2??) ;;
        *)
            echo "check-served-assets: FAIL  $_base/ returned HTTP ${_status:-000} — cannot read index.html"
            rm -rf "$_tmp"
            return 2
            ;;
    esac

    extract_refs "$_index" | sort -u > "$_tmp/refs"

    _ok=0
    _bad=0
    _skipped=0
    while read -r _kind _ref; do
        [ -n "$_ref" ] || continue
        case "$_ref" in
            "$_origin"/*) _url="$_ref" ;;
            //*)
                case "$_scheme:$_ref" in
                    "$_origin"/*) _url="$_scheme:$_ref" ;;
                    *) _skipped=$((_skipped + 1)); continue ;;
                esac
                ;;
            *://* | data:* | blob:*) _skipped=$((_skipped + 1)); continue ;;
            /*) _url="$_origin$_ref" ;;
            *) _url="$_base/${_ref#./}" ;;
        esac

        verify_asset "$_kind" "$_url"
    done < "$_tmp/refs"

    # A page that referenced nothing at all (e.g. a JSON error body) is
    # vacuous regardless of what the manifest later says, so this is checked
    # — and can return — before the manifest step runs.
    if [ $((_ok + _bad)) -eq 0 ]; then
        echo "check-served-assets: FAIL  $_base/ referenced no same-origin script/modulepreload/stylesheet — refusing to pass vacuously"
        rm -rf "$_tmp"
        return 1
    fi

    # index.html only names what it eagerly loads — a route behind a lazy
    # `import()` that is never modulepreloaded is invisible to the pass above
    # (#4341 residual gap). asset-manifest.json (Vite's build.manifest) is an
    # independent reference source that names every chunk and asset the build
    # produced, so fetch it and verify everything it names too.
    # Known blind spot: Vite's manifest omits the `new Worker(new URL(...))`
    # chunk (cpmWorker-*.js), so this pass does not see it. asset-files.json
    # (vite.config.ts) does list it, and the prior-release pass below reads that.
    #
    # Skipped under SERVED_ASSETS_MANIFEST=0, for a caller deliberately probing
    # a previously-published image that predates this manifest feature — such
    # an image has no asset-manifest.json by construction, which is a fact
    # about the point in history being probed, not a finding about today's code.
    # Read fresh here, like run_check's own SERVED_ASSETS_ROUNDS, so --self-test
    # can toggle it per case without re-execing the script.
    _manifest_check="${SERVED_ASSETS_MANIFEST:-1}"
    if [ "$_manifest_check" = "1" ]; then
        _manifest_url="$_origin/asset-manifest.json"
        _manifest_file="$_tmp/manifest.json"
        _manifest_bad=0
        _meta="$(fetch_url "$_manifest_url" "$_manifest_file")"
        _status="${_meta%%|*}"
        _manifest_ctype="${_meta#*|}"
        case "$_status" in
            2??) ;;
            *)
                echo "check-served-assets: FAIL  $_manifest_url returned HTTP ${_status:-000} — cannot verify lazily-imported chunks (#4341)"
                _bad=$((_bad + 1))
                _manifest_bad=1
                ;;
        esac
        if [ "$_manifest_bad" -eq 0 ]; then
            _manifest_lc="$(printf '%s' "$_manifest_ctype" | tr '[:upper:]' '[:lower:]')"
            case "$_manifest_lc" in
                *text/html*)
                    echo "check-served-assets: FAIL  $_manifest_url served as text/html (the SPA fallback) — the build manifest is missing from this image (#4341)"
                    _bad=$((_bad + 1))
                    _manifest_bad=1
                    ;;
            esac
        fi
        if [ "$_manifest_bad" -eq 0 ]; then
            _manifest_first="$(sed -n '1s/^[[:space:]]*//p' "$_manifest_file" | cut -c1)"
            if [ "$_manifest_first" != "{" ]; then
                echo "check-served-assets: FAIL  $_manifest_url did not parse as a JSON object — cannot verify lazily-imported chunks (#4341)"
                _bad=$((_bad + 1))
                _manifest_bad=1
            fi
        fi
        if [ "$_manifest_bad" -eq 0 ]; then
            extract_manifest_refs "$_manifest_file" > "$_tmp/manifest_refs"
            if [ ! -s "$_tmp/manifest_refs" ]; then
                echo "check-served-assets: FAIL  $_manifest_url named no assets — refusing to pass vacuously (#4341)"
                _bad=$((_bad + 1))
            else
                while read -r _mref; do
                    [ -n "$_mref" ] || continue
                    _murl="$_origin/$_mref"
                    if grep -qxF -- "$_murl" "$_tmp/checked_urls" 2> /dev/null; then
                        continue
                    fi
                    case "$_mref" in
                        *.js | *.mjs) _mkind="js" ;;
                        *.css) _mkind="css" ;;
                        *) _mkind="any" ;;
                    esac
                    verify_asset "$_mkind" "$_murl"
                done < "$_tmp/manifest_refs"
            fi
        fi
    fi

    # Prior-release pass (ADR-1249) — see the header. Read fresh per call, like
    # SERVED_ASSETS_MANIFEST above, so --self-test can toggle it per case.
    if [ "${SERVED_ASSETS_PRIOR_DIR+set}" = set ]; then
        _prior_dir="$SERVED_ASSETS_PRIOR_DIR"
        _prior_src=""
        _prior_skip=""
        : > "$_tmp/prior_refs"
        if [ -z "$_prior_dir" ]; then
            _prior_skip="no prior release supplied (SERVED_ASSETS_PRIOR_DIR is empty)"
        elif [ -f "$_prior_dir/asset-files.json" ]; then
            extract_manifest_refs "$_prior_dir/asset-files.json" > "$_tmp/prior_refs"
            _prior_src="its asset-files.json"
        elif [ -d "$_prior_dir/assets" ]; then
            (cd "$_prior_dir" && find assets -type f) | sort -u > "$_tmp/prior_refs"
            _prior_src="its assets/ listing (no asset-files.json: built before ADR-1249)"
            [ -s "$_tmp/prior_refs" ] || _prior_skip="$_prior_dir/assets is empty and there is no asset-files.json"
        else
            _prior_skip="$_prior_dir has no asset-files.json and no assets/"
        fi
        if [ -z "$_prior_skip" ] && [ ! -s "$_tmp/prior_refs" ]; then
            echo "check-served-assets: FAIL  prior-release $_prior_src named no assets — refusing to pass vacuously (ADR-1249)"
            _bad=$((_bad + 1))
        elif [ -n "$_prior_skip" ]; then
            if [ "${SERVED_ASSETS_PRIOR_REQUIRED:-0}" = "1" ]; then
                echo "check-served-assets: FAIL  prior-release pass required but nothing to check — $_prior_skip (ADR-1249)"
                _bad=$((_bad + 1))
            else
                echo "check-served-assets: prior-release pass SKIPPED — $_prior_skip (ADR-1249)"
            fi
        else
            _prior_bad_before=$_bad
            _prior_n=0
            while read -r _pref; do
                [ -n "$_pref" ] || continue
                _prior_n=$((_prior_n + 1))
                _purl="$_origin/$_pref"
                # Already fetched by a pass above: this release still ships the
                # file, and it was verified there.
                if grep -qxF -- "$_purl" "$_tmp/checked_urls" 2> /dev/null; then
                    continue
                fi
                case "$_pref" in
                    *.js | *.mjs) _pkind="js" ;;
                    *.css) _pkind="css" ;;
                    *) _pkind="any" ;;
                esac
                verify_asset "$_pkind" "$_purl"
            done < "$_tmp/prior_refs"
            echo "check-served-assets: prior-release pass: $_prior_n files named by $_prior_src, $((_bad - _prior_bad_before)) not served (ADR-1249)"
        fi
    fi

    # A path that cannot exist must 404. If the web tier answers it 2xx it is
    # serving the SPA index.html for a missing chunk, which is what turns a
    # rolling-update version skew into a silent blank screen (#4341). Asserted
    # on its own so a tier whose referenced assets all exist still fails.
    # Skippable only so an upgrade drill can check the PRE-upgrade release, an
    # already-published image that predates #4341 and cannot pass it (#4346).
    if [ "$MISSING_PROBE" != "0" ]; then
        _probe="$_origin/assets/does-not-exist-$$-$(date +%s).js"
        _meta="$(fetch_url "$_probe" "$_tmp/probe")"
        _status="${_meta%%|*}"
        case "$_status" in
            2??)
                echo "check-served-assets: FAIL  $_probe returned HTTP $_status — a missing /assets/ file must 404, not fall back to index.html"
                _bad=$((_bad + 1))
                ;;
        esac
    else
        echo "check-served-assets: missing-/assets/ 404 probe SKIPPED (SERVED_ASSETS_MISSING_PROBE=0)"
    fi
    rm -rf "$_tmp"

    echo "check-served-assets: $_ok served, $_bad failed, $_skipped cross-origin skipped ($_base/)"
    [ "$_bad" -eq 0 ]
}

run_check() {
    _rounds="${SERVED_ASSETS_ROUNDS:-1}"
    # 0, a negative number, or a non-number would skip the loop entirely and
    # return 0 having fetched nothing — a vacuous pass. Refuse it as a usage error.
    case "$_rounds" in
        "" | *[!0-9]* | 0 | 0*)
            echo "check-served-assets: SERVED_ASSETS_ROUNDS must be a positive integer, got '${SERVED_ASSETS_ROUNDS:-}'" >&2
            return 2
            ;;
    esac
    _i=1
    _rc=0
    while [ "$_i" -le "$_rounds" ]; do
        [ "$_rounds" -gt 1 ] && echo "check-served-assets: round $_i/$_rounds"
        check_once "$1" || { _r=$?; [ "$_r" -gt "$_rc" ] && _rc=$_r; }
        _i=$((_i + 1))
    done
    return "$_rc"
}

self_test() {
    st_dir="$(mktemp -d)"
    st_rc=0
    FIXTURE_DIR="$st_dir/site"
    mkdir -p "$FIXTURE_DIR/assets"

    # page <body-lines...> — writes index.html. The healthy shape mirrors what
    # Vite emits plus the multi-line font preloads (which must NOT be checked).
    page() {
        {
            echo '<!doctype html><html><head>'
            echo '<link'
            echo '  rel="preload"'
            echo '  href="/fonts/inter.woff2"'
            echo '  as="font" crossorigin />'
            echo '<script src="/theme-init.js"></script>'
            for _l in "$@"; do echo "$_l"; done
            echo '</head><body><div id="root"></div></body></html>'
        } > "$FIXTURE_DIR/index.html"
    }
    # The manifest mirrors Vite's build.manifest shape closely enough to
    # exercise extract_manifest_refs: an entry keyed by source path ("file" +
    # "css[]"), a dynamic entry with an "assets[]" (LazyChunk-DDD.js's own
    # font/image dependency, Icon-EEE.svg — neither referenced by index.html
    # at all, which is the whole #4341 shape this gate exists to close), and
    # an unrelated "imports" array of bare chunk names (no "assets/" prefix)
    # that extract_manifest_refs must NOT mistake for a servable asset.
    healthy_manifest() {
        printf '%s' '{"src/main.tsx":{"file":"assets/index-AAA.js","isEntry":true,"css":["assets/index-CCC.css"],"imports":["_chunk-Z.js"]},"src/features/toast/Toast.tsx":{"file":"assets/Toast-BBB.js","isDynamicEntry":true},"src/features/lazy/LazyRoute.tsx":{"file":"assets/LazyChunk-DDD.js","isDynamicEntry":true,"assets":["assets/Icon-EEE.svg"]}}' \
            > "$FIXTURE_DIR/asset-manifest.json"
    }
    healthy_assets() {
        rm -rf "$FIXTURE_DIR/assets" && mkdir -p "$FIXTURE_DIR/assets"
        echo 'export{}' > "$FIXTURE_DIR/theme-init.js"
        echo 'export{}' > "$FIXTURE_DIR/assets/index-AAA.js"
        echo 'export{}' > "$FIXTURE_DIR/assets/Toast-BBB.js"
        echo 'body{}' > "$FIXTURE_DIR/assets/index-CCC.css"
        # Reached ONLY through the manifest — never named by index.html — so a
        # healthy pass proves extract_manifest_refs is what finds them.
        echo 'export{}' > "$FIXTURE_DIR/assets/LazyChunk-DDD.js"
        echo '<svg/>' > "$FIXTURE_DIR/assets/Icon-EEE.svg"
        healthy_manifest
    }
    healthy_tags='<script type="module" crossorigin src="/assets/index-AAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/Toast-BBB.js">
<link rel="stylesheet" crossorigin href="/assets/index-CCC.css">'

    # _case <name> <expect-pass|expect-fail> [<must-name-in-output>]
    _case() {
        st_out="$(run_check "$FIXTURE_ORIGIN" 2>&1)" && st_r=0 || st_r=$?
        if [ "$2" = "expect-pass" ]; then
            if [ "$st_r" -eq 0 ]; then echo "SELF-TEST OK: $1 accepted."
            else echo "SELF-TEST FAILED: $1 was rejected and must not be:" >&2; echo "$st_out" >&2; st_rc=1; fi
        else
            st_named=1
            case "$st_out" in *"${3:-}"*) st_named=0 ;; esac
            if [ "$st_r" -ne 0 ] && [ "$st_named" -eq 0 ]; then
                echo "SELF-TEST OK: $1 correctly rejected."
            else echo "SELF-TEST FAILED: $1 was accepted (or did not name ${3:-the asset}):" >&2; echo "$st_out" >&2; st_rc=1; fi
        fi
    }

    healthy_assets
    page "$healthy_tags"
    _case "healthy build (module + modulepreload + stylesheet + classic script)" expect-pass

    # THE #4338 SHAPE: the chunk is absent, nginx answers 200 text/html with
    # index.html. A status-only check passes this; it must not.
    healthy_assets
    rm -f "$FIXTURE_DIR/assets/Toast-BBB.js"
    _case "modulepreload chunk served as the SPA index.html fallback" expect-fail "Toast-BBB.js"

    healthy_assets
    rm -f "$FIXTURE_DIR/assets/index-CCC.css"
    _case "stylesheet served as the SPA index.html fallback" expect-fail "index-CCC.css"

    healthy_assets
    rm -f "$FIXTURE_DIR/assets/index-AAA.js"
    _case "entry module served as the SPA index.html fallback" expect-fail "index-AAA.js"

    healthy_assets
    : > "$FIXTURE_DIR/assets/Toast-BBB.js"
    _case "zero-byte chunk" expect-fail "empty body"

    # THE #4341 SHAPE: every referenced asset exists, but the tier answers a
    # missing /assets/ path with the SPA fallback instead of a 404.
    healthy_assets
    page "$healthy_tags"
    FIXTURE_SPA_FALLBACK=1
    _case "missing /assets/ path answered with the SPA fallback" expect-fail "does-not-exist"
    # The opt-out skips only that probe: the same pre-#4341 tier passes, and a
    # genuinely missing referenced chunk on it still fails.
    MISSING_PROBE=0
    _case "pre-#4341 tier with the missing-path probe opted out" expect-pass
    rm -f "$FIXTURE_DIR/assets/Toast-BBB.js"
    _case "missing chunk still caught with the missing-path probe opted out" expect-fail "Toast-BBB.js"
    MISSING_PROBE=1
    FIXTURE_SPA_FALLBACK=0

    healthy_assets
    page '<script type="module" src="/assets/gone-DDD.js"></script>'
    _case "asset answering 404" expect-fail "HTTP 404"

    healthy_assets
    echo 'x' > "$FIXTURE_DIR/assets/wrongtype-EEE.js"
    page '<script type="module" src="/assets/wrongtype-EEE.js"></script>'
    _case "script served with a non-JavaScript type" expect-fail "expected JavaScript"

    # ── #4341 residual-gap negative controls ────────────────────────────────
    # These are the shapes the refs-only check above cannot see at all: a
    # lazy `import()` chunk index.html never names. Each must actually go red
    # — a check that only ever passes proves nothing.

    # (a) The manifest names a lazy chunk; index.html does not reference it at
    # all (healthy_tags is AAA/BBB/CCC only); the file is missing from disk.
    # Without the manifest pass this would be invisible — the whole point of
    # #4341 — and the run must fail naming it.
    healthy_assets
    page "$healthy_tags"
    rm -f "$FIXTURE_DIR/assets/LazyChunk-DDD.js"
    _case "manifest-only lazy chunk missing from disk, not referenced by index.html" expect-fail "LazyChunk-DDD.js"

    # (a2) Same shape for a manifest "assets[]" entry (a font/image reached
    # only through a dynamic import's own asset list).
    healthy_assets
    page "$healthy_tags"
    rm -f "$FIXTURE_DIR/assets/Icon-EEE.svg"
    _case "manifest assets[] entry missing from disk, not referenced by index.html" expect-fail "Icon-EEE.svg"

    # (b) The manifest itself is gone (an image built before this gate, or
    # one where build.manifest regressed off) — the SPA fallback answers it
    # with index.html, 200 text/html. Must fail, not silently skip the check.
    healthy_assets
    page "$healthy_tags"
    rm -f "$FIXTURE_DIR/asset-manifest.json"
    _case "asset-manifest.json missing entirely" expect-fail "manifest is missing"

    # (b2) The manifest is served but is not JSON at all (a misconfigured
    # content negotiation, or the SPA fallback under a content type this
    # script cannot distinguish from JSON by status/size alone).
    healthy_assets
    page "$healthy_tags"
    printf 'not json' > "$FIXTURE_DIR/asset-manifest.json"
    _case "asset-manifest.json is not valid JSON" expect-fail "did not parse as a JSON object"

    # (c) The manifest parses but names nothing — an empty object would
    # otherwise pass vacuously, exactly the failure mode the refs-only
    # vacuous check above already guards against for index.html.
    healthy_assets
    page "$healthy_tags"
    printf '{}' > "$FIXTURE_DIR/asset-manifest.json"
    _case "asset-manifest.json names zero assets" expect-fail "named no assets"

    # (d) SERVED_ASSETS_MANIFEST=0 skips the manifest pass entirely — for a
    # caller probing a previously-published image predating this feature
    # (helm-install-drill.sh's demo-upgrade PRE-upgrade leg, #4341). Reuse the
    # exact "manifest missing" fixture from (b): with the toggle on this fails;
    # with it off the same fixture must pass, proving the step is genuinely
    # skipped and not merely downgraded to a warning.
    healthy_assets
    page "$healthy_tags"
    rm -f "$FIXTURE_DIR/asset-manifest.json"
    SERVED_ASSETS_MANIFEST=0
    _case "SERVED_ASSETS_MANIFEST=0 skips the manifest pass" expect-pass
    unset SERVED_ASSETS_MANIFEST

    # ── ADR-1249 prior-release pass ─────────────────────────────────────────
    # The previous release's files sit beside this build's in assets/; its
    # index.html is gone (the image ships only its own). PRIOR is a local copy
    # of that release's html root, as a caller would extract it.
    st_prior="$st_dir/prior"
    # asset-files.json lists the worker chunk; the Vite manifest beside it
    # does not, exactly as a real build emits them. The pass must use the list.
    prior_manifest() {
        rm -rf "$st_prior" && mkdir -p "$st_prior"
        printf '%s' '{"files":["assets/Font-OLD4.woff2","assets/Lazy-OLD3.js","assets/cpmWorker-OLD5.js","assets/index-OLD1.js","assets/index-OLD2.css"]}' \
            > "$st_prior/asset-files.json"
        printf '%s' '{"src/main.tsx":{"file":"assets/index-OLD1.js","css":["assets/index-OLD2.css"]},"src/Lazy.tsx":{"file":"assets/Lazy-OLD3.js","assets":["assets/Font-OLD4.woff2"]}}' \
            > "$st_prior/asset-manifest.json"
    }
    prior_served() {
        healthy_assets
        page "$healthy_tags"
        echo 'export{}' > "$FIXTURE_DIR/assets/index-OLD1.js"
        echo 'body{}' > "$FIXTURE_DIR/assets/index-OLD2.css"
        echo 'export{}' > "$FIXTURE_DIR/assets/Lazy-OLD3.js"
        echo 'woff' > "$FIXTURE_DIR/assets/Font-OLD4.woff2"
        echo 'export{}' > "$FIXTURE_DIR/assets/cpmWorker-OLD5.js"
    }

    # The prior list's whole set is served -> PASS, and it really checked all
    # five (a pass that checked nothing would read the same).
    prior_served
    prior_manifest
    SERVED_ASSETS_PRIOR_DIR="$st_prior"
    _case "prior-release asset-files.json set fully served" expect-pass
    case "$(run_check "$FIXTURE_ORIGIN" 2>&1)" in
        *"prior-release pass: 5 files named by its asset-files.json, 0 not served"*)
            echo "SELF-TEST OK: prior-release pass checked all five prior files." ;;
        *) echo "SELF-TEST FAILED: prior-release pass did not report checking all five prior files." >&2; st_rc=1 ;;
    esac

    # THE ADR-1249 SHAPE: a lazy chunk of the previous release, named only by
    # ITS list, is not in the new image -> the old tab's next route blanks.
    rm -f "$FIXTURE_DIR/assets/Lazy-OLD3.js"
    _case "prior-release asset-files.json names a file the new image lacks" expect-fail "Lazy-OLD3.js"
    # The worker chunk: absent from the prior Vite manifest, so only a pass
    # reading asset-files.json can see it is gone.
    prior_served
    rm -f "$FIXTURE_DIR/assets/cpmWorker-OLD5.js"
    _case "prior-release worker chunk (unlisted by the Vite manifest) not served" expect-fail "cpmWorker-OLD5.js"

    # A prior release built before asset-manifest.json existed: its assets/
    # listing is the reference instead (0.4.0-beta.6 -> first ADR-1249 image).
    prior_served
    rm -rf "$st_prior" && mkdir -p "$st_prior/assets"
    : > "$st_prior/assets/index-OLD1.js"
    : > "$st_prior/assets/index-OLD2.css"
    _case "pre-manifest prior release, assets/ listing fully served" expect-pass
    : > "$st_prior/assets/Gone-OLD9.js"
    _case "pre-manifest prior release, listed file not served" expect-fail "Gone-OLD9.js"

    # No prior manifest supplied -> SKIPPED with a reason, never reported as a
    # pass of the prior check (the run's own verdict is the other passes').
    prior_served
    for st_prior_case in "" "$st_dir/prior-empty"; do
        rm -rf "$st_dir/prior-empty" && mkdir -p "$st_dir/prior-empty"
        SERVED_ASSETS_PRIOR_DIR="$st_prior_case"
        st_out="$(run_check "$FIXTURE_ORIGIN" 2>&1)" && st_r=0 || st_r=$?
        case "$st_r:$st_out" in
            *"prior-release pass: "*) echo "SELF-TEST FAILED: prior dir '$st_prior_case' with nothing to check was reported as checked:" >&2; echo "$st_out" >&2; st_rc=1 ;;
            0:*"prior-release pass SKIPPED — "?*) echo "SELF-TEST OK: prior dir '$st_prior_case' with nothing to check is SKIPPED with a reason." ;;
            *) echo "SELF-TEST FAILED: prior dir '$st_prior_case' with nothing to check was not logged as SKIPPED:" >&2; echo "$st_out" >&2; st_rc=1 ;;
        esac
        SERVED_ASSETS_PRIOR_REQUIRED=1
        _case "prior-release pass required, nothing to check (dir '$st_prior_case')" expect-fail "prior-release pass required"
        unset SERVED_ASSETS_PRIOR_REQUIRED
    done

    # A prior list naming nothing is a FAIL, not a skip.
    prior_served
    rm -rf "$st_prior" && mkdir -p "$st_prior"
    printf '{"files":[]}' > "$st_prior/asset-files.json"
    SERVED_ASSETS_PRIOR_DIR="$st_prior"
    _case "prior-release asset-files.json names zero assets" expect-fail "named no assets"
    unset SERVED_ASSETS_PRIOR_DIR

    # A page with nothing to check is not a pass (e.g. a JSON error body).
    page ''
    rm -f "$FIXTURE_DIR/theme-init.js"
    printf '{"detail":"not found"}' > "$FIXTURE_DIR/index.html"
    _case "page referencing no assets" expect-fail "referenced no same-origin"

    # A document that ends on an asset tag (no newline, no </html>) must still
    # have that last asset checked.
    healthy_assets
    rm -f "$FIXTURE_DIR/theme-init.js"
    printf '%s' '<script type="module" src="/assets/index-AAA.js"></script><link rel="stylesheet" href="/assets/missing-ZZZ.css">' > "$FIXTURE_DIR/index.html"
    _case "final tag with no trailing newline" expect-fail "missing-ZZZ.css"

    # Cross-origin references are skipped, not fetched and not failed.
    healthy_assets
    page "$healthy_tags" '<script src="https://cdn.example.com/x.js"></script>' \
        "<link rel='stylesheet' href='//cdn.example.com/y.css'>"
    _case "cross-origin references skipped" expect-pass

    # Relative refs resolve against the base, and single-quoted attributes parse.
    healthy_assets
    page "<script type='module' src='./assets/index-AAA.js'></script>" \
        '<link rel="modulepreload" href="assets/Toast-BBB.js">'
    _case "relative and single-quoted refs" expect-pass
    rm -f "$FIXTURE_DIR/assets/Toast-BBB.js"
    _case "relative ref falling back to index.html" expect-fail "Toast-BBB.js"

    # THE MECHANISM REPRODUCED FOR #4338 (tracked as #4341): two builds behind
    # one load balancer. Each build's index.html names only its own hashed
    # chunk; a request for build B's chunk that lands on build A gets A's SPA
    # fallback. One pass pinned to build A reads clean — that is the blind spot
    # SERVED_ASSETS_ROUNDS exists for, so both directions are asserted.
    FIXTURE_B_DIR="$st_dir/site-b"
    FIXTURE_COUNTER="$st_dir/counter"
    for _site in "$FIXTURE_DIR" "$FIXTURE_B_DIR"; do
        rm -rf "$_site" && mkdir -p "$_site/assets"
    done
    echo 'export{}' > "$FIXTURE_DIR/assets/index-OLD.js"
    echo 'body{}' > "$FIXTURE_DIR/assets/index-OLD.css"
    printf '%s\n' '<script type="module" src="/assets/index-OLD.js"></script>' \
        '<link rel="stylesheet" href="/assets/index-OLD.css">' > "$FIXTURE_DIR/index.html"
    printf '%s' '{"src/main.tsx":{"file":"assets/index-OLD.js","isEntry":true,"css":["assets/index-OLD.css"]}}' \
        > "$FIXTURE_DIR/asset-manifest.json"
    echo 'export{}' > "$FIXTURE_B_DIR/assets/index-NEW.js"
    echo 'body{}' > "$FIXTURE_B_DIR/assets/index-NEW.css"
    printf '%s\n' '<script type="module" src="/assets/index-NEW.js"></script>' \
        '<link rel="stylesheet" href="/assets/index-NEW.css">' > "$FIXTURE_B_DIR/index.html"
    printf '%s' '{"src/main.tsx":{"file":"assets/index-NEW.js","isEntry":true,"css":["assets/index-NEW.css"]}}' \
        > "$FIXTURE_B_DIR/asset-manifest.json"
    # One round is index + css + js + manifest + probe = 5 requests, all on
    # build A — the manifest here names the same two files index.html already
    # named, so it is deduplicated and never adds its own extra request.
    FIXTURE_SKEW_AFTER=5

    echo 0 > "$FIXTURE_COUNTER"
    SERVED_ASSETS_ROUNDS=1
    _case "mixed builds, single round pinned to one replica (the blind spot)" expect-pass
    # Guard the fixture itself: if the pass above checked fewer than both
    # assets, it pinned nothing and the ROUNDS case below would prove nothing.
    echo 0 > "$FIXTURE_COUNTER"
    case "$(run_check "$FIXTURE_ORIGIN" 2>&1)" in
        *"2 served, 0 failed"*) echo "SELF-TEST OK: mixed-build fixture checks both assets per round." ;;
        *) echo "SELF-TEST FAILED: mixed-build fixture did not check both assets in one round." >&2; st_rc=1 ;;
    esac

    echo 0 > "$FIXTURE_COUNTER"
    SERVED_ASSETS_ROUNDS=3
    _case "mixed builds caught by SERVED_ASSETS_ROUNDS=3" expect-fail "content-type 'text/html'"

    unset SERVED_ASSETS_ROUNDS
    FIXTURE_B_DIR=""
    FIXTURE_COUNTER=""

    # A bad round count must not skip the check and pass. Use a page whose only
    # asset is broken, so a vacuous zero-round "pass" is distinguishable.
    healthy_assets
    page '<script type="module" src="/assets/gone-FFF.js"></script>'
    for st_bad in 0 -1 abc 07; do
        SERVED_ASSETS_ROUNDS="$st_bad"
        _case "SERVED_ASSETS_ROUNDS=$st_bad" expect-fail "must be a positive integer"
    done
    unset SERVED_ASSETS_ROUNDS
    FIXTURE_DIR=""

    # ---- live fetch-backend parity (#4353) ---------------------------------
    # Everything above runs through FIXTURE_DIR, which short-circuits fetch_url
    # before either backend is ever reached — it proves the verdict logic, not
    # the dispatch. The in-cluster probe pod this script is now driven from
    # (scripts/helm-install-drill.sh's demo-upgrade mid-rollout check) has
    # python3 but no curl, so a REAL loopback server is used here to prove
    # SERVED_ASSETS_FETCHER=python3 fetches correctly, and that forcing
    # SERVED_ASSETS_FETCHER=curl still does too (the dispatch itself, not just
    # one branch of it).
    if command -v python3 > /dev/null 2>&1; then
        live_dir="$(mktemp -d)"
        mkdir -p "$live_dir/assets"
        printf '%s\n' '<script type="module" src="/assets/app.js"></script>' \
            '<link rel="stylesheet" href="/assets/app.css">' > "$live_dir/index.html"
        echo 'export{}' > "$live_dir/assets/app.js"
        echo 'body{}' > "$live_dir/assets/app.css"
        live_port=18199
        ( cd "$live_dir" && exec python3 -m http.server "$live_port" --bind 127.0.0.1 ) > /dev/null 2>&1 &
        live_pid=$!
        # No fractional sleep (BusyBox's sleep is integer-only, per this
        # script's own portability rule) — a few 1s retries is plenty for a
        # stdlib HTTP server's own startup.
        live_up=0
        live_i=0
        while [ "$live_i" -lt 5 ]; do
            if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${live_port}/', timeout=1)" > /dev/null 2>&1; then
                live_up=1
                break
            fi
            live_i=$((live_i + 1))
            sleep 1
        done
        if [ "$live_up" -eq 1 ]; then
            case "$(SERVED_ASSETS_FETCHER=python3 SERVED_ASSETS_MANIFEST=0 run_check "http://127.0.0.1:${live_port}" 2>&1)" in
                *"2 served, 0 failed"*) echo "SELF-TEST OK: SERVED_ASSETS_FETCHER=python3 fetches a real server correctly (#4353)." ;;
                *) echo "SELF-TEST FAILED: SERVED_ASSETS_FETCHER=python3 did not pass against a real local server (#4353)." >&2; st_rc=1 ;;
            esac
            if command -v curl > /dev/null 2>&1; then
                case "$(SERVED_ASSETS_FETCHER=curl SERVED_ASSETS_MANIFEST=0 run_check "http://127.0.0.1:${live_port}" 2>&1)" in
                    *"2 served, 0 failed"*) echo "SELF-TEST OK: SERVED_ASSETS_FETCHER=curl still fetches a real server correctly." ;;
                    *) echo "SELF-TEST FAILED: SERVED_ASSETS_FETCHER=curl did not pass against a real local server." >&2; st_rc=1 ;;
                esac
            fi
        else
            echo "SELF-TEST FAILED: the loopback python3 -m http.server fixture for the #4353 fetch-backend parity test never came up." >&2
            st_rc=1
        fi
        kill "$live_pid" > /dev/null 2>&1 || true
        wait "$live_pid" 2>/dev/null || true
        rm -rf "$live_dir"
    else
        echo "SELF-TEST SKIPPED: no python3 on this host — cannot verify the #4353 curl-less fetch fallback itself (the dispatch logic still ran above, against FIXTURE_DIR, for every other case)." >&2
    fi

    rm -rf "$st_dir"
    if [ "$st_rc" -eq 0 ]; then echo "SELF-TEST PASSED"; else echo "SELF-TEST FAILED" >&2; fi
    return "$st_rc"
}

case "${1:-}" in
    --self-test) self_test; exit $? ;;
    "" | -h | --help)
        echo "usage: check-served-assets.sh <base_url> | --self-test" >&2
        exit 2
        ;;
esac
# fetch_url auto-detects curl-else-python3 unless SERVED_ASSETS_FETCHER pins
# one of them (#4353) — fail fast, before any request, naming the one tool
# that is actually missing rather than a generic requirement.
case "${SERVED_ASSETS_FETCHER:-auto}" in
    curl) command -v curl > /dev/null 2>&1 || { echo "check-served-assets: curl is required (SERVED_ASSETS_FETCHER=curl)" >&2; exit 2; } ;;
    python3) command -v python3 > /dev/null 2>&1 || { echo "check-served-assets: python3 is required (SERVED_ASSETS_FETCHER=python3)" >&2; exit 2; } ;;
    *)
        command -v curl > /dev/null 2>&1 || command -v python3 > /dev/null 2>&1 \
            || { echo "check-served-assets: curl or python3 is required" >&2; exit 2; }
        ;;
esac
run_check "$1"
