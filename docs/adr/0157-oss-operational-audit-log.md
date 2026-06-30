# ADR-0157: OSS Operational Audit Log + Enterprise-Signing Extension Point

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class AuditEvent)

## Context

PMO and workspace owners need an answer to "who did what, when?" at the workspace
administration grain — who added or removed a member, who changed a role, who
created or deleted a project, who changed workspace settings, who triggered an
export. Today the OSS edition has **no** workspace-level operational audit path.
Marcus (PMO) is a documented hard-NO on adopting a tool with no audit trail
(2026-05-29 VoC audit).

The `enterprise-check` verdict for this need is **Split (OSS-eligible)**:

- **OSS** ships a *mutable, human-readable, single-workspace* operational event
  log. Owner/Admin-visible. No immutability, no cryptographic signing, no
  retention guarantees, no cross-workspace aggregation, no SOC-2 export.
- **Enterprise** (separate repo, existing) layers immutable/append-only storage,
  signing, retention policy, and SOC-2 export *on top of* the OSS events via a
  stable signal hook — **without modifying OSS code**.

The split is identical in shape to two precedents already in the codebase:

1. **`sprint_scope_changed`** (`projects/signals.py`) — a Django `Signal()` fired
   after a `SprintScopeChange` row is saved so "Enterprise audit receivers can
   capture the event without modifying OSS code." This ADR generalizes that exact
   idiom from the sprint grain to the **workspace** grain.
2. **The provider/registry seam** (ADR-0029/0049) used by `sharing_settings.py`,
   `task_duration_settings.py`, etc. — OSS defines a neutral hook and registers
   no provider; enterprise registers one in its `AppConfig.ready()`.

