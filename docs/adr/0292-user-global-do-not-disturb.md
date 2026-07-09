# ADR-0292: User-global Do-Not-Disturb (DND) notification preference

## Status
Accepted

> **ADR number:** `0291` was drafted first but collides with the committed
> `0291-connected-accounts-available-sources-section.md` on the in-flight
> `feat/1420` branch, so this ADR uses `0292` — the number #1707 had already
> reserved (project memory). The four-event `DND_BYPASS_EVENTS` membership below
> was confirmed by the maintainer before implementation.

## Context

The TopBar `NotificationBell` (#1707) rendered a slashed "muted" bell emoji
(`🔕`) whenever unread count was zero. No mute/off state existed, so the glyph
falsely implied "notifications are off." Web-rule 240 requires that a
slashed/off glyph appear **only** when a real preference fact drives it. Rather
than merely neutralizing the glyph, we introduce the missing fact: a per-user
**global Do-Not-Disturb (DND)** toggle. The bell then reflects DND honestly.

**P3M layer:** Operations (an individual contributor's personal app preference).
It does not aggregate across projects, programs, or the org.

The notification subsystem is mature and already contains the exact precedent we
need:

- **Global per-user routing** lives in `notifications.NotificationPreference`
  (`(event_type, channel, enabled)` rows) with `DEFAULT_PREFERENCES` fallback.
  The in-app dispatch functions (`create_event_notifications`,
  `create_event_notifications_batch`, `create_mention_notifications`, the
  stale-task path) each gate the **durable in-app inbox row** on the user's
  `in_app` preference and independently set `email_pending` from the `email`
  preference. The email is sent later by a drain reading `email_pending=True`.
- **Per-project quiet hours** live on `ProjectNotificationPreference`
  (`paused` kill-switch + `quiet_hours_enabled/from(20:00)/until(07:00)`,
  project-tz anchored). Critically, `_QUIET_HOURS_EXEMPT_CHANNELS = {in_app}`:
  quiet hours silence only the **transient** channel (email), and **never** drop
  the durable in-app record. GitHub's model — "the record persists; only the
  interruption is held back."

**Gaps (verified):** no user-global quiet-hours/DND, no global mute kill-switch,
no per-user timezone field, no DND/mute field on `profiles.UserProfile`.

**Hard constraints from prior review (all honored below):**
1. 🔴 A muted bell must NEVER swallow a critical alert (VoC blocker).
2. Keep the numeric unread count on the bell (no bare red dot).
3. Private & PMO-invisible — a self-serve individual preference, never a
   governance surface (Morgan's condition; OSS/adoption boundary).
4. Web-rule 240 — the muted glyph must be driven by this real DND fact.

## Decision

Introduce a **user-global DND toggle** that mirrors the quiet-hours precedent:
DND silences only transient/interrupting channels (email now; push later) and is
**structurally incapable of suppressing the durable in-app inbox row**. Critical
"signal" events bypass DND entirely for the transient channel too. The bell keeps
its unread count in every state and shows the muted glyph iff DND is on.

### Resolved decisions (1–8)

**1. Where the DND state lives → a new user-scoped singleton model in the
`notifications` app (`UserNotificationSettings`), NOT `profiles.UserProfile` and
NOT `NotificationPreference`.**

```python
# notifications/models.py
class UserNotificationSettings(models.Model):
    """Per-user global notification settings (DND kill-switch).

    User-global analog of ProjectNotificationPreference. Lives in the
    notifications app because the delivery gate (services.py) reads it; a plain
    Model (no server_version) — a personal app preference, never synced or
    broadcast, mirroring ProjectNotificationPreference and profiles.UserProfile.
    Lazily created via get_or_create; absence of a row == dnd_enabled False.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="notification_settings",
    )
    dnd_enabled = models.BooleanField(default=False)
    # v1 ships dnd_enabled only. The scheduled-window fields below mirror
    # ProjectNotificationPreference and are DEFERRED (see decision 4) — do not
    # add them until the follow-up; shown here only to fix the growth shape.
    #   quiet_hours_enabled = models.BooleanField(default=False)
    #   quiet_hours_from    = models.TimeField(default=datetime.time(20, 0))
    #   quiet_hours_until   = models.TimeField(default=datetime.time(7, 0))
    #   timezone            = models.CharField(max_length=64, blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notifications_user_settings"
```

*Why not `profiles.UserProfile`?* The `profiles` app is scoped to app-navigation
preferences (`default_landing`, `role_context`, `hidden_views`,
`schedule_in_deliver`). The DND fact is consumed by the **notification delivery
gate** in `notifications/services.py`; co-locating it with the gate (as
`ProjectNotificationPreference` already is) keeps notification routing logic in
one app and avoids a cross-app import into the hot dispatch path.

*Why not `NotificationPreference`?* That table is per-`(event_type, channel)`
rows — the wrong grain for a single user-global boolean. A DND flag there would
be a sentinel row or N duplicated rows; a dedicated singleton is cleaner and
leaves room for the deferred scheduled window.

**2. DND semantics (precise).**
- DND **ON** silences transient/interrupting channels — **email** today, push
  when it ships — for **non-critical** events.
- **Durable in-app `Notification` rows are ALWAYS created**, exactly as under
  quiet hours (`in_app` is DND-exempt). Nothing is ever lost; the inbox is the
  complete record.
- **Critical events (see decision 3) send email even under DND.**
- **The bell badge is unchanged by DND.** It counts every unread in-app row in
  all states. DND does **not** suppress routine unread from the count — doing so
  would (a) risk under-counting/losing items, (b) require a drift-prone per-item
  critical classification on the read path, and (c) violate constraint 2. Under
  DND the bell shows `muted glyph + count`: "you have N unread, and you've muted
  interruptions." The glyph is the only visible bell change.

**3. Safety by construction (🔴 constraint 1).** DND is wired into the **same
transient-channel gate** as quiet hours and cannot touch in-app row creation, so
a critical (or any) event's durable inbox row is created regardless of DND — it
can never be swallowed. On top of that, a single explicit bypass set is consulted
at the one email gate:

```python
# notifications/models.py — a DEDICATED set, defined once, next to the model.
# NOTE: this is deliberately NOT SIGNAL_ONLY_EVENTS (see 🔴 below).
DND_BYPASS_EVENTS: frozenset[str] = frozenset({
    NotificationEventType.TASK_BLOCKED,
    NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED,
    NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED,
    NotificationEventType.MILESTONE_FORECAST_SHIFTED,
})

# notifications/services.py — mirrors _QUIET_HOURS_EXEMPT_CHANNELS.
_DND_EXEMPT_CHANNELS = frozenset({NotificationChannel.IN_APP.value})

def _dnd_allows(dnd_enabled: bool, *, event_type: str, channel: str) -> bool:
    """True if DND permits this (event, channel). in_app is always exempt (the
    durable inbox is never dropped); critical events bypass DND entirely."""
    if not dnd_enabled:
        return True
    if channel in _DND_EXEMPT_CHANNELS:
        return True
    return event_type in DND_BYPASS_EVENTS
```

The `email_pending` computation in each dispatch function ANDs this in:
`email_pending = _allows(uid, EMAIL) and _dnd_allows(dnd, event_type=et, channel=EMAIL)`.
The in-app creation guard (`if not _allows(uid, IN_APP): continue`) is untouched.
Because the bypass is one frozenset consulted at one gate — not a runtime
`if critical: deliver anyway` scattered across call sites — it cannot drift.

> 🔴 **BLOCKER — the critical-bypass set does NOT equal `SIGNAL_ONLY_EVENTS`.**
> The task brief said to reuse the existing `SIGNAL_ONLY_EVENTS` set, but that
> set (models.py ~L459) is **actually** `{TASK_BLOCKED, TASK_DUE_DATE_CHANGED}` —
> it is the *contributor-friendly "signal-only" settings preset* applied by
> `POST /me/notification-preferences/apply-preset/`, **not** the
> critical-alert-bypass set. It is missing `signal.ceiling_proposal_opened`,
> `signal.ceiling_proposal_resolved`, and `milestone.forecast_shifted`, and it
> includes `task.due_date_changed`, which is routine, not a blocker.
> **Reusing it would let a routine due-date change bypass DND while silencing a
> signal-ceiling proposal — the inverse of the intent.** Therefore v1 defines a
> **dedicated `DND_BYPASS_EVENTS`** set (above), matching the four events the
> reviewer enumerated. **Confirm this exact membership before coding** — it is
> the load-bearing safety contract.

**4. Scheduled quiet-hours window → DEFERRED. v1 = manual on/off toggle only.**
A user-global scheduled window needs a new per-user timezone field, tz-resolution
in the dispatch path, and window UI — none of which the honest-bell motivation
requires. v1 ships the `dnd_enabled` boolean, which fully resolves #1707. The
model is *shaped* to grow the `quiet_hours_*` + `timezone` fields later (mirroring
`ProjectNotificationPreference`), tracked as a follow-up issue (see Scope).

**5. API shape → new `/me/notification-settings/` (GET/PATCH) in the
notifications app, plus a read-only `dnd_enabled` projection on `/auth/me`.**
- **Write/authoritative read:** `GET/PATCH /me/notification-settings/` — a
  singleton endpoint (`get_or_create` on the caller), consistent with
  `/me/notification-preferences/` and owned by the app that holds the state
  (decision 1). Returns `{ "dnd_enabled": bool }`.
- **Bell read:** surface `dnd_enabled` (read-only) on the existing `/auth/me`
  serializer, alongside `hidden_views` / `role_context` / `schedule_in_deliver`.
  The shell already fetches `/auth/me` on load, so the bell reads
  `useCurrentUser().dnd_enabled` with **zero extra requests** and **zero new
  e2e mock surface** (a new bell-read endpoint would force every shell spec to
  mock it — the "mock every endpoint a page reads" tax). This is a one-way
  cross-app *read* in the me-serializer aggregation (it already aggregates the
  profile), not a write coupling.
- The toggle PATCHes `/me/notification-settings/` and optimistically updates /
  invalidates the `['current-user']` query so the glyph flips immediately.

**6. Broadcast/real-time → NONE.** DND is a pure per-user preference affecting
only the owner's own delivery and their own bell. No other user observes it; it
is not a board-scoped resource. No `broadcast_board_event()`, no Channels wiring.
The change reflects on the owner's next `/auth/me` read (or the optimistic local
update). `broadcast-check` is **N/A** for this change.

**7. OSS or Enterprise → OSS.** Personal, self-serve, individual, PMO-invisible;
mirrors `ProjectNotificationPreference` (already OSS). It answers "would a
contributor need this to run their day?" → yes → OSS. The Enterprise line is
crossed only by an **admin-enforced org-wide DND policy** or **directory-driven
quiet hours** (org identity governance) — both explicitly **out of scope** and
would register against the OSS extension points, not ship here. `enterprise-check`
is not required (this is squarely OSS).

**8. Migration safety → non-destructive.** A `CreateModel` for
`UserNotificationSettings` with `dnd_enabled = BooleanField(default=False)`.
`NOT NULL` is satisfied by the `default=False`. Rows are lazily created via
`get_or_create`, so **no backfill / data migration** — the absence of a row reads
as DND off. No `server_version` (not synced, mirroring
`ProjectNotificationPreference` / `UserProfile`). Batch the model edit and run
`makemigrations` once; follow with `ruff check --fix && ruff format`.

### Frontend (NotificationBell, web-rule 240)

- Read `dnd = useCurrentUser().dnd_enabled`. Keep `count` from
  `useUnreadNotificationCount` unchanged.
- **Glyph:** show the muted/off bell **iff `dnd`** — driven by the real fact
  (rule 240). At `!dnd && count === 0` the bell is the normal (active) bell, NOT
  the slashed one (the #1707 bug: an off-glyph with no off-state). Prefer a
  single active `BellIcon` SVG with a mute indicator overlaid when `dnd`, per the
  #1707 memory note (one active SVG in all states; unread = badge+accent, not an
  icon swap) — reconcile the exact rendering with that MR's decision.
- **Badge:** unchanged — the numeric unread count still renders whenever
  `count > 0`, in both DND and non-DND states (constraint 2).
- **`aria-label`** must state DND: e.g. `"Notifications, {count} unread, Do Not
  Disturb on"` so the muted state is conveyed non-visually (color/glyph never the
  sole signal).
- The DND toggle itself is a `role="switch"` on the notification settings surface
  (`NotificationPreferencesPage` header, or the panel header) — small, self-serve,
  never on any team/PMO surface.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **State on `notifications.UserNotificationSettings` (chosen)** | Co-located with the delivery gate; mirrors `ProjectNotificationPreference`; room for deferred scheduled window; correct grain | One new small table |
| State on `profiles.UserProfile` | Reuses the established per-user `/auth/me` + `PATCH /auth/me/profile/` pattern; no new endpoint | Cross-app import of a routing fact into the hot dispatch path; mixes app-nav prefs with notification routing |
| Fields on `NotificationPreference` | No new model | Wrong grain (per-`(event,channel)` rows); forces a sentinel/duplicated rows for one global boolean |
| DND suppresses the badge count for routine items | "Quieter" bell | Violates constraint 2; risks under-count/lost items; needs drift-prone per-item classification on read |
| Reuse `SIGNAL_ONLY_EVENTS` for bypass | No new set | 🔴 Wrong membership — silences a signal-ceiling proposal while letting routine due-date changes through (see decision 3) |
| DND as a runtime `if critical: deliver` check at each call site | Local | Drifts; a new dispatch site can forget it — not safe by construction |

## Consequences

**Easier**
- The bell reflects a true fact; web-rule 240 is satisfiable.
- Contributors get a real "mute the noise" control without losing anything — the
  inbox stays complete; only email interruptions pause.
- Safety is structural: the in-app row is never gated by DND, and the bypass set
  is one frozenset at one gate. A future dispatch site inherits the guarantee by
  calling the shared gate helper.

**Harder / watch-outs**
- 🔴 The `DND_BYPASS_EVENTS` membership is the safety contract — it must be
  reviewed and kept in step as new critical event types are added. A test must
  assert every `DND_BYPASS_EVENTS` member emails under `dnd_enabled=True`.
- Every dispatch function that computes `email_pending` must route through
  `_dnd_allows` — an audit of the four dispatch paths
  (`create_event_notifications`, `create_event_notifications_batch`,
  `create_mention_notifications`, stale-task) is required so none is missed.
- The `/auth/me` `dnd_enabled` projection couples the me-serializer to the
  notifications singleton (read-only). Acceptable — it already aggregates profile.

**Risks**
- If `_dnd_allows` were accidentally applied to the in-app guard, DND would start
  dropping durable rows (data loss). Guard with a test asserting in-app rows are
  created for a routine event while `dnd_enabled=True`.

## Implementation Notes
- **P3M layer:** Operations (personal preference).
- **Affected packages:** api (`notifications` app: model + migration + endpoint +
  gate; `auth`/me serializer read projection), web (`NotificationBell`, a
  `useNotificationSettings`/`useUpdateDnd` hook + toggle, `/auth/me` type).
- **Migration required:** yes — one `CreateModel`, `default=False`, no backfill.
- **API changes:** yes — new `GET/PATCH /me/notification-settings/`; read-only
  `dnd_enabled` added to `/auth/me`. Regenerate `docs/api/openapi.json` (merge
  `origin/main` first).
- **OSS or Enterprise:** OSS.

### Scope boundary — THIS MR (on !1151 / #1707) vs deferred

**In scope (this MR):**
- `UserNotificationSettings` model + migration; `DND_BYPASS_EVENTS` set;
  `_dnd_allows` helper wired into the `email_pending` computation of all four
  dispatch paths; in-app row creation left untouched.
- `GET/PATCH /me/notification-settings/` endpoint + serializer;
  `dnd_enabled` read-only on `/auth/me`.
- `NotificationBell` glyph driven by `dnd_enabled` (rule 240) + `aria-label`;
  badge count unchanged; a DND toggle control on the settings/panel surface.
- Tests (all three layers): pytest — in-app row always created under DND, email
  held for a routine event, email **sent** for every `DND_BYPASS_EVENTS` member,
  settings endpoint auth + happy path; vitest — bell glyph/aria per `dnd` state,
  count preserved; Playwright — toggle DND → bell shows muted glyph, count still
  shows. Docs: `docs/features/` notifications page + `docs/administration/` if the
  toggle surfaces there; changelog fragment `1707.added.md` (or `.changed.md`).

**Deferred (file follow-up issues, do NOT build here):**
- User-global **scheduled quiet-hours window** + per-user **timezone** field
  (grow the model's `quiet_hours_*`/`timezone` fields, mirror the
  `ProjectNotificationPreference` tz-resolution). Motivation for a separate pass:
  new field, tz math in the dispatch path, and window UI.
- **Push** channel participation (DND silences push when push ships — it will
  slot into `_dnd_allows` as another non-exempt transient channel automatically).
- Admin-enforced **org-wide DND policy** / directory-driven quiet hours —
  **Enterprise**, registers against the OSS extension points.

### Durable Execution
1. **Broker-down behaviour:** N/A — the DND toggle is a synchronous DB write; it
   introduces no async dispatch. The existing email drain is unchanged (it still
   reads `email_pending=True` rows); DND only decides whether `email_pending` is
   set at creation.
2. **Drain task:** Reuses the existing email-send drain — no new async category.
   DND is evaluated synchronously at notification-creation time, not in the drain.
3. **Orphan window:** N/A — no new outbox/drain rows.
4. **Service layer:** Extends `notifications/services.py` — new `_dnd_allows()`
   consulted in the `email_pending` branch of the four existing dispatch
   functions; no new dispatch path.
5. **API response on best-effort dispatch:** N/A — `PATCH /me/notification-
   settings/` is a synchronous write returning the updated object (200), not a
   queued 202.
6. **Outbox cleanup:** N/A — no outbox rows introduced.
7. **Idempotency:** The PATCH is naturally idempotent (sets a boolean to the
   desired value); the singleton is guarded by the `OneToOneField` unique
   constraint via `get_or_create`.
8. **Dead-letter / failure handling:** N/A — synchronous request; standard DRF
   error responses. No task, no retry, no DLQ.
