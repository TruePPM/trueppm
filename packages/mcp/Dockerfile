# Read-only TruePPM MCP server (ADR-0186).
#
# A pure HTTP client of the TruePPM REST API — no Django, no database driver, no
# system libraries beyond the Python runtime. stdio is the primary transport (an
# AI client spawns the container and speaks MCP over the pipe); pass
# `--transport http` to serve the network transport for web assistants.
#
# Build context is this package directory:
#   docker build -t trueppm-mcp packages/mcp/
# Run (stdio):
#   docker run --rm -i -e TRUEPPM_API_URL=... -e TRUEPPM_API_TOKEN=... trueppm-mcp
# Run (HTTP, port 8000):
#   docker run --rm -p 8000:8000 -e TRUEPPM_API_URL=... -e TRUEPPM_API_TOKEN=... \
#     trueppm-mcp --transport http --host 0.0.0.0 --port 8000
#   WARNING: the HTTP/SSE transport has no client-side auth — anyone who can reach
#   the published port acts as the token owner. Only publish it behind an
#   authenticated, TLS-terminating ingress; otherwise keep it loopback-only. See
#   administration/mcp-server.md ("Security posture").

# ---------------------------------------------------------------------------
# Stage 1: builder — install the package into an isolated virtualenv
# ---------------------------------------------------------------------------
# CI overrides this with the GitLab Dependency Proxy prefix so dind builds
# don't pull Docker Hub anonymously (#4201); the default keeps local and
# release builds unchanged.
ARG DOCKERHUB_PREFIX=docker.io

FROM ${DOCKERHUB_PREFIX}/python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9 AS builder

ENV VIRTUAL_ENV=/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Patch the venv-seeded build tooling forward before installing so the published
# image scans clean (mirrors the api image hardening, #1388): 3.11's ensurepip
# seeds an old `wheel` that trips Trivy on CVE-2026-24049.
# --only-binary :all: keeps this a wheel-only install so no sdist setup script
# runs during the build (wheel ships a manylinux wheel, so the flag is safe here
# — unlike the local source install of /build/mcp below).
RUN pip install --only-binary :all: --no-cache-dir --upgrade "wheel>=0.46.2"

# `uv` is a build-only tool used below to resolve dependencies from the
# checked-in lockfile instead of `pip`'s live-PyPI resolution (#4184, same
# class as #4078 on the api image). It installs into this SAME venv (there is
# no separate build-tool venv) and this venv is copied wholesale into the
# runtime stage, so it is `pip uninstall`ed explicitly right after its last
# use below, before any runtime-stage COPY can pick it up. Pinned exact (not
# a floor) and matched to the api image's pin: `uv export`'s output shape is
# a build input, not a runtime dependency, so a version drift here should be
# a deliberate bump, not something that silently changes on the next
# `docker build`.
RUN pip install --only-binary :all: --no-cache-dir "uv==0.9.5"

# Resolve every runtime dependency from packages/mcp/uv.lock — the lock CI
# tested against — instead of a fresh `pip` resolution against whatever PyPI
# serves on the day of the build (same structural gap #4078 fixed for the api
# image, here for the smaller `mcp[cli]` / `httpx` / `cryptography` set).
# `trueppm-mcp` itself is excluded from the export (--no-emit-project): the
# LOCAL source copied in below is what must ship, not whatever version the
# lock happens to record.
#
# --require-hashes verifies every downloaded artifact against the hash uv
# recorded at lock time — the supply-chain hardening the previous unpinned
# `pip install` had no way to do. This requires every entry in the export to
# carry a hash, which holds here since the only hash-less member of the
# dependency graph (trueppm-mcp itself) is excluded above.
COPY pyproject.toml uv.lock /build/mcp-lock/
RUN cd /build/mcp-lock && \
    uv export --frozen --no-dev --no-emit-project \
      -o /build/requirements.txt && \
    pip uninstall -y uv && \
    pip install --no-cache-dir --require-hashes -r /build/requirements.txt

# Install the mcp package itself. Its dependencies were all installed from
# the lock above, so --no-deps stops pip from re-resolving them against
# PyPI — the exact step that reopens the gap this fix closes if it is ever
# dropped.
COPY . /build/mcp
RUN pip install --no-cache-dir --no-deps /build/mcp

# Prove the image can actually boot before it ships: import the CLI entry
# point module (the console script's target, `trueppm_mcp.cli:main`), which
# transitively imports the server, client, and config modules and would fail
# the same way a live-PyPI-resolved dependency mismatch would (mirrors the
# api image's `django.setup()` boot smoke from #4078). Runs in every build —
# local `docker build` and any future CI job — not only a later automated
# gate, so a regression is caught at the earliest possible point.
RUN /venv/bin/python -c "import trueppm_mcp.cli; print('boot smoke: OK')"

# ---------------------------------------------------------------------------
# Stage 2: runtime — lean image with only the venv
# ---------------------------------------------------------------------------
FROM ${DOCKERHUB_PREFIX}/python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9 AS runtime

COPY --from=builder /venv /venv

# Drop the Python build tools (pip/setuptools/wheel) from both the base image's
# system Python and the app venv: the server runs entirely from the venv console
# script and never invokes them at runtime, but Trivy scans them and fails the
# release on their fixable CVEs (mirrors the api image, #1388).
RUN python -m pip uninstall -y wheel setuptools pip \
 && /venv/bin/python -m pip uninstall -y wheel setuptools pip

# Non-root runtime user.
RUN useradd --uid 1000 --no-create-home --shell /sbin/nologin trueppm

ENV PATH="/venv/bin:$PATH"
WORKDIR /app
USER trueppm

# stdio by default; override CMD args for http/sse, e.g.
#   docker run ... trueppm-mcp --transport http --host 0.0.0.0
ENTRYPOINT ["trueppm-mcp"]
