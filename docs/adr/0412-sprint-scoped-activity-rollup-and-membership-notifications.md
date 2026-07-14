# ADR-0412: Sprint-scoped activity rollup + sprint-membership-change notifications

## Status
Proposed

## Context

A 2026-07-14 Voice-of-Customer audit of the activity-streams / task-drawer surface
(issue #1946) surfaced two hard-NO blockers:

- **Jordan (PO, 4/10 🔴):** "PM/admin can silently add tasks to an active sprint (no
  audit/notification)."
- **Alex (SM, 5/10 🔴):** "mid-sprint scope changes that slip in silently with no audit."
- **Morgan (Agile Coach)** independently asked for scope changes to surface "where the
  team already looks, not buried per-task" — but *without* becoming
  surveillance-by-notification (autonomy constraint: pull/rollup + opt-in, not a firehose).

### What already ships (this ADR corrects an earlier over-scope)

An initial design draft assumed no board/sprint activity feed existed. **That is wrong** —
ADR-0160 (issue #1261, backed by the read API in issue #325) already shipped a
board-level activity feed, and it already covers most of what #1946 asked for:

- **Endpoint:** `GET /projects/{id}/board/activity` — board-scoped, keyset-paginated
  (`until` → `next_until`), server-side filtering by `type` / `actor` / `since`.
- **Sprint membership is already a first-class event vocabulary:** the feed emits
  `entered_sprint`, `exited_sprint`, `moved_sprint` — each with its own icon/tint/verb
  ("added to sprint" / "removed from sprint" / "moved sprint", `text-brand-primary`) —
  **sourced from the `HistoricalTask` sprint-FK delta** (ADR-0160's "one source" rule; no
  double-count with `SprintScopeChange`).
- **A "Sprint" filter chip already exists** (`TypeGroup='sprint'` →
  `entered_sprint,exited_sprint,moved_sprint`).
- **Web surface exists:** `packages/web/src/features/board/activity/BoardActivityPanel.tsx`
  — a virtualized, filterable right-rail with loading/empty/error states, wired into
  `BoardView` as a toggleable panel (`useBoardActivity.ts`).

So issue #1946's parts (1) "first-class added/removed-from-sprint event + filter chip" and
(2) "one aggregated screen instead of a per-drawer scavenger hunt" are **already
substantially delivered at the board scope**. What is genuinely missing is:

1. **Sprint *scope*.** The feed is board-wide (all tasks); the personas need it narrowed to
   *this active sprint's* tasks (Alex/Jordan watching ~40 sprint tasks, not the whole
   project's history).
2. **Notification.** The feed is **pull-only** — #1261 explicitly deferred the live
   `board.activity` WebSocket push, and there is **no notification** on sprint-membership
   change. ADR-0102's `sprint_scope_changed` signal exists but has **no OSS receiver
   wired**, so mid-sprint injection is only *passively* visible in My-Work (ADR-0102 §6
   deliberately withholds push for a *pending* proposal). This is the real "silent
   injection" gap the personas describe.

**P3M layer:** Programs and Projects / Operations — single-team sprint self-governance.
Squarely **OSS** under ADR-0177. No cross-program/portfolio surface introduced.

### Design principle adopted (settings-first, not policy-by-fiat)

Who is notified is routed through the existing notification **settings** infrastructure
(`NotificationPreference` per-user × event × channel; `UserNotificationSettings` DND,
ADR-0292), not hard-coded. The per-user opt-out *is* Morgan's autonomy constraint honored
structurally. The only value that can't be a per-user opt-out — *recipient eligibility* —
gets an inherited, overridable default. OSS ships the raw knobs + a stable seam; Enterprise
later registers presets/"collections" and org-policy enforcement against the ADR-0177 seam
(see [[feedback_visibility_decisions_settings_oss_enterprise]]).

| Concern | OSS (adoption) | Enterprise (governance) |
|---|---|---|
| Per-user prefs | every knob, self-service | inherited |
| Project default (candidate set) | raw knob, inherited-but-changeable | enforced / locked org-wide |
| Presets / "collections" (easy buttons) | turn each knob yourself | named bundles, admin-applied |

## Decision

Reuse the shipped board-activity feed; add **only the two missing pieces**. Three parts.

### 1. Sprint scope on the existing feed (small backend extension + web reuse)

Add an optional `?sprint=<sprint_id>` param to `GET /projects/{id}/board/activity` that
narrows results to events whose task is **currently** in that sprint OR whose own
sprint-transition references that sprint (so a removal stays visible in the sprint it
left). The scope is applied **in Python over the already-capped keyset batch** — mirroring
the existing `actor` post-filter — via a single bulk `Task.objects.filter(pk__in=…)
.values_list("pk","sprint_id")` lookup, not a DB `task__sprint_id` predicate pushed into
the activity query (this preserves the keyset paging + delta-computation invariants the
builder relies on). Composes with the existing `type` / `actor` / `since` filters. No new endpoint, no new
model, no new event vocabulary.

**Web:** reuse `BoardActivityPanel` / `useBoardActivity` verbatim, threading a `sprintId`
scope through the filter state and query key. When the panel is opened from a sprint
context (the board's active-sprint view, ADR-0119), it defaults to **"This sprint"** scope
with a scope toggle ("This sprint" ↔ "Whole board"). This is the "Activity where the team
already looks" surface — the same rail they use, scoped to the sprint. The existing
"Sprint" event-type chip is relabeled **"Scope changes"** to make the events Jordan/Alex
watch (added/removed) findable without hunting the "All" stream.

### 2. Sprint-membership-change notification (the genuinely new work)

New `NotificationEventType.SPRINT_MEMBERSHIP_CHANGED = "sprint.membership_changed"`.

- **Write-time trigger:** at `TaskViewSet.perform_update` (`views.py:3782`), the single call
  site where `Task.sprint` changes (it already captures `old_sprint_id` and runs the
  ADR-0102 gate). Fires only when a task **actually enters or leaves an `ACTIVE` sprint**
  (committed change — including when a *pending* ADR-0102 injection is *accepted*, whose
  commit path also flips the FK), **not** on the pending proposal itself (honors ADR-0102
  §6). No notification for `PLANNED`/`COMPLETED`/`CANCELLED` sprints. The audit row is
  **not** re-emitted here — the durable audit already exists via `HistoricalTask` and is
  read back through the board feed's `entered_sprint`/`exited_sprint` derivation. This
  trigger only fans out the *notification*.
- **Default recipient candidate set (inherited, overridable):** project leads — interim
  `role >= Role.ADMIN` (Owner + Admin only; Scheduler is 200 < Admin 300, so excluded)
  until ADR-0078 PO/SM facets exist — **minus
  the actor**. The only code-level default; the seed Enterprise will later lock/preset.
- **Per-user autonomy:** plugs into `NotificationPreference` with `DEFAULT_PREFERENCES` =
  **in-app ON, email OFF** (the ADR-0075/0085 contributor-signal default). Any recipient
  can mute individually.
- **Batching:** one inbox row per recipient summarizing N moves
  (`create_event_notifications_batch`, ADR-0232) — respects Priya's per-item-noise hard-NO.
- **Delivery:** durable in-app row inside `transaction.on_commit`, wrapped in try/except so
  a notification failure never fails/reverts the sprint mutation (ADR-0232 pattern). Email
  best-effort via the existing `drain_notification_emails` Beat task. DND honored via
  `_dnd_allows` (ADR-0292); **not** added to `DND_BYPASS_EVENTS` (a scope change is not a
  hard-critical interrupt). Mapped to `CATEGORY_TASKS` in `apps/notifications/categories.py`
  (CI asserts every event type is mapped). Add to `ENUM_NAME_OVERRIDES` in the same commit
  (drf-spectacular enum-collision guard).

### 3. Live update — unchanged, out of scope

The board feed's live WS push was deferred by #1261 and stays deferred; the panel refetches
on focus + manual refresh. No new WS event type (ADR-0160 Amendment B, ADR-0152). The new
notification rides the existing notification-bell read path.

### Deferred behind the ADR-0177 seam (out of scope for 0.4)

- Per-project **override UI** for the candidate set (0.4 ships inherited default +
  per-user opt-out only).
- Enterprise **presets/"collections"** and **org-policy enforcement**.
- The board feed's live WS push and its perf composite index (#1261's own deferred items).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Reuse shipped board feed + `?sprint=` scope + new notification (chosen)** | Minimal net-new code; no new endpoint/model/verbs; no migration; consistent with the surface the team already uses | Requires the small `sprint` scope param on an existing view; notification is the only substantive new backend work |
| B. New `sprint_added/removed` `TaskActivityEventType` verbs + new `/sprints/{id}/activity/` endpoint (earlier draft) | "First-class" verbs | Duplicates the already-shipped `entered_sprint`/`exited_sprint` board events; new endpoint + additive migration for no user-visible gain; double-source risk |
| C. Hard-code "notify project leads," skip settings integration | Simplest | No per-user autonomy (fails Morgan); no Enterprise seam |
| D. Notify on pending injection (pre-acceptance) | Earliest signal | Duplicates ADR-0102 passive My-Work surface; violates §6; more noise |

## Consequences

**Easier:**
- Mid-sprint scope changes are auditable in one place *and* actively surfaced to the
  accountable roles — closes Jordan's and Alex's hard-NOs — with far less new code than a
  from-scratch build, because the feed already exists.
- Every future "who gets told about X" decision has a settings home (ADR-0177 seam).

**Harder / risks:**
- One more `NotificationEventType` to keep in `DEFAULT_PREFERENCES`, `categories.py`, and
  `ENUM_NAME_OVERRIDES` (CI enforces the category map; add all in one commit).
- The interim `role >= Admin` recipient default is a placeholder for ADR-0078 PO/SM facets.
- The `?sprint=` scope is a Python post-filter over the capped keyset batch (one bulk
  `Task` PK→sprint_id lookup), not a DB predicate — same behavior class as the existing
  `actor` post-filter. Consequence (accepted, pre-existing class): for a sparse sprint in a
  high-activity project a page can return fewer than `limit` rows and end paging early
  (mitigated by the builder's 4× overfetch). Guaranteeing full pages would require
  keyset-continuation and would also change the shipped `actor` filter — out of scope.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations (single-team sprint self-governance).
- **Affected packages:** api (`?sprint=` param on the board-activity view; new notification
  event type + write-time emitter/receiver), web (sprint scope + toggle on
  `BoardActivityPanel`/`useBoardActivity`; "Scope changes" chip relabel; reach-from-sprint
  affordance).
- **Migration required:** **no.** No new model, column, or `TaskActivityEventType` choice.
  The new `NotificationEventType` and preference seed are Python constants + lazily-created
  preference rows.
- **API changes:** additive — one optional `sprint` query param on
  `GET /projects/{id}/board/activity`; new notification event type in the notifications
  read surface. Regenerate `docs/api/openapi.json`.
- **OSS or Enterprise:** OSS (`trueppm-suite`). Enterprise presets/org-policy register
  against the ADR-0177 seam later. `grep -r trueppm_enterprise packages/` stays zero.

### Durable Execution
1. **Broker-down behaviour:** The `?sprint=` scope is a pure read — no async. The
   notification's durable in-app row is created inside `transaction.on_commit` via
   `create_event_notifications_batch` (a DB insert, not a task dispatch), so it survives a
   down broker; email is picked up by the existing drain. Reuses the ADR-0075/0085/0232
   path — no new outbox row type.
2. **Drain task:** Reuses the existing `drain_notification_emails` Beat task (30 s,
   `@idempotent_task(on_contention="skip")`). No new drain.
3. **Orphan window:** N/A for the read and the synchronous in-app insert. Email reuses the
   existing 5-min orphan window.
4. **Service layer:** New emitter `notify_sprint_membership_change(task, old_sprint_id,
   new_sprint_id, actor)` in `projects/services.py`, called from `perform_update`; it
   resolves recipients and calls `notifications.services.create_event_notifications_batch`.
   Never writes `Notification` rows directly.
5. **API response on best-effort dispatch:** N/A — the membership change is a side effect of
   the existing task PATCH (returns the task synchronously, 200). The feed is a plain GET.
6. **Outbox cleanup:** N/A. Notification rows follow the existing `archive_old_notifications`
   retention.
7. **Idempotency:** Emitter guarded by `old_sprint_id != new_sprint_id`; a no-op PATCH fans
   out nothing. The notification batch is deduped per recipient by
   `create_event_notifications_batch`'s existing recipient-set logic.
8. **Dead-letter / failure handling:** In-app notification failure is swallowed by the
   `on_commit` try/except (never fails the sprint mutation); email failure reuses the
   existing 3-attempt cap + `email_failed_at`. The read path has no failure side effects.

### Test plan (three layers)
- **pytest (api):** `?sprint=` narrows the board feed to that sprint's tasks and composes
  with `type`/`actor`/`since` + keyset paging; notification fans out on active-sprint
  enter/leave and NOT on no-op / planned / closed sprint / pending-only proposal;
  recipients = leads minus actor; per-user opt-out suppresses; DND holds email but keeps
  in-app row; enum + category maps include the new type.
- **vitest (web):** the sprint scope threads into the query key; the scope toggle switches
  This-sprint ↔ Whole-board; "Scope changes" chip filters to entered/exited/moved.
- **Playwright (e2e):** golden path — move a task into the active sprint, see the row in the
  sprint-scoped panel + a bell notification; one empty/error state.
