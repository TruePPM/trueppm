# ADR-0161: Bulk-PATCH inherited settings across Program / Project rows

## Status
Accepted

## Context

Issue #1233 generalizes the old methodology-only "✦ matrix" into a select-rows →
pick-inherited-field → set-value matrix, mounted at two scopes: **Workspace → Programs**
and **Program → Projects** (one component, two mounts; decision confirmed with Kelly).
"Only checked rows change; the rest keep inheriting."

The matrix needs a backend foundation that does not exist today: only a per-entity
`PATCH /programs/{id}/` (and the `risk-policy` / `rollup-config` sub-resources) and a
task-level bulk endpoint (`projects/{id}/tasks/bulk/`) exist. There is no way to set an
inherited field on a *selection* of Program or Project rows in one call. This ADR designs
that **backend bulk-PATCH endpoint** (the matrix UI is a deferred frontend follow-up).

A codebase survey (2026-06-22) reshaped the field list the issue sketched
("calendar / notifications / risk / iteration"):

- `methodology` — on **both** Program and Project (non-null, `Methodology.choices`).
- `iteration_label` — on **both** (nullable; `null` = inherit per ADR-0116).
- `risk_slip_propagation` + `risk_escalation_days` — **Program only** (the cross-project
  dependency risk policy lives at the program boundary; Project has neither).
- `calendar` — **Project only**, and changing it must trigger a schedule recalculation —
  but **no calendar→recalc trigger exists today**, not even on the single-entity
  `ProjectViewSet.perform_update`. Wiring brand-new recalc semantics into a *bulk* path
  is out of scope here.
- **notification defaults** — **do not exist on Program or Project at all.** Notification
  preferences live in `ProjectNotificationPreference` (per-(project, user) JSON matrix,
  separate app), with no program-level row and no inheritance chain. #1137 (0.4) owns the
  notification-default model work.

**P3M layer**: Programs and Projects (a single PM's program). **OSS.** Bulk-editing a
program's own projects, or a workspace's own programs, is single-program/workspace
administration — not cross-program/portfolio governance (which stays Enterprise).

## Decision

Add two thin POST actions to `ProgramViewSet`, backed by a shared, scope-parameterized
apply routine in `apps/projects/bulk_settings.py`:

| Route | Scope | Permission | Fields (this slice) |
|-------|-------|------------|---------------------|
| `POST /api/v1/programs/bulk-fields/` | Workspace → Programs | `IsWorkspaceAdmin` | methodology, iteration_label, risk_slip_propagation, risk_escalation_days |
| `POST /api/v1/programs/{pk}/bulk-project-fields/` | Program → Projects | `IsProgramAdmin` (+ not closed) | methodology, iteration_label |

**Request envelope** (`BulkFieldsRequestSerializer`):
```json
{ "ids": ["<uuid>", ...], "fields": { "methodology": "AGILE", "iteration_label": "PI" } }
```
Only the entities in `ids` are touched, and only the keys in `fields` are set on them —
every other row and every other field keeps inheriting. `ids` is capped at
`MAX_BULK_TARGETS = 200`; `fields` must be non-empty.

**Validation** reuses the per-entity field validators via narrow per-scope
`ModelSerializer`s (`ProgramBulkFieldsSerializer`, `ProjectBulkFieldsSerializer`) that
whitelist exactly the bulk-editable fields and carry the same `validate_methodology`
(ADR-0107 workspace-lock backstop) and `validate_iteration_label` (ADR-0116 null=inherit)
logic. A key in `fields` that is not in the scope's whitelist → **400** (explicit, not
silently dropped). A bad value → 400. An `id` outside the allowed scope (a foreign
program/project) → 400 listing the offending ids (IDOR-safe: the program PK in the URL is
the boundary for the project scope; the workspace singleton + open/non-deleted filter
bounds the program scope).

**Why narrow serializers, not the full `ProjectSerializer`:** the full serializer's
`validate()` carries a *project-level* Admin-vs-Scheduler field gate. In the program-scope
bulk path the authority is `IsProgramAdmin` (program-level), so the project-level gate
would wrongly fight a program admin who is not a per-project scheduler. Authority is
enforced at the **view** layer; the serializers carry only field-shape validation.

