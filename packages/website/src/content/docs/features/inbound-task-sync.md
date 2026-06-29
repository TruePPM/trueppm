---
title: Inbound Task Sync
description: Push tasks into TruePPM from Jira, Linear, GitHub Issues, or any custom source via a project-scoped API token.
---

**Inbound Task Sync** is the lightweight authenticated webhook that lets external task tools push work into a TruePPM project — without TruePPM having to host an OAuth handshake or maintain a connector. You mint a token, your external system POSTs to `/projects/{id}/task-sync/`, and the task lands in the project's backlog ready for the PM to schedule.

It's deliberately **import-only**: status changes you make in TruePPM do **not** flow back to the external source. Designate one source of truth for status *before* setup — see [Source of truth](#source-of-truth) below. Two-way sync with conflict resolution is on the Enterprise roadmap.

This feature closes [ADR-0065 Gap 3](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0065-hybrid-bridge-v1-1-cpm-velocity-feedback-my-work-and-inbound-sync.md) and is detailed in [ADR-0068](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0068-inbound-task-sync-protocol-project-api-tokens-audit-and-status-map.md).

## What's in v1

- Authenticated `POST /api/v1/projects/{id}/task-sync/` endpoint
- Project-scoped API tokens (`Authorization: Bearer tppm_<64-hex>`)
- Idempotent upsert by `(project, source, external_id)` — re-pushes update; they don't duplicate
- Default status map (`todo` → `NOT_STARTED`, `in_progress` → `IN_PROGRESS`, `done` → `COMPLETE`, plus common synonyms) with per-token override
- Assignee resolution by email; unresolved emails parked in a per-link queue
- Parent attach via `parent_external_id` — preserves Jira epic → story hierarchy
- Per-project rate limit (100 req/min steady state, 1000 req/min during the first 60 minutes after token creation — the **backfill window** for migrating existing data)
- Append-only audit log readable by every project member

## What's *not* in v1

- **No write-back to the external source** — TruePPM is downstream. Status, name, and assignee changes you make in TruePPM stay in TruePPM.
- **No sprint binding from the payload** — every inbound task lands in the project backlog (`status=BACKLOG`, `sprint=null`). The PM places it into a sprint via the normal sprint-planning surface.
- **No OAuth handshake or HMAC signature verification** — authentication is the bearer token only. If you need stronger guarantees (signed payloads, SSO-gated token issuance) those are Enterprise.

## Quick start

### 1. Mint a token (Admin / PM)

Tokens can be minted and revoked from the **Integrations** settings page at both
project scope (**Project → Settings → Integrations**) and program scope
(**Program → Settings → Integrations**), or via the API as shown below.

```bash
curl -X POST "https://your-truppm/api/v1/projects/${PROJECT_ID}/api-tokens/" \
  -H "Authorization: Bearer ${YOUR_JWT}" \
  -H "Content-Type: application/json" \
  -d '{"name": "Jira Production"}'
```

The response contains the raw token in the `token` field. **Copy it now** — it is not retrievable later. Subsequent reads of this endpoint return the prefix (the first 8 hex characters) only.

To configure a custom status mapping for a source whose vocabulary doesn't match the default:

```bash
curl -X POST "https://your-truppm/api/v1/projects/${PROJECT_ID}/api-tokens/" \
  -H "Authorization: Bearer ${YOUR_JWT}" \
  -d '{
    "name": "Linear",
    "status_map": {
      "started": "IN_PROGRESS",
      "in_review": "REVIEW",
      "shipped": "COMPLETE"
    }
  }'
```

`status_map` is **immutable** after mint by design — changing it requires minting a new token and revoking the old one (which appears in the audit log so the team sees it).

### 2. Push tasks

```bash
curl -X POST "https://your-truppm/api/v1/projects/${PROJECT_ID}/task-sync/" \
  -H "Authorization: Bearer ${TPPM_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "jira",
    "external_id": "PROJ-123",
    "name": "Add CSV export to the report dashboard",
    "description": "Customers asked for...",
    "status": "in_progress",
    "assignee_email": "priya@example.com",
    "story_points": 3,
    "external_url": "https://your.atlassian.net/browse/PROJ-123",
    "parent_external_id": "PROJ-1"
  }'
```

Response on first push:

```json
{
  "task_id": "f8c0...",
  "short_id": "00000027",
  "created": true,
  "assignee_resolved": true
}
```

Same payload re-pushed: `created: false`, same `task_id`. The task name, description, status, and story points are updated; the assignee is **not** overwritten if it was previously resolved (this prevents a compromised token from silently rewriting human ownership decisions).

### 3. Revoke a token

