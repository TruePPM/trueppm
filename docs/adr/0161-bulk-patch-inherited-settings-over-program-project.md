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

## Amendment (2026-10-06, #4310): program authority does not reach member-project content

**Decision: NARROW.** A Program Admin (program `ADMIN` or above, ADR-0161's program-side
grant) does not acquire read access to the *content* of a member project on which the
caller holds no live `ProjectMembership`. Program membership grants authority over the
program's own surfaces (roster, program backlog, ceremonies, program settings, program
webhooks as registrant). It does not grant the tasks, attachments, time entries, change
history or MS Project XML of a member project.

**Why.** `ProjectMembership` is the sole project-read boundary: `_membership_role` in
`apps/access/permissions.py` is what `IsProjectMember` and every project object check
consult, and project read has no superuser or workspace-admin bypass. A program-side
grant that reached project content through the program's bulk exports or its webhook
fan-out would be a second, weaker project-read path that the project endpoints do not
honor. The program export bundle and program-scoped webhooks are the two places this
already happened (#4310); both now intersect with the caller's live membership.

**How it is enforced.**

- `export_program` (sync seed, `GET /programs/{id}/export/`) includes only member
  projects the `requesting_user` holds live membership on. The management command
  (`manage.py export_program`) passes no requester and remains the trusted operator path,
  as it already is for email redaction. A `None` requester (deleted account) and a
  deactivated requester fail closed.
- `build_and_store_program_archive` (async bundle) captures the requester at enqueue time
  (`ProgramExportJob.requested_by`) but evaluates membership when the bundle is built, so
  a membership revoked while the job waited is not used.
- The async bundle's download and its in-flight de-dupe are per requester: only the admin
  who requested a bundle can download it, and another admin's request never returns it.
  Job metadata stays program-scoped.
- Editing a program webhook is refused (403) unless the requester is its registrant
  (`created_by`) and still holds live membership on every project the program covers.
  The check runs before validation, so a no-op PATCH is refused too. If the creator lacks membership on any project in the program, including one added later, nobody can edit or disable the webhook; any Program Admin can delete it and re-create it under a member account. Its
  delivery log is readable only by the registrant, because it replays past payloads from
  every member project.
- Program-scoped webhook dispatch keeps a program webhook for an event on project P only
  when its registrant (`Webhook.created_by`) holds live membership on P, checked at
  dispatch time. A NULL or deactivated registrant fails closed. (See the #4325 amendment
  below: the "project-scoped webhooks are unchanged" reasoning originally written here
  did not hold for a project-scoped webhook's *own* registrant losing membership on that
  same project — only for the cross-project program grant this amendment is about.)
- `GET /programs/{id}/resource-contention/` (round 2, #4310): the contention scope was
  every visible member project with no membership intersection, so a Program Scheduler or
  Admin with no `ProjectMembership` on a member project read that project's task ids,
  names, statuses and dates. It now intersects the scope with the caller's live
  membership, the same predicate `task_search` already applied.

**Alternatives considered.**

- *Broaden:* Program Admin reads every member project's content. Rejected: it makes
  "Program Admin" a read grant over projects the admin was never added to, and it is the
  reverse of the boundary #3439 drew for the program `projects` action.
- *Narrow the export only:* leave webhooks broad. Rejected: a removed member would keep
  receiving live events from a project they can no longer read, and the webhook is the
  same leak on a different channel.

**Consequences.**

- A Program Admin who is not a member of a project gets a program export without that
  project. Operators who relied on the broader export must add the admin to the project
  or export the project itself.
- Program webhooks whose registrant has no membership on a member project stop receiving
  that project's events. Their deliveries are dropped at dispatch, not queued.
- #2066 (PRIVATE project visibility) builds on this: a PRIVATE project's content is
  readable only through `ProjectMembership`, which this amendment makes the single rule
  for the program-side surfaces too.

## Amendment (2026-10-07, #4325): the live-membership dispatch check also covers project-scoped webhooks

**Decision: EXTEND.** The #4310 amendment above narrowed program-scoped webhook dispatch
to a registrant with live `ProjectMembership` on the firing project, and left the
project-scoped branch of `dispatch_webhooks` untouched on the stated reasoning that a
project-scoped webhook "is scoped to the very project whose event fires, so there is no
cross-project grant to re-check." That reasoning is correct about the *program* grant —
a project-scoped webhook never had one — but it did not address the registrant's own
membership on that same project being revoked after the webhook was created. A project
webhook kept delivering indefinitely to a creator who had since lost access to the
project the webhook was scoped to.

**How it is enforced.** `dispatch_webhooks` applies the identical live-membership
predicate to both branches now (`_drop_webhooks_without_live_member_owner` in
`apps/webhooks/dispatch.py`, generalized from the #4310 program-only helper): a webhook's
registrant must hold live `ProjectMembership` on the project the event fires on,
regardless of whether the webhook is itself project- or program-scoped. For a
project-scoped webhook that project is always the one it is scoped to, so no separate
query shape was needed — the fix widened the existing owner set rather than adding a
second check. A NULL or deactivated registrant fails closed, matching #4310.

**Why edit/delete/delivery-log access needed no equivalent fix.** Unlike dispatch
(an async path with no per-request caller to check), a project webhook's `update`,
`destroy`, and `deliveries` actions already run `IsProjectAdmin`, which re-reads the
*requesting caller's* live membership on every request (`_membership_role` only honours
non-soft-deleted rows). A creator who loses project membership already lost those
abilities before this amendment; only the async dispatch path was reading a stale
assumption. This is also why project-scoped webhooks never needed the program-scoped
rule's registrant-only restriction on the delivery log: any current project Admin, not
only the creator, can already read it, which carries no cross-project disclosure risk
because the log never contains another project's data.

**Consequences.**

- A project webhook whose creator has lost membership on its project stops receiving
  events at the next dispatch, the same as a program webhook today.
- No new query shape: the single per-event membership query already described above
  now also covers project-scoped candidates, at no added query count.

## Amendment (2026-10-08, #4330): a role floor, on both membership axes, matching the Admin-only delivery-log read gates

**Decision: EXTEND.** The #4310/#4325 amendments above gate dispatch on live
`ProjectMembership` — any role. But `ProjectWebhookViewSet.get_permissions` (project
scope) and `ProgramWebhookViewSet.get_permissions` / `_check_delivery_log_access`
(program scope) have always been Admin-only for reading a webhook's delivery log,
because the payload is documented information disclosure beyond plain membership
(#903). A registrant demoted — not removed — below that floor kept receiving the exact
payloads via dispatch that the matching read gate would already refuse them: below
Project Manager on the firing project for a project-scoped webhook, or below Project
Manager on the firing project **or** below Program Manager on the program for a
program-scoped one (the read gate for program-scoped webhooks is keyed on the
registrant's *program* role, not their project role).

**How it is enforced.** `_drop_webhooks_without_live_member_owner` adds
`role >= Role.ADMIN` to its existing `ProjectMembership.live()` query, for both scopes.
A new, program-scoped-only helper, `_drop_program_webhooks_without_live_program_admin_owner`,
adds a second, independent check: a live `ProgramMembership.live()` row at
`role >= Role.ADMIN` on the program itself. A program-scoped webhook's dispatch
eligibility is the AND of both checks — the project-role check from #4310/#4325 is still
required (a program grant has never been a project-read grant), and the program-role
check is now required too. Each is one membership query per event; the program-role
query runs, and costs anything, only when at least one program-scoped webhook survives
the project-role filter first.

**Why edit access needed no equivalent fix, and still does not.** Editing a
project-scoped webhook already requires `IsProjectAdmin`, which re-checks the *caller's*
live role on every request — unaffected by, and already consistent with, this
amendment. Editing a program-scoped webhook, however, continues to require only live
membership **at any role** on every project the program covers (`_can_edit`), not Admin
on either axis — that gate was deliberately left alone, since #4330 scoped its fix to
dispatch only. The asymmetry this leaves: a program webhook's creator can still disable
or re-point it themselves after a demotion that has already silenced its deliveries,
exactly as they could before this amendment.

**Consequences.**

- A project-scoped webhook's registrant must hold Project Manager or above on the
  project, not merely be a live member, to keep receiving events — matching
  `IsProjectAdmin` exactly.
- A program-scoped webhook's registrant must hold Project Manager or above on the
  firing project AND Program Manager or above on the program — the second requirement is
  new, and matches the program-scoped delivery-log read gate exactly; the first
  continues to have no equivalent in that read gate, because reading the log never
  depended on the registrant's project-level role.
- No change to query count in the common case: the new program-role query is skipped
  entirely (zero extra queries) when no program-scoped webhook survives the existing
  project-role filter.
