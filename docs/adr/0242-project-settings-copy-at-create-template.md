# ADR-0242: Project settings copy-at-create ("settings template")

## Status
Accepted

## Context

Issue #157 (OSS, milestone 0.4) — "Program & Project Settings templates with
inheritance" — wants a new project to be able to start from another project's
settings instead of the hardcoded defaults. The **governance overlay** (policy
locks, live re-binding to the source, audit trail, approval routing) is Enterprise
#47 and must not ship here. The slice we land now is the *basic data model only*:

- Project create accepts an optional `copy_settings_from` argument.
- At create time, the new project **copies the source's settings values and stores
  them as its own** — copy-at-create, no live binding back to the source.
- After creation, admins/managers override any setting freely — no locks, no
  warnings, no audit.

**P3M layer:** Programs and Projects (single project configuration). **OSS.** This
is exactly what one PM needs to stand up a new project quickly from a known-good
one; it is not cross-program governance.

### The force that reshapes this design: an inheritance chain already exists

The Project model does **not** store all settings as flat own-values. Two distinct
classes of settings field already exist (confirmed in
`packages/api/src/trueppm_api/apps/projects/models.py` and `serializers.py`):

1. **Plain stored settings** — non-null, the project owns its value outright:
   `visibility`, `timezone`, `default_view`, `estimation_mode`, `agile_features`,
   `board_cadence`, `stale_task_threshold_days`, `prioritization_model`, `calendar`.

2. **Live-inherited settings** — nullable, where **`NULL` means "inherit"**. Their
   effective value is computed *on read* down the chain
   **Project → Program → Workspace → hardcoded default** (ADR-0107 methodology
   preset, ADR-0116 iteration label, ADR-0135 sharing, ADR-0144 MC history). The
   serializer already exposes `effective_*` and `inherited_*` computed fields for
   each.

`Program` carries exactly the inheritable set (methodology + the nullable overrides)
and nothing else — it has no `timezone`, `default_view`, `estimation_mode`,
`board_cadence`, etc.

This has two sharp consequences the implementer must not miss:

- **Copying an inheritable field can silently *pin* it.** If we copy the source's
  *effective* (resolved) value into the new project's override column, we destroy
  the inherit semantics — the workspace/program admin can no longer change a default
  and have it flow down. We copy the **stored** value (which may be `NULL`), not the
  effective value.
- **"Use program defaults" is already delivered by live inheritance.** For every
  field a Program carries, a new project that (a) sets its `program` FK and (b)
  leaves those columns `NULL` *already* inherits the program's defaults, live.

## Decision

### 1. Copy-allowlist vs exclude-list (definitive)

`copy_settings_from` copies **only** the settings payload below. Everything else is
excluded because it is identity, lifecycle, sync bookkeeping, per-project counters,
or a relationship the caller supplies directly.

**COPY (the template payload):**

| Class | Fields |
|-------|--------|
| Plain stored settings | `visibility`, `timezone`, `default_view`, `estimation_mode`, `agile_features`, `board_cadence`, `stale_task_threshold_days`, `prioritization_model` |
| Calendar | `calendar` — copy the **FK reference** (same row); see §2 |
| Inheritable (copy **stored** value incl. `NULL`) | `methodology`, `iteration_label`, `public_sharing`, `allow_guests`, `mc_history_enabled`, `mc_history_retention_cap`, `mc_history_attribution_audience`, `task_duration_change_percent_policy`, `attachments_enabled`, `allowed_attachment_types`, `show_reporting`, `show_time_tracking`, `show_baselines`, `show_monte_carlo` |

**EXCLUDE (never copied):** `name`, `description`, `start_date`, `status_date`,
`code`, `health`, `lead`, `object_sequence`, `risk_sequence`, `program`,
`is_archived`, `archived_at`, `archived_by`, `is_sample`, `server_version`,
`is_deleted`, `deleted_version`, `deleted_at`, `deleted_by`, `recalculated_at`,
`last_sync_version`, `id`.

The single copy-allowlist lives in `services.py` (`SETTINGS_TEMPLATE_FIELDS`) as the
one source of truth — the serializer imports it, and the "no field slips the net"
test asserts it against the live model's field set.

> **`visibility` note:** it is a genuine setting and is copied, but copying a source
> that is `PRIVATE` will make the new project private. Acceptable (it is the source's
> chosen posture), and the caller can override it explicitly (§3).

### 2. `calendar` — share the reference, do not clone

Point the new project at the **same `Calendar` row** (copy the FK). `Calendar` is a
standalone shared resource (`db_table = "projects_calendar"`, no owning-project FK;
projects reference it, `on_delete=PROTECT`), so sharing the reference is safe and
matches the existing shared-calendar model. Cloning would spawn a duplicate calendar
per project and would have to copy `CalendarException` rows — a separate "duplicate
calendar" feature, out of scope. If the source's `calendar` is `NULL`, the new
project gets `NULL` → normal default-calendar fallback.

### 3. Where the copy lives + precedence

- **Location:** the copy runs in the write serializer's **`create()`**, delegating to
  a pure, unit-testable **service function** —
  `projects/services.py::apply_settings_template(validated_data, source)` — that fills
  the allowlisted keys the caller did **not** provide. `validate()` is **not** used to
  mutate; the `copy_settings_from` reference is validated by the field's scoped
  queryset (§5).
