#!/bin/sh
# scripts/web-image-asset-smoke.sh — boot a just-built web image and require it
# to serve every asset its index.html references, BEFORE the image is pushed
# (#4338).
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

cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

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
    echo "web-image-asset-smoke: FAIL  ${IMAGE} does not serve its own index.html's assets — NOT pushing." >&2
    docker logs "$NAME" 2>&1 | tail -n 40 >&2 || true
    exit 1
fi