The extension point must be defined **before** landing so the event payload schema
is stable for enterprise to register against (the requirement called out in #859).

**P3M layer.** Operations / Programs-and-Projects administration. The log is
strictly **single-workspace** — it never aggregates across workspaces. Cross-
workspace / org-wide compliance aggregation is the Portfolio/Senior-Leadership
layer and stays in Enterprise. This keeps the Apache-2.0 boundary clean: OSS emits
events; Enterprise consumes them.

## Decision

Ship a **backend slice** (the team's established pattern — #967/#388/#414 shipped
backend-first; the web viewer is a deferred follow-up):

### 1. `AuditEvent` model (`workspace/models.py`)

A plain `models.Model` — **not** `VersionedModel`. Mirrors the `SprintScopeChange`
justification: audit rows are **not synced to mobile**; they are server-side
operational metadata read only through the Owner/Admin web/API surface. No
`server_version`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `UUIDField` PK | `default=uuid.uuid4, editable=False` (house convention) |
| `actor` | `FK(AUTH_USER_MODEL, on_delete=SET_NULL, null=True)` | Null = system action or deleted user. Survives user deletion. |
| `actor_label` | `CharField(max_length=255, blank=True)` | Denormalized actor display (email/name at event time) — survives user deletion, so the log stays human-readable. |
| `event_type` | `CharField(max_length=40, choices=AuditEventType.choices, db_index=True)` | See taxonomy below. |
| `target_type` | `CharField(max_length=40, blank=True)` | e.g. `"project"`, `"member"`, `"workspace"`. |
| `target_id` | `UUIDField(null=True, blank=True)` | Best-effort pointer; may dangle after hard delete (denormalized label is the source of truth). |
| `target_label` | `CharField(max_length=512, blank=True)` | Denormalized human-readable target (project name, member email). Survives target deletion — same idiom as `SprintScopeChange.subtask_name`. |
| `metadata` | `JSONField(default=dict, blank=True)` | Structured extra context (e.g. `{"old_role": "MEMBER", "new_role": "ADMIN"}`). Bare `JSONField`, no custom encoder (house convention). |
| `created_at` | `DateTimeField(auto_now_add=True, db_index=True)` | |

No `workspace` FK — the OSS workspace is a singleton, so (per the
`WorkspaceExportJob` precedent: "no FK to Workspace because it is a singleton; a
job always concerns the one workspace") the row carries no workspace dimension.
The enterprise receiver resolves the workspace itself (`Workspace.load()`) when
it mirrors events into its multi-tenant schema.

`Meta`: `db_table = "workspace_auditevent"`, `ordering = ["-created_at"]`.
`created_at` carries `db_index=True` (covers the default reverse-chron list);
add a composite `(event_type, created_at)` for the type filter. `actor` is a
ForeignKey (implicitly indexed) so the actor filter is covered. Index name ≤ 30
chars (Postgres-safe; the lesson from #388's `projfcast_proj_recent_idx`):
`auditevent_type_created_idx`.

**`AuditEventType`** (`models.TextChoices`) — granular but bounded; the 5 issue
categories expand to the natural verbs:

```
MEMBER_ADDED            = "member_added"
MEMBER_REMOVED          = "member_removed"
MEMBER_ROLE_CHANGED     = "member_role_changed"
OWNERSHIP_TRANSFERRED   = "ownership_transferred"   # role-change sub-case worth its own verb
PROJECT_CREATED         = "project_created"
PROJECT_DELETED         = "project_deleted"
SETTINGS_CHANGED        = "workspace_settings_changed"
EXPORT_TRIGGERED        = "workspace_export_triggered"
```

The choice set is **additive-only** going forward (new verbs may be appended;
existing values never change) so enterprise receivers and stored rows stay valid.

### 2. The `audit_event_created` extension point (`workspace/signals.py`)

A new module defining one Django signal (mirrors `projects/signals.py`):

```python
# Fired AFTER an AuditEvent row is committed. Enterprise audit receivers connect
# here to layer immutable/signed/SOC-2 storage on top — OSS never imports
# trueppm_enterprise. Payload schema is STABLE (ADR-0157): do not change kwargs.
#
#   sender       = AuditEvent (the model class)
#   audit_event  = the committed AuditEvent instance
audit_event_created = django.dispatch.Signal()
```

- **Fire timing:** `transaction.on_commit(...)` so receivers only ever see a
  committed row (no phantom events on rollback). Inside the caller's transaction
  the `AuditEvent` row is written atomically with the action; if the action rolls
  back, the audit row rolls back too — the log never claims an action that did
  not happen.
- **`send_robust`, not `send`:** a raising enterprise receiver is swallowed (and
  logged) and can never break the OSS write path. Matches the `sprint_scope_changed`
  precedent.
- **Registration:** enterprise calls `audit_event_created.connect(receiver)` in
  its `AppConfig.ready()`. OSS connects **no** receiver. This is the whole
  extension point — a pure signal, no provider registry needed.

### 3. `record_audit_event()` service (`workspace/services.py`)

Single choke point — every emission site calls this, never `AuditEvent.objects.create`
directly:

```python
def record_audit_event(
    *, event_type, actor, target_type="", target_id=None,
    target_label="", metadata=None,
) -> AuditEvent:
    event = AuditEvent.objects.create(
        actor=actor,
        actor_label=_actor_label(actor),
        event_type=event_type,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        metadata=metadata or {},
    )
    transaction.on_commit(
        lambda: audit_event_created.send_robust(sender=AuditEvent, audit_event=event)
    )
    return event
```

Emission sites (verified file:line on `main`) — each wired with a local import to
avoid circular imports (the codebase idiom for cross-app service calls):

| Category | Site |
|----------|------|
| member added | `workspace/services.py::accept_invite` (on `created=True`) |
| member removed | `workspace/views.py::WorkspaceMemberDetailView.delete` |
| member role changed | `workspace/views.py::WorkspaceMemberDetailView.patch` (when `new_role != role`) |
| ownership transferred | `workspace/services.py::transfer_workspace_ownership` |
| project created | `projects/views.py::ProjectViewSet.perform_create` |
| project deleted | `projects/views.py::ProjectViewSet.perform_destroy` (soft + hard) |
| settings changed | `workspace/views.py::WorkspaceSettingsView.patch` |
| export triggered | `workspace/services.py::enqueue_workspace_export` |

Project create/delete live in the `projects` app and call into
`workspace.services.record_audit_event` (dependency direction projects → workspace,
which is the more-foundational app; via a function-level import — no module-load
cycle).

### 4. Read endpoint — `GET /api/v1/workspace/audit-events/`

- Explicit `path()` + `APIView` (workspace app convention; no DRF router).
- **RBAC:** Owner/Admin only — **including reads**. The existing `IsWorkspaceAdmin`
  passes *any* member on safe methods, which is too loose for an audit log, and
  `IsWorkspaceOwner` is too strict (owner-only). Add a small permission class
  `IsWorkspaceAuditViewer` requiring `role >= WorkspaceRole.ADMIN` on **all**
  methods.
- **Pagination:** `CursorPagination` ordered by `-created_at`. Unlike other
  workspace sub-resources (flat lists), the audit log grows unbounded, so it
  **must** paginate; cursor pagination is stable under concurrent appends and
  O(1) regardless of depth.
- **Filtering:** `?event_type=`, `?actor=` (user id), `?since=` / `?until=`
  (ISO-8601 on `created_at`). All optional, ANDed.
- **N+1 safety:** `select_related("actor")` on the queryset.
- Read-only serializer exposes: `id, event_type, actor (id + label), target
  (type/id/label), metadata, created_at`.

### 5. Retention

OSS = **none**. Rows accumulate. This is acceptable because workspace
*administration* events are intrinsically low-volume (member/role/project/settings/
export changes happen on the order of tens-to-hundreds per workspace, not per-task
or per-request). Automatic retention/purge is an Enterprise concern (ADR-0173
territory) and a guarantee OSS explicitly does **not** make (per #859). No cap in
this slice; if volume ever proves a problem an admin-triggered prune can be added
later without schema change.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Signal hook (chosen)** | Matches `sprint_scope_changed` precedent; enterprise consumes with zero OSS edits; payload schema is the only contract | Enterprise must wire a receiver; OSS write path does a tiny synchronous insert |
| Reuse `django-simple-history` (`HistoricalRecords`) | Already on `Workspace`/`Task`/etc. | Per-object field diffs, not an *operational* event stream; no actor-action semantics for "export triggered"/"member removed"; not Owner/Admin-scoped; wrong grain |
| Provider-registry seam (like `sharing_settings`) | Consistent with ADR-0029/0049 | Over-engineered — a registry is for *replacing* behavior; audit just needs a fan-out *notification*, which is exactly what a Signal is |
| Emit only the signal, no OSS row | No OSS storage to maintain | OSS would have **no** audit surface at all — fails the core requirement (Marcus hard-NO); the read endpoint needs rows to serve |
| `BigAutoField`/sequential PK | Cheap ordering | Violates the all-UUID-PK house rule; cursor pagination on `created_at` is fine |

## Consequences

- **Easier:** OSS gains a real audit surface (closes Marcus's hard-NO). Enterprise
  gets a stable, documented seam (`audit_event_created`, payload = `{audit_event}`)
  to layer signing/retention/SOC-2 export with zero OSS changes.
- **Harder:** Every future workspace-admin mutation should remember to call
  `record_audit_event`. Mitigated by the single-service choke point and tests that
  assert a row is written at each of the 8 sites.
- **Risks:**
  - *Coupling:* projects → workspace dependency for project create/delete events.
    Mitigated with function-level imports (existing idiom).
  - *Unbounded growth:* accepted given low admin-event volume; revisitable without
    a schema change.
  - *Renumber race:* highest committed ADR is **0155**; **0156** is claimed by the
    in-flight #967 branch (MR !715, not yet merged). This ADR takes **0157**. If a
    parallel branch also grabs 0157, the second-to-merge renumbers (the team's
    standard merge-time fixup). Grep `ADR-0157` before merge.

## Implementation Notes
- P3M layer: Operations / Programs-and-Projects administration (single-workspace).
- Affected packages: **api** (workspace + projects apps). No web in this slice
  (viewer deferred to a follow-up issue).
- Migration required: **yes** — one additive `CreateModel` in `workspace/migrations`
  (next number after the highest committed, **0013**; renumber if a parallel
  workspace migration lands first).
- API changes: **yes** — one new read endpoint `GET /api/v1/workspace/audit-events/`
  (additive; no existing endpoint changes shape). Sync `docs/api/openapi.json`.
- OSS or Enterprise: **OSS** (trueppm-suite). Enterprise registers a receiver in
  its own repo against `audit_event_created`.

### Durable Execution
1. **Broker-down behaviour:** N/A — the OSS audit *write* is a synchronous DB
   insert inside the caller's existing transaction; the `audit_event_created` fan-out
   is an in-process `transaction.on_commit` signal, not a Celery dispatch. No broker
   is touched. Enterprise receivers own the durability of *their* downstream work.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no outbox; the row is committed atomically with the
   triggering action and the signal fires post-commit.
4. **Service layer:** new `record_audit_event()` in `workspace/services.py` — the
   single write+emit choke point.
5. **API response on best-effort dispatch:** N/A — emission is a side effect of
   existing endpoints (they keep their current responses); the audit *read* endpoint
   is a plain synchronous paginated GET.
6. **Outbox cleanup:** N/A — no outbox.
7. **Idempotency:** Each event is an append-only row; "duplicates" only arise if a
   real mutation happens twice (two actions ⇒ two correct rows). Member-add emits
   only on `get_or_create(...)[created=True]`, so a re-accepted invite does not
   double-log. No idempotency key required.
8. **Dead-letter / failure handling:** `send_robust` swallows-and-logs a raising
   enterprise receiver so it can never break the OSS write path. No DLQ in OSS;
   enterprise owns its receiver's failure handling.
