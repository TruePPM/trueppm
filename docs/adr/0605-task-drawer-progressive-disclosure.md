# ADR-0605: Task-detail drawer progressive disclosure (`isPopulated` section predicate)

## Status
Accepted

## Context
The Task-Detail Drawer v2 redesign (#2315, VoC 3.7/10) has one dominant blocker:
the Details tab always renders **six** collapsed optional-section headers — Sprint,
Blocker, Dependencies, Related tasks, Recurrence, Estimates — regardless of whether
the task has any data in them. The imported design ("Task Detail Drawer v2") renders
only the *populated* optional sections and folds the rest behind a single **"Add
detail"** affordance.

The sections render through the ADR-0050 `task_detail.section` widget-registry. Its
descriptor has `canRender(ctx)` — a **capability** gate ("can this task *type* ever
have this section", e.g. milestones have no estimates) — but nothing that answers
"does THIS task have content here *right now*". The registry is also a **frozen public
extension point**: Enterprise registers sections against it (ADR-0050/#1355), and
ADR-0437/0439 froze `DrawerSectionProps` specifically so Enterprise sections keep
compiling. Any change must be additive.

A further constraint: sections lazy-mount their TanStack Query only when their
`CollapsibleSection` opens (drawerSectionStore persists open state). "Populated?" must
therefore be answerable **without firing the section's query**.

P3M layer: Programs and Projects (OSS). This is a pure web presentation change.

## Decision
Add an **optional** `isPopulated?(ctx): boolean` predicate to the section descriptor,
parallel to `canRender`:

- On `SlotRegistration`: `isPopulated?(ctx: unknown): boolean`.
- Narrowed on `DrawerSectionRegistration`: `isPopulated?(ctx: DrawerSectionContext): boolean`.
- `DrawerSectionContext` gains optional `tasks?` / `links?` (the already-warm schedule
  cache) so a predicate can decide emptiness from data the drawer already holds — no
  new fetch. `DrawerSectionProps` (the component contract) is **untouched**.

Semantics in the Details tab:
- `isPopulated` **absent** → section always shown (today's behavior). Every Enterprise
  section and any OSS section whose emptiness isn't task-derivable is unaffected —
  this is the backward-compatibility guarantee.
- `isPopulated` returns **true** → shown, and auto-opened (the user wants to see it).
- `isPopulated` returns **false** → folded out of the main flow and offered under one
  "Add detail" row. Revealing it (session-scoped, per-task, in `drawerSectionStore`)
  moves it back into the flow, auto-opened.

Only the four **task-derivable** sections got a predicate in the first slice:
| section | populated signal |
|---|---|
| sprint | `task.sprintId != null` |
| blocker | `task.blockedAgeSeconds != null` (the team-visible flag, not the privacy-gated `blockedReason`) |
| dependencies | any `links` edge touches the task (falls back to `predecessorCount > 0`) |
| estimates | leaf: any PERT duration set; summary: any descendant PERT |

`related-links` and `recurring` carried **no** task-level signal (their content lives
behind `useTaskRelations` / `useRecurrenceRule`), so they omitted `isPopulated` and
stayed always-shown collapsed headers — a deliberate partial, no regression.

**Completed in #2317** (option C below, taken as a follow-up rather than as part of
the first slice): `annotate_tasks_queryset` now adds two `Exists()` annotations that
TaskSerializer exposes read-only, and the two sections read them:
| section | populated signal |
|---|---|
| related-links | `task.hasRelatedLinks` — a live `TaskRelation` on **either** end (the section unions both directions) |
| recurring | `task.hasRecurrence` — the task owns a live `TaskRecurrenceRule` |

`has_recurrence` is deliberately **not** `Task.is_recurring`: the latter is also true
for generated occurrences, which own no rule, so keying off it would leave an
occurrence's Recurrence section expanded and permanently empty (ADR-0090). Both
annotations default to `False` when a caller bypasses the viewset, so an unannotated
task reports *not* populated — the section is offered under "Add detail", never
wrongly expanded. All six optional Details-tab sections now carry a predicate.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. `isPopulated` predicate (chosen)** | Additive to a frozen extension point; zero new fetch; Enterprise unaffected (no predicate → shown) | related-links/recurring not covered until a server annotation lands |
| B. Fire each section's query on drawer open to know emptiness | Covers all six | Defeats ADR-0050 lazy-load — a fetch storm on every open, exactly what the registry avoids |
| **C. Add `has_*` booleans to the Task serializer** — deferred, then adopted in #2317 | Covers all six cleanly | Turns a frontend slice into a full-stack change (perf/rbac/api-docs/schema); too large a blast radius for the *first* slice, fine as a follow-up once A had shipped and proved the interaction |
| D. Self-reporting sections (each renders, then hides if empty) | No predicate | Section must mount + fetch to decide — same fetch-storm cost as B, and empty headers still flash |

## Consequences
- **Easier:** the common task (no sprint/blocker/deps/estimates) drops from six empty
  headers to two, and to **zero** once #2317 landed the two server annotations — just
  a clean "Add detail" row. A section with content is shown and opened automatically.
- **Harder / risks:** two sections (related-links, recurring) remained always-shown
  between the first slice and #2317 — a deliberate, documented partial. The predicate
  runs on every drawer render; it is O(sections) over in-memory data, negligible.
  A cold schedule cache makes a summary-estimates or dependency predicate under-report
  (→ section offered in "Add detail", never wrongly showing stale data); acceptable
  because the cache is warm whenever the drawer opens from the schedule/board.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web; api (as of #2317)
- Migration required: no — both annotations are queryset-level, no model field
- API changes: yes, as of #2317 — two additive read-only `TaskSerializer` booleans
  (`has_related_links`, `has_recurrence`). Additive and read-only, so no client break.
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A — no async side effects; pure client-side presentation.
2. Drain task: N/A — no task dispatched.
3. Orphan window: N/A.
4. Service layer: N/A — no server mutation.
5. API response on best-effort dispatch: N/A — no API call added.
6. Outbox cleanup: N/A.
7. Idempotency: N/A — reveal state is idempotent session UI state; re-revealing a
   section is a no-op set insert.
8. Dead-letter / failure handling: N/A — a predicate throw is contained by the existing
   per-section error boundary (ADR-0050); a section whose predicate errors would surface
   through the registry filter, not crash the drawer.
