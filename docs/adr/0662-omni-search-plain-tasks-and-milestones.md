# ADR-0662: Omni-search covers plain tasks and milestones

## Status
Accepted (extends ADR-0508 D4 — the `GET /api/v1/me/search/` omni-search endpoint — and
does not supersede it) — status corrected 2026-07-29 after ADR audit (#2539, verified:
`_OMNI_SEARCH_TYPES` includes `milestone`, web `useOmniSearch.ts` default types).

## Context

Issue #2442, filed from the 2026-07-26 UX-flows VoC audit (finding 4 of 6), reports that
the ⌘K global omni-search returns **epics and stories only**. Raised independently by
Sarah (PM), Marcus (PMO Director) and Janet (Executive Sponsor); stated frequency
**daily**.

The failure mode is worse than a missing filter. A construction PM running 3–5 concurrent
waterfall projects has **no epics or stories at all**. Typing a real task name —
"Foundation pour" — into the product's one global search surface returns **zero results**,
which reads as *"the tool doesn't have my data"* rather than *"you asked for the wrong
type."* Milestones are worse still: they are the unit Marcus and Janet actually ask about
("is the Q4 gate still holding?") and they are unreachable from global search entirely, at
any scope beyond a single project view.

The gap is one line of client default plus a missing server concept:

* `_OMNI_SEARCH_TYPES` (`views.py:12517`) already understands `task`.
* The client never asks for it — `OMNI_SEARCH_DEFAULT_TYPES = 'epic,story'` in
  `useOmniSearch.ts` pins the request set, and there is no UI to widen it. An
  opt-in with no way to opt in is, for every user, simply absent.
* There is no `milestone` concept on the endpoint at all.

**The issue's proposed mechanism does not work, and this is the substance of the ADR.**
#2442 says: *"add a milestone kind to `_OMNI_SEARCH_TYPES` … Milestones are `Task` rows
already, so this is a type filter, not a new source."* The first clause is impossible as
written:

* `_OMNI_SEARCH_TYPES` maps each key to a `(TaskType, BacklogItemType)` **tuple**, and
  **`MILESTONE` is not a member of either enum.** `TaskType` is
  `epic|story|task|bug|spike|tech_debt`; `BacklogItemType` is
  `epic|feature|story|task|bug|spike|chore`.
