# CI overrides this with the GitLab Dependency Proxy prefix so dind builds
# don't pull Docker Hub anonymously (#4201); the default keeps local and
# release builds unchanged.
ARG DOCKERHUB_PREFIX=docker.io
# The previous published web image whose hashed assets this one also serves
# (ADR-1249). Empty by default; see the `prev` stage below.
ARG PREV_WEB_IMAGE=

# Dev stage — Vite dev server with HMR.
# Source is bind-mounted from the host; no COPY of src needed here.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS dev

WORKDIR /app
# npm ci installs the exact, resolved versions from the committed lockfile
# (reproducible + tamper-evident) instead of npm install re-resolving ranges.
COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build stage — compiles the production bundle.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS builder

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
# files the prior image's own asset-manifest.json names, or its whole assets/
# when it predates the manifest; every name checked to be a regular file under
# assets/). A throwaway stage, so nothing of the prior image reaches the final
# one except those plain files. The prior filesystem is only bind-mounted and
# read: nothing from it executes. Node is the JSON parser, from the same pinned
# image the builder stage already pulled.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS prev-assets
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
FROM ${DOCKERHUB_PREFIX}/nginxinc/nginx-unprivileged:alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083

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
RUN apk upgrade --no-cache

# Prior release's assets first, then this build on top. Content-hashed names
# mean a file in both is byte-identical, so the order only matters for the
# root files (index.html, asset-manifest.json), which come from this build
# alone: the prior stage writes nothing outside assets/.
COPY --from=prev-assets /prev-assets/ /usr/share/nginx/html/
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Explicit non-root user (the base image already sets this; declared here so the
# container's effective user is unambiguous and never root — also undoes the
# `USER root` above, needed for the apk upgrade).
USER 101

EXPOSE 8080
