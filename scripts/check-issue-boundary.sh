#!/usr/bin/env bash
# Detect open OSS issues that describe enterprise functionality and therefore
# violate the OSS/Enterprise boundary (CLAUDE.md § Two-Repo Rule). Issues
# carrying the `enterprise` or `portfolio` label in this OSS repo are the
# leakage pattern this guard exists to prevent: an enterprise feature filed
# against the wrong tracker rots the boundary as quickly as enterprise code
# imported into OSS.
#
# Exit codes:
#   0  no violations
#   1  violations found (CI fails; see output for the list and remediation)
#   2  invocation / API error

set -euo pipefail

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
PROJECT="${CI_PROJECT_ID:-}"

if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi

# Prefer a project- or group-level access token (BOUNDARY_CHECK_TOKEN) so the
# audit can run against issues regardless of CI_JOB_TOKEN scope settings.
# Falls back to CI_JOB_TOKEN, which works for same-project issue reads on
# default GitLab token scopes.
if [ -n "${BOUNDARY_CHECK_TOKEN:-}" ]; then
  AUTH_HEADER="PRIVATE-TOKEN: ${BOUNDARY_CHECK_TOKEN}"
else
  AUTH_HEADER="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
fi

found_total=0

for label in enterprise portfolio; do
  url="${API}/projects/${PROJECT}/issues?labels=${label}&state=opened&per_page=100"
  if ! result=$(curl -sf --header "$AUTH_HEADER" "$url"); then
    echo "ERROR: failed to query GitLab API for label='${label}'" >&2
    exit 2
  fi
  count=$(echo "$result" | jq 'length')
  if [ "$count" -gt 0 ]; then
    echo ""
    echo "BOUNDARY VIOLATION: ${count} open OSS issue(s) labeled '${label}':"
    echo "$result" | jq -r '.[] | "  #\(.iid) — \(.title)\n    \(.web_url)"'
    found_total=$((found_total + count))
  fi
done

if [ "$found_total" -gt 0 ]; then
  cat <<'MSG'

These issues describe enterprise functionality (cross-project, portfolio,
SSO, audit, approval workflows) and must be filed in trueppm-enterprise.

Remediation per issue:
  - If genuinely enterprise: close with a migration comment that links to
    the trueppm-enterprise equivalent, OR move via the GitLab API
    (POST /projects/:id/issues/:iid/move with to_project_id=<enterprise>).
  - If it represents OSS extension-point work (slot registration or edition
    routing per ADR-0029 / ADR-0030): rename to clarify, drop the
    `enterprise` / `portfolio` label.

See CLAUDE.md § Two-Repo Rule for the boundary definition.
MSG
  exit 1
fi

echo "OK: no open OSS issues with enterprise or portfolio labels."
