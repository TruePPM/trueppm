# ADR-0758: Sprint Story Picker — In-Place Multi-Select and the "Ready Only" Default

## Status

Accepted — implemented in #2670.

## Context

**P3M layer:** Programs and Projects (single-project sprint planning). **OSS** — core
agile workflow; no cross-program coordination.

Committing existing backlog stories to a sprint was not a flow, it was a detour.
`SprintBacklogTable` offered a single `<Link to="/projects/:id/product-backlog">`
labeled "Pull from backlog →" (added for #1347). Clicking it navigated the user off
the Sprints page — losing the sprint's goal, capacity preflight, and committed-points
readout — to click a per-row commit toggle once per story, then navigate back.

Independently, TruePPM already has a first-class Definition-of-Ready (DoR) concept
(ADR-0105, #731): `Task.dor` (`idea | refine | ready`), server-computed
`dor_blockers` reason codes (`unestimated`, `no_acceptance_criteria`,
`acceptance_criteria_unmet`), and an advisory `mark_ready()` gate. None of it was
consulted at the point a story actually entered a sprint — `SprintCommitButton`
committed any story regardless of `dor`, and the Sprints page never surfaced
readiness at all.

This issue is the design handoff for both: a real picker, and where DoR fits into it.
Three questions had to be answered as a set:

- **Q1 — What is the picker, and where does it live?** Modal vs. panel; must the
  capacity preflight and committed-points readout stay live as stories are selected.
- **Q2 — Are non-ready stories hidden, or shown and blocked?** Silent absence is the
  worst failure mode in a picker; the alternative costs list density.
- **Q3 — What governs the default, and at which scope?** A workspace → program →
  project inheritable setting was proposed, following the established "Shape A"
  pattern (ADR-0116, ADR-0510): boolean vs. policy enum was left open.
- **Q4 — Does the old link survive as a fallback?** And if so, pre-filtered how.

Scope boundary (from the governing issue): URL state for the Product Backlog
grooming filter is explicitly out (#2445), as is bulk-commit on the Product Backlog
page itself (#2496, 0.6). Any `ENFORCE`/hard-block behavior is explicitly
Enterprise-scoped-out — the OSS behavior for a non-ready story must be advisory
(warn, explain, allow), never a 403.

## Decision

### 1. In-place modal, multi-select, live capacity (Q1)

`StoryPickerModal` (`packages/web/src/features/sprints/StoryPickerModal.tsx`) opens
as a dialog over the Sprints page — not a side panel and not a page navigation. It
reads the same `useProductBacklog(projectId)` grooming payload the Product Backlog
page already fetches (epics + ungrouped stories, all sprint-less by construction: the
endpoint scopes to `status=BACKLOG, sprint__isnull=True`), so no new read endpoint was
needed.

Selection is multi-select via checkboxes (plus a click-anywhere-on-the-row toggle and
a select-all-visible checkbox); a single **Commit N stories** action batches one
`PATCH /tasks/{id}/ {sprint: <id>}` per selected story via `Promise.allSettled`, so a
partial failure leaves only the failed rows selected for retry rather than losing the
whole batch. The footer's points/capacity chip re-derives live from
`committedPoints + selectedPoints` against `sprint.capacity_points` (reusing
`capacityPointsChip` from `sprintMath.ts`, the same function `CapacityPreflight`
already uses) — so the "what happens if I commit this" number never requires leaving
the dialog to check.

`SprintBacklogTable`'s `showBacklogLink` prop is replaced by `onOpenPicker` — the
affordance is a `<button>`, not a `<Link>`, on both the header and the empty state.

### 2. Ready-first ordering with a "Ready only" default, never silent absence (Q2)

The issue priced three options and asked for a decision on its own merits (not
inherited from ADR-0631's schedule-view dim-vs-hide precedent, which does not
transfer to a flat list). This ADR takes the **third option**: show everything,
sorted ready-first, with a **"Ready only" / "Show all"** toggle that defaults per
§3 below.

- **Ready only** (the default view): non-ready stories are omitted, with an explicit
  count and an inline escape hatch — *"N not-ready stories are hidden. **Show all**"*
  — so absence is never silent.
- **Show all**: every story renders, ready-first, with a non-ready row dimmed
  (`opacity-70`) and annotated with its specific blocker reason(s), reusing the exact
  `dor_blockers` → plain-English mapping `StoryDetailDrawer`'s `DorControl` already
  uses (`unestimated` → "needs an estimate", etc.) so the same story reads identically
  on the backlog and in the picker.

Selecting a non-ready story is **never blocked**. It surfaces an inline advisory
banner — *"N selected stories are not marked Ready — you can still pull them into the
sprint"* — and the Commit button stays enabled. This is the same advisory posture
`mark_ready()` already has (ADR-0105): DoR gates the *Ready* label, never a commit.

### 3. The default is a plain inheritable boolean, no override policy (Q3)

`sprint_picker_ready_only_default` is added identically named on `Workspace`
(non-null root, `default=True`), `Program`, and `Project` (both nullable — `NULL`
means inherit), resolved computed-on-read in the new
`trueppm_api.apps.projects.sprint_picker_settings` module. This is a byte-for-byte
structural mirror of `estimation_scale` (ADR-0510) rather than the
`public_sharing`/duration-policy shape (ADR-0135/ADR-0151), and that choice is
deliberate:

- **Boolean, not a policy enum.** The issue asked whether to match the
  `INHERIT`/`SUGGEST`/`ENFORCE` vocabulary those ADRs use. A policy enum earns its
  keep only when `ENFORCE` has real teeth — a lock that changes downstream behavior
  when active. Here, the only thing `ENFORCE` could mean is hard-blocking a
  not-ready commit, which is the exact behavior this issue's scope excludes from OSS.
  Building the enum's third state with no legal way to activate it in OSS is
  ceremony, not a real extension point.
- **No override_policy field, no enforcement registry.** `estimation_scale`'s own
  rationale applies verbatim: this is a plain PO/team preference, freely overridable
  at every scope, with no enforcement seam. A future Enterprise ADR that adds a
  genuine hard-block gate introduces its own policy/enforcement seam at that point —
  retrofitting one here today, unused, would be the "SSO tax"-shaped mistake of
  building a lock nobody can turn.
- **Scheduler+-writable at the project scope** (`_SCHEDULER_WRITABLE_FIELDS`),
  Admin+-writable at program/workspace — matching `estimation_scale` exactly: this is
  PO/team territory, not a Project-Manager-only policy decision.

Resolution precedence: project override → program override → workspace value
(`resolve_effective_sprint_picker_ready_only`); `resolve_inherited_...` answers "what
would this scope show if its own override were cleared" for the settings UI's
`InheritableToggleField` "Inherit (Ready only / Show all)" affordance.

### 4. The old link is fully replaced, not kept as a fallback (Q4)

The plain `<Link>` to the Product Backlog page is removed outright — the picker is a
strict superset of what it offered (a Ready-only default plus a **Manage full
backlog →** link inside the picker's own empty/footer state covers the "I want the
full grooming page" case). Keeping a second top-level navigation affordance
alongside a picker that already does more would reintroduce the "two ways to do the
same thing" confusion the issue opened with. Pre-filtering that link to `?dor=ready`
was considered and rejected: the Product Backlog grooming filter carries no URL state
at all (`useGroomingFilters.ts`), and giving it one is the explicitly out-of-scope
change tracked at #2445.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Hide non-ready stories entirely (Q2 option A) | Cleanest list | Silent absence — the worst failure mode in a picker; a PO sees no evidence a story exists or why it's missing |
| Always show all, no toggle (Q2 option B, ADR-0631-style dim-never-hide) | Never hides anything | No safe default for a team that wants a clean Ready-only view; every session starts noisy |
| Policy enum (`INHERIT`/`SUGGEST`/`ENFORCE`) for the default (Q3) | Vocabulary-consistent with sibling ADRs | No legal `ENFORCE` behavior in OSS without also building the hard-block gate this issue excludes; ceremony over function |
| Keep the Product Backlog link as a secondary affordance (Q4) | Preserves a familiar path | Two competing "how do I add work" CTAs; the picker already subsumes it |

## Consequences

**Easier**

- Committing N stories is one action instead of N page-scoped clicks.
- A not-ready story is never invisible — it is either counted-and-hidden with an
  escape hatch, or shown with its exact blocker reason.
- No migration risk from the setting: `sprint_picker_ready_only_default` has no
  enforcement seam to get wrong, mirroring `estimation_scale`'s already-proven shape.

**Harder**

- `StoryPickerModal` duplicates a small amount of ready-vs-not-ready row rendering
  that also exists on the Product Backlog page (`atoms.tsx`'s `DorChip`) — a future
  pass could extract a shared row component if a third surface needs the same
  treatment.
- The Product Backlog page's own bulk-commit (#2496, 0.6) and this picker are two
  surfaces converging on the same underlying action (commit a story to a sprint);
  they should be designed coherently when #2496 is picked up.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (`workspace/models.py`, `projects/models.py`, new
  `projects/sprint_picker_settings.py`, `projects/serializers.py`,
  `workspace/serializers.py`); `web` (`features/sprints/StoryPickerModal.tsx`,
  `SprintBacklogTable.tsx`, `SprintsView.tsx`, the three settings General pages,
  `api/types.ts`, `useProject.ts`, `useProjectMutations.ts`, `useProgramMutations.ts`,
  `useWorkspaceSettings.ts`, `useUpdateWorkspaceSettings.ts`)
- **Migration required**: Yes — three additive `BooleanField` columns
  (`workspace`/`projects` apps), no data backfill, no destructive operation
- **API changes**: Additive only — `sprint_picker_ready_only_default` (write),
  `effective_sprint_picker_ready_only_default` / `inherited_sprint_picker_ready_only_default`
  (read-only) on `Project`, `Program`, and `Workspace`
- **OSS or Enterprise**: OSS. No Enterprise extension point is introduced by this
  ADR — see §3 for why one was deliberately not built
- **Durable execution**: N/A — the setting is a plain resolved-on-read model field
  with no async dispatch, outbox row, or broadcast; committing a story to a sprint
  reuses the existing `TaskViewSet` update path unchanged
