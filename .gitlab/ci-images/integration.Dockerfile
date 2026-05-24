# Custom CI image for the `web:integration` job in .gitlab-ci.yml.
#
# Pre-installs Python 3 + libpq-dev/gcc, uvicorn, and the full editable-install
# dev-deps tree of packages/scheduler and packages/api on top of the official
# Playwright image. The integration job skips the ~3-minute apt+pip cold
# install on every main pipeline.
#
# Mirrors .gitlab/ci-images/api.Dockerfile — see #640 (ci-api image) and #651
# (ci-scheduler image) for the established pattern.
#
# Rebuilt by the `ci:build-integration-image` job when any of the following change:
#   - packages/api/pyproject.toml
#   - packages/scheduler/pyproject.toml
#   - .gitlab/ci-images/integration.Dockerfile
# or on a scheduled pipeline (weekly safety net for transitive drift).
#
# Tagged `:noble` — the Playwright base ships Ubuntu 24.04 noble, which provides
# Python 3.12. Both packages declare `requires-python = ">=3.11"` so 3.12 is in
# range. The Playwright version is pinned here AND in packages/web/playwright
# configs; bump both together.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# Python 3 + build deps for psycopg's C extension. curl is used by the
# integration job to poll the Django health endpoint. Ubuntu 24.04 enforces
# PEP 668 ("externally managed environments") on the system python, so we
# install dev-deps into a venv and put it on PATH — runtime `pip install -e`
# in the CI job then resolves to the venv automatically.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      python3 python3-pip python3-venv python3-dev \
      libpq-dev gcc git curl \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/api-venv

ENV PATH="/opt/api-venv/bin:$PATH"

WORKDIR /opt/ci-deps

# Same metadata-only copy pattern as api.Dockerfile: dep wheels stay resident,
# the real source is layered on at CI runtime via `pip install -e packages/...`.
COPY packages/scheduler/pyproject.toml ./scheduler/pyproject.toml
COPY packages/scheduler/README.md      ./scheduler/README.md
COPY packages/api/pyproject.toml       ./api/pyproject.toml
COPY packages/api/README.md            ./api/README.md

# Stub source roots so hatchling can build the editable wheels. The stub
# packages are uninstalled at the end — only the dep wheels (+ uvicorn) remain.
# Real CI jobs then `pip install -e packages/scheduler[dev] packages/api[dev]`
# against the actual source.
RUN mkdir -p scheduler/src/trueppm_scheduler api/src/trueppm_api \
 && touch scheduler/src/trueppm_scheduler/__init__.py \
          api/src/trueppm_api/__init__.py \
 && pip install --no-cache-dir -e "./scheduler[dev]" -e "./api[dev]" "uvicorn[standard]" \
 && pip uninstall --yes trueppm-scheduler trueppm-api \
 && rm -rf /opt/ci-deps

WORKDIR /
