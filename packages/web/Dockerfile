# CI overrides this with the GitLab Dependency Proxy prefix so dind builds
# don't pull Docker Hub anonymously (#4201); the default keeps local and
# release builds unchanged.
ARG DOCKERHUB_PREFIX=docker.io
# The previous published web image whose hashed assets this one also serves
# (ADR-1249). Empty by default; see the `prev` stage below.
ARG PREV_WEB_IMAGE=

# Dev stage — Vite dev server with HMR.
# Source is bind-mounted from the host; no COPY of src needed here.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS dev

WORKDIR /app
# npm ci installs the exact, resolved versions from the committed lockfile
# (reproducible + tamper-evident) instead of npm install re-resolving ranges.
COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build stage — compiles the production bundle.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

WORKDIR /app
# npm ci — locked, reproducible install from the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Prior-release assets (ADR-1249, #4341). A tab opened before an upgrade still
# holds the previous release's index.html, so the next lazy route it visits
# asks THIS image for one of that release's content-hashed chunks. Serving them
# turns a blank screen into a working page. PREV_WEB_IMAGE names the previous
# published web image, pinned by digest (scripts/resolve-prev-web-image.sh
# picks it in CI). Empty, the default, means none: `scratch` is never pulled,
# so local and dev builds stay hermetic and need no network. (The ARG itself
# is declared at the top: an ARG used in FROM must precede the first FROM.)
FROM ${PREV_WEB_IMAGE:-scratch} AS prev

# Picks WHICH prior files to keep (scripts/collect-prior-assets.mjs: only the
# files the prior image's own asset-files.json lists, or its whole assets/ when
# it was built before ADR-1249 and so holds only its own build; every name
# checked to be a regular file under assets/). A throwaway stage, so nothing of the prior image reaches the final
# one except those plain files. The prior filesystem is only bind-mounted and
# read: nothing from it executes. Node is the JSON parser, from the same pinned
# image the builder stage already pulled.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS prev-assets
ARG PREV_WEB_IMAGE
COPY scripts/collect-prior-assets.mjs /collect-prior-assets.mjs
RUN --mount=type=bind,from=prev,target=/prev \
    PREV_WEB_IMAGE="$PREV_WEB_IMAGE" node /collect-prior-assets.mjs /prev/usr/share/nginx/html /prev-assets

# Serve stage (default) — nginx serves the pre-built bundle.
# Used by docker-compose.prod.yml via the web-build init pattern.
#
# nginx-unprivileged runs as a non-root user (uid 101) and listens on an
# unprivileged port (8080) — see nginx.conf. The reverse proxy in
# docker-compose.prod.yml maps host 80 -> container 8080.
FROM ${DOCKERHUB_PREFIX}/nginxinc/nginx-unprivileged:alpine@sha256:884e0b7f42f303641b0f4e78755aea647521dca0b89ca3be7992ad78b5c07434

# The pinned digest above is immutable, so it cannot pick up an Alpine
# OS-package patch on its own — unlike the api image's Debian base, this stage
# previously had no equivalent of `apt-get upgrade` at all (#4335), so a CVE
# fixed by Alpine upstream (in its live package repo) sat unpatched in every
# build until nginx's maintainers republished the image. `apk upgrade --no-cache`
# re-resolves every installed package against Alpine's current repo at build
# time and leaves no cache behind, the same rationale as the api Dockerfile's
# `apt-get update && apt-get upgrade`. The base image's default user is already
# non-root (101), so this needs an explicit `USER root` first.
USER root

# worker_shutdown_timeout (#4359): a MAIN-context nginx directive, so it
# cannot live in the chart-mounted/compose-mounted default.conf (included
# inside this file's `http {}` block — setting it there is a hard config
# error). It is inserted here, into the base image's own /etc/nginx/nginx.conf,
# with sed rather than a wholesale COPY-replacement, so this stays a one-line
# diff against the vendor's file instead of a config this project must keep
# in sync with nginx-unprivileged's own upstream changes (mime types, log
# format, temp paths, ...).
#
# Why it is needed at all: the chart's PRODUCTION web ConfigMap branch
# (configmap.yaml's `else` block, and the image-direct nginx.conf) proxies
# /ws/ with proxy_read_timeout 86400s — the two demo branches 404 it instead,
# so they carry no WebSocket traffic and are unaffected either way. Whether
# the production branch's /ws/ proxy actually sees live traffic depends on
# topology: values.yaml's documented default Ingress routes /ws straight to
# the api Service, bypassing the web pod's nginx entirely — this directive
# matters on a topology that instead routes /ws through the web tier (no
# Ingress, or an Ingress/LB configured to do so). On such a topology, the
# base image's inherited `STOPSIGNAL SIGQUIT` triggers a graceful shutdown
# that, with no bound, waits for open connections to close on their own, so a
# terminating pod with live WebSocket viewers held those sockets open until
# Kubernetes' termination grace period (30s for the web tier, minus the 5s
# preStop sleep that runs before SIGQUIT is even sent — see values.yaml's
# lifecycle.web) ran out and SIGKILLed the process: the connection's TCP
# socket drops with no WebSocket close frame either way (close code 1006 on
# the client), just later. 20s bounds that drain window inside the 25s that
# remains after preStop, so the SIGKILL case is reached sooner and more
# predictably rather than always eating the full remaining grace.
RUN apk upgrade --no-cache \
 && sed -i '1i worker_shutdown_timeout 20s;' /etc/nginx/nginx.conf

# Prior release's assets first, then this build on top. Content-hashed names
# mean a file in both is byte-identical, so the order only matters for the
# root files (index.html, asset-manifest.json, asset-files.json), which come from this build
# alone: the prior stage writes nothing outside assets/.
COPY --from=prev-assets /prev-assets/ /usr/share/nginx/html/
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Explicit non-root user (the base image already sets this; declared here so the
# container's effective user is unambiguous and never root — also undoes the
# `USER root` above, needed for the apk upgrade).
USER 101

EXPOSE 8080