```bash
curl -X DELETE "https://your-truppm/api/v1/projects/${PROJECT_ID}/api-tokens/${TOKEN_ID}/" \
  -H "Authorization: Bearer ${YOUR_JWT}"
```

Revocation is immediate and append-only — the revoke event appears in the audit log for every project member to see.

## Payload fields

| Field | Required | Description |
|---|---|---|
| `source` | yes | Lowercase identifier of the external tool (`jira`, `linear`, `github`, or your own `[a-z][a-z0-9_]{0,31}` value) |
| `external_id` | yes | The external system's identifier — `PROJ-123`, `LIN-42`, `#7` |
| `name` | recommended | Task title. Defaults to `external_id` if omitted |
| `description` | no | Free-form text (stored in TruePPM's `notes` field) |
| `status` | no | External status string, translated via the token's status_map |
| `assignee_email` | no | If the email matches a current project member, the assignee is set; otherwise parked in `pending_assignee_email` |
| `story_points` | no | Integer 0–999 |
| `external_url` | no | Canonical URL of the external task (used by future UI surfaces) |
| `parent_external_id` | no | The external system's parent identifier. If a previous push with that `external_id` exists *for the same source*, the new task is attached as a subtask under it. Cross-source parents are rejected. |

## Source of truth

**Designate one tool as the source of truth for status before setup.** TruePPM does not write back. If your team marks a task `Done` in TruePPM and the same task as `In Progress` in Jira, the next inbound push from Jira will set it back to `In Progress`.

The recommended pattern:

- **Jira / Linear / GitHub Issues is the source of truth.** TruePPM aggregates work into a PM's schedule and a contributor's [My Work](/features/my-work/) view. Status edits happen in the source.
- **TruePPM PMs schedule, not status-track.** PMs use the schedule to plan critical-path dates and the sprint surface to commit work; status flips happen in the source tool.
- **Contributors (Priya) stay in their tool.** The whole point of inbound sync is that the contributor never has to open TruePPM directly.

If you need TruePPM to be the source of truth for status, simply don't push `status` in the inbound payload — TruePPM will retain whatever status the team set via the schedule, board, or My Work surfaces.

## Rate limiting

- **Steady-state**: 100 requests per minute per project.
- **Backfill window**: 1000 requests per minute per project during the first 60 minutes after the token's `created_at`. Designed for migrating an existing Jira project of a few thousand tickets in one go.

`429 Too Many Requests` includes a `Retry-After: 60` header. Clients should respect it.

A 2000-ticket initial import can be chunked like this:

```bash
# chunk the export into 1000-row JSONL files: batch_1.jsonl, batch_2.jsonl
for batch in batch_1.jsonl batch_2.jsonl; do
  while read line; do
    curl -sS -X POST "${API}/projects/${PROJ}/task-sync/" \
      -H "Authorization: Bearer ${TPPM_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$line"
  done < "$batch"
  sleep 60  # respect the per-minute window
done
```

Incremental updates after that fit comfortably in the 100/min steady-state cap.

## Pending assignees

If an inbound push references an email that doesn't match any current project member, the task is created with `assignee=null` and the email is parked on the inbound link as `pending_assignee_email`. When that user joins the project, the next push for the same `external_id` will resolve the assignee automatically.

PMs can see the count of unresolved assignees on the project detail response:

```bash
curl "https://your-truppm/api/v1/projects/${PROJECT_ID}/" \
  -H "Authorization: Bearer ${YOUR_JWT}" \
  | jq '.unresolved_assignee_count'
```

A non-zero count usually means a new contributor still needs to be invited to the project.

## Audit log

Every token mint, revoke, and use is recorded in an append-only audit log:

```bash
curl "https://your-truppm/api/v1/projects/${PROJECT_ID}/api-token-audit/" \
  -H "Authorization: Bearer ${YOUR_JWT}"
```

- Every project member can read this log — sprint sovereignty matters, and the team should see when integration tokens are being used in their workspace.
- Audit entries record the token prefix (first 8 hex chars), the actor (for `minted` / `revoked`), the source IP (for `used`), and a JSON `detail` blob describing what happened.
- Audit rows are never deleted — compliance evidence has indefinite retention.

## Reference integrations

The following snippets cover the most common external sources. They all use the same endpoint and the same payload shape — only the source-system glue differs.

### GitHub Actions

Push every issue change to TruePPM by adding a workflow:

```yaml
# .github/workflows/sync-to-trueppm.yml
on:
  issues:
    types: [opened, edited, assigned, closed, reopened]
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST "${{ secrets.TPPM_API }}/projects/${{ secrets.TPPM_PROJECT }}/task-sync/" \
            -H "Authorization: Bearer ${{ secrets.TPPM_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "source": "github",
              "external_id": "${{ github.event.issue.number }}",
              "name": "${{ github.event.issue.title }}",
              "status": "${{ github.event.issue.state }}",
              "assignee_email": "${{ github.event.issue.assignee.email }}",
              "external_url": "${{ github.event.issue.html_url }}"
            }'
```

### Jira Cloud (webhook)

Configure a webhook in Jira's `System → WebHooks` that POSTs to a lightweight relay (Jira's outbound webhook doesn't let you set arbitrary headers, so a one-line proxy is the simplest path). The relay translates the Jira payload to TruePPM's shape and forwards it with the bearer header. Status mapping is handled by the `status_map` on your TruePPM token, so the relay can pass the raw Jira status string through.

### Linear (custom webhook)

Linear's webhooks include rich JSON. A two-line transform in a Cloudflare Worker or Vercel Function converts Linear's `data.identifier` / `data.title` / `data.state.name` into TruePPM's payload shape and POSTs it. Same `status_map` story.

## CI acceptance-result ingestion

The **same API token** also authorizes a sibling endpoint that closes the XP
acceptance-test-driven loop: when CI runs a story's acceptance tests, it reports the
verdicts and TruePPM flips the matching acceptance criteria. This landed in **0.3**.

```http
POST /api/v1/projects/{project_id}/acceptance-results/
Authorization: Bearer tppm_<64-hex>
Content-Type: application/json

{
  "results": [
    { "criterion_id": "3fa85f64-...", "passed": true },
    { "criterion_id": "7c1d92a0-...", "passed": false }
  ]
}
```

- **Criteria are matched by UUID** — CI supplies each `AcceptanceCriterion` id (no
  external-ref field, no migration). A criterion that belongs to a *different* project
  than the URL is reported in `unknown` and left untouched (cross-project write
  defense).
- **`passed: true` marks the criterion met; `passed: false` un-marks it.** The review
  trail (`met_by` / `met_at`) is stamped to the **human who minted the token**, never
  the CI system — the same attribution rule the interactive UI uses.
- **Idempotent** — re-reporting the same verdict is a no-op (counted as `unchanged`,
  no version churn, no restamp).
- **Definition-of-Ready is satisfied, not auto-advanced** — flipping the last unmet
  criterion clears the DoR gate (the response reports `dor_ready: true` per affected
  task) but does **not** transition the task to READY. The team keeps the deliberate
  Mark-ready step.
- **Batch up to 200 results per request**; duplicate `criterion_id`s and an empty
  `results` array are rejected with `400`. The endpoint shares the same per-token rate
  limits as task-sync.

The response reports the outcome per criterion and the post-flip DoR state per task:

```json
{
  "updated": 1,
  "unchanged": 0,
  "unknown": ["7c1d92a0-..."],
  "tasks": [
    { "task": "9c8b...", "dor_ready": true, "criteria_met": 3, "criteria_total": 3 }
  ]
}
```

Like task-sync, this is **one narrow authenticated endpoint** — no provider registry,
no HMAC/OAuth, no conflict resolution. The general multi-provider bidirectional ingest
hub remains Enterprise.

## Security

- The token is a 256-bit random value, hashed with SHA-256 at rest. The raw value is **shown once** and never retrievable. Treat it like a password.
- The `tppm_` prefix on every token is greppable by secret scanners (GitGuardian, GitHub secret scanning) — if a token leaks into a public repo, those services will catch it.
- The token is project-scoped — an attacker who exfiltrates it cannot access other projects' data or any cross-project surface.
- A revoked token is rejected immediately; revocation is not eventually consistent.
- 401 responses do not leak whether the token is malformed, unknown, revoked, or scoped to a different project — all four return the same generic body.

See [ADR-0068 §Risks](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0068-inbound-task-sync-protocol-project-api-tokens-audit-and-status-map.md) for the full STRIDE analysis.

## Related

- [My Work](/features/my-work/) — the contributor surface that consumes the imported tasks
- [ADR-0065 Hybrid Bridge v1.1](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0065-hybrid-bridge-v1-1-cpm-velocity-feedback-my-work-and-inbound-sync.md) — the overarching v1.1 design
- [ADR-0068 Inbound Task-Sync Protocol](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0068-inbound-task-sync-protocol-project-api-tokens-audit-and-status-map.md) — full design details
- [ADR-0148 Inbound CI Acceptance-Result Ingestion](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0148-inbound-ci-acceptance-result-ingestion.md) — the CI acceptance-result endpoint design
- [ADR-0049 External Integration Extension Points](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0049-external-integration-extension-points.md) — the outbound side (webhooks, task-link providers, notification channels)
