---
title: "ADR-0003: RBAC, Auto-Scheduling, WebSockets"
---

# ADR-0003: 5-Role RBAC, Incremental CPM Auto-Scheduling, and WebSocket Real-Time Collaboration

## Status

Accepted

## Context

Phase 1 Batch B introduces three features that are tightly coupled at the permission,
data-write, and broadcast layers. They must be designed together to avoid rework:

- **#11 — 5-role RBAC**: project-scoped roles (Owner, Admin, Scheduler, Member, Viewer)
  gating every existing and future API endpoint, implemented entirely in OSS.
- **#8 — Auto-scheduling (incremental CPM via Celery)**: on any Task or Dependency write,
  re-run `trueppm_scheduler.schedule()` and write CPM outputs back to the Task model.
  Must be idempotent; only Scheduler+ roles can manually trigger.
- **#7 — WebSocket real-time collaboration (Django Channels)**: broadcast CPM results and
  all create/update/delete events to all connected project members in real time; JWT auth
  on connect; channel group `project_{project_pk}`.

The existing codebase has:
- `IsProjectMember` permission class stubbed out in `trueppm_api/permissions.py` — it
  currently allows any authenticated user and documents exactly where full enforcement
  will be added.
- All four ViewSets (`CalendarViewSet`, `ProjectViewSet`, `TaskViewSet`,
  `DependencyViewSet`) already reference `IsProjectMember`.
- `ASGI_APPLICATION`, `CHANNEL_LAYERS` (Redis DB 1), and `CELERY_BROKER_URL` (Redis DB 0)
  are configured in `settings/base.py`.
- `routing.py` has an empty `websocket_urlpatterns` list with a doc comment noting
  where the consumer registration goes.
- `celery.py` is configured and auto-discovers tasks.
- No auth backend is installed yet; `REST_FRAMEWORK` uses `SessionAuthentication` and
  `TokenAuthentication` as placeholders.

---

## Decision Summary

| Topic | Decision |
|-------|----------|
| Auth backend | django-allauth + djangorestframework-simplejwt |
| RBAC location | New `trueppm_api.apps.auth_` app |
| Membership model | `ProjectMembership` through-table on its own app |
| Permission classes | Custom DRF `BasePermission` subclasses, no django-guardian |
| Schedule trigger | DRF `perform_create` / `perform_update` / `perform_destroy` hooks |
| Celery idempotency | Redis SET NX lock per project, TTL 5 minutes |
| WebSocket consumer | `AsyncJsonWebsocketConsumer`, JWT validated on connect |
| Broadcast source | Celery task calls `channel_layer.group_send` after CPM writes; mutations broadcast independently via `transaction.on_commit` |

---

## Decisions in Detail

### 1. Auth Backend: django-allauth + djangorestframework-simplejwt

**Confirmed as specified in CLAUDE.md.**

django-allauth handles registration, email verification, social login (future), and
password flows. simplejwt issues access/refresh tokens consumed by DRF and by the
WebSocket consumer on handshake. No session cookies are used for API clients or
WebSocket auth — JWT only.

**Settings changes required:**

```python
THIRD_PARTY_APPS += [
    "allauth",
    "allauth.account",
    "allauth.socialaccount",
    "rest_framework_simplejwt",
]

REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"] = [
    "rest_framework_simplejwt.authentication.JWTAuthentication",
]

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
}
```

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| django-allauth + simplejwt | Battle-tested, OSS, large contributor pool, supports social auth for future enterprise SSO bridge | Two packages; allauth has Django session coupling that must be disabled for pure JWT |
| djoser + simplejwt | Lightweight, JWT-first | No social auth support; registration/email flows need custom code |
| Knox | Simple token model | No JWT; tokens are opaque, cannot be validated in Channels middleware without DB lookup on every WS message |
| Auth0 / external IdP | Zero auth code | External dependency, breaks offline mobile, SaaS cost at scale |

**Verdict:** django-allauth + simplejwt is confirmed. The allauth `ACCOUNT_ADAPTER` must
be configured to disable session login for API requests so Django sessions are never
relied upon by DRF or Channels.

---

### 2. ProjectMembership Model Design

