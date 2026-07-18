#!/usr/bin/env bash
# Run a local SonarCloud scan WITH test-coverage import (issue #2090).
#
# SonarCloud does not run tests — it imports coverage reports. This script
# prepares the report that needs a repo-root rewrite (the web LCOV) and then
# invokes sonar-scanner, which reads the report paths declared in
# sonar-project.properties.
#
# Usage:
#   SONAR_TOKEN=xxxxxxxx scripts/sonar-scan.sh            # prep + scan
#   scripts/sonar-scan.sh --prep-only                     # only rewrite lcov, no scan
#
# Coverage reports are expected at the paths in sonar-project.properties:
#   packages/scheduler/coverage.xml   (Cobertura, from `make coverage-diff`)
#   packages/api/coverage.xml         (Cobertura, from `make coverage-diff`)
#   packages/mcp/coverage.xml         (Cobertura, optional locally)
#   packages/web/coverage/lcov.info   (LCOV, from `make coverage-diff`)
#
# Generate any that are missing with `make coverage-diff` first — this script
# will warn (not fail) on a missing Python report so a partial scan still works,
# but a missing web lcov.info means web coverage will not import.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

PREP_ONLY=0
if [[ "${1:-}" == "--prep-only" ]]; then
    PREP_ONLY=1
fi

WEB_LCOV="packages/web/coverage/lcov.info"
WEB_LCOV_SONAR="packages/web/coverage/lcov.sonar.info"

# --- Web LCOV rewrite ------------------------------------------------------
# vitest emits `SF:src/...` paths relative to packages/web. The scanner runs
# from the repo root, so rewrite them to `SF:packages/web/src/...` — the same
# prefix the Makefile `coverage-diff-web` target applies for diff-cover. Without
# this the scanner reads the report, resolves zero files, and reports 0%.
if [[ -f "${WEB_LCOV}" ]]; then
    sed 's|^SF:|SF:packages/web/|' "${WEB_LCOV}" > "${WEB_LCOV_SONAR}"
    echo "→ wrote ${WEB_LCOV_SONAR} (repo-root-relative SF paths)"
else
    echo "! ${WEB_LCOV} not found — web coverage will not import."
    echo "  Run \`make coverage-diff\` (or \`cd packages/web && npm run test:coverage\`) first."
fi

# --- API Cobertura <source> rewrite ----------------------------------------
# packages/api sets `relative_files = true` (cross-runner shard combine, #1348),
# so its coverage.xml emits an EMPTY `<source></source>` and filenames like
# `src/trueppm_api/...`. From the repo root the scanner resolves those against
# `<repo>/src/...` and drops every file (#2113). Inject the package root so they
# resolve to `<repo>/packages/api/src/...` — matching the absolute <source> the
# scheduler/mcp reports already carry. sonar-project.properties points the API
# reportPath at this generated coverage.sonar.xml. The substitution is a no-op on
# a report that already has a non-empty <source> (e.g. a local non-combine run).
API_COV="packages/api/coverage.xml"
API_COV_SONAR="packages/api/coverage.sonar.xml"
if [[ -f "${API_COV}" ]]; then
    sed "s#<source></source>#<source>${REPO_ROOT}/packages/api</source>#" "${API_COV}" > "${API_COV_SONAR}"
    echo "→ wrote ${API_COV_SONAR} (resolvable <source> root)"
else
    echo "! ${API_COV} not found — API coverage will not import (run \`make coverage-diff\`)."
fi

# --- Python report presence check (warn only) ------------------------------
for xml in packages/scheduler/coverage.xml packages/api/coverage.xml packages/mcp/coverage.xml; do
    if [[ ! -f "${xml}" ]]; then
        echo "! ${xml} not found — that package's coverage will not import (run \`make coverage-diff\`)."
    fi
done

# --- Web E2E coverage presence check (warn only, issue #2117) ---------------
# The E2E LCOV comes from the nightly `web:e2e:coverage` CI job (instrumented
# build + Playwright). It is expensive to reproduce locally, so a local scan
# simply imports without it — Sonar just reports lower web coverage than the
# nightly. Regenerate on demand with `cd packages/web && npm run test:e2e:coverage`.
if [[ ! -f "packages/web/coverage/e2e/lcov.info" ]]; then
    echo "! packages/web/coverage/e2e/lcov.info not found — E2E coverage will not"
    echo "  import locally (it is produced by the nightly web:e2e:coverage job)."
    echo "  To include it: cd packages/web && npm run test:e2e:coverage"
fi

if [[ "${PREP_ONLY}" == "1" ]]; then
    echo "→ prep-only: skipping sonar-scanner."
    exit 0
fi

# --- Scan ------------------------------------------------------------------
if ! command -v sonar-scanner >/dev/null 2>&1; then
    echo "sonar-scanner not on PATH. Install it (brew install sonar-scanner) or run via the docker image." >&2
    exit 1
fi
if [[ -z "${SONAR_TOKEN:-}" ]]; then
    echo "SONAR_TOKEN is not set. Export a SonarCloud token before scanning." >&2
    exit 1
fi

echo "→ running sonar-scanner (coverage imported from sonar-project.properties)…"
exec sonar-scanner