- **Precedence (definitive): explicit request value > copied value > model default.**
  The copy fills only the allowlisted fields absent from `validated_data`. Verified:
  the allowlisted fields are plain model fields, so DRF `ModelSerializer` maps them to
  `required=False` with **no serializer `default=`** (a model default is applied by
  the model, not injected into `validated_data`), so an omitted field is genuinely
  *absent* and the copy can fill it.

Copy semantics for inheritable fields: **copy the raw stored column value, including
`NULL`** — never the `effective_*` computed value. Where the source inherits, the new
project inherits too (from its *own* program/workspace, which may differ).

### 4. Program-defaults source — API shape (resolved: peer-project only)

**Ship `copy_settings_from` for peer PROJECT sources only.** "Use program defaults" is
satisfied by the mechanism that already exists — set the `program` FK and leave the
inheritable columns `NULL` so they inherit live. We do **not** add a second copy
source that materialises (pins) program defaults into the new project's columns,
because that contradicts the live-inheritance architecture and edges toward the
governance/locking concern that is Enterprise #47. An explicit "materialise program
defaults now" affordance is filed as a follow-up product question, not built here.

API surface:

```
POST /api/v1/projects/
{
  "name": "...",
  "start_date": "...",
  "copy_settings_from": "<source_project_uuid>",   // optional, write-only
  ...explicit overrides...
}
```

`copy_settings_from` is a **write-only, optional `PrimaryKeyRelatedField`** naming a
**Project** (see §5 for its queryset). It is not persisted and is popped in
`create()`. A **Program** id passed here is rejected (does not resolve in the
project-scoped queryset → 400).

### 5. Permission / IDOR

- **Gate:** the source project must be in the caller's **readable** set — an active
  (`is_deleted=False`) `ProjectMembership`. **Any role (Viewer and up) suffices**,
  because reading settings is a read operation.
- **Reuse existing scoping.** The field's `queryset` is set per-request to the same
  membership-scoped filter `ProjectScopedViewSet` uses for `Project`:
  `Project.objects.filter(pk__in=<caller's active membership project ids>,
  is_deleted=False)` — archived NOT filtered (allowed), trashed filtered.
- **Error:** when the source is not in that queryset — nonexistent, trashed, or the
  caller is not a member — DRF raises the field's `does_not_exist` error → **HTTP
  400**, with an **identical** message in all three cases, so it leaks no existence
  information (IDOR/enumeration hygiene). 400 (not 404/403) is correct because the
  source is a *reference inside the create body*.

### 6. Source-state validation

| Source state | Behaviour |
|--------------|-----------|
| Nonexistent id | 400 `does_not_exist` |
| Caller not a member | 400 — **same message**, no leak |
| Trashed (`is_deleted=True`) | 400 — excluded from queryset |
| Archived (`is_archived=True`) | **Allowed** — archive is read-only, not hidden; "archive a template project, keep spawning from it" is legitimate |
| Different program than target | **Allowed** — copying settings values does not move membership or cross a governance boundary (not the ADR-0070 project-move check) |

### 7. WebSocket broadcast / migration

- **Migration: NONE.** `copy_settings_from` is a write-only serializer field, not a
  model field; every target field already exists on `Project`. `migration-check` N/A.
- **Broadcast: no new point.** The copied values are part of the created project's
  *initial state* and ride the existing project-create broadcast/response. No
  post-create settings mutation → no new `broadcast_board_event()`.

### 8. Test surface (pytest — same MR)

Happy path; precedence (explicit wins); **stored-not-effective** (NULL stays NULL);
IDOR/not-a-member (byte-identical message); nonexistent id; archived-source-allowed;
trashed-source-excluded; cross-program-allowed; calendar-reference-shared (+ NULL
passthrough); no-`copy_settings_from` regression; Viewer-role source suffices;
Program-id rejected; allowlist-vs-model-field-set guard (no settings field silently
un-copied when the model gains one).

## Alternatives Considered

| Option | Verdict |
|--------|---------|
| **A. Copy STORED values; peer-project source only; program defaults via live inheritance (chosen)** | Respects the shipped inheritance design; no migration; no boundary risk |
| B. Copy EFFECTIVE (resolved) values | Rejected — silently pins every inherited setting, regressing ADR-0107/0116/0135/0144 |
| C. Explicit "materialise program defaults now" copy source | Deferred — pins inheritance (same as B); edges into Enterprise #47; redundant with live inheritance |
| D. Store a `settings_template_source` FK for live re-binding | Rejected — this is the Enterprise #47 governance overlay, wrong repo |

## Consequences

- **Easier:** standing up a new project from a known-good one in a single create call;
  fully API-first; zero schema change; no async, no new broadcast surface.
- **Harder:** the implementer must respect the stored-vs-effective distinction and the
  "no serializer default" constraint — both covered by tests.
- **Follow-up:** an explicit "pin the program's current defaults" affordance (🔴 #1
  from the review) is out of this slice; a follow-up issue captures the product
  question. A web create-dialog "copy settings from" picker is a separate frontend
  slice.

## Implementation Notes

- **Affected packages:** `api` only (`projects/serializers.py`, new
  `projects/services.py::apply_settings_template` + `SETTINGS_TEMPLATE_FIELDS`, viewset
  serializer-context already carries `request`).
- **Migration required:** no. **API changes:** one optional write-only field
  `copy_settings_from`; OpenAPI schema regenerates. **OSS.**
