# CI overrides this with the GitLab Dependency Proxy prefix so dind builds
# don't pull Docker Hub anonymously (#4201); the default keeps local and
# release builds unchanged.
ARG DOCKERHUB_PREFIX=docker.io
# Registry for the Red Hat UBI base (#4336). Not Docker Hub, so it has its own
# knob: the Dependency Proxy prefix above does not front registry.access.redhat.com.
ARG REDHAT_PREFIX=registry.access.redhat.com
# The previous published web image whose hashed assets this one also serves
# (ADR-1249). Empty by default; see the `prev` stage below.
ARG PREV_WEB_IMAGE=

# Dev stage — Vite dev server with HMR.
# Source is bind-mounted from the host; no COPY of src needed here.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS dev

WORKDIR /app
# npm ci installs the exact, resolved versions from the committed lockfile
# (reproducible + tamper-evident) instead of npm install re-resolving ranges.
COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build stage — compiles the production bundle.
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS builder

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
FROM ${DOCKERHUB_PREFIX}/node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS prev-assets
ARG PREV_WEB_IMAGE
COPY scripts/collect-prior-assets.mjs /collect-prior-assets.mjs
RUN --mount=type=bind,from=prev,target=/prev \
    PREV_WEB_IMAGE="$PREV_WEB_IMAGE" node /collect-prior-assets.mjs /prev/usr/share/nginx/html /prev-assets

# Serve stage (default) — nginx serves the pre-built bundle.
# Used by docker-compose.prod.yml via the web-build init pattern.
#
# Red Hat UBI 9 nginx (#4336, ADR-1466). It runs as uid 1001 (gid 0) and listens
# on 8080 like the Alpine image it replaced, so the Service/Ingress/compose port
# maps are unchanged. Its layout is s2i-style, though — see nginx-main.conf for
# why that file replaces the vendor /etc/nginx/nginx.conf, and for the three
# writable paths (/var/cache/nginx, /var/run, /tmp) the chart and compose mount.
FROM ${REDHAT_PREFIX}/ubi9/nginx-124@sha256:25689563c913e06be2879b36394e8a156b7a96ad1fd45e2cfcbf91dc5c071f70

# The pinned digest is immutable, so it cannot pick up an OS-package patch on
# its own (#4335 was a CVE that sat unpatched in the pinned Alpine base). UBI is
# rebuilt promptly by Red Hat, but a digest pin still lags the repo between
# bumps, so security errata are applied at build time too: `--security` limits
# the upgrade to advisories rather than every newer package, keeping the layer
# small and the build reproducible enough to reason about. UBI's repos are
# anonymous, no subscription. Needs root; the base image's user is 1001.
USER root
RUN dnf -y upgrade --security --setopt=install_weak_deps=0 \
 && dnf clean all \
 && rm -rf /var/cache/dnf /opt/app-root/src/* /usr/share/nginx/html/* \
 && mkdir -p /var/cache/nginx /usr/share/nginx/html \
 && chgrp -R 0 /var/cache/nginx && chmod -R g=u /var/cache/nginx

COPY nginx-main.conf /etc/nginx/nginx.conf

# Prior release's assets first, then this build on top. Content-hashed names
# mean a file in both is byte-identical, so the order only matters for the
# root files (index.html, asset-manifest.json, asset-files.json), which come from this build
# alone: the prior stage writes nothing outside assets/. The docroot is
# /usr/share/nginx/html on purpose: scripts/collect-prior-assets.mjs reads the
# PREVIOUS image's files from that path, and every release back to the Alpine
# ones serves from there (ADR-1249).
COPY --from=prev-assets /prev-assets/ /usr/share/nginx/html/
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Explicit non-root user: the image's own default, declared so the effective
# user is unambiguous and never root (undoes the `USER root` above).
USER 1001

EXPOSE 8080

# The base image's CMD is the s2i usage banner, which exits 0 — a container that
# silently "succeeds" and stops. Run nginx in the foreground instead. The base
# image's `container-entrypoint` and its SIGQUIT stop signal (graceful drain,
# bounded by worker_shutdown_timeout in nginx-main.conf) are kept.
CMD ["nginx", "-g", "daemon off;"]