A dedicated through-table in the new `auth_` app (see §4) rather than a ManyToMany
`through=` on `Project`. This is cleaner than a through= argument because:

- `ProjectMembership` needs methods and a manager (`for_user`, `for_project`,
  `has_role_gte`) that belong on their own model.
- Migrations for the through-table are independent of the `Project` migration chain.
- The model participates in `VersionedModel` for sync (mobile needs to know when
  membership changes).

**Model sketch:**

```python
class Role(models.TextChoices):
    OWNER     = "owner",     "Owner"
    ADMIN     = "admin",     "Admin"
    SCHEDULER = "scheduler", "Scheduler"
    MEMBER    = "member",    "Member"
    VIEWER    = "viewer",    "Viewer"

ROLE_RANK = {
    Role.OWNER: 5,
    Role.ADMIN: 4,
    Role.SCHEDULER: 3,
    Role.MEMBER: 2,
    Role.VIEWER: 1,
}

class ProjectMembership(VersionedModel):
    user    = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                                related_name="memberships")
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE,
                                related_name="memberships")
    role    = models.CharField(max_length=20, choices=Role.choices,
                               default=Role.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("user", "project")]
        db_table = "auth_project_membership"

    def has_role_gte(self, minimum: Role) -> bool:
        return ROLE_RANK[self.role] >= ROLE_RANK[minimum]
```

The first `User` to create a `Project` is automatically assigned `Role.OWNER` via
`ProjectViewSet.perform_create`.

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| `Project.members = ManyToManyField(User, through=ProjectMembership)` | Convenience access via `project.members.all()` | through= still requires a separate model; adds FK back to Project from two directions, making migration ordering messy |
| Store role on `User` model (global role) | Simpler | Incompatible with project-scoped requirement; cannot support a user being Scheduler on one project and Viewer on another |
| django-guardian (per-object permissions) | Flexible | Heavyweight; adds tables for every permission codename; overkill for a fixed 5-role hierarchy; no native DRF integration |

---

### 3. Permission Class Architecture

**Custom DRF `BasePermission` subclasses. No django-guardian.**

The 5-role hierarchy is a fixed ordinal scale. Every endpoint maps to a minimum
required role. Custom permission classes express this cleanly without any
framework overhead.

**Core classes (all in `trueppm_api/permissions.py`):**

```
IsProjectMember          — any role (Viewer+); gates list/retrieve
IsProjectMemberWrite     — Member+ for create/update/delete
IsProjectScheduler       — Scheduler+ for manual trigger endpoint
IsProjectAdmin           — Admin+ for membership management
IsProjectOwner           — Owner only for project deletion / ownership transfer
```

Each class resolves the project PK from `view.kwargs`, looks up
`ProjectMembership.objects.get(user=request.user, project_id=pk)` (with
`select_related` cached on the request via middleware), and compares role rank.

A `ProjectMembershipMiddleware` (or a mixin on the base viewset) attaches
`request.membership` once per request so all permission classes share the
same DB hit.

**has_object_permission pattern:**

`has_permission` checks authentication only. `has_object_permission` checks
the membership row. This preserves DRF's two-phase check and allows list
endpoints to filter the queryset to only projects the user is a member of.

**Queryset scoping:**

All ViewSets override `get_queryset()` to filter by `request.user`'s memberships.
This prevents IDOR (returning data for projects the user is not a member of)
independently of the permission class.

---

### 4. Where RBAC Lives: New `auth_` App

