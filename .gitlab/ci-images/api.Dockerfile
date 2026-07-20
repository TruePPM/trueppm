# Custom CI image for the .api / .api-no-db job templates in .gitlab-ci.yml,
# and for the mcp:typecheck / mcp:test jobs.
#
# Pre-installs apt build deps (libpq-dev, gcc) and the full editable-install
# dev-deps tree of packages/scheduler, packages/api, and packages/mcp, so the
# api:* CI jobs skip the ~3.5-minute apt+pip cold install on every run and the
# mcp:* jobs skip their cold mcp[dev] install. MCP is a pure HTTP client
# (mcp[cli] + httpx, no Django/ORM — ADR-0186); its small dep tree overlaps the
# api dev tools already here, so baking it costs the api jobs almost nothing and
# avoids standing up a fourth CI image for two jobs.
#
# Rebuilt by the `ci:build-api-image` job when any of the following change:
#   - packages/api/pyproject.toml
#   - packages/scheduler/pyproject.toml
#   - packages/mcp/pyproject.toml
#   - .gitlab/ci-images/api.Dockerfile
# or on a scheduled pipeline (weekly safety net for transitive drift).
#
# Tagged `:py3.11` — the only Python version we ship to. Bump to `:py3.12`
# when we move requires-python.
#
# Base image pinned by digest (#904 supply-chain hardening — OpenSSF Scorecard
# "Pinned-Dependencies"). Renovate (pinDigests) keeps the digest current; bump
# the tag + digest together. Resolve a new digest with:
#   docker buildx imagetools inspect python:3.11-slim --format '{{.Manifest.Digest}}'
FROM python:3.11-slim@sha256:ae52c5bef62a6bdd42cd1e8dffef86b9cd284bde9427da79839de7a4b983e7ca

# git is needed by drf-spectacular's schema diff and by diff-cover; libpq-dev +
# gcc build psycopg's C extensions.
#
# postgresql-client-16 (pg_dump + psql) is used by api:testdb-dump (dump the
# migrated schema) and the api:test shards (load it into the `migrated`
# template DB) — see #688. It must be v16 to match the postgres:16 service:
# pg_dump refuses to dump from a server newer than itself, and Debian bookworm's
# default postgresql-client is v15, so we pull v16 from the PGDG apt repo.
#
# The PGDG signing key is verified against a known sha256 (#904 supply-chain
# hardening) so a www.postgresql.org compromise / DNS hijack cannot substitute a
# malicious key (which would otherwise sign a substituted postgresql-client). If
# the sha256sum check ever fails, PostgreSQL re-published the key file: confirm
# the fingerprint is still ACCC4CF8 and bump the hash. The same pinned hash
# guards the stale-image fallback in .gitlab-ci.yml (ensure-pg-client).
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      libpq-dev gcc git curl ca-certificates gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl --proto '=https' --tlsv1.2 -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" | sha256sum -c - \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ci-deps

# Copy package metadata (pyproject + README) but NOT the source trees. The
# real source is layered on at CI runtime via `pip install -e packages/...`;
# the dev-dep wheels stay resident in the image so that re-install is a
# near-instant editable re-link rather than a 100s wheel download.
COPY packages/scheduler/pyproject.toml ./scheduler/pyproject.toml
COPY packages/scheduler/README.md      ./scheduler/README.md
# CHANGELOG.md is force-included into the scheduler wheel (scheduler
# pyproject force-include, #945), so the editable build below needs it present
# even in this metadata-only stub tree — otherwise hatchling fails the build
# with "Forced include not found".
COPY packages/scheduler/CHANGELOG.md   ./scheduler/CHANGELOG.md
COPY packages/api/pyproject.toml       ./api/pyproject.toml
COPY packages/api/README.md            ./api/README.md
COPY packages/mcp/pyproject.toml       ./mcp/pyproject.toml
COPY packages/mcp/README.md            ./mcp/README.md

# Stub source roots so hatchling can build the editable wheels. The stub
# packages are uninstalled at the end — only the dep wheels remain. Real
# CI jobs then `pip install -e packages/scheduler[dev] packages/api[dev]`
# (or packages/mcp[dev]) against the actual source.
RUN mkdir -p scheduler/src/trueppm_scheduler api/src/trueppm_api mcp/src/trueppm_mcp \
 && touch scheduler/src/trueppm_scheduler/__init__.py \
          api/src/trueppm_api/__init__.py \
          mcp/src/trueppm_mcp/__init__.py \
 && pip install --no-cache-dir -e "./scheduler[dev]" -e "./api[dev]" -e "./mcp[dev]" \
 && pip uninstall --yes trueppm-scheduler trueppm-api trueppm-mcp \
 && rm -rf /opt/ci-deps

# Pin drf-spectacular to the exact version docs/api/openapi.json was generated
# with. The editable install above resolves it from the pyproject range
# (>=0.27,<1.0), so an unpinned rebuild silently adopts a new release whose
# schema output differs — the 0.29->0.30 blank-field `oneOf` change that broke
# api:schema-drift fleet-wide. Adopting a new version is deliberate: bump this
# pin, `uv lock --upgrade-package drf-spectacular`, and regenerate the schema in
# lockstep (scripts/export-openapi.sh) in one MR.
RUN pip install --no-cache-dir "drf-spectacular[sidecar]==0.30.0"

# Trust the CI checkout dir regardless of owner. GitLab's helper clones the repo
# as root into /tmp/builds, but the job's step_script runs as `ci` (uid 1000),
# so git aborts `git fetch origin` with "detected dubious ownership" unless the
# build dir is marked safe. Baking it here fixes every ci-api job at once, with
# no per-job `git config` line in .gitlab-ci.yml.
RUN git config --system --add safe.directory '*'

# Run the CI jobs as a non-root user (Sonar dockerfile:S6471, defense-in-depth
# for a build container that pulls the repo + third-party deps). uid 1000 owns
# the whole /usr/local tree so any job-time `pip install` writes without root —
# not just the `pip install -e packages/...[dev]` editable re-link into
# site-packages/bin, but also packages that drop data files under etc/ or share/.
# Chowning only lib+bin left those unwritable and failed installs with EACCES
# (#2236 — surfaced on scheduler:notebooks' jupyter install, same image pattern).
RUN useradd --uid 1000 --create-home --shell /bin/bash ci \
 && chown -R ci /usr/local
USER ci

WORKDIR /
