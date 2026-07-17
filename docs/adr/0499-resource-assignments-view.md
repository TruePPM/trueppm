# ADR-0499: Resource assignments view — "what is this person working on?"

## Status
Accepted

## Context

The org Resources catalog detail panel
(`packages/web/src/features/resources/ResourceDetailPanel.tsx`) shows only
Name / Email / Job role / Capacity / Skills. A PM or resource manager opening a
person's card cannot answer the first question they actually have: *what is this
person working on, and are they overloaded?* (issue #2047).

There is no cross-project resource-assignments endpoint today:

- `ResourceViewSet` (`apps/resources/views.py`) has only a `restore` custom
  action. It is the org-level catalog: **read** is `IsAuthenticated` (any user —
  supports self-view and the roster picker, email stripped for non-admins per
  #892); **write** is `IsOrgAdmin` (ADMIN/Owner on any project) per ADR-0034.
- `TaskResourceViewSet` supports `GET /task-resources/?resource={id}`, but
  `TaskResourceSerializer` exposes only `["id","task","resource","resource_name",
  "units"]` — no task name, no project id/name — and its queryset is deliberately
  **scoped to the requesting user's member projects** as an IDOR guard, so it
  under-reports a cross-project picture by construction.
- `GET /me/work/` aggregates a user's tasks across projects, but is hardwired to
  `request.user` — a good reference for the *shape*, wrong for the *subject*.

We need a per-resource, cross-project, read-only assignments feed, and a decision
on who may see it — because task and project names are project-scoped confidential
data, not org-level catalog facts.

## Decision

### 1. API shape

Add a nested read-only action on the existing catalog viewset:

```
GET /api/v1/resources/{id}/assignments/
@action(detail=True, methods=["get"], url_path="assignments")
```

Nesting on `ResourceViewSet` (rather than extending `/task-resources/`) keeps the
subject explicit in the URL, inherits the catalog's throttle, and lets us apply a
distinct RBAC gate (below) without weakening the base `TaskResource` scope guard.

**Response: a flat list, grouped client-side.** Each row carries its own project
fields; the panel groups by `project_id` for the "tasks grouped by project" view.
Flat + client-grouped keeps the serializer trivial and the payload paginatable;
server-side grouping would fight DRF pagination for no gain at this scale.

New serializer `ResourceAssignmentSerializer` (read-only,
`serializers.ModelSerializer[TaskResource]`):

| Field | Source expression | Notes |
|-------|-------------------|-------|
| `id` | `TaskResource.id` | assignment (allocation) id — the link target |
| `task` | `task_id` | task id |
| `task_name` | `task.name` | |
| `project` | `task.project_id` | project id (client group key) |
| `project_name` | `task.project.name` | |
| `status` | `task.status` | `TaskStatus` value |
| `percent_complete` | `task.percent_complete` | cheap, directly answers "active vs done" |
| `units` | `TaskResource.units` | decimal fraction of capacity (0.5 = 50%) |

All fields `read_only`. `Meta.fields = ["id","task","task_name","project",
"project_name","status","percent_complete","units"]`. This is a projection of data
the row already joins — no writes, no new model, no migration.

**Queryset filtering:** exclude soft-deleted tasks (`task__is_deleted=False`).
Include **all** task statuses (COMPLETE included) so "what have they done / are
they winding down" is answerable; the client filters/sections by status. Order by
`task__project__name, task__name` so the flat list is already group-contiguous.

### 2. RBAC — gate on `IsOrgAdmin` (option a), returning the full cross-project view

**Decision: the action requires `IsOrgAdmin` and returns *all* of the resource's
assignments across every project — no member-scoping.**

Rationale:

- Task names and project names are **project-scoped confidential data**. The base
  catalog read is open to any authenticated user precisely because it exposes only
  *org-level* facts (name, job role, capacity, skills). An assignments feed
  crosses that boundary: it would tell any authenticated user which
  projects a colleague is on and what those tasks are called — an information
  disclosure the catalog does not currently permit, and exactly the leak
  `TaskResourceViewSet`'s member-scope guard exists to prevent. So the assignments
  action must **not** inherit the base read's `IsAuthenticated`.
- The persona that needs this — a resource manager asking "is this person
  overloaded?" — needs the *complete* picture, including projects they are not
  personally a member of. Option (b) (member-scoped) is safe but structurally
  under-reports and defeats the feature's purpose (a resource manager rarely sits
  on every project their people work across).
- `IsOrgAdmin` (ADMIN/Owner on at least one project) is already this codebase's
  proxy for the resource-manager capability: it is exactly the gate that guards
  **writing** the catalog (creating/editing/deactivating resources, ADR-0034). A
  user trusted to manage the workforce catalog is the right audience for "what is
  the workforce doing." Reusing it keeps the model consistent and avoids inventing
  a new capability.

Override `get_permissions` so the `assignments` action returns
`[IsAuthenticated(), IsOrgAdmin()]` even though it is a GET (the base class opens
GET to everyone). Non-admins receive 403; the web hides the Assignments tab unless
the caller is an org admin (reuse the existing `useIsOrgAdmin`/role signal that
already gates the catalog's write affordances).

Rejected — **(b) member-scoped for everyone**: under-reports, defeating the
purpose. Rejected — **(c) any authenticated user sees all**: leaks cross-project
task/project names org-wide, the exact IDOR the sibling viewset guards against.

Because the caller is an org admin, no ADR-0120-D5 "external task card" redaction
is needed — the elevated gate is what authorizes seeing every project's names in
full.

### 3. OSS vs Enterprise — this is OSS

Confirmed OSS. This is single-subject **resource management** — "what is this one
person working on" — not cross-program leveling or portfolio governance. It reads
existing assignment rows and renders them; it computes no utilization score,
proposes no reallocation, and spans no *program* boundary as a coordination
surface. It sits squarely in the "would a PM / resource manager need this to run
their work?" → OSS test, alongside the existing resource catalog and heatmap.

**The line not to cross (stays Enterprise):** do **not** add, on this endpoint or
panel, any of — a utilization/overload *score* or rating, cross-program leveling
or reallocation suggestions, a portfolio/cross-program rollup, or an
actor/"who viewed whom" audit dimension. Surfacing raw `units` and letting the
human read overload is OSS; *scoring* and *leveling* it is Enterprise (cross-
program resource leveling, per CLAUDE.md). Keep this a read-only projection.

### 4. Performance

Single-resource fan-out is naturally bounded (one person's assignments — tens, not
thousands), but the join is N+1-prone through `task` → `project`:

```python
queryset = (
    TaskResource.objects
    .filter(resource_id=<pk>, task__is_deleted=False)
    .select_related("task__project")          # task.name, task.project_id/name, task.status
    .order_by("task__project__name", "task__name")
)
```

`select_related("task__project")` is **required** and sufficient — every
serializer field resolves from `TaskResource`, its `task`, or `task.project`; no
`prefetch_related` is needed (no reverse/M2M traversal). Without it, `task_name`,
`status`, `percent_complete`, `project_name` each trigger a query per row.

**Pagination:** keep the default DRF page (do not set `pagination_class = None`).
The result is bounded per resource, but leaving pagination on is a cheap
worst-case guard for a heavily-assigned resource and matches the rest of the API.
`resource_id` is already indexed (`TaskResource.resource` has `db_index=True`), so
the filter is index-backed. perf-check should see zero N+1 with the
`select_related` above.

## 🔴 Blocking questions for the implementer

None blocking. Two decisions are made here to pre-empt them:

1. **Completed tasks** — included (client sections by status). If product wants
   "active only," add `?status=` filtering later; do not hardcode exclusion.
2. **Deactivated resources** — the action should still return assignments for a
   soft-deleted resource when an org admin opens its card from the deactivated
   pool (`?include_deleted=true` path); it reads assignments, which is orthogonal
   to the resource's `is_deleted` flag. Filter deleted *tasks*, not by resource
   state.

## Consequences

- **Positive:** a first-class, API-first, MCP-reachable server fact ("what is
  resource X assigned to") with no new model or migration; the panel gains an
  Assignments view; the cross-project leak stays gated behind the same capability
  that already guards catalog writes.
- **Negative / accepted:** non-admins cannot see the Assignments tab — acceptable,
  since the data is management-oriented and the base catalog card (role, capacity,
  skills) remains open to all. If a self-view use case ("show me *my own*
  assignments from the catalog") emerges, that is `/me/work/`'s job, not this
  endpoint's.
- **Tests:** pytest for the action (org-admin 200 full cross-project set;
  non-admin 403; soft-deleted task excluded; N+1 assertion), vitest for the
  `useResourceAssignments` hook + client grouping, Playwright for the panel's
  Assignments tab golden path + empty state.

## UX

Design spec for issue #2047 — the **Assignments** section added to
`ResourceDetailPanel` (view mode only). Implementation-ready; no component code
here. Visual template is the existing **Skills** section; row density follows
`schedule/sections/SubtasksSection.tsx`; status uses the shared **`StatusPill`**
from `features/grid/ui.tsx` (reused, not reinvented).

Note on "tab" vs "section": earlier prose in this ADR calls it the "Assignments
tab." It is a **section** inside the panel's existing scrollable body
(`<div className="flex-1 overflow-y-auto p-4 space-y-4">`), not a new tab — same
uppercase-tracked-widest heading pattern as Skills. Treat "tab"/"section" as
synonyms here.

### 1. Placement

- Rendered **last** in the scrollable body of `ViewPanel`, immediately after the
  Skills `<div>` (still inside the `space-y-4` stack). Order becomes: Name →
  Email → Job role → Capacity → Skills → **Assignments**.
- Rationale: identity/capacity/skills *describe the person* (static, synchronous);
  assignments *describe their current load* (async, management-oriented) — natural
  reading order, and putting the only async section last keeps the editable fields
  stable at the top.
- **View mode only** — it lives in `ViewPanel`, so `CreatePanel` never shows it.
- **Shown for deactivated resources too** — do NOT gate on `resource.isDeleted`
  (a soft-deleted person can still hold assignments; the endpoint returns them).

### 2. Grouping & row layout

Section header: `ASSIGNMENTS` in the standard
`text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2`.
A neutral **summary line** sits under it (see §5): e.g. *"3 tasks across 2
projects."*

Below, an **outer list of project groups**, each with:

- **Project group header** — project name (`text-xs font-semibold
  text-neutral-text-primary`, `flex-1 min-w-0 truncate`) as a **link** to that
  project's allocation view (see §3), with a right-aligned neutral count
  (`shrink-0 text-xs text-neutral-text-secondary`), e.g. *"2 tasks"* (per-project
  units subtotal optional — see §5).
- **Task rows** — a compact **two-line** row (narrow panel; keeps name off the
  same line as the metadata so a long name never collides with status/percent):
  - Line 1: task name **link** (`flex-1 min-w-0 truncate`, `title={taskName}`).
    Completed tasks: `line-through text-neutral-text-disabled` (SubtaskRow
    pattern) so done work de-emphasizes within the group.
  - Line 2 (meta, `flex items-center gap-2`): `<StatusPill status={status} />`
    (shared component, carries its own visible text label) · progress
    `{Math.round(percent_complete)}%` in `tppm-mono text-xs
    text-neutral-text-secondary` · allocation chip `{units}×` (multiplier glyph,
    `tppm-mono`, `title="{units} allocation units"`) — the `×` visually
    distinguishes allocation from the `%`-complete figure.
  - Row container: `py-1.5 px-1 rounded-card hover:bg-neutral-surface-raised`,
    min tap height ≥ 32px.

**Status = `StatusPill` (reused), not a bespoke badge.** Percent = plain mono
text (matches SubtaskRow); **no progress bar** — a bar per row is too heavy for a
narrow multi-row list.

### 3. Row link target

- **Task row → the task in its project schedule with the drawer open:**
  `/projects/{projectId}/schedule?task={taskId}`. This is the established
  deep-link pattern (My Work / notifications, #2031) — it lands on the exact task
  the person is assigned to, in context.
- **Project group header → per-project allocation view:**
  `/projects/{projectId}/resources/allocation`. Answers "how is this person
  allocated *on this project*."
- Two distinct, unambiguous targets: row = the task; group header = the
  allocation picture. (Context: the ⌘K People tier lands shallow on
  `/resources?q=<name>`; this section is the deeper drill from the catalog into
  project context — complementary, not redundant.)

### 4. States

The whole section is wrapped so a non-admin never sees it:

- **Non-admin (hidden):** render **`null`** — no heading, no placeholder. Client
  gate = `useCurrentUser().user?.can_access_admin_settings` used as the query
  `enabled` flag. Because that boolean is broader than server `IsOrgAdmin`, the
  hook must also **map a 403 → `forbidden` and render `null`** (defense in depth):
  a non-org-admin who slips past the client boolean sees nothing, never a broken
  error box. (If a tighter client signal is wanted, add `is_org_admin` to
  `/auth/me/`; otherwise the 403-swallow is the robust fallback — flagged to the
  API author.)
- **Loading:** heading renders immediately, then **2–3 skeleton rows**
  (`animate-pulse bg-neutral-surface-raised rounded` bars at row height),
  container `aria-busy="true"`.
- **Empty (200, zero rows):** heading + inline
  `<p className="text-xs text-neutral-text-disabled">No current assignments.</p>`
  — matches the Skills "No skills tagged." pattern. Do **not** use the full
  centered `EmptyState` component (too heavy inline).
- **Error (network/5xx):** heading + inline `role="alert"` line styled like the
  panel's `saveError` box (`border-semantic-critical/40 bg-semantic-critical-bg
  text-xs text-semantic-critical`) with a compact **"Retry"** text button
  (`refetch()`). Not the full-page `QueryErrorState`.

### 5. Overload signal WITHOUT scoring (OSS line)

This section is a **read-only projection** ("what"), never a verdict ("should").

- **Allowed (OSS):** neutral **count** facts — the summary line *"N tasks across
  M projects"*, per-project task counts in group headers, and each row's raw,
  as-stored `units`. These are plain projections of stored data.
- **Allowed, kept neutral:** a **per-project** units subtotal in a group header
  (e.g. *"2 tasks · 1.0×"*) — a sum *within one project*, not across the boundary
  the Enterprise feature owns.
- **NOT allowed (Enterprise leveling/scoring line):** a **cross-project** units
  total, any comparison of summed units against `maxUnits` capacity, any
  "overallocated / overloaded" flag, and any color/severity signal derived from
  units-vs-capacity. Summing units across projects is one subtraction away from a
  utilization verdict — that seam belongs to Enterprise cross-program leveling.
- **Ruling:** show the cross-project **count** ("across 2 projects"), never a
  cross-project **units total**.

### 6. Accessibility

- **Region + heading:** wrap in `<section aria-labelledby="assignments-heading">`
  and give the heading `<p>` `id="assignments-heading"` — SR announces the region
  by name without changing the existing visual `<p>` heading pattern.
- **Grouped-list semantics:** nested lists — outer `<ul>` of projects; each
  project `<li>` holds a `role="group"` (labelled by the project-name element via
  `aria-labelledby`) wrapping an inner `<ul>` of task `<li>`s. A SR hears
  "group, Project Atlas, list, 2 items."
- **Link accessible names (task name is ambiguous across projects):** the row
  link's accessible name **must include project, status, and progress** —
  `aria-label={`${taskName}, ${STATUS_LABEL[status]}, ${pct}% complete, in
  ${projectName}`}` (mirrors QueueLayout's aria-label composition). Visible text
  stays just the task name.
- **Avoid double announcement:** the standalone `{pct}%` and `{units}×` spans are
  `aria-hidden="true"` since they are already spoken via the row link's
  aria-label; `StatusPill`'s text is likewise covered by the aria-label.
- Summary count line is plain text inside the region — announced in context.

### 7. Responsive / narrow panel

- Panel is a fixed narrow side panel — **rows must never horizontal-scroll.**
- Task name and project name: `flex-1 min-w-0 truncate` with `title` for the full
  string; metadata chips (`StatusPill`, percent, units) are `shrink-0`.
- The **two-line** row is the key reflow guard: name owns line 1, all metadata
  owns line 2, so a long name can truncate without ever pushing status/percent off
  the edge.
- Group-header count/subtotal is `shrink-0` and right-aligned.
- Touch: row link ≥ 32px tall, `hover:bg-neutral-surface-raised` affordance.

### Component / state plan

- **`useResourceAssignments(resourceId, { enabled })`** — TanStack Query, key
  `['resource-assignments', resourceId]`, `GET /resources/{id}/assignments/`.
  `enabled = mode === 'view' && canSeeAssignments`. Maps HTTP 403 → `{ forbidden:
  true }`. Returns `{ data, isLoading, isError, forbidden, refetch }`. (vitest.)
- **`groupAssignmentsByProject(rows)`** — pure util → `[{ projectId, projectName,
  tasks[] }]`; stable sort by project name, tasks by status (active first,
  completed last). Unit-tested in isolation. (vitest.)
- **Presentational subcomponents** (new sibling file
  `ResourceAssignmentsSection.tsx`, imported into `ViewPanel`):
  `AssignmentsSection` (gate + states), `ProjectGroup`, `AssignmentRow`.
- **Admin gate:** `const { user } = useCurrentUser(); const canSeeAssignments =
  Boolean(user?.can_access_admin_settings);` — feeds `enabled`; 403-swallow in the
  hook is the authoritative backstop.
- **Reuse:** `StatusPill` + `STATUS_LABEL` from `@/features/grid/ui`;
  `useCurrentUser`; the panel's existing `saveError` box styling for the error
  line; `tppm-mono` for numerics.
- Tests (per ADR): pytest (endpoint), vitest (hook + grouping util), Playwright
  (panel Assignments section golden path + empty state), per repo three-layer rule.
