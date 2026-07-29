# ADR-0663: Scheduled Program-Health and Resource-Overallocation Digests

## Status
Accepted — status corrected 2026-07-29 after ADR audit (#2539, verified:
`NotificationDigestRun` model, migration `0011_usernotificationsettings_digest_hour_and_more.py`,
`send_scheduled_digests` Celery Beat task).

## Context

Every notification TruePPM sends today is **event-triggered and contributor-shaped**:
a mention lands, a task is assigned, a milestone forecast shifts. The pipeline behind
them is complete and good — a per-(event_type, channel) preference matrix
(`NotificationPreference`, ADR-0085), an account-wide DND switch
(`UserNotificationSettings`, ADR-0292), per-project routing plus quiet hours
(`ProjectNotificationPreference`, ADR-0216), a durable in-app inbox row, and an
`email_pending` outbox drained by `notifications.drain_notification_emails`.

What is missing is that **nothing scheduled ever leaves the box for a manager.**
There is exactly one digest-shaped event today — `milestone.forecast_shifted`, the
sprint-close bridge digest (#861) — and even that fires on an event, not a clock.

The VoC panel of 2026-07-26 surfaced this independently from three personas:

- **Janet (Executive Sponsor, 4/10 🔴)** — her #1, and the panel's one *unexpected*
  red. Her hard NO is *"requires her to log in and navigate to find a number."* The
  program rollup she needs is already computed (`compute_program_rollup`, ADR-0088)
  and sitting behind a login.
- **Marcus (PMO Director)** — matches his daily-scan / weekly-CEO-prep cadence.
- **David (Resource Manager)** — wants the *existing* overallocation verdict
  delivered rather than visited. His 15-minute daily heat-map check exists only
  because nothing pushes.

The forces in tension:

1. **Reach the person who never logs in** — which means email, and means a clock.
2. **Do not re-open the notification-volume wound.** Priya's blocker is "just my
   tasks." Any new traffic must be invisible to a user who does not ask for it.
3. **Do not build a second pipeline.** Preference matrix, DND, the email outbox and
   Beat all exist. A digest that bypasses them re-implements DND and unsubscribe
   handling badly.
4. **Do not become #370.** The auto-narrative weekly status report (0.8) generates
   editable prose for a PM to send. This is a terse status push with no editing step
   and no natural-language generation.

**P3M layer: Programs and Projects → OSS.** The digest aggregates *within* a single
program (`compute_program_rollup` is explicitly intra-program; cross-program
aggregation is Enterprise per ADR-0070/0088). A program manager needs this to run
their program, so it is OSS by the CLAUDE.md classification test. An org-wide
"every program in the portfolio" digest with PMO distribution lists is the Enterprise
counterpart and is **not** built here.

## Decision

Ship a **clock-driven digest built entirely from existing computed facts**, delivered
through the existing preference matrix and email outbox, gated by a per-user schedule.

### 1. Two new event types, one new inbox category

Two `NotificationEventType` values:

| Event type | Meaning |
|---|---|
| `program.health_digest` | Weekly program health — programs `at_risk` / `critical` + the top contributing project driving each |
| `resource.overallocation_digest` | Weekly resource overallocation — resources whose load exceeds the same threshold the heat map colors red |

They join a **new category `digests`** in `apps/notifications/categories.py`, so the
inbox `?category=` filter and the panel's category chips gain one group rather than
two. The category is the *filter* grain; the per-user *toggle* grain stays
`(event_type, channel)`, so a user can take program health without overallocation.
This is why the issue's "two categories" reads as two toggles and one filter group.

Both events, both channels, default **`False`** in `DEFAULT_PREFERENCES` — genuinely
opt-in. This is deliberately *unlike* `milestone.forecast_shifted`, which defaults
email ON. That precedent is defensible because it fires only on a material event a PM
already cares about; a weekly clock-driven send that nobody asked for is exactly the
volume Priya rejects. The cost is stated plainly in Consequences below.

Because `create_event_notifications` skips a recipient whose `in_app` is off, an
all-`False` default means **no row is created for anyone until they opt in** — the
feature is inert on upgrade, which is the correct posture for scheduled mail.

### 2. Per-user schedule on `UserNotificationSettings`

`UserNotificationSettings` was documented from the start as "shaped to grow a
scheduled quiet-hours window + a per-user timezone later" (ADR-0292 §4). That is
exactly this. Three fields:

- `digest_weekday` — `IntegerField`, 0–6 Mon–Sun (Python `weekday()`), default **6
  (Sunday)**, matching Janet's "Sunday-evening email."
- `digest_hour` — `IntegerField`, 0–23, default **17**.
- `digest_timezone` — `CharField(blank=True, default="")`; empty falls back to
  `settings.TIME_ZONE`. A blank string is the single unset state (project DJ001
  convention — no nullable strings).

One schedule per user covering both digest events. A separate schedule per event type
would double the settings surface to serve a use case nobody named.

### 3. Hourly Beat sweep, per-user slot match

`notifications.send_scheduled_digests`, registered in `CELERY_BEAT_SCHEDULE` at
`crontab(minute=10)` — hourly, offset off the top of the hour so it does not contend
with `generate-recurring-occurrences` (`minute=0`).

The sweep **does not scan all users.** Because the default is OFF, an opted-in user
necessarily has a stored `NotificationPreference` row with `enabled=True` for a digest
event. The candidate set is therefore that queryset — typically a handful of rows —
joined to `UserNotificationSettings`. For each candidate, convert "now" into their
`digest_timezone` and send iff `(local.weekday(), local.hour)` equals their configured
slot. A user with no settings row uses the defaults (Sunday 17:00, server timezone).

Hourly-with-slot-match, rather than one Beat entry per possible slot, keeps Beat's
schedule static and makes the timezone the user's property rather than the cluster's.

### 4. Content from already-computed facts — no new math

**Program health.** For each `Program` the user has a `ProgramMembership` on, call
`compute_program_rollup(program)` (ADR-0088) and keep those whose `program_health` is
`at_risk` or `critical`. The **top contributing project** is the member project with
the worst `_schedule_health_by_project` band, tie-broken by open critical-task count —
computed by a small helper in `program_rollup.py` beside the function that already
derives those bands, so the digest and the Program Overview can never disagree. Each
line deep-links to `/programs/<id>/overview`, the existing drill-through.

**Resource overallocation.** For each `Project` the user has a `ProjectMembership` on
with `role >= Role.SCHEDULER` (the Resource Manager ordinal — David's seat), call the
existing `compute_utilization` over the coming week and keep resources with
`overallocated=True`. That flag is `load_pct > 100`, `_load_band`'s own verdict —
**the same threshold the heat map colors red**, read from the same function rather
than re-derived. Lines deep-link to the project's resources view.

**Honest empty state.** "Nothing at risk this week" is a real send, not a suppressed
one. A digest that only arrives when something is wrong trains the reader to treat
silence as either good news or a broken pipeline, and they cannot tell which. The
subject line distinguishes the two cases so an inbox scan is enough.

### 5. Idempotency ledger

New model `NotificationDigestRun` — `(user, event_type, period_start)` with a unique
constraint. `period_start` is the user-local date of the send's week start. The task
`get_or_create`s the ledger row **before** building notifications and skips on
conflict, so a Beat double-fire, a manual re-queue, or a worker retry cannot send a
second copy. Plain `models.Model` (no `server_version`): an operational record, never
synced or broadcast, mirroring `UserNotificationSettings`.

Purged nightly at 7-day-equivalent retention (rows older than 90 days — a weekly
grain needs a longer window than the 7-day convention for per-request outbox rows, or
the ledger would forget a fortnight-old send it must not repeat; 90 days is well past
any plausible retry).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Hourly sweep + per-user slot match, opt-in, existing pipeline (chosen)** | No new infrastructure; DND/unsubscribe/quiet-hours inherited; timezone is the user's property; Beat schedule stays static | Sweep runs 24×/day to send weekly; needs an idempotency ledger |
| B. One Beat entry per weekday/hour slot | No slot-matching logic | 168 Beat entries, or a cluster-wide fixed send time that is 3 a.m. for half the users |
| C. Reuse `ProjectNotificationPreference` quiet-hours window as the schedule | No new fields | Quiet hours are a *suppression* window, not a *send* time; overloading it makes both harder to reason about |
| D. Digest as a new standalone mailer bypassing `Notification` | Simpler content model | Re-implements DND, unsubscribe headers, email retry/backoff, and leaves no in-app record; a user who opts into in-app-only gets nothing |
| E. Email ON by default (follow `milestone.forecast_shifted`) | Janet gets it without configuring anything | Re-opens Priya's volume blocker on *every* upgraded install; a clock-driven send nobody requested is the exact traffic the matrix exists to prevent |
| F. Compute digest content at read time (no stored rows) | No ledger | Nothing to email; the whole point is reaching someone outside their session |

## Consequences

**Easier**
- The panel's highest-leverage ask lands without new infrastructure — one Beat entry,
  one task, one ledger model, three settings fields.
- Any future scheduled digest (sprint review, #2410's export subjects) reuses the
  sweep by adding an event type and a content builder.
- The overallocation verdict has exactly one definition (`_load_band`), now read by
  the board, the API, the heat map, and the digest.

**Harder**
- `compute_program_rollup` is now on a background path as well as a request path. It
  is a fixed small number of grouped queries per program, but a user on many programs
  multiplies that. The task caps at **25 programs and 25 projects per user per digest**
  and states the truncation in the body rather than silently dropping lines.
- The digest reads across a user's whole membership set, so it is the first place a
  single render spans many projects. It must not become a cross-*program* aggregate —
  that is the Enterprise line, and the cap plus the per-program grouping keep it on the
  correct side.

**Risks**
- 🟡 **Opt-in means Janet still gets nothing until someone turns it on.** This is a
  real tension with the issue's own framing ("push to the people who never log in") and
  is resolved in favor of the issue's explicit "OFF by default" instruction and
  Marcus's stated rationale. Mitigation: the Notifications settings page surfaces the
  digest group with its schedule inline, so enabling it is one visit, and onboarding
  can point at it. If adoption data later shows nobody finds it, flipping the default
  is a one-line change to `DEFAULT_PREFERENCES` — but that is a product decision with
  a volume cost, not a bug fix, and should not be made silently here.
- Timezone correctness: a user whose `digest_timezone` is invalid or removed from the
  tz database must not crash the sweep for everyone else. Resolution falls back to
  `settings.TIME_ZONE` and logs, per-user, inside the loop.
- DST: a slot match on local hour means the send can skip or repeat an hour across a
  DST boundary. The ledger's `(user, event_type, period_start)` uniqueness makes the
  repeat case a no-op; the skip case is absorbed because the *weekday* still matches
  on the next hourly tick only if the hour matches — so a spring-forward user whose
  slot is the skipped hour gets no digest that week. Accepted: the alternative is a
  catch-up window that risks double sends, and a weekly digest missing once at a DST
  boundary is a smaller harm than a duplicate.

## Implementation Notes

- **P3M layer**: Programs and Projects (intra-program only — cross-program is Enterprise)
- **Affected packages**: api, web
- **Migration required**: **yes** — 3 fields on `UserNotificationSettings`, 1 new model
  `NotificationDigestRun`. All additive; the new fields carry defaults so the
  `AddField` backfills non-interactively. One migration for the whole feature per the
  batch-then-`makemigrations`-once rule.
- **API changes**: **yes**
  - `UserNotificationSettingsSerializer` gains `digest_weekday`, `digest_hour`,
    `digest_timezone` as writable fields on the existing
    `GET/PATCH /api/v1/me/notification-settings/`. `digest_timezone` is validated
    against `zoneinfo.available_timezones()`; `digest_weekday` / `digest_hour` are
    range-validated (0–6 / 0–23) so a bad value is a 400, not a silently dead schedule.
  - The two new event types appear automatically in the existing preference-matrix
    endpoint and the `?category=digests` filter — no new endpoint.
  - `docs/api/openapi.json` regenerated after merging `origin/main`.
- **OSS or Enterprise**: **OSS** (`trueppm-suite`)

### Durable Execution

1. **Broker-down behaviour**: N/A for dispatch — there is no user-facing action to
   make durable. The digest originates in Beat, not in a request. If the broker is
   down at the scheduled tick that week's digest is skipped; the next weekly tick sends
   fresh content. Deliberately **no catch-up**: a stale program-health snapshot mailed
   days late is worse than a missed one, and the ledger's `period_start` makes a late
   catch-up indistinguishable from a duplicate.
2. **Drain task**: **Reuses** `notifications.drain_notification_emails`. Semantics match
   exactly — the digest sets `email_pending=True` on ordinary `Notification` rows via
   `create_event_notifications`, which is precisely what that drain exists to send. No
   new drain.
3. **Orphan window**: N/A for the digest task itself (Beat-originated, not written
   inside a request's `on_commit`). The reused email drain keeps its existing 5-minute
   orphan window, which is more than sufficient — digest rows are committed by the
   task before it returns.
4. **Service layer**: **New functions needed** —
   `apps/notifications/digests.py::build_program_health_digest(user)` and
   `::build_resource_overallocation_digest(user)` return the rendered
   `(subject, body, lines)` for one user; `::send_due_digests(now)` performs candidate
   selection and the ledger guard. The Celery task in `tasks.py` is a thin wrapper, per
   the existing `detect_stale_tasks` / `create_stale_task_notifications` split.
5. **API response on best-effort dispatch**: N/A — no endpoint dispatches this. The
   settings PATCH is a synchronous 200 and changes only *when* the next sweep matches.
6. **Outbox cleanup**: `NotificationDigestRun` rows purged nightly by
   `notifications.purge_old_digest_runs` at 03:20 UTC (between the existing 03:15
   archive and 04:00 workflow purge), retention **90 days** — deliberately longer than
   the 7-day per-request convention because the ledger's job is to remember a *weekly*
   send. Digest `Notification` rows are covered by the existing
   `archive-old-notifications` job with no change.
7. **Idempotency**: Key is `(user, event_type, period_start)` where `period_start` is
   the user-local week-start date. `NotificationDigestRun.objects.get_or_create(...)`
   inside the per-user loop; `created=False` means this week's digest already went and
   the user is skipped. The unique constraint makes the check atomic under concurrent
   workers. The task additionally carries
   `@idempotent_task("notifications:digest-sweep", on_contention="skip")` so two
   overlapping sweeps cannot both enter the loop — belt and braces, since the ledger
   alone is already sufficient.
8. **Dead-letter / failure handling**: Per-user failures are caught, logged with the
   user id, and the sweep continues — one user's broken timezone or deleted program
   must not deny every other user their digest. The ledger row is created *before*
   content build, so a mid-build crash does **not** re-send on the next tick (fail
   closed: a missing digest is recoverable by the reader logging in; a duplicate
   erodes trust in the channel). No DLQ table: the failure mode is a skipped weekly
   mail, which the next week's send supersedes. `max_retries=0` — retrying an hourly
   sweep is pointless because the next tick is 60 minutes away and re-evaluates from
   current state.
