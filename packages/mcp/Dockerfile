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
FROM python:3.11-slim AS builder

ENV VIRTUAL_ENV=/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Patch the venv-seeded build tooling forward before installing so the published
# image scans clean (mirrors the api image hardening, #1388): 3.11's ensurepip
# seeds an old `wheel` that trips Trivy on CVE-2026-24049.
# --only-binary :all: keeps this a wheel-only install so no sdist setup script
# runs during the build (wheel ships a manylinux wheel, so the flag is safe here
# — unlike the local source install of /build/mcp below).
RUN pip install --only-binary :all: --no-cache-dir --upgrade "wheel>=0.46.2"

COPY . /build/mcp
RUN pip install --no-cache-dir /build/mcp

# ---------------------------------------------------------------------------
# Stage 2: runtime — lean image with only the venv
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

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
