# ADR-0033: Resource Pool, Skills, and Project Roster Management

## Status
Proposed

## Context

Issues #149 (resource pool) and #150 (resource skills and roles): TruePPM has the
plumbing for resource assignment (`Resource`, `TaskResource`, allocation timeline,
over-allocation warnings) but no surface for managing **who is on a project** or
**what they are good at**. Today, a resource exists on a project only by
side-effect of being assigned to a specific task — there is no roster, no
project-specific capacity override, no notion of skills, and no skill-aware
assignment.

VoC panel average **5.2/10** — high enthusiasm from Sarah (PM, 8/10) and David
(Resource Mgr, 7/10), tolerated by Marcus (PMO, 4/10) as a foundation for the
Enterprise heat map (#88), correctly out-of-scope for Janet (COO).

**P3M Layer**: Programs and Projects — single-project roster and project-scoped
skill matching. OSS repo. Cross-project resource pooling and skill-gap analysis
remain Enterprise per ADR-0030.

### VoC top blockers driving design

🔴 Skills/proficiency must live on `Resource` (global), not project-scoped — so the
Enterprise cross-project heat map (#88) can aggregate without schema rework.
🔴 Skill coverage gaps surfaced inline at assignment time, not as a separate
dashboard nobody opens.
🟡 Mobile parity for roster add/remove (Sarah is on-site 3 days/week).
🟡 Self-service profile view for team members (Priya must see and dispute her own
skills).
🟡 Partial allocation must accept hours/day **or** %FTE in the UI; storage stays
decimal `max_units`.

### Existing foundation (do not duplicate)

- `Resource` (VersionedModel, soft-delete, `max_units` decimal, optional
  `Calendar` FK) — global, not project-scoped, no `User` link.
- `TaskResource` (no `server_version` per ADR-0028, `unique_together(task, resource)`,
  decimal `units`, `db_index` on `resource`).
- `Calendar` is the established pattern for global+shared entities.
- `ProjectMembership(user, project, role)` is **separate from** `Resource` — it
  governs *access*, not *staffing*. We do not conflate the two.
- `ResourceViewSet` is currently org-level (CRUD on the global `Resource` table)
  via `IsProjectMember` permission and unscoped queryset.
- `TaskResourceViewSet.perform_create` houses the summary-task guard (ADR-0024)
  and the over-allocation soft warning (ADR-0028) — both must continue to apply.
- Allocation timeline endpoint `GET /api/v1/projects/{id}/resource-allocation/`
  (ADR-0031) is the existing utilization surface; it is reused, not replaced.
- `CanAssignResource` permission (resources/permissions.py:236) gates
  `TaskResource` writes at SCHEDULER (role ≥ 2). Reused for the new endpoints.
- No `skill`, `proficiency`, `job_role`, or `pool` field exists anywhere — clean
  slate.

### Relevant prior ADRs

- ADR-0021 — MS Project import/export name-matches `Resource` and maps `MaxUnits`
  ↔ `max_units`. New resource fields must be importable/exportable.
- ADR-0024 — Summary task assignment guard in `TaskResourceViewSet.perform_create`.
  Skill-filtered assignment respects the same guard.
- ADR-0025 / ADR-0028 — Established `TaskResource` write contract; `units`
  decimal-in-storage, percent-in-UI; over-allocation soft warning. Unchanged.
- ADR-0027 — All schedule-affecting mutations call `enqueue_recalculate(project_id,
  changed_task_ids=...)` via `scheduling/services.py`. Cascade deletes from pool
  removal must use this path.
- ADR-0029 — Frontend slot registry is the Enterprise injection point. We declare
  empty slots so Enterprise can layer cross-project skill-gap UI without forking.
- ADR-0030 — OSS is single-project; cross-project resource leveling is Enterprise.
  This ADR holds that boundary.
- ADR-0031 — Resource allocation timeline endpoint and `max_units` display contract.
  The roster surface re-uses this endpoint; no new utilization endpoint.

## Decision

Five new Django models, three new endpoints, and three roster-aware UI surfaces.
All OSS, all single-project-scoped at the API boundary.

### 1. Data model

#### 1.1 `ProjectResource` — explicit project roster join

```python
class ProjectResource(VersionedModel):
    """A resource's membership in a single project's roster.

    Distinct from TaskResource: a resource can be on the project roster without
    yet being assigned to any task. Distinct from ProjectMembership: that gates
    *access* (a user's role on the project), this gates *staffing* (a resource's
    availability and project-specific overrides).
    """
    project = ForeignKey(Project, on_delete=CASCADE, related_name="resource_pool")
    resource = ForeignKey(Resource, on_delete=CASCADE, related_name="project_memberships")
    role_title = CharField(max_length=120, blank=True)        # project-specific override
    units_override = DecimalField(4, 2, null=True, blank=True)  # project-specific cap
    notes = CharField(max_length=500, blank=True)

    class Meta:
        db_table = "resources_project_resource"
        unique_together = [("project", "resource")]
        indexes = [Index(fields=["project", "is_deleted"])]
```

`role_title` and `units_override` are **per-project overrides**. The default
display falls back to `Resource.job_role` and `Resource.max_units` respectively.

`ProjectResource` inherits `VersionedModel` because it is a standalone roster row
that mobile must sync independently of any task. (Contrast with `TaskResource`,
which syncs as a side effect of its parent task per ADR-0028.)

#### 1.2 `Resource.job_role` — primary designation

Add one CharField to the existing `Resource` model:

```python
job_role = CharField(max_length=120, blank=True)
```

Free-text with frontend autocomplete from existing distinct values
(`SELECT DISTINCT job_role FROM resources_resource WHERE job_role != ''`). No
catalog table — VoC tolerance for that complexity is low for OSS, and Enterprise
can layer a controlled vocabulary later via the slot registry without breaking
the field shape.

#### 1.3 `Skill` and `ResourceSkill` — global skill catalog with proficiency

```python
class Proficiency(IntegerChoices):
    BEGINNER = 1, "Beginner"
    INTERMEDIATE = 2, "Intermediate"
    EXPERT = 3, "Expert"


class Skill(VersionedModel):
    """A capability tag — global catalog, shared across all resources."""
    name = CharField(max_length=120)
    normalized_name = CharField(max_length=120, unique=True)  # casefold + strip
    category = CharField(max_length=60, blank=True)            # e.g. "language", "trade"

    class Meta:
        db_table = "resources_skill"
        ordering = ["name"]


class ResourceSkill(VersionedModel):
    resource = ForeignKey(Resource, on_delete=CASCADE, related_name="skills")
    skill = ForeignKey(Skill, on_delete=PROTECT, related_name="resources")
    proficiency = IntegerField(choices=Proficiency.choices, default=Proficiency.INTERMEDIATE)

    class Meta:
        db_table = "resources_resource_skill"
        unique_together = [("resource", "skill")]
        indexes = [Index(fields=["skill", "proficiency"])]
```

Both inherit `VersionedModel` so mobile sync covers skill profile changes.

`Skill.normalized_name` is the de-dup key — "react", "React", "REACT" all collapse
to one row. The serializer normalizes on write. `Skill.category` is optional
metadata for grouping in pickers; no enum yet (free text).

#### 1.4 `TaskSkillRequirement` — what a task needs

```python
class TaskSkillRequirement(VersionedModel):
    task = ForeignKey(Task, on_delete=CASCADE, related_name="skill_requirements")
    skill = ForeignKey(Skill, on_delete=PROTECT, related_name="task_requirements")
    min_proficiency = IntegerField(choices=Proficiency.choices, default=Proficiency.BEGINNER)

    class Meta:
        db_table = "resources_task_skill_requirement"
        unique_together = [("task", "skill")]
```

Drives the skill-filtered assignment picker (#150) and the inline skill-fit
warning. Optional — a task with no requirements behaves identically to today.

### 2. API surface

#### 2.1 New endpoints

```
# Project roster (#149)
GET    /api/v1/projects/{id}/resource-pool/           list project's roster
POST   /api/v1/project-resources/                     add resource to project
PATCH  /api/v1/project-resources/{id}/                edit overrides / notes
DELETE /api/v1/project-resources/{id}/                remove from roster

# Skill catalog (#150) — org-level CRUD; SCHEDULER+ for writes
GET    /api/v1/skills/?search={q}                     autocomplete
POST   /api/v1/skills/                                create (de-dup by normalized)
PATCH  /api/v1/skills/{id}/                           rename / recategorize

# Resource skills (#150)
GET    /api/v1/resources/{id}/skills/                 list resource's skills
POST   /api/v1/resource-skills/                       tag resource w/ skill
PATCH  /api/v1/resource-skills/{id}/                  change proficiency
DELETE /api/v1/resource-skills/{id}/                  untag

# Task skill requirements (#150)
GET    /api/v1/tasks/{id}/skill-requirements/
POST   /api/v1/task-skill-requirements/
PATCH  /api/v1/task-skill-requirements/{id}/
DELETE /api/v1/task-skill-requirements/{id}/

# Skill-aware resource search (#150)
GET    /api/v1/resources/?required_skill={skill_id}&min_proficiency=2
                                                       filter assignment picker
```

The existing `GET /api/v1/projects/{id}/resource-allocation/` (ADR-0031) is
re-used unchanged for utilization. The roster page calls both endpoints in
parallel.

#### 2.2 Existing endpoints — additive changes only

`ResourceSerializer` gains read-only nested fields:

```python
job_role = serializers.CharField(allow_blank=True, required=False)
skills = ResourceSkillSerializer(many=True, read_only=True)
```

`TaskSerializer` gains a read-only nested field:

```python
skill_requirements = TaskSkillRequirementSerializer(many=True, read_only=True)
```

Writes go through the dedicated viewsets. This matches the `assignments`
read-only nested + dedicated `TaskResourceViewSet` write pattern from ADR-0028.

#### 2.3 Skill-fit response on assignment (inline gap surfacing — VoC blocker)

When `POST /api/v1/task-resources/` is called, the existing 201 response gains an
optional `warnings` entry with code `skill_mismatch`:

```json
{
  "warnings": [
    {
      "code": "skill_mismatch",
      "detail": "Task requires React (Intermediate). Alice is tagged with React (Beginner).",
      "missing_skills": [{"skill_id": "...", "skill_name": "React", "required": 2, "actual": 1}]
    }
  ]
}
```

The assignment is saved regardless — soft warning, identical UX to the
over-allocation warning (ADR-0028). This is **the** mechanism for surfacing
skill gaps. There is no separate "gap dashboard" endpoint in OSS.

A read-only `skill_fit` annotation is added to resources returned by the
skill-filtered search:

```json
{ "id": "...", "name": "Alice", "skill_fit": "exact" | "partial" | "missing" }
```

Driven by joining `ResourceSkill` against the requesting task's
`TaskSkillRequirement` set when `?task={uuid}` is also passed.

### 3. Permissions

Reuse existing classes — no new permission code:

| Endpoint | Read | Write |
|----------|------|-------|
| `/projects/{id}/resource-pool/` | `IsProjectMember` (VIEWER+) | n/a (read-only) |
| `/project-resources/` | `IsProjectMember` | `CanAssignResource` (SCHEDULER+) |
| `/skills/` | `IsAuthenticated` | `CanAssignResource` (SCHEDULER+, any project) |
| `/resource-skills/` | `IsAuthenticated` (own profile) or `CanAssignResource` | `CanAssignResource` |
| `/task-skill-requirements/` | `IsProjectMember` | `CanAssignResource` |

**Self-service profile read (Priya):** A user can `GET
/api/v1/resources/{id}/skills/` if `Resource.email == request.user.email` even
without project membership. Edits still require SCHEDULER+ on at least one
project they share with the resource.

**Why not a new `CanManageRoster` class?** SCHEDULER+ is the existing gate for
all resource writes (ADR-0028, ADR-0031). Adding a class just for roster ops
fragments the role matrix without justification.

### 4. UI

Three surfaces, all built on existing components:

#### 4.1 Roster page — `/projects/:projectId/resource-pool`

New top-level project tab next to "Allocation". Two-pane layout:

- **Left pane**: Roster list (`ProjectResource` rows) with: avatar, name,
  `job_role` (override or fallback), capacity (effective `units_override` or
  `max_units` shown as both `Xh/day` and `Y%`), calendar name, skill chips
  (top 3 + "+N more"), inline overallocation indicator.
- **Right pane**: Selected resource detail — full skills list with proficiency,
  utilization sparkline (re-uses `useResourceAllocation`), notes field, "Remove
  from project" action.
- **Toolbar**: search, filter (by role, skill, calendar), `+ Add to project`
  button opening a `ResourceSearchCombobox` (existing component) restricted to
  resources not already in the roster.

Slot registry IDs declared (for Enterprise injection per ADR-0029):
- `resource-pool-toolbar-end`
- `resource-pool-row-actions`
- `resource-detail-skills-extension`

#### 4.2 Capacity input — dual-mode

Single component used in both `ProjectResource` and `Resource` edit forms.
Toggle between **`%FTE`** and **`hours/day`** (persists in user preferences).
Both inputs write the same canonical decimal `max_units` (or `units_override`).
Conversion: `hours/day = max_units * resource.calendar.hours_per_day`. Falls
back to `8.0` if no calendar. Tooltip clarifies: `"50% FTE = 4h/day on this
calendar"`.

#### 4.3 Skill-aware assignment picker (extends existing `ResourceSearchCombobox`)

When opened from a task with `skill_requirements`, the picker:

1. Calls `GET /resources/?task={taskId}&required_skill={...}` — server returns
   resources sorted by `skill_fit` descending (`exact > partial > missing`).
2. Renders three groups: **"Best fit"**, **"Partial fit"**, **"No skill match"**.
3. Each row shows the skill chips with proficiency dots and a deficiency badge
   (e.g. `"Missing: AWS"`) where applicable.
4. Allows selecting a "no match" resource (PM judgment override) — but the 201
   response surfaces the `skill_mismatch` warning toast.

Slot registry: `task-skill-requirement-extension` (Enterprise can show
cross-project skill availability hints here).

### 5. Frontend types and hooks

```typescript
type ProjectResource = {
  id: string;
  projectId: string;
  resourceId: string;
  resource: Resource;            // expanded
  roleTitle: string | null;
  unitsOverride: number | null;
  notes: string;
  effectiveMaxUnits: number;     // computed: unitsOverride ?? resource.maxUnits
};

type Skill = { id: string; name: string; normalizedName: string; category: string };
type ResourceSkill = { id: string; resourceId: string; skillId: string;
                       skill: Skill; proficiency: 1 | 2 | 3 };
type TaskSkillRequirement = { id: string; taskId: string; skillId: string;
                              skill: Skill; minProficiency: 1 | 2 | 3 };
```

New hooks:
- `useProjectResourcePool(projectId)` — list
- `useAddProjectResource`, `useUpdateProjectResource`, `useRemoveProjectResource`
- `useResourceSkills(resourceId)`, `useAddSkill`, `useUpdateProficiency`, `useRemoveSkill`
- `useTaskSkillRequirements(taskId)` + matching mutations
- `useSkillCatalog(query)` — debounced search for autocomplete

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Roster: explicit `ProjectResource` join (chosen)** | Pre-assignment supported; per-project overrides; mobile-syncable; matches VoC UX | One new table |
| Roster: implicit via `TaskResource` distinct | No schema | Cannot pre-assign; UX mismatch with "add to project" verb; requires aggregation join on every roster fetch |
| Roster: extend `ProjectMembership` | Reuses table | Conflates access (User+role) with staffing (Resource+capacity); breaks the User-vs-Resource distinction |
| **Skills: catalog table + M2M with proficiency (chosen)** | Controlled vocab, de-dup, Enterprise-aggregatable | Two new tables |
| Skills: JSON array on Resource | No tables | No de-dup, no portfolio aggregation, breaks Marcus VoC blocker |
| Skills: tag-style polymorphic | Flexible | No tag infra exists; over-engineering for a finite domain |
| **Skill-fit: inline warning at assignment (chosen)** | VoC blocker resolved; reuses ADR-0028 warning channel; no new dashboard | Sarah/David won't see gaps until they try to assign |
| Skill-fit: dedicated gap dashboard | Visible without action | VoC: Sarah/David won't navigate to a "gaps" page; data rots |
| **Job role: free-text CharField (chosen)** | OSS simplicity; Enterprise can layer catalog | Inconsistent capitalization risk |
| Job role: FK to Role catalog | Controlled vocab | New table for low-VoC value; overkill for OSS |
| **Capacity input: dual-mode (chosen)** | Resolves David's blocker; one canonical storage | Conversion edge cases (calendar `hours_per_day` change) |
| Capacity input: %FTE only | Simpler | Construction PMs (Sarah's persona) think in hours/day |
| Capacity input: hours/day only | Simpler | Office PMs (Marcus's reports) think in %FTE |
| **Self-service: read-only via `email` match (chosen)** | No new identity link required | Email-based match is fragile if a user changes their email |
| Self-service: add `Resource.user` FK | Strong identity link | Breaking schema change; not all resources are users |

## Consequences

### What becomes easier

- A PM can build their project's roster up front, separate from task assignment
- Skills can be tracked, queried, and filtered without polluting `Resource`
  with array fields
- The Enterprise heat map (#88) can `JOIN ResourceSkill` across projects without
  any OSS schema change
- Mobile sync covers everything that should sync (`ProjectResource`, `Skill`,
  `ResourceSkill`, `TaskSkillRequirement` all `VersionedModel`)
- MS Project import gains an upgrade path: `Resource/MaxUnits` → `max_units` is
  unchanged; `Resource/Group` → `job_role` is a one-line addition; Skills are
  not in MS Project XML, so importer is unchanged
- The over-allocation warning (ADR-0028) is mirrored by a parallel
  skill-mismatch warning — one mental model for both

### What becomes harder

- Five new tables increase the migration surface; risk of partial deploy
  visibility (mitigated: all new endpoints are additive, OSS-only)
- The skill-aware assignment picker depends on `task` query param — must keep
  default behavior intact when the param is absent (covered by tests)
- Capacity dual-mode requires the user's calendar to be loaded for the conversion
  display (mitigated: `Calendar.hours_per_day` ships with `Resource.calendar` in
  the existing serializer)

### Risks

- **Skill catalog spam.** Free-text `Skill.name` with autocomplete will collect
  duplicates ("React.js" vs "React" vs "ReactJS"). `normalized_name` unique
  constraint handles exact-match dedup; near-match merge tooling is deferred
  (Enterprise feature candidate).
- **Self-service email matching is fragile.** If a user changes their email in
  Django auth but `Resource.email` is stale, they lose access to their own
  profile until the mismatch is resolved. Acceptable for OSS; Enterprise SCIM
  sync (out of scope) can solve this.
- **Cascade delete from pool removal.** Removing a `ProjectResource` row that
  has live `TaskResource`s on the same project must (a) prompt the user
  client-side, (b) not silently delete the `TaskResource` rows. Server-side:
  reject with 409 if any `TaskResource` exists for that resource on that
  project, with a `force=true` query param to cascade. The cascade path goes
  through `scheduling/services.py::enqueue_recalculate(project_id,
  changed_task_ids=[...])` per ADR-0027.
- **`TaskSkillRequirement` change does not invalidate existing assignments.**
  Adding a skill to a task does not unassign resources that no longer fit;
  it just makes the next assignment surface a warning. Documented as designed.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project roster, project-scoped
  skill matching). OSS.
- **Affected packages**: `api` (resources/models.py, serializers.py, views.py,
  urls.py, migrations; projects/views.py for nested roster endpoint), `web`
  (new feature dir `packages/web/src/features/roster/`, hook additions),
  `helm` (none), `mobile` (data model already syncs via `VersionedModel`; UI
  is a follow-up)
- **Migration required**: Yes — five new tables + one column on `Resource`. All
  additive, no destructive ops, no `NOT NULL` without default. Migration order:
  (1) add `Resource.job_role`, (2) `Skill`, (3) `ResourceSkill`,
  (4) `ProjectResource`, (5) `TaskSkillRequirement`
- **API changes**:
  - New endpoints listed in §2.1
  - `ResourceSerializer`: add `job_role`, nested `skills` (read-only)
  - `TaskSerializer`: add nested `skill_requirements` (read-only)
  - `TaskResourceViewSet.perform_create`: extend `warnings[]` with
    `skill_mismatch` when `task.skill_requirements` is non-empty
  - Existing `/projects/{id}/resource-allocation/` unchanged
- **OSS or Enterprise**: OSS (trueppm-suite). Enterprise injection via
  three new slot registry IDs.

### Durable Execution

1. **Broker-down behaviour**: Roster CRUD and skill CRUD do not dispatch tasks
   directly. Cascade delete of `ProjectResource` (with `force=true`) deletes
   live `TaskResource` rows in the same DB transaction and calls
   `transaction.on_commit(lambda: enqueue_recalculate(project_id,
   changed_task_ids=affected))` — the existing scheduling outbox covers durability.
2. **Drain task**: No new drain. Reuses `drain_schedule_queue` because the
   only async path is CPM recalculation triggered by cascade delete — identical
   semantics to ADR-0028's assignment-triggered recalculation.
3. **Orphan window**: Unchanged 10-minute filter on `drain_schedule_queue`.
4. **Service layer**: `scheduling/services.py::enqueue_recalculate(project_id,
   changed_task_ids=[...])`. Roster delete cascade is the only call site;
   skill writes never trigger CPM (skill changes don't shift dates).
5. **API response on best-effort dispatch**: All new CRUD is synchronous
   (200/201/204). No queued response shape; cascade delete returns the deleted
   `ProjectResource` and the count of cascaded `TaskResource` rows.
6. **Outbox cleanup**: N/A — reuses existing `purge_old_schedule_requests`.
7. **Idempotency**: DB-level via `unique_together` on every join
   (`(project, resource)`, `(resource, skill)`, `(task, skill)`). Duplicate
   POST returns 409 (matches ADR-0028 `Conflict` exception). Skill creation
   normalizes `name` and returns the existing row (200) on collision rather
   than a new row.
8. **Dead-letter / failure handling**: No new async paths beyond ADR-0027's
   `recalculate_schedule`. Existing retry / time-limit / DLQ policies apply.

### Implementation sequence

1. **api/migrations**: `Resource.job_role` (CharField, blank, no default needed)
2. **api/migrations**: `Skill`, `ResourceSkill`, `ProjectResource`, `TaskSkillRequirement` —
   one migration per model for reviewability
3. **api/serializers**: `SkillSerializer` (with normalize-on-save), `ResourceSkillSerializer`,
   `ProjectResourceSerializer`, `TaskSkillRequirementSerializer`; extend `ResourceSerializer`
   and `TaskSerializer` with read-only nested fields
4. **api/views**: `SkillViewSet`, `ResourceSkillViewSet`, `ProjectResourceViewSet`,
   `TaskSkillRequirementViewSet`; nested `resource-pool` action on `ProjectViewSet`
5. **api/views**: `TaskResourceViewSet.perform_create` — extend `warnings[]` with
   `skill_mismatch` derivation
6. **api/views**: `ResourceViewSet` — `?required_skill=` and `?min_proficiency=`
   query params + `?task=` for `skill_fit` annotation
7. **api/views**: `ProjectResourceViewSet.destroy` — `force=true` cascade with
   `enqueue_recalculate`
8. **api/permissions**: no new classes; reuse `IsProjectMember`, `CanAssignResource`,
   `IsAuthenticated`. Add `email`-match exception in `ResourceSkillViewSet.list`
9. **api/tests**: roster CRUD + RBAC, skill catalog + dedup, resource-skill CRUD,
   task-skill-requirement CRUD, skill-aware assignment picker (sort, fit annotation),
   skill-mismatch warning on `TaskResource` create, cascade delete with/without `force`,
   self-service profile read
10. **web/types**: `ProjectResource`, `Skill`, `ResourceSkill`, `TaskSkillRequirement`
    in `packages/web/src/types/index.ts`; regenerate OpenAPI types
11. **web/hooks**: as listed in §5
12. **web/features/roster**: `RosterPage`, `RosterList`, `RosterDetailPanel`,
    `CapacityInput` (dual-mode), `SkillChipList`, `SkillEditor`
13. **web/features/gantt**: `ResourceSearchCombobox` — accept optional `taskId`,
    render group headers ("Best fit" / "Partial fit" / "No skill match")
14. **web/router**: mount roster page at `/projects/:projectId/resource-pool`,
    add tab to project shell
15. **web/tests** (vitest): `CapacityInput` conversion both ways, `RosterList` filter
    by role/skill/calendar, `SkillChipList` rendering, `useProjectResourcePool` cache
16. **web/e2e** (Playwright): roster add/remove flow; skill tag/proficiency edit flow;
    skill-filtered assignment picker; cascade-delete confirmation
17. **docs**: `docs/features/resource-pool.md`, `docs/features/skills.md`;
    `docs/api/openapi.json` regenerated after merge with main
18. **slot registry**: declare three new slot IDs in `frontend/src/slots/registry.ts`
19. **MS Project**: extend importer to map `Resource/Group` → `job_role` (additive)

### Open questions

🟢 **Resolved**: Skill catalog is global (org-level), not project-scoped.
🟢 **Resolved**: Job role is free-text, not catalog.
🟢 **Resolved**: Self-service via email match, not via `Resource.user` FK.
🟡 **Deferred to follow-up**: Mobile UI for roster management (data model is
mobile-ready; UI is a Phase 2 issue under the mobile epic).
🟡 **Deferred to Enterprise**: Cross-project skill-gap rollup (#88-adjacent).
🟡 **Deferred**: Skill near-match merge tooling — manual cleanup acceptable for
OSS volumes.

### Related ADRs

- ADR-0024 — Summary-task assignment guard (unchanged; new endpoints respect it)
- ADR-0025 — Read-only nested `assignments` on `TaskSerializer` (pattern reused)
- ADR-0027 — `enqueue_recalculate(changed_task_ids=)` (used by cascade delete)
- ADR-0028 — Resource assignment write flow + warning channel (extended with
  `skill_mismatch` code)
- ADR-0029 — Slot registry (three new slot IDs declared)
- ADR-0030 — OSS single-project boundary (held; Enterprise heat map remains separate)
- ADR-0031 — Resource allocation timeline (re-used unchanged for utilization)
