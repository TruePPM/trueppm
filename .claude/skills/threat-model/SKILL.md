---
name: threat-model
model: opus
description: >
  Architecture-level threat modeling (STRIDE) for new TruePPM subsystems and features
  that touch authentication, authorization, sync, board membership, file handling, or
  external integrations. Distinct from security-review (code-level audit) — this skill
  reasons about the data flow and trust boundaries before code is written. Pairs with
  the architect skill on any feature that crosses a trust boundary.
---

# Threat Model Skill

You are producing a STRIDE-based threat model for a new or modified TruePPM subsystem. This runs at the **architecture stage**, before code is written. Output feeds into the SOC 2 readiness work and the architect's ADR.

## When to invoke

Run before architect for any feature that:
- Adds an authentication path (SSO, magic link, invite token, API key)
- Modifies an authorization boundary (new role, new resource scope, cross-project sharing)
- Introduces external data ingress (webhook, OAuth, file upload, email-in)
- Crosses the OSS / Enterprise boundary (new extension point, new event)
- Modifies the sync protocol (new event type, conflict resolution change)
- Handles user-controlled input that flows to a privileged surface

## STRIDE per asset

For each asset (user record, project, board membership, JWT, sync session, etc.):

| Threat | Question to answer |
|--------|--------------------|
| **S**poofing | Who can impersonate this? What identity claim is required? Where is it verified? |
| **T**ampering | Where is this mutated? What integrity checks exist? Can it be modified in transit, at rest, or by a privileged-but-not-owning actor? |
| **R**epudiation | Is the action audit-logged with actor + timestamp + before/after state? Is the log tamper-evident? |
| **I**nformation disclosure | Who can read this? Through which paths (REST, WebSocket broadcast, export, error message, log line)? Are field-level redactions consistent across paths? |
| **D**enial of service | What's the unbounded growth path? What rate-limits apply? What happens at 10× expected scale? |
| **E**levation of privilege | Can a Viewer become a Member, a Member become a Scheduler, a Scheduler become an Admin? Through what sequence of legal operations? |

## Trust boundaries to map

Draw the data flow and explicitly mark:
- **Boundary 1**: Internet ↔ TruePPM API (auth required at this line)
- **Boundary 2**: API ↔ Database (transactional integrity required)
- **Boundary 3**: API ↔ Celery worker (task arguments are user-controlled)
- **Boundary 4**: API ↔ Redis pub/sub (broadcast payload is replicated to all subscribers — field leak risk)
- **Boundary 5**: OSS ↔ Enterprise (extension-point inputs from enterprise must be validated as untrusted)
- **Boundary 6**: TruePPM ↔ external integration (webhook payload, OAuth token, ingested email)

For each boundary the feature crosses, name the validation, authentication, and audit obligations.

## TruePPM-specific patterns to call out

- **Field-leak via broadcast**: the WebSocket broadcast layer fans out to all channel subscribers without per-recipient filtering. Any field hidden by the REST serializer for some roles must also be absent from the broadcast — or filtered in the consumer.
- **Sync conflict resolution**: `server_version` is last-writer-wins. If the new feature stores anything sensitive in the diff, last-writer-wins becomes a vulnerability surface.
- **Invite-token leakage**: tokens in URLs land in browser history, server logs, and analytics. If the feature mints a new token type, specify the rotation, scope, and expiry.
- **OSS/Enterprise extension inputs**: enterprise code calls into OSS extension points. Treat extension-point arguments as **untrusted** even though enterprise is "ours" — defense in depth.
- **Outbox pattern**: any async event dispatch must go through the durable outbox (`services.py`) — bypassing it loses events on transaction rollback.

## Output

A structured document with these sections:

1. **Asset inventory** — what is being protected, with sensitivity classification (public / internal / confidential / restricted)
2. **Trust boundary diagram** — ASCII or Mermaid; label every crossing
3. **STRIDE matrix** — one row per asset × threat type, with the mitigation or "accepted-risk: <reason>"
4. **Top 3 risks** — ranked by likelihood × impact, with proposed mitigations
5. **Decisions for the architect** — open questions whose answers shape the design (e.g., "should webhook payloads be deduplicated by signature or by body hash?")
6. **SOC 2 control mapping** — for each mitigation, name the SOC 2 Trust Service Criteria it satisfies (CC6.1 logical access, CC7.2 monitoring, etc.) so the audit trail builds itself

Threat model output is an input to architect, not a substitute. Pair the two on any feature large enough to warrant either.
