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
FROM python:3.11-slim

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

# Stub the source root so hatchling can build the editable wheel. The stub
# package is uninstalled at the end — only the dep wheels remain.
RUN mkdir -p scheduler/src/trueppm_scheduler \
 && touch scheduler/src/trueppm_scheduler/__init__.py \
 && pip install --no-cache-dir -e "./scheduler[dev]" \
 && pip uninstall --yes trueppm-scheduler \
 && rm -rf /opt/ci-deps

WORKDIR /
