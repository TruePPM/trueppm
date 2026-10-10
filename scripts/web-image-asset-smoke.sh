#!/bin/sh
# scripts/web-image-asset-smoke.sh — boot a just-built web image and require it
# to serve every asset its index.html references AND every chunk its Vite
# build manifest names — including a lazily-`import()`ed route chunk
# index.html never mentions at all — BEFORE the image is pushed (#4338, #4341).
#
# web:publish used to go build -> Trivy -> SBOM -> push with nothing ever
# starting the image, so "the image serves a working app" was asserted by no
# job. This starts the container with the image's OWN baked nginx.conf (the
# config `docker run ghcr.io/trueppm/web` gets) and hands its URL to
# scripts/check-served-assets.sh, which fails on the SPA-fallback shape: a
# missing chunk answered 200 text/html.
#
# Where the container is reachable from:
#   * docker:27 + dind (the amd64 legs) — the daemon is the `docker` service
#     container, so a published port lives on THAT host, not the job's
#     localhost. Those jobs pass WEB_SMOKE_HOST=docker.
#   * the macOS arm64 shell runner — the daemon is Docker Desktop on the same
#     host, so 127.0.0.1. Bound to loopback only: it is a persistent shared host.
#
# `--add-host api:127.0.0.1`: the baked nginx.conf proxies /api/, /ws/ and
# /static/ to http://api:8000, and nginx resolves an upstream hostname at
# startup — with no `api` in DNS the container exits immediately with "host
# not found in upstream". Nothing here exercises those routes.
#
# Prior-release assets (ADR-1249). WEB_SMOKE_PRIOR_IMAGE names the previous
# published image the one under test was built FROM (its PREV_WEB_IMAGE build
# arg). Set, the prior image's asset-manifest.json (or, for an image built
# before that manifest existed, its assets/ listing) is copied out with
# `docker create` + `docker cp`, which never starts it, and
# check-served-assets.sh's prior-release pass then requires every file it
# names to be served by the NEW image. Set but empty (the resolver found no
# prior release) logs the pass as SKIPPED. Unset, no prior pass runs.
#
# Usage: scripts/web-image-asset-smoke.sh <image-ref>
# Exit:  0 image served every asset · non-zero otherwise (container logs printed)

set -eu

IMAGE="${1:?usage: web-image-asset-smoke.sh <image-ref>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="web-asset-smoke-$$"

# WEB_SMOKE_HOST names the daemon's host explicitly (the dind jobs pass
# `docker`). Otherwise a tcp:// DOCKER_HOST names it, and with neither the
# daemon is assumed local and the port is bound to loopback only. No socket
# sniffing: a local CLI may reach its daemon through a context or a symlinked
# socket, and guessing wrong points the probe at the wrong machine.
if [ -n "${WEB_SMOKE_HOST:-}" ]; then
    HOST="$WEB_SMOKE_HOST"
    PUBLISH="8080"
else
    case "${DOCKER_HOST:-}" in
        tcp://*)
            _h="${DOCKER_HOST#tcp://}"
            HOST="${_h%%:*}"
            PUBLISH="8080"
            ;;
        *)
            HOST="127.0.0.1"
            PUBLISH="127.0.0.1::8080"
            ;;
    esac
fi

PRIOR_NAME="web-asset-smoke-prior-$$"
PRIOR_DIR=""
cleanup() {
    docker rm -f "$NAME" "$PRIOR_NAME" > /dev/null 2>&1 || true
    [ -z "$PRIOR_DIR" ] || rm -rf "$PRIOR_DIR"
}
trap cleanup EXIT INT TERM

if [ "${WEB_SMOKE_PRIOR_IMAGE+set}" = set ]; then
    if [ -n "$WEB_SMOKE_PRIOR_IMAGE" ]; then
        PRIOR_DIR="$(mktemp -d)"
        docker create --name "$PRIOR_NAME" "$WEB_SMOKE_PRIOR_IMAGE" > /dev/null
        if docker cp "$PRIOR_NAME:/usr/share/nginx/html/asset-manifest.json" "$PRIOR_DIR/asset-manifest.json" > /dev/null 2>&1; then
            echo "web-image-asset-smoke: prior release ${WEB_SMOKE_PRIOR_IMAGE}: checking the files its asset-manifest.json names"
        else
            docker cp "$PRIOR_NAME:/usr/share/nginx/html/assets" "$PRIOR_DIR/assets" > /dev/null
            echo "web-image-asset-smoke: prior release ${WEB_SMOKE_PRIOR_IMAGE} has no asset-manifest.json (built before ADR-1249): checking its assets/ listing"
        fi
        docker rm -f "$PRIOR_NAME" > /dev/null
        export SERVED_ASSETS_PRIOR_DIR="$PRIOR_DIR"
        export SERVED_ASSETS_PRIOR_REQUIRED=1
    else
        export SERVED_ASSETS_PRIOR_DIR=""
    fi
fi

docker run -d --name "$NAME" --add-host api:127.0.0.1 -p "$PUBLISH" "$IMAGE" > /dev/null

# `docker port` prints e.g. "0.0.0.0:32768" (and a second "[::]:32768" line).
PORT="$(docker port "$NAME" 8080/tcp | sed -n 1p | sed 's/.*://')"
BASE="http://${HOST}:${PORT}"
echo "web-image-asset-smoke: ${IMAGE} listening at ${BASE}"

# Wait for nginx to answer at all; the asset verdict is the next step's job.
i=0
until curl -fsS --max-time 5 -o /dev/null "${BASE}/" 2> /dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 30 ] || [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2> /dev/null)" != "true" ]; then
        echo "web-image-asset-smoke: FAIL  ${IMAGE} never answered on ${BASE}/" >&2
        docker logs "$NAME" >&2 2>&1 || true
        exit 1
    fi
    sleep 1
done

if ! sh "$HERE/check-served-assets.sh" "$BASE"; then
    echo "web-image-asset-smoke: FAIL  ${IMAGE} does not serve every asset it must (its own, plus the prior release's when WEB_SMOKE_PRIOR_IMAGE is set) — NOT pushing." >&2
    docker logs "$NAME" 2>&1 | tail -n 40 >&2 || true
    exit 1
fi
