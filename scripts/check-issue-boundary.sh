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
#   2  invocation / API error (rejected token, 4xx)
#   3  the tracker was unreadable after the shared bounded retry (429 / 5xx /
#      timeout, 5 attempts with backoff). Still fail-closed, but a distinct
#      code so a red here reads as "retry the job", not "a label is wrong"
#      (#4400).

set -euo pipefail

# The retry/backoff policy lives in the shared reader, not here: this script used
# to `curl -sf` once, so one transient 5xx failed main for 50 minutes with no code
# cause (#4400). A real violation (exit 1) is never retried.
# shellcheck source=lib/gitlab-issues.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/gitlab-issues.sh"

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
PROJECT="${CI_PROJECT_ID:-}"

if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi

# Use a project- or group-level access token (BOUNDARY_CHECK_TOKEN, or the
# shared ISSUES_API_TOKEN). #3043 established that CI_JOB_TOKEN cannot
# authenticate against the GitLab Issues API at all, so it is not sent. Without
# a token the shared reader reads anonymously, which works only while the
# tracker is public and is rate-limited per egress IP — configure the token.
TOKEN="${BOUNDARY_CHECK_TOKEN:-${ISSUES_API_TOKEN:-}}"

found_total=0

for label in enterprise portfolio; do
  rc=0
  rows=$(gitlab_issues_by_label "$API" "$PROJECT" "$TOKEN" "$label" opened) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "ERROR: failed to query GitLab API for label='${label}'" >&2
    [ "$rc" -eq 3 ] && exit 3
    exit 2
  fi
  count=$(printf '%s' "$rows" | grep -c . || true)
  if [ "$count" -gt 0 ]; then
    echo ""
    echo "BOUNDARY VIOLATION: ${count} open OSS issue(s) labeled '${label}':"
    printf '%s\n' "$rows" | while IFS=$'\t' read -r iid _state title _rest; do
      echo "  #${iid} — ${title}"
      echo "    ${CI_PROJECT_URL:-https://gitlab.com/trueppm/trueppm}/-/issues/${iid}"
    done
    found_total=$((found_total + count))
  fi
done

if [ "$found_total" -gt 0 ]; then
  cat <<'MSG'

These issues describe enterprise functionality (cross-PROGRAM coordination,
portfolio governance, org identity governance, audit trail, approval
workflows, multi-tenancy) and must be filed in trueppm-enterprise.

Two things this message used to get wrong, printed at the exact moment a
maintainer is deciding where an issue belongs (#2859):

  - "SSO" is NOT enterprise. Basic OIDC/OAuth2 login against the operator's
    own IdP is OSS — gating it is the SSO tax that kills adoption before a
    prospect feels value. The Enterprise line is org identity GOVERNANCE:
    SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, enforced
    org-wide SSO, group->role mapping. Log in via your own IdP -> OSS;
    provision, deprovision and govern accounts from a directory -> Enterprise.
  - "cross-project" is NOT enterprise. Coordination BETWEEN PROJECTS WITHIN
    ONE PROGRAM is OSS — Program is an OSS entity. Only cross-PROGRAM and
    portfolio-level governance is Enterprise.

Remediation per issue:
  - If genuinely enterprise: close with a migration comment that links to
    the trueppm-enterprise equivalent, OR move via the GitLab API
    (POST /projects/:id/issues/:iid/move with to_project_id=<enterprise>).
  - If it represents OSS extension-point work (slot registration or edition
    routing per ADR-0029 / ADR-0030): rename to clarify, and relabel to
    `enterprise-extension-point`, which this gate does not match. Examples:
    #2064, #2219, #1175. Do NOT keep `enterprise` / `portfolio` on it — this
    gate reads the label alone, so there is no open issue on which those two
    are valid.
  - If it is a TRIAGE issue filed to ASK whether something is enterprise:
    it must not carry the label it is asking about, or filing the question
    reds main (#2973 did exactly this, for 6.5 hours). Run enterprise-check,
    then apply one of the two branches above to the ruling.

See CLAUDE.md § Two-Repo Rule for the boundary definition.
MSG
  exit 1
fi

echo "OK: no open OSS issues with enterprise or portfolio labels."
