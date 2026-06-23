# ADR-0165: Blocker roll-up filters + actionable task.blocked email (deep-link)

## Status
Proposed

## Context
This is a polish wave of two follow-ups to **ADR-0124** (blocker end-to-end, MR !596),
both raised by the VoC audit of !596 (2026-06-13). Neither changes the blocker data
model; both sharpen surfaces that already ship.

- **#1157** — `GET /projects/{id}/blocked/` and `GET /sprints/{id}/blocked/` ship
  oldest-blocked-first with **no filter/sort params**. Alex (SM, 8–12 concurrent
  blockers) can't slice "all *Decision needed* blockers" or "anything blocked > 3 days";
  Marcus (PMO) needs "type = X" / "older than N days" for weekly escalation prep.
- **#1158** — the opt-in `task.blocked` email (#1136) carries type + age but **no task
  link and no actor/blocking_task**, so it is a dead-end: the recipient cannot act
  without opening the app and hunting for the task. Sarah: a link that lands on a login
  or non-mobile page kills the habit within a week.

**The hard constraint, inherited verbatim from ADR-0124 (Morgan's surveillance
boundary):** the free-text `blocked_reason` is contributor voice and must **NEVER**
become a filterable / queryable / email-readable field. Everything in this wave operates
strictly on the *already-shareable* structured signal (`blocker_type`, age via
`blocked_since`, `blocked_by` actor, `blocking_task` link).

P3M layer: **Programs and Projects** (single-project / single-sprint triage). OSS.

## Decision

### #1157 — filter params on the existing roll-up endpoints
Add two optional query params to **both** existing endpoints (no new endpoints):

- `?blocker_type=<enum>` — exact match on `Task.blocker_type`. Validated against
  `BlockerType.values`; an unknown value returns **400** (`{"blocker_type": [...]}`),
  not a silent empty list, so Marcus's automated reporting fails loudly on a typo
  rather than under-counting escalations.
- `?min_age_days=<int>` — keep only tasks blocked at least N days, i.e.
  `blocked_since <= now() - N days`. Must be a non-negative integer; a negative or
  non-integer value returns **400**. `0` is a no-op (matches all blocked rows).

Both params are **AND**-combined and both default to absent → today's behavior
(unfiltered, oldest-first) is preserved exactly. Ordering is unchanged
(`blocked_since` asc). The filter keys touch only `blocker_type` and `blocked_since`;
`blocked_reason` is never a filter key and never returned (it is already omitted from
roll-up rows). The Morgan boundary is structurally intact — there is no code path that
accepts reason text as input or emits it.

Parsing/validation lives in a small shared helper (`parse_blocked_filters(query_params)`
in `blocker_services.py`) consumed by both views, so the contract has one definition.
`project_blocked_rollup` / `sprint_blocked_rollup` / `_blocked_queryset` gain optional
`blocker_type` / `min_age_days` kwargs threaded down to the queryset.

### #1158 — actionable task.blocked email
Enrich `render_blocker_notification(task)` (whose output is frozen onto the
event-sourced `Notification.subject/body` at dispatch) to append, **after** the existing
reason-free type+age line:

- the **actor**: `Flagged by <blocked_by.username>` (omitted if unset),
- the **blocking_task** title: `Waiting on: <blocking_task.name>` (omitted if unset),
- a **deep-link**: `{FRONTEND_BASE_URL}/projects/{project_id}/schedule?task={task_id}`
  — the same path the in-app inbox uses (`NotificationRow.tsx:48`), so web + email
  resolve identically and the SPA renders responsively on mobile.

`blocked_reason` stays omitted. The link line is emitted **only when
`FRONTEND_BASE_URL` is non-empty**; unset → the email degrades to type/age/actor/
blocking-task with no link (strictly better than today, never worse).

### New setting: `FRONTEND_BASE_URL`
First coupling of the API to a public frontend origin. Django setting
`FRONTEND_BASE_URL = env("FRONTEND_BASE_URL", default="")`, trailing slash stripped at
read time to avoid `//`. Surfaced as a Helm `.Values.env` entry (empty default, doc
comment) so it flows through the existing `trueppm.envVars` helper with no template
change. Documented in `docs/administration/`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **#1157**: 400 on invalid `blocker_type` (chosen) | Automated consumers fail loud, not silently empty | One more error branch |
| #1157: silently ignore invalid filter | DRF-ish leniency | Marcus's weekly report silently under-counts on a typo — unacceptable for an escalation surface |
| #1158: hardcode link only when configured (chosen) | Self-hosters with no public URL still get a useful email; zero-config safe | Two body shapes to test |
| #1158: require FRONTEND_BASE_URL, error if unset | Always-linked | Breaks existing zero-config email; over-reach for a polish wave |
| New per-task deep-link route `/projects/:id/tasks/:taskId` | Cleaner URL | Diverges from the inbox path; two link conventions to maintain |

## Consequences
- **Easier**: SM/PMO triage (slice by type/age); email recipients act in one tap.
- **Harder**: the API now has a notion of "where the frontend lives" — operators must
  set `FRONTEND_BASE_URL` for links to appear (documented; safe-empty default).
- **Risks**: (1) a reason leak through the new filter/email surfaces — mitigated because
  no new code path reads or emits `blocked_reason`; covered by an explicit regression
  test asserting reason never appears in filtered rows or the email body. (2) `//` or
  malformed link from a misconfigured base URL — mitigated by trailing-slash strip.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api, helm, docs (no web, no scheduler, no mobile)
- Migration required: **no**
- API changes: **yes** — two optional query params on two existing GET endpoints;
  response shapes unchanged. OpenAPI schema regenerated.
- OSS or Enterprise: **OSS** (single-project / single-sprint; no cross-program aggregation)

### Durable Execution
1. Broker-down behaviour: **N/A for #1157** (pure read endpoints, zero async). **#1158**
   adds no new dispatch — it only changes the *text* rendered by the existing
   `task.blocked` notification, which already rides the ADR-0124 notification outbox +
   `drain_notification_emails` Beat drain. No new durability surface.
2. Drain task: reuses the existing `drain_notification_emails` drain — semantics
   unchanged (this wave only enriches the frozen body string).
3. Orphan window: N/A — no new outbox rows; unchanged from ADR-0124.
4. Service layer: `blocker_services.py` — new `parse_blocked_filters()`, extended
   `render_blocker_notification()` / `*_blocked_rollup()` / `_blocked_queryset()`.
   No new Celery dispatch path.
5. API response on best-effort dispatch: N/A — read endpoints return 200 synchronously;
   the email path is fire-and-drain exactly as ADR-0124 defined.
6. Outbox cleanup: N/A — no new outbox category.
7. Idempotency: N/A — read endpoints are nullipotent; email rendering is a pure function
   of task state, safe to re-render on drain retry (already the ADR-0124 contract).
8. Dead-letter / failure handling: unchanged from ADR-0124 (`email_attempts` +
   `email_failed_at` on the Notification row; the drain retries).