**Field-authority safety:** the two fields exposed in the project scope (methodology,
iteration_label) are benign — methodology only changes tab visibility (ADR-0107: "CPM
always runs underneath regardless of methodology"; no recalc) and iteration_label is
cosmetic. Neither is schedule-affecting nor exposes data, so a program admin pushing them
to member projects carries no escalation risk. `calendar` is deliberately *not* in the
project scope precisely because it is schedule-affecting.

**Writes** go through per-row `save()` (never `bulk_update()`) so `VersionedModel`
bumps `server_version` for offline sync and `HistoricalRecords` audits the diff. The
whole batch runs in one `transaction.atomic()` with `select_for_update()` on the targets:
**all-or-nothing** (consistent with ADR-0082 batch atomicity and the task-bulk endpoint).
Response: `{ "updated": [{ "id", "server_version" }, ...], "fields": [...] }`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Two `@action`s on ProgramViewSet (chosen)** | Reuses the established `risk-policy`/`rollup-config` sub-resource shape + IdempotencyMixin; one apply routine for both scopes; Program is the anchor for both matrix mounts | Two routes instead of one |
| One generic `POST /bulk-settings/` with an `entity_type` discriminator | Single route | Conflates two RBAC scopes (workspace-admin vs program-admin) behind one permission check; harder to keep IDOR boundaries clean |
| `bulk_update()` for one UPDATE per scope | Fewer queries | Bypasses `VersionedModel.save()` → no `server_version` bump (breaks offline sync) and no history audit (ADR-0142) |
| Include calendar + notification fields now | Matches the issue's sketch verbatim | calendar needs a recalc trigger that does not exist (scope creep into a latent single-entity gap); notification defaults are not Program/Project fields (needs #1137's model) |

## Consequences
- **Easier**: the matrix UI (follow-up) has a stable two-route contract; the field
  whitelists are a single `Meta.fields` list per scope, so adding a field later (once its
  validation/recalc story is settled) is a one-line change.
- **Harder**: nothing structurally; the deferred fields each need their own groundwork
  (calendar → a bulk recalc trigger; notifications → #1137's model).
- **Risks**: low. No model change, no migration. The only authority decision (program
  admin may push methodology/iteration_label to member projects) is bounded to two benign,
  non-schedule fields.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (web matrix deferred to a follow-up issue)
- Migration required: **no** (all fields already exist; no `ScheduleRequestReason`
  addition because calendar is deferred)
- API changes: **yes** — two new POST actions (see table). OpenAPI regenerated.
- OSS or Enterprise: **OSS**

### Durable Execution
1. Broker-down behaviour: **N/A** — the fields in this slice (methodology, iteration_label,
   risk policy) trigger no async work. methodology changes never recalc (ADR-0107);
   iteration_label and risk policy are not CPM inputs. The schedule-affecting `calendar`
   field is deferred precisely so this endpoint dispatches nothing.
2. Drain task: **N/A** — no async work enqueued.
3. Orphan window: **N/A** — no outbox rows written.
4. Service layer: bulk apply lives in `apps/projects/bulk_settings.py::apply_bulk_fields`;
   no CPM enqueue (would route through `scheduling/services.py::enqueue_recalculate` if
   calendar lands later).
5. API response on best-effort dispatch: **N/A** — synchronous, all-or-nothing; returns
   200 with the per-row new `server_version`.
6. Outbox cleanup: **N/A**.
7. Idempotency: covered by the `IdempotencyMixin` on `ProgramViewSet` (honors an optional
   `Idempotency-Key`); the operation is also naturally idempotent in effect — re-applying
   the same field map yields the same field values (a duplicate without a key bumps
   `server_version` again, which is the correct "a write happened" signal).
8. Dead-letter / failure handling: **N/A** — any per-row validation failure raises inside
   the atomic block and rolls the whole batch back (400); nothing is partially applied.
