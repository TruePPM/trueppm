# ADR-0034: Org-Level Resource Management Page

## Status
Proposed

## Context

Issue #155: TruePPM has a `Resource` model and a fully-featured project roster
(#149) and skill catalog (#150), but no UI to **create** a Resource. Today,
`Resource` rows can only be created via Django admin or direct API call —
which means a fresh OSS install has zero resources, and the project roster
combobox returns an empty list. Sarah (PM) currently cannot self-serve onto
TruePPM without engineering help.

VoC panel average **4.6/10** — David (Resource Manager, 8/10) is the hero
user; Sarah (PM, 6/10) wants inline create from the roster combobox; Marcus
(PMO, 5/10) flags this as the LDAP upsell signal and is anxious about a
"shadow directory" forming in OSS that drifts from the corporate IdP; Priya
(Team Member, 3/10) needs a read-only self-view; Janet (COO, 1/10) sees this
as the wrong layer for her needs.

**P3M Layer**: Programs and Projects (supporting infrastructure). The
`Resource` table is org-level, but its consumers are project-scoped.
Cross-project resource heat maps and demand forecasting remain Enterprise
per ADR-0030 / ADR-0033.

### VoC top blockers driving design

🔴 Extension slot for "Managed by directory" badge **and** Create-button
suppression when the Enterprise LDAP/SCIM sync is active. Without this, an
OSS shadow directory will form alongside Active Directory and drift —
exactly what Marcus is worried about.

🔴 Soft-delete only. Hard delete from this page is forbidden. Resources
that have ever been assigned to a task must remain queryable forever for
historical capacity reports and audit trails. Use the existing
`VersionedModel.is_deleted` field.

🟡 Read-only self-view for non-admin authenticated users (Priya). Surface
the catalog via `GET /api/v1/resources/` for any authenticated user; gate
write operations behind a new permission.

🟡 Inline create from `AddToRosterCombobox` so Sarah does not leave the
project context. ("Maria Chen is not on this project" → "+ Create resource
'Maria Chen' and add to project").

🟡 Reserve toolbar slot for future CSV import (David's #2 ask, deferred).

### Existing foundation (do not duplicate)

- `Resource` model — name, email, job_role, max_units, optional Calendar FK,
  `VersionedModel` base providing `id` (UUID), `server_version`, `is_deleted`,
  `deleted_version`. Already has `?exclude_project=` filter and `?task=`
  skill-fit annotation from #149/#150.
- `ResourceViewSet` (resources/views.py:329) — currently
  `permission_classes = [IsAuthenticated, IsProjectMember]`. Not adequate for
  org-level write: anyone with Viewer role on any project can currently create
  resources, and no role gates DELETE specifically. We tighten this.
- `IsProjectMember`, `IsProjectScheduler`, `IsProjectAdmin`, `CanAssignResource`
  in apps/access/permissions.py — all **project-scoped** (require a
  `project_id` to resolve membership). None apply to an org-wide write.
- ADR-0029 — frontend slot registry + `useEditionFeatures()` is the established
  Enterprise injection mechanism. We declare new slots; we do not invent a new
  pattern.
- ADR-0033 — `ProjectResource` and `TaskResource` rely on `Resource` rows; their
  cascade behaviour (CASCADE on `Resource` delete) is **broken by design**
  for this feature. We never hard-delete a `Resource`; soft-delete preserves
  the FK targets and historical assignments.
- Sidebar — currently shows Portfolio / Projects sections (ADR-0030). A top-
  level "Resources" entry slots in below "Projects".

### Relevant prior ADRs

- ADR-0027 — schedule-affecting mutations call
  `scheduling/services.py::enqueue_recalculate(project_id, ...)`. Deactivating a
  resource with open assignments triggers recalc per project.
- ADR-0029 — slot registry; we declare three new slot IDs.
- ADR-0030 — OSS is single-project / Operations layer; cross-project resource
  rollups are Enterprise. This ADR holds that line — the resource page is a
  catalog, not an analytics view.
- ADR-0033 — established `Resource`-related conventions; this ADR builds on
  them and adds **the missing CRUD shell**.

## Decision

A single new top-level page `/resources/`, a tightened `ResourceViewSet`
permission gate, three new slot registrations, and a new
`useEditionFeatures().directorySync` flag. No new models. No new endpoints —
the existing `ResourceViewSet` handles everything.

### 1. RBAC: `IsOrgAdmin` permission

OSS has no first-class "org admin" concept (membership is project-scoped).
Rather than introduce a new entity, we derive org-admin from project
membership: **anyone with `Role.ADMIN` (Project Manager) or higher on at
least one project is an org admin** for resource catalog purposes.

```python
# apps/access/permissions.py

class IsOrgAdmin(BasePermission):
    """Org-level admin gate.

    OSS has no separate org-admin entity. We derive admin authority from
    project membership: a user with PM (ADMIN) or Owner role on at least
    one project may manage the global resource catalog.

    Enterprise installs override this via ProjectMembership-independent
    role grants (LDAP group mapping, SAML claims) — but the OSS check
    stays correct: Enterprise admins always also have project ADMIN.
    """
    message = (
        "You need Project Manager role on at least one project to manage "
        "the resource catalog."
    )

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        if request.user.is_superuser:
            return True
        return ProjectMembership.objects.filter(
            user=request.user,
            role__gte=Role.ADMIN,
        ).exists()
```

`ResourceViewSet` permission becomes:

| Method            | Permission                          |
|-------------------|-------------------------------------|
| GET (list/detail) | `IsAuthenticated`                   |
| POST              | `IsAuthenticated` + `IsOrgAdmin`    |
| PATCH/PUT         | `IsAuthenticated` + `IsOrgAdmin`    |
| DELETE            | `IsAuthenticated` + `IsOrgAdmin`    |

Read access remains open to all authenticated users (so the roster
combobox, self-view, and assignment picker continue to function for team
members). Write access narrows to PMs/Owners.

### 2. Soft-delete on DELETE

`ResourceViewSet.perform_destroy` is overridden to set `is_deleted=True`
and bump `server_version`, **never** running an actual SQL DELETE.
`ProjectResource` and `TaskResource` rows referencing the resource remain
intact and queryable for historical capacity reports.

```python
def perform_destroy(self, instance: Resource) -> None:
    instance.is_deleted = True
    instance.server_version = (instance.server_version or 0) + 1
    instance.deleted_version = instance.server_version
    instance.save(update_fields=["is_deleted", "server_version", "deleted_version"])
    # Recalc each project where this resource has open task assignments.
    affected_project_ids = (
        TaskResource.objects
        .filter(resource_id=instance.pk)
        .values_list("task__project_id", flat=True)
        .distinct()
    )
    for project_id in affected_project_ids:
        enqueue_recalculate(project_id, reason=f"resource_deactivated:{instance.pk}")
```

The default queryset filter (`is_deleted=False`) hides deactivated rows.
A new `?include_deleted=true` query param surfaces them for the admin
"Show deactivated" toggle. A `POST /api/v1/resources/{id}/restore/`
custom action flips `is_deleted` back to `False`.

### 3. Frontend page: `/resources/`

A two-pane layout consistent with the project roster page from #149:

- **Left pane** (list): table of resources with name, email, job role,
  capacity (max_units rendered as "% FTE" or "h/day" via `CapacityInput`
  read-only mode), skill count, calendar name. Toolbar: search,
  "Show deactivated" toggle, "+ Add resource" button.
- **Right pane** (detail): full resource detail. Editable form for
  fields; `SkillEditor` from #150 for managing skills; "Deactivate"
  button (or "Restore" if deactivated). Read-only when the viewer is not
  an org admin (Priya's self-view).

Sidebar entry: top-level "Resources" link below the Projects section.
Visibility gated by `useCurrentUserRole().hasOrgAdminAccess` —
non-admins still see the link **but** it lands them on a read-only
filtered view (just their own resource record if linked, plus the catalog
in read-only mode).

### 4. Enterprise extension slots (ADR-0029)

Three new `SlotId` values declared in
`packages/web/src/lib/widget-registry.ts`:

| Slot ID                              | Purpose                                                                                  |
|--------------------------------------|------------------------------------------------------------------------------------------|
| `resources_page.toolbar_end`         | Enterprise injects "Sync from LDAP" button + "Last synced 4 min ago" timestamp here.     |
| `resources_page.detail_managed_by`   | "Managed by Active Directory · DN: cn=maria,dc=acme" badge above the detail-pane name.   |
| `resources_page.create_form_extension` | Extra fields (employee ID, cost center) injected into the create form.                 |

A new edition feature flag `directorySync.enabled` (consumed via existing
`useEditionFeatures()` hook from ADR-0029) controls Create-button
suppression: when true, the "+ Add resource" button is replaced by an
Enterprise-supplied chip ("Resources are synced from Active Directory");
the rest of the page remains read-only for everyone, including org admins.
This prevents shadow-directory drift.

### 5. Inline create from roster combobox (#149 enhancement)

The `AddToRosterCombobox` (project Team page) already calls
`/resources/?search=&exclude_project=`. We extend the empty-state of the
combobox with a "+ Create '{query}' as a new resource" entry that opens a
mini create form (name + email only — full editing happens from
`/resources/`). On success, the new resource is auto-added to the
project roster.

This entry is suppressed when `directorySync.enabled=true`.

## Alternatives Considered

| Option                                                                                | Pros                                                                       | Cons                                                                                                                                                    |
|---------------------------------------------------------------------------------------|----------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| **A. Pure inline create from roster combobox; no dedicated page**                    | Lowest scope; preserves Sarah's flow                                       | David has no admin home; bulk view impossible; deactivation flow has nowhere to live; doesn't address the "shadow directory" concern (no admin surface) |
| **B. Embed resource management as a project Settings tab**                           | Reuses project tab pattern                                                 | Conceptually wrong — Resource is org-scoped, not project-scoped; appears N times if user has N projects                                                 |
| **C. Build full `/resources/` page (chosen)**                                         | Org-level home; clean Enterprise extension story; David's hero workflow    | More UI scope; needs RBAC clarification (resolved by `IsOrgAdmin` deriving from membership)                                                             |
| **D. Defer to Enterprise (LDAP-only)**                                                | Simpler OSS                                                                | Breaks self-serve; OSS becomes unusable without an Enterprise add-on; product positioning fail (open-core promise)                                      |
| **E. New `is_org_admin` boolean on User model**                                       | Explicit, simple                                                           | Requires migration on auth model; new bootstrap problem (who's the first admin?); violates "ProjectMembership is the source of role truth"              |

## Consequences

**What becomes easier:**
- Fresh OSS installs are usable end-to-end with no Django shell access.
- Sarah can stay in the project context and create a resource without leaving.
- David has a single page that lists everyone, supports deactivation, and
  shows skill counts at a glance.
- Enterprise has a clean, named injection surface (three slots + one flag)
  to wire LDAP/SCIM sync without forking the OSS shell.

**What becomes harder:**
- A new permission class to maintain (`IsOrgAdmin`).
- The "deactivate" semantic is subtle — UI must consistently use
  "Deactivate" / "Restore" wording, not "Delete".
- We must guarantee the Resource detail form remains read-only when
  `directorySync.enabled` — easy to regress.

**Risks:**
- Without strict E2E coverage of the soft-delete path, a future contributor
  could replace `perform_destroy` with the default DRF behaviour and silently
  introduce hard delete. Mitigation: pytest assertion that `Resource` count
  is unchanged after DELETE, plus explicit assertion on `is_deleted=True`.
- `IsOrgAdmin` derives from membership — if all projects are deleted, every
  user loses admin access. Mitigation: project soft-delete (existing) means
  membership rows persist; we test this explicitly.

## Implementation Notes

- **P3M layer**: Programs and Projects (org-level supporting catalog).
- **Affected packages**: api / web.
- **Migration required**: no — existing fields suffice.
- **API changes**:
  - Tighten `ResourceViewSet` permissions (breaking for any client that
    relies on Member-role write access — none in OSS).
  - Override `perform_destroy` to soft-delete.
  - Add `?include_deleted=true` query param on list.
  - Add `POST /api/v1/resources/{id}/restore/` custom action.
- **OSS or Enterprise**: OSS. Enterprise registers against the new slots
  and implements the `directorySync` flag.

### Durable Execution

1. **Broker-down behaviour**: Deactivating a `Resource` that has open
   `TaskResource` assignments triggers recalc per affected project via
   the existing `enqueue_recalculate()` outbox path (ADR-0027). No new
   outbox category. Create/Update on `Resource` are pure DB writes with no
   async dispatch — N/A.

2. **Drain task**: Reuses the existing schedule-recalculate outbox drain
   (Beat: every 30 s, `@idempotent_task(on_contention="skip")`). No new drain
   task; semantics match exactly (a recalc is a recalc).

3. **Orphan window**: 10 minutes (matches existing schedule-recalc orphan
   window). Resource deactivation is wrapped in `transaction.atomic()` and
   fans out to per-project recalc requests inside `transaction.on_commit`.

4. **Service layer**: `scheduling/services.py::enqueue_recalculate(project_id,
   reason=...)` — already exists, no new function. Called once per affected
   project inside the deactivation transaction.

5. **API response on best-effort dispatch**: `DELETE /resources/{id}/`
   returns `204 No Content` synchronously. The recalc fan-out is
   fire-and-forget via the outbox; clients do not wait. The Resource page
   surfaces a toast: "{Name} deactivated. Schedules will recalculate."

6. **Outbox cleanup**: Existing nightly purge (7-day retention). No change.

7. **Idempotency**: Deactivation is idempotent — running twice yields the
   same `is_deleted=True` state. The recalc outbox row uses
   `(project_id, reason)` for de-dup; multiple deactivations in the same
   minute coalesce to one recalc per project.

8. **Dead-letter / failure handling**: Recalc task DLQ already exists.
   On permanent recalc failure the project's last-recalc status surfaces
   the error via the existing schedule-status endpoint. Resource
   deactivation itself is a single DB write — failure modes are uniqueness
   collisions (handled by DRF) or DB unavailability (returns 503; client
   retries).
