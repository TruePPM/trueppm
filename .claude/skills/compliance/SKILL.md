---
name: compliance
model: sonnet
description: >
  SOC 2 Type 2 evidence collection and control mapping for TruePPM. Walks the codebase
  and infrastructure to produce a control-to-evidence matrix, flag missing artifacts,
  and surface drift between documented controls and current implementation. Run before
  audit cycles and when adding any feature that touches an SOC 2 control area
  (access management, change management, data handling, monitoring).
---

# Compliance Skill

You are producing SOC 2 Type 2 evidence and control mappings for TruePPM. This skill is invoked: (1) ahead of an audit window, (2) when adding a feature that touches a controlled area, (3) periodically as a drift check. Output feeds the SOC 2 readiness plan tracked at `trueppm-enterprise#86`.

## Scope

TruePPM targets **SOC 2 Type 2** with the **Trust Service Criteria**: Security (mandatory), Availability, and Confidentiality. Privacy and Processing Integrity are deferred per the anti-roadmap.

## Control areas TruePPM must demonstrate

| TSC | Control Area | TruePPM artifact |
|-----|--------------|------------------|
| CC6.1 | Logical access | SSO config, role matrix, ProjectMembership model, permission tests |
| CC6.2 | User registration | Invite flow, email verification, audit log of admissions |
| CC6.3 | User deprovisioning | Member-removal flow, session revocation, JWT rotation |
| CC6.6 | Encryption in transit | TLS termination at ingress, internal mTLS where applicable |
| CC6.7 | Encryption at rest | Postgres TDE / KMS, secret mount config in Helm |
| CC7.1 | System monitoring | Metrics endpoints, log aggregation, alert routing |
| CC7.2 | Security event monitoring | Audit trail (#14), anomaly detection thresholds |
| CC7.3 | Incident response | Runbook, on-call rotation, post-mortem template |
| CC8.1 | Change management | MR workflow, mandatory CI gates, branch protection rules |
| A1.2 | Backup | Postgres backup schedule, restore drill cadence |
| C1.1 | Data classification | Data retention policy (#35), tagging convention |
| C1.2 | Data disposal | GDPR delete path, retention sweep evidence |

## Walk pattern

For each control area:

1. **Locate the implementation** — code path, config file, Helm values, CI job
2. **Locate the evidence artifact** — log line format, audit-trail event type, stored screenshot or runbook page
3. **Verify the control fires** — is there a test that exercises it? An assertion that the audit row appears?
4. **Note gaps**:
   - Implementation exists but no evidence artifact (auditor cannot verify)
   - Evidence artifact exists but stale (last refresh > 90 days)
   - Documented control but no implementation
   - Implementation differs from the documented control

## TruePPM-specific evidence sources

- **Audit trail** (trueppm-enterprise#14) — primary evidence for CC6.x and CC7.2
- **CI gates** (`.gitlab-ci.yml`) — primary evidence for CC8.1; capture screenshots of branch protection
- **Helm chart values** — encryption-at-rest, TLS, secret mounts; capture rendered values
- **Penetration test report** (annual, per trust artifact bundle) — CC6.1 / CC6.6 / CC6.7
- **Backup runbook + restore drill log** — A1.2

## Output

1. **Control-to-evidence matrix** — markdown table, one row per applicable TSC criterion
2. **Gap list** — items where implementation, evidence, or documentation is missing or stale, ranked by audit impact
3. **Suggested issue filings** — for each non-trivial gap, propose an issue (title + scope) in `trueppm-enterprise`
4. **Evidence artifact inventory** — list every file/log/dashboard the auditor will request, with current location

## Drift mode

When invoked after a feature change rather than at audit time, scope to the affected control areas:
- New auth path → CC6.1, CC6.2, CC6.3
- New write endpoint → CC8.1, CC7.2
- New data field → C1.1 (classification), C1.2 (disposal path)

Surface only deltas from last run; do not re-emit the full matrix.

## Out of scope

- Privacy (GDPR) compliance is tracked separately — flag intersections, do not own
- HIPAA / FedRAMP / IL5 — deferred per anti-personas list; do not produce artifacts unless the user explicitly asks
- The actual audit relationship (auditor selection, scope letters) — this skill produces evidence; the human handles the auditor
