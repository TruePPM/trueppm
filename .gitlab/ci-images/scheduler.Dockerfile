# Custom CI image for the .scheduler job template in .gitlab-ci.yml.
#
# Pre-installs the full editable-install dev-deps tree of packages/scheduler
# (numpy, networkx, scipy, numba, pytest, pytest-benchmark, jupyter for the
# notebooks job, mypy, ruff, etc.) so the five scheduler:* CI jobs skip the
# cold pip install on every run.
#
# Mirrors .gitlab/ci-images/api.Dockerfile — see #651, follow-up to #640.
#
# Rebuilt by the `ci:build-scheduler-image` job when any of the following change:
#   - packages/scheduler/pyproject.toml
#   - .gitlab/ci-images/scheduler.Dockerfile
# or on a scheduled pipeline (weekly safety net for transitive drift).
#
# Tagged `:py3.11` — the only Python version we ship to. Bump to `:py3.12`
# when we move requires-python.
#
# Base image pinned by digest (#904 supply-chain hardening). Renovate
# (pinDigests) keeps the digest current; bump the tag + digest together.
FROM python:3.11-slim@sha256:ae52c5bef62a6bdd42cd1e8dffef86b9cd284bde9427da79839de7a4b983e7ca

# git is needed by diff-cover and by some scheduler:* tooling.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ci-deps

# Copy package metadata only (not source). Real source is layered on at CI
# runtime via `pip install -e packages/scheduler[dev]`; the dev-dep wheels
# stay resident in the image so re-install is a near-instant editable re-link.
COPY packages/scheduler/pyproject.toml ./scheduler/pyproject.toml
COPY packages/scheduler/README.md      ./scheduler/README.md
# CHANGELOG.md is force-included into the wheel (pyproject [tool.hatch.build
# .targets.wheel.force-include], #945), so the editable build below needs it
# present even in this metadata-only stub tree — otherwise hatchling fails the
# build with "Forced include not found".
COPY packages/scheduler/CHANGELOG.md   ./scheduler/CHANGELOG.md

# Stub the source root so hatchling can build the editable wheel. The stub
# package is uninstalled at the end — only the dep wheels remain.
RUN mkdir -p scheduler/src/trueppm_scheduler \
 && touch scheduler/src/trueppm_scheduler/__init__.py \
 && pip install --no-cache-dir -e "./scheduler[dev]" \
 && pip uninstall --yes trueppm-scheduler \
 && rm -rf /opt/ci-deps

# CycloneDX SBOM generator for scheduler:sbom: / scheduler:publish: (#936).
# Pinned + resident so the SBOM jobs never do a live install. Installed
# SEPARATELY from scheduler[dev] so its own deps (lxml, jsonschema, …) stay out
# of the audited dependency set in security:pip-audit:scheduler: (#935).
RUN pip install --no-cache-dir cyclonedx-bom==7.3.0

WORKDIR /
