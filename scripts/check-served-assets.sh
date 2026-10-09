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
# Cross-origin references are skipped and counted, never fetched.
#
# Mixed-version serving. A tier where some replicas serve one build and some
# another (a stuck or in-flight rolling update) passes or fails this check by
# load-balancer luck. SERVED_ASSETS_ROUNDS=N repeats the whole check N times —
# index.html included, since the index can come from either build — which turns
# that luck into a probability a drill can drive toward certainty.
#
# Portability. POSIX sh + curl + tr/sed/grep/sort/wc only, no GNU-only flags:
# it runs in docker:27 (BusyBox), on the macOS arm64 shell runner (BSD tools),
# and inside the Helm drill environment.
#
# Usage:  scripts/check-served-assets.sh <base_url>
#         scripts/check-served-assets.sh --self-test
# Env:    SERVED_ASSETS_ROUNDS    repeat the full check N times (default 1)
#         SERVED_ASSETS_TIMEOUT   per-request curl --max-time seconds (default 20)
# Exit:   0 every asset served correctly · 1 at least one asset failed, or the
#         page referenced none · 2 usage error, or index.html not fetchable

set -eu

TIMEOUT="${SERVED_ASSETS_TIMEOUT:-20}"

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
            # A real `try_files $uri =404` — what a correct /assets/ block does.
            */gone-*) : > "$2"; echo "404|text/html"; return 0 ;;
        esac
        if [ -f "$_f" ]; then
            cp "$_f" "$2"
            case "$_p" in
                *wrongtype*) echo "200|text/plain" ;;
                *.js | *.mjs) echo "200|application/javascript" ;;
                *.css) echo "200|text/css" ;;
                *) echo "200|text/html" ;;
            esac
        else
            # The SPA fallback this script exists to catch.
            cp "$_root/index.html" "$2"
            echo "200|text/html"
        fi
        return 0
    fi
    # -w after the body is written; a transport failure prints status 000.
    curl -sS --max-time "$TIMEOUT" -o "$2" -w '%{http_code}|%{content_type}' "$1" 2>/dev/null || true
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

# check_once <base_url> — one full pass. Prints failures; returns 0/1/2.
check_once() {
    _base="${1%/}"
    # scheme://host[:port] — everything before the first '/' after "//".
    _scheme="${_base%%://*}"
    _rest="${_base#*://}"
    _origin="$_scheme://${_rest%%/*}"
    _tmp="$(mktemp -d)"
    _index="$_tmp/index.html"

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

        _body="$_tmp/body"
        _meta="$(fetch_url "$_url" "$_body")"
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
            case "$_kind:$_lc" in
                js:*javascript*) ;;
                css:text/css*) ;;
                js:*) _why="content-type '${_ctype:-none}', expected JavaScript" ;;
                css:*) _why="content-type '${_ctype:-none}', expected text/css" ;;
            esac
        fi
        if [ -z "$_why" ] && [ "$_size" -eq 0 ]; then
            _why="empty body"
        fi

        if [ -n "$_why" ]; then
            echo "check-served-assets: FAIL  $_url — $_why"
            _bad=$((_bad + 1))
        else
            _ok=$((_ok + 1))
        fi
    done < "$_tmp/refs"
    rm -rf "$_tmp"

    if [ $((_ok + _bad)) -eq 0 ]; then
        echo "check-served-assets: FAIL  $_base/ referenced no same-origin script/modulepreload/stylesheet — refusing to pass vacuously"
        return 1
    fi
    echo "check-served-assets: $_ok served, $_bad failed, $_skipped cross-origin skipped ($_base/)"
    [ "$_bad" -eq 0 ]
}

run_check() {
    _rounds="${SERVED_ASSETS_ROUNDS:-1}"
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
    healthy_assets() {
        rm -rf "$FIXTURE_DIR/assets" && mkdir -p "$FIXTURE_DIR/assets"
        echo 'export{}' > "$FIXTURE_DIR/theme-init.js"
        echo 'export{}' > "$FIXTURE_DIR/assets/index-AAA.js"
        echo 'export{}' > "$FIXTURE_DIR/assets/Toast-BBB.js"
        echo 'body{}' > "$FIXTURE_DIR/assets/index-CCC.css"
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

    healthy_assets
    page '<script type="module" src="/assets/gone-DDD.js"></script>'
    _case "asset answering 404" expect-fail "HTTP 404"

    healthy_assets
    echo 'x' > "$FIXTURE_DIR/assets/wrongtype-EEE.js"
    page '<script type="module" src="/assets/wrongtype-EEE.js"></script>'
    _case "script served with a non-JavaScript type" expect-fail "expected JavaScript"

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
    echo 'export{}' > "$FIXTURE_B_DIR/assets/index-NEW.js"
    echo 'body{}' > "$FIXTURE_B_DIR/assets/index-NEW.css"
    printf '%s\n' '<script type="module" src="/assets/index-NEW.js"></script>' \
        '<link rel="stylesheet" href="/assets/index-NEW.css">' > "$FIXTURE_B_DIR/index.html"
    # One round is index + 2 assets = 3 requests, all on build A.
    FIXTURE_SKEW_AFTER=3

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
    FIXTURE_DIR=""
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
command -v curl > /dev/null 2>&1 || { echo "check-served-assets: curl is required" >&2; exit 2; }
run_check "$1"
