# Custom CI image for the .api / .api-no-db job templates in .gitlab-ci.yml.
#
# Pre-installs apt build deps (libpq-dev, gcc) and the full editable-install
# dev-deps tree of packages/scheduler and packages/api, so the six api:*
# CI jobs skip the ~3.5-minute apt+pip cold install on every run.
#
# Rebuilt by the `ci:build-api-image` job when any of the following change:
#   - packages/api/pyproject.toml
#   - packages/scheduler/pyproject.toml
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
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
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

# Stub source roots so hatchling can build the editable wheels. The stub
# packages are uninstalled at the end — only the dep wheels remain. Real
# CI jobs then `pip install -e packages/scheduler[dev] packages/api[dev]`
# against the actual source.
RUN mkdir -p scheduler/src/trueppm_scheduler api/src/trueppm_api \
 && touch scheduler/src/trueppm_scheduler/__init__.py \
          api/src/trueppm_api/__init__.py \
 && pip install --no-cache-dir -e "./scheduler[dev]" -e "./api[dev]" \
 && pip uninstall --yes trueppm-scheduler trueppm-api \
 && rm -rf /opt/ci-deps

WORKDIR /