A new Django app `trueppm_api.apps.auth_` (underscore suffix avoids collision with
Django's built-in `django.contrib.auth`).

This app owns:
- `ProjectMembership` model and migration
- `Role` enum / `ROLE_RANK` mapping
- All custom DRF permission classes (moved from the top-level `permissions.py`)
- `api/v1/auth/` URL prefix (registration, login, token refresh, membership CRUD)
- The `ProjectMembershipViewSet` (Admin+ can add/remove members and change roles)

**Why not extend `projects` app?**

`ProjectMembership` imports `User` (from `settings.AUTH_USER_MODEL`) and `Project`.
Putting it in `projects` creates a circular-looking concern: the projects app would
own its own access control. Keeping auth as a separate app makes the dependency
direction explicit: `auth_` → `projects`, never the reverse.

**Why not a top-level `permissions.py` file?**

The file already exists as a module-level utility. Once membership lookups are added
it will grow into a small sub-system. Promoting it to an app keeps tests, models,
serializers, and views co-located.

---

### 5. Celery Task Design: Idempotency via Redis Lock

**One Celery task per project; Redis SET NX lock collapses concurrent triggers.**

```python
# trueppm_api/apps/scheduling/tasks.py

SCHEDULE_LOCK_TTL = 300  # seconds

@shared_task(bind=True, max_retries=3, default_retry_delay=5)
def run_cpm_for_project(self, project_id: str) -> None:
    """Run CPM for a project and write results back to Task rows.

    Idempotency: acquires a Redis lock keyed by project_id. If the lock is
    already held (concurrent trigger for same project), the task exits
    immediately — the holding task will produce a correct result.
    """
    lock_key = f"cpm_lock:{project_id}"
    redis_client = get_redis_client()  # django-redis or redis-py from settings

    acquired = redis_client.set(lock_key, "1", nx=True, ex=SCHEDULE_LOCK_TTL)
    if not acquired:
        # Another worker is already computing CPM for this project.
        # Queue a follow-up run to catch any changes that arrived after the
        # lock was acquired by the current holder.
        self.apply_async((project_id,), countdown=10)
        return

    try:
        _do_run_cpm(project_id)
    finally:
        redis_client.delete(lock_key)
```

The `_do_run_cpm` private function:
1. Fetches the `Project` and all its `Task` + `Dependency` rows.
2. Converts them to `trueppm_scheduler.models.Project` dataclasses.
3. Calls `trueppm_scheduler.engine.schedule(project)`.
4. Bulk-updates all `Task` rows with CPM output fields using `Task.objects.bulk_update()`.
5. Calls `broadcast_schedule_result(project_id, result)` wrapped in `transaction.on_commit`.

**Why Redis lock over DB state (e.g. a `ScheduleRun` table with a `running` flag)?**

| Option | Pros | Cons |
|--------|------|------|
| Redis SET NX | Atomic, no migration, automatic TTL prevents stuck locks | Requires a Redis client outside Celery broker abstraction; TTL must be generous enough for large projects |
| DB row with `running` flag | Persistent, queryable | Requires migration; risk of stuck rows if worker dies; more DB writes on hot path |
| Celery task deduplication (unique task ID) | Native to Celery | Celery's `task_always_eager` and result backend make dedup brittle in test; `apply_async` with `task_id` only prevents duplicate enqueue, not concurrent execution |

**Verdict:** Redis SET NX lock. TTL of 5 minutes is safe for any realistic project
size (CPM on 10 000 tasks completes in under 1 second in the scheduler engine).

**Manual trigger endpoint:**

```
POST /api/v1/projects/{id}/schedule/
```

Permission: `IsProjectScheduler` (Scheduler+ role). Enqueues
`run_cpm_for_project.delay(project_id)`. Returns `202 Accepted` immediately.
The Celery task status is not polled; the client learns the result via WebSocket.

---

### 6. Schedule Trigger Mechanism: DRF `perform_*` Hooks

**DRF `perform_create` / `perform_update` / `perform_destroy` on `TaskViewSet` and `DependencyViewSet`.**

Not Django signals; not model `save()` override.

**Rationale:**

| Option | Pros | Cons |
|--------|------|------|
| `perform_create/update/destroy` in DRF ViewSets | Explicit; fire only on API writes; no accidental triggers from fixtures, migrations, or management commands; easy to test by mocking `run_cpm_for_project.delay` | Must be added to every ViewSet that mutates Task/Dependency — currently two ViewSets |
| Django `post_save` / `post_delete` signals | Fire regardless of call site | Fire during fixtures, `loaddata`, migrations; require `update_fields` inspection to avoid CPM re-runs from the Celery task writing CPM output back (infinite loop risk) |
| Model `save()` override | Same scope as signals | Same infinite loop risk; harder to skip in tests; violates "thin model" convention |

**Infinite loop protection:** The Celery task writes CPM output fields via
`Task.objects.bulk_update(tasks, fields=[...cpm_fields...])`. `bulk_update` does not
call `save()` and does not fire `post_save` signals, so there is no trigger chain.
If `perform_update` is used to write CPM fields it must pass
`update_fields=[...non_cpm_fields...]` to prevent triggering CPM again — but the
preferred approach is to use `bulk_update` directly in the Celery task.

**Implementation:**

```python
class TaskViewSet(viewsets.ModelViewSet):
    def perform_create(self, serializer):
        instance = serializer.save()
        transaction.on_commit(
            lambda: run_cpm_for_project.delay(str(instance.project_id))
        )

    def perform_update(self, serializer):
        instance = serializer.save()
        transaction.on_commit(
            lambda: run_cpm_for_project.delay(str(instance.project_id))
        )

    def perform_destroy(self, instance):
        project_id = str(instance.project_id)
        instance.delete()
        transaction.on_commit(
            lambda: run_cpm_for_project.delay(project_id)
        )
```

`transaction.on_commit` ensures the Celery task only fires after the DB row is
committed and visible to the worker. This eliminates a race condition where the
worker reads stale data if the transaction is still open.

---

### 7. WebSocket Consumer Design

**`AsyncJsonWebsocketConsumer` with JWT validated on connect.**

```python
# trueppm_api/apps/scheduling/consumers.py

class ProjectConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        token = _extract_token(self.scope["query_string"])
        user = await _validate_jwt(token)           # hits DB once on connect
        if user is None:
            await self.close(code=4001)
            return

        project_id = self.scope["url_route"]["kwargs"]["project_id"]
        is_member = await _check_membership(user, project_id)  # DB check
        if not is_member:
            await self.close(code=4003)
            return

        self.group_name = f"project_{project_id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content):
        # Clients do not send messages in this version; consumer is receive-only.
        # Reserved for future ping/pong or subscription refinement.
        pass

    async def project_event(self, event):
        """Handler for channel layer messages sent to this group."""
        await self.send_json(event["payload"])
```

**Token extraction:** The JWT is passed as a query parameter:
`ws://host/ws/projects/{id}/?token=<access_token>`. This is the only practical
option for browser WebSocket connections (the `Authorization` header cannot be set
on browser WebSocket handshakes). The token is a short-lived access token
(15 minutes per §1), limiting the exposure window if intercepted.

**Reconnect handling:** Clients are responsible for reconnect with exponential
backoff. On reconnect the full auth flow runs again. The server does not maintain
session state between connections — the channel group is ephemeral. The client
should request a fresh state snapshot via REST after reconnect (a `GET
/api/v1/projects/{id}/tasks/` call) to fill any gap.

**URL pattern:**

```python
# trueppm_api/routing.py
websocket_urlpatterns = [
    path("ws/projects/<uuid:project_id>/", ProjectConsumer.as_asgi()),
]
```

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| `AuthMiddlewareStack` (Channels session auth) | Built-in | Requires session cookies; incompatible with JWT-only mobile clients |
| Token in `Sec-WebSocket-Protocol` header | Header-based | Not universally supported by load balancers; non-standard |
| JWT in query param (chosen) | Works in browser and mobile; simple to implement | Token visible in server access logs — mitigated by short TTL |

---

### 8. Broadcast Mechanism

**Two separate broadcast paths:**

**Path A — Mutation events (Task/Dependency/Project create/update/delete):**

Each ViewSet's `perform_*` hook fires a `broadcast_board_event()` call inside
`transaction.on_commit`, alongside the CPM trigger. These are independent of CPM
and fire immediately after the write commits, giving collaborators sub-second
awareness of changes.

```python
# trueppm_api/broadcast.py
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

def broadcast_board_event(project_id: str, event_type: str, payload: dict) -> None:
    """Send a real-time event to all connected members of a project.

    Must be called inside transaction.on_commit() to guarantee the DB row
    is visible before clients re-fetch.
    """
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"project_{project_id}",
        {"type": "project.event", "payload": {"type": event_type, **payload}},
    )
```

**Path B — CPM completion events:**

After `_do_run_cpm` completes and `bulk_update` commits, the Celery task calls
`broadcast_board_event` with `event_type="schedule.updated"` and a payload
containing the updated task dates. This is also wrapped in `transaction.on_commit`
inside the Celery task to guarantee the bulk-update is visible to clients before
they re-fetch.

**Why not a separate signal for CPM completion?**

A Django signal fired from inside a Celery task runs in the worker process. It
would require the signal handler to also call `channel_layer.group_send`, which
is the same code as `broadcast_board_event`. Signals add indirection without any
benefit here. The explicit call in the Celery task is clearer and easier to test.

**Event payload schema (WebSocket message to client):**

```json
{
  "type": "task.updated",
  "task_id": "<uuid>",
  "project_id": "<uuid>",
  "changes": { "<field>": "<new_value>", "...": "..." }
}

{
  "type": "schedule.updated",
  "project_id": "<uuid>",
  "tasks": [
    {
      "id": "<uuid>",
      "early_start": "2025-06-01",
      "early_finish": "2025-06-10",
      "late_start": "2025-06-01",
      "late_finish": "2025-06-10",
      "total_float": 0,
      "free_float": 0,
      "is_critical": true
    }
  ]
}
```

---

## Alternatives Considered (cross-cutting)

| Topic | Rejected Option | Reason |
|-------|----------------|--------|
| RBAC | django-guardian | Per-object permission tables are overkill for a 5-role ordinal hierarchy; no native DRF `has_object_permission` integration; adds operational complexity |
| RBAC | Global (non-project-scoped) roles on `User.role` | Cannot support a user being Scheduler on one project and Viewer on another — incompatible with the requirement |
| Celery idempotency | Celery `task_id` dedup | Only prevents duplicate enqueue, not concurrent execution of two tasks that were enqueued before either started |
| WebSocket | Socket.IO | Not in tech stack; requires separate Node process; violates constraint |
| WebSocket | Firebase Realtime DB | External dependency; breaks offline mobile; not Apache 2.0 |
| Broadcast | Celery task polls until CPM done, then broadcasts | Unnecessary polling; the Celery task itself owns the CPM run and can broadcast directly |

---

## Consequences

**Easier:**

- All five roles are expressible as a single integer rank comparison — permission checks
  are one line of code once `request.membership` is attached.
- The `IsProjectMember` stub in `permissions.py` needs only its `has_object_permission`
  body replaced — all four ViewSets are already wired.
- `transaction.on_commit` + Celery ensures workers never race against uncommitted writes.
- WebSocket consumers are stateless (no in-memory state beyond the channel name) —
  horizontal scaling of Daphne workers requires no coordination beyond the Redis channel
  layer that is already configured.

**Harder:**

- Every new ViewSet must explicitly scope its queryset to the user's memberships or it
  risks leaking data (IDOR). A base `ProjectScopedViewSet` mixin should enforce this
  by default.
- The `auth_` app introduces a new migration dependency chain that other apps must
  import (`projects` → none, `auth_` → `projects`). Circular import risk must be
  managed by using string references (`"projects.Project"`) in FK definitions.
- JWT short TTL (15 min) means mobile clients must implement refresh token rotation.
  The simplejwt blacklist app (`rest_framework_simplejwt.token_blacklist`) must be in
  `INSTALLED_APPS` for `ROTATE_REFRESH_TOKENS` to work safely.

**Risks:**

- **Redis lock TTL**: If CPM takes longer than 5 minutes (unrealistic but possible on
  a pathologically large project with no calendar caching), the lock expires and a
  second worker starts a concurrent run. Mitigation: extend TTL to 10 minutes and add
  a Celery task time limit of 8 minutes (`time_limit=480` on the task decorator).
- **Broadcast before client re-fetches**: The WebSocket payload contains CPM output
  fields directly. If the client uses these fields to update its local state without
  re-fetching, it must handle partial updates correctly. The alternative — broadcast
  only a "data changed" signal and let clients re-fetch — is simpler but doubles
  read traffic on large projects. The chosen approach (broadcast full CPM fields)
  is the right call for Gantt chart real-time updates.
- **`post_save` signal infinite loop**: Explicitly not a risk because the Celery task
  uses `bulk_update`, which bypasses signals and `save()`. This must be documented
  in the task code and enforced in code review.

---

## Implementation Notes

**Affected packages:** `api` (all changes), `scheduler` (no changes — pure library)

**New app:** `trueppm_api.apps.auth_`

**Migration required:** Yes — `ProjectMembership` table, `auth_` app migrations.
Existing `projects` migrations are not modified. Migration order:
`0001_initial` on `auth_` must run after `projects.0001_initial`.

**New dependencies (to be vetted via `/dependency` agent before adding):**

- `django-allauth` — registration, email verification
- `djangorestframework-simplejwt` — JWT tokens for DRF + WebSocket auth
- `rest_framework_simplejwt.token_blacklist` — refresh token rotation safety
- `redis` (redis-py) — for the SET NX lock in the Celery task (may already be
  pulled in by `channels_redis`; confirm before adding)

**API changes:** Yes

New endpoints:

```
POST   /api/v1/auth/register/
POST   /api/v1/auth/token/
POST   /api/v1/auth/token/refresh/
POST   /api/v1/auth/token/blacklist/
GET    /api/v1/projects/{id}/members/
POST   /api/v1/projects/{id}/members/
PATCH  /api/v1/projects/{id}/members/{user_id}/
DELETE /api/v1/projects/{id}/members/{user_id}/
POST   /api/v1/projects/{id}/schedule/         (manual CPM trigger, Scheduler+)
WS     ws://host/ws/projects/{id}/?token=<jwt>
```

**OSS or Enterprise:** OSS (`trueppm-suite`) — all three features are explicitly listed
as OSS in CLAUDE.md.

**Queryset scoping baseline:** A `ProjectScopedViewSet` base class (or mixin) should
be introduced at the same time as RBAC to ensure every current and future ViewSet
filters its queryset to the authenticated user's project memberships by default. This
is not optional — without it, any new ViewSet risks an IDOR vulnerability.

---

## Blocking Questions for Kelly

### 🔴 BQ-1: Auth app naming

The proposed app name is `auth_` (with trailing underscore) to avoid collision with
Django's built-in `django.contrib.auth`. Alternative names: `iam`, `access`, `membership`.
**Decision needed before the migration is created** — renaming after initial migration
requires a squash or a rename migration.

### 🔴 BQ-2: Viewer role write access to CPM output fields

Viewers can read tasks (including CPM dates). Can they read the WebSocket stream too,
or are WebSocket connections restricted to Member+ ? The consumer currently grants
access to any project member (Viewer+). If Viewers should be excluded from real-time
updates (to reduce load for large read-only audiences), the `_check_membership` call
in the consumer needs a minimum role check. **This changes the consumer code.**

### 🔴 BQ-3: Project creation — who can create projects?

The `ProjectViewSet.perform_create` auto-assigns the creator as Owner. But who is
allowed to hit `POST /api/v1/projects/` in the first place? Options:
- Any authenticated user (simplest; OSS community ethos)
- Any user with a global `can_create_project` flag on the User model (adds a column)
- Admin-only initially (restrictive; complicates onboarding)

**This affects the `ProjectViewSet` permission class and the User model design.**

### 🟡 BQ-4: Calendar RBAC scope

`Calendar` objects are currently global (not project-scoped). The `CalendarViewSet`
is gated by `IsProjectMember`, which does not currently make sense for a global
resource. In the full RBAC world: should calendars be project-scoped (owned by one
project) or remain global (shared across projects)? If global, the permission class
for CalendarViewSet needs a different strategy (e.g., `IsAuthenticated` for read,
`IsStaff` for write). **This is a design question, not a blocking bug**, but it
must be resolved before CalendarViewSet permissions are tightened.

### 🟡 BQ-5: WebSocket reconnect — full state snapshot vs. incremental

On reconnect, should the server send a full state snapshot of the current project
(all task dates) immediately after the client connects? This simplifies client-side
gap-filling after a disconnect but requires a DB read on every WebSocket connection.
At low scale this is fine; at hundreds of concurrent users reconnecting after a
deploy it could spike DB load. The ADR currently recommends a REST fetch by the
client. Confirm this is acceptable for the web and mobile clients.