* Milestone-ness is an orthogonal, coupled tri-state invariant (#1773):
  `is_milestone=True` ⟺ `delivery_mode='milestone'` ⟺ `duration=0`. The `MILESTONE` value
  at `models.py:1866` belongs to `DeliveryMode`, a different enum.
* Therefore a milestone `Task` **still carries an independent `type`** (typically `task`),
  and "milestone" cannot be a value in a `TaskType`-keyed tuple.

The second clause is right: milestones need no new source. But because milestone-ness is
orthogonal rather than exclusive, adding it naively creates a **duplicate-row defect**: a
milestone `Task` satisfies both `is_milestone=True` and `type='task'`, so `?type=task,milestone`
would return the same row twice with two different chips.

P3M layer: **Programs and Projects** — a read across the projects and programs the caller
is already a member of. No cross-portfolio aggregation, so this stays OSS.

## Decision

**D1 — Replace the tuple map with a per-key predicate spec (a single membership-gated
query).** `_OMNI_SEARCH_TYPES` values become a small frozen dataclass carrying a task-side
`Q` predicate and an optional backlog `item_type`:

```python
@dataclass(frozen=True)
class _OmniSearchKind:
    task_filter: Q | None      # None → this key never matches a Task
    backlog_type: str | None   # None → this key never matches a BacklogItem
```

`milestone` gets `task_filter=Q(is_milestone=True), backlog_type=None` — expressing
directly that a milestone is a schedule artifact and never program intake.

The rejected alternative — special-casing `milestone` inside `_task_results` — is rejected
**on security grounds, not taste**. A second branch is a second queryset, and a second
queryset must independently re-apply the 🔴 IDOR membership re-filter
(`project__memberships__user_id`, `project__memberships__is_deleted=False`). That is
precisely the forgotten-gate failure mode ADR-0104 §risk-1 documents. Composing per-key
predicates with `OR` into the **one** existing queryset means the membership gate is
written once and a future key **cannot** be added in a way that bypasses it.

**D2 — Disjointness is enforced in the predicate, not at merge time.** Every agile key
gains `is_milestone=False`; the `milestone` key is `is_milestone=True`. The keys are
therefore mutually exclusive **by construction**, so no requested combination can
double-list a row, and no merge-time dedup pass is needed.

A row reports its type from the row itself, not from the key that matched it:

```python
"type": "milestone" if task.is_milestone else task.type,
```

This is safe precisely because `OmniSearchResultSerializer.type` is a plain `CharField`,
not a `ChoiceField` — a deliberate choice (`serializers.py:7307-7314`) made so the field
does not emit a `KindEnum` component colliding with `AssetItem.kind`. Synthesizing
`"milestone"` therefore adds **no** OpenAPI enum and renames nothing.

A milestone must *report* as a milestone: if it reported `type="task"` the client could not
chip it correctly, and Marcus's and Janet's mental unit — "the Q4 gate" — would render as a
generic task, which is the original complaint in a new costume.

**Accepted behavior change:** a milestone-flagged epic or story is no longer returned under
`?type=epic` / `?type=story`; it is returned under `?type=milestone`. Given the #1773
invariant (duration 0, `delivery_mode='milestone'`) such a row *is* a milestone first. This
narrows the current default (`epic,story`) for those rare rows, and is documented rather
than hidden.

**D3 — Two new palette groups; do not reuse `'task'`.** `CommandGroup` already has a
`'task'` member owned by the **project-scoped** "jump to task" tier. Reusing it would file
global cross-program results under a group header that means "in this project", putting two
different scopes under one heading. Add distinct groups for the omni task and milestone
rows. `omniSearchGroup()` — which today returns `'epic'` for epics and `'story'` for
*everything else*, and so would mislabel a plain task as a Story — is corrected to map each
type to its own group. **Group header copy and row order are deferred to the `ux-design`
gate**; this ADR fixes only the structure.

**D4 — Tasks and milestones join the default set; ranking gains a type tier, server-side.**
The client default becomes `epic,story,task,milestone`. The server comment justifying
opt-in ("a cold search never dumps every plain task") is already satisfied by three
independent bounds that all remain: the 2-character `_OMNI_SEARCH_MIN_Q` floor, the
`_OMNI_SEARCH_SCAN_CAP = 100` per-source bound, and prefix-first ranking.

Type ranking is a **new** requirement (the endpoint currently ranks prefix-first then
alphabetically with no type weighting) and belongs **server-side**: ranking is this
endpoint's documented contract, the endpoint is `McpReadableViewMixin` so an MCP agent
inherits the same ordering, and client-side re-ranking would fight server pagination order.

The type tier is a **tiebreaker, not the primary key**:

```
(prefix_match, type_rank, title_lower, id)
```

with `type_rank = epic 0, story 1, milestone 2, task 3`. Keeping `prefix_match` dominant
matters: an exact prefix-matching task is far more likely to be what the user meant than an
alphabetically-first epic, so type rank must not bury it. This satisfies "tasks ranked below
epics/stories so the agile ordering is undisturbed" only *within* a prefix class, which is
the correct reading of that requirement.

**D5 — Record as ADR-0662, extending ADR-0508 D4.** This changes a documented API contract
(new `?type=` key, a new disjointness invariant, a new ranking tier, a changed default set),
which is more than an erratum. ADR-0508 is a five-ask document; burying a contract change
inside it would hide it. ADR-0662 is the reserved number for this work.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Per-key predicate spec (chosen)** | One membership-gated queryset; IDOR filter written once; a future key cannot bypass it; disjointness expressible | Touches the shape of an existing module-level constant |
| B. Special-case `milestone` in `_task_results` | Smallest diff | Second queryset must re-apply the 🔴 IDOR gate — the ADR-0104 §risk-1 forgotten-gate class; disjointness has nowhere natural to live |
| C. Keep tuples, add `MILESTONE` to `TaskType` | Fits the existing structure | Wrong data model: contradicts the #1773 coupled invariant, needs a migration, and breaks every `type=` consumer and the `_ITEM_TYPE_TO_TASK_TYPE` pull map |
| D. Merge-time dedup instead of disjoint predicates | No change to agile-key filters | Pays for every request to undo a defect the predicate can prevent; leaves "which chip wins?" as an arbitrary runtime tiebreak |
| E. Tasks/milestones stay opt-in via a palette toggle | Preserves today's default exactly | Ships the bug: the waterfall PM's default search still returns nothing, and adds a control users must discover to get data they expect |
| F. Rank type before prefix match | Strict "agile first" ordering | Buries an exact prefix match under alphabetical epics — actively worse for the search's primary job |

## Consequences

**Easier**
- A waterfall PM finds plain tasks in the one global search surface — the #2442 defect.
- Milestones become globally searchable for the first time, at the layer Marcus and Janet ask at.
- MCP agents inherit both, and the same ranking, with no extra work (API-first).
- Adding a future omni key is one dataclass entry with the membership gate already applied.

**Harder**
- `_OMNI_SEARCH_TYPES` is a richer structure than a tuple map — marginally more to read.
- A milestone-flagged epic/story changes group (see D2). Rare, documented, intentional.

**Risks**
- *Result dilution*: plain tasks are far more numerous than epics/stories, so a two-character
  query could crowd out agile rows. Mitigated by the type tier within each prefix class and
  the unchanged scan cap. **Watch after ship**; if dilution is real the answer is a per-type
  cap, not a narrower default.
- *Query cost*: an `OR` of predicates over the same membership-joined queryset, still
  bounded by `_OMNI_SEARCH_SCAN_CAP`. The `is_milestone` column is a plain boolean with no
  dedicated index; confirm the `perf-check` gate sees no regression against the trigram path.
- *Contract drift*: `types.ts` is hand-maintained (#2123-27), so the new `type` value and
  any group additions must be mirrored by hand in the same MR.

## Implementation Notes
- P3M layer: **Programs and Projects**
- Affected packages: **api**, **web**
- Migration required: **no** — no model change; `is_milestone` and `Task.type` both already exist
- API changes: **yes** — `GET /api/v1/me/search/` accepts `?type=…,milestone`; `type` in a
  result row may now be `"milestone"`; the default requested set widens to
  `epic,story,task,milestone`; merged results gain a type tiebreaker. No new endpoint, no
  new permission surface, no change to the 🔴 IDOR membership re-filter. `docs/api/` and the
  `?type=` `OpenApiParameter` description both need updating.
- OSS or Enterprise: **OSS** — a read scoped to the caller's own project/program
  memberships, no cross-portfolio aggregation. Verified `grep -r "trueppm_enterprise" packages/`
  returns only boundary-documenting comments, zero imports.

### Durable Execution
1. **Broker-down behaviour**: N/A — `MeSearchView` is a pure read endpoint with zero async
   side effects. Nothing is dispatched, so there is no durability gap to close.
2. **Drain task**: N/A — no async work, so no new Beat drain and no reuse of an existing one.
3. **Orphan window**: N/A — no outbox rows are written.
4. **Service layer**: N/A — the query is a bounded read composed in the view, consistent with
   `MeWorkView` and `/me/recent-projects/`. No CPM recalculation is triggered, so
   `scheduling/services.py::enqueue_recalculate()` is not involved.
5. **API response on best-effort dispatch**: N/A — synchronous read returning the standard
   `{count, next, previous, results}` page envelope (pinned `operation_id`
   `v1_me_search_list`, #2267).
6. **Outbox cleanup**: N/A — no outbox rows.
7. **Idempotency**: Inherently idempotent — a `GET` with no writes. Repeated identical
   requests return the same page, with `id` as the final sort key giving a stable total order
   across pages so pagination cannot duplicate or skip a row.
8. **Dead-letter / failure handling**: N/A for task failure. Request-level failure is the
   existing behavior: a sub-floor `q` returns an empty page rather than an error, and abuse is
   bounded by `throttle_scope = "omni_search"` (unchanged).
