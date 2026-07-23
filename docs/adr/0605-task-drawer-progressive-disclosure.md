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

Only the four **task-derivable** sections get a predicate this slice:
| section | populated signal |
|---|---|
| sprint | `task.sprintId != null` |
| blocker | `task.blockedAgeSeconds != null` (the team-visible flag, not the privacy-gated `blockedReason`) |
| dependencies | any `links` edge touches the task (falls back to `predecessorCount > 0`) |
| estimates | leaf: any PERT duration set; summary: any descendant PERT |

`related-links` and `recurring` carry **no** task-level signal (their content lives
behind `useTaskRelations` / `useRecurrenceRule`), so they omit `isPopulated` and stay
always-shown collapsed headers — no regression. Giving them true progressive disclosure
needs server-computed `has_related_links` / `has_recurrence` annotations on the Task
serializer (the established `predecessorCount` / `linkedRisksCount` pattern); filed as
a follow-up.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. `isPopulated` predicate (chosen)** | Additive to a frozen extension point; zero new fetch; Enterprise unaffected (no predicate → shown) | related-links/recurring not covered until a server annotation lands |
| B. Fire each section's query on drawer open to know emptiness | Covers all six | Defeats ADR-0050 lazy-load — a fetch storm on every open, exactly what the registry avoids |
| C. Add `has_*` booleans to the Task serializer now | Covers all six cleanly | Turns a frontend slice into a full-stack change (perf/rbac/api-docs/schema); larger blast radius for the first slice |
| D. Self-reporting sections (each renders, then hides if empty) | No predicate | Section must mount + fetch to decide — same fetch-storm cost as B, and empty headers still flash |

## Consequences
- **Easier:** the common task (no sprint/blocker/deps/estimates) drops from six empty
  headers to two, plus a clean "Add detail" row. A section with content is shown and
  opened automatically.
- **Harder / risks:** two sections (related-links, recurring) remain always-shown until
  the follow-up server annotation — a deliberate, documented partial. The predicate
  runs on every drawer render; it is O(sections) over in-memory data, negligible.
  A cold schedule cache makes a summary-estimates or dependency predicate under-report
  (→ section offered in "Add detail", never wrongly showing stale data); acceptable
  because the cache is warm whenever the drawer opens from the schedule/board.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web only
- Migration required: no
- API changes: no (a follow-up will add `has_related_links` / `has_recurrence`)
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
