# ADR-0155: At-a-glance external-link-status indicators (task list + Gantt)

## Status
Accepted

## Context
#637 (ADR-0049, ADR-0076) shipped git-aware task links: an `integrations.TaskLink`
row links a task to an external PR/MR/issue and caches a `status`
(`open | draft | merged | closed | unknown`). Today that status is visible **only**
inside the task-detail drawer (`ExternalLinksSection`), one badge per link.

The #637 UX design also wanted the *worst* link status surfaced **at a glance** on the
task-list row and the Gantt bar, so a PM/dev scanning the schedule can see "this task's
PR is closed/abandoned" without opening the drawer. That was deferred for cost: the list
indicator touches the hot-path task-list serializer and the Gantt glyph is canvas work
with a hard per-frame budget. #767 picks up exactly that deferred surface.

**P3M layer:** Programs and Projects (single project, per-task). Read-only surfacing of
existing per-task data — **no cross-project aggregation**. → OSS.

**VoC (4 relevant personas, avg ~5.25, no blockers):** Priya (target dev) 8/10 🟢 —
at-a-glance PR state with zero data entry. Alex 5/10 🟡 / Jordan 5/10 🟡 — useful but
want it *also* on the sprint board card (Alex) and as an epic/sprint rollup + DoD signal
(Jordan); both are scope expansions → follow-up issues, not #767. Sarah 3/10 🔴 — the
expected pre-0.4 web/offline miss, explicitly not a reason to rescope. The task-list-row
glyph is the highest-value surface; the Gantt dot is secondary.

## Decision

1. **Canonical "worst status" precedence**, identical in Python and TypeScript, ordered
   most-attention-first (matching the existing `ExternalLinksSection` badge color
   severity — critical → at-risk → on-track → success → neutral):

   | rank | status   | meaning                          | color (existing badge) |
   |------|----------|----------------------------------|------------------------|
   | 0    | `closed` | link died / abandoned (worst)    | critical (red)         |
   | 1    | `draft`  | not ready                        | at-risk (amber)        |
   | 2    | `open`   | active / in review               | on-track (green)       |
   | 3    | `merged` | done (best)                      | brand (sage)           |
   | 4    | `unknown`| no status fetched                | neutral                |

   The worst status of a task is the **minimum-rank** status across its non-deleted
   links. A single shared module owns this in each language:
   - Python: a `LINK_STATUS_RANK` map + helper next to `integrations/registry.py`.
   - TypeScript: `packages/web/src/lib/linkStatus.ts`, reused by `ExternalLinksSection`
     (refactored to drop its private precedence-free per-link rendering — it keeps its
     per-link badges but now imports the shared color/rank map), `TaskListRow`, and the
     Gantt renderer.

2. **API shape** — a nested read-only field on the task **list** serializer:
   ```jsonc
   "external_link_summary": { "count": 3, "worst_status": "closed" }  // worst_status null when count == 0
   ```
   Computed with **two aggregate annotations** in `annotate_tasks_queryset()` (no N+1),
   mirroring the existing `linked_risks_count` / `linked_risks_max_severity` pattern on
   the same queryset (the local convention is aggregates, not `Subquery`):
   - `external_link_count = Count("links", filter=Q(links__is_deleted=False), distinct=True)`.
   - `external_link_worst_rank = Min(Case(When(links__status="closed", 0), …, default=4,
     output_field=IntegerField()), filter=Q(links__is_deleted=False))`.

   `distinct=True` keeps the count correct under the queryset's other multi-relation
   joins; `Min` is multiplication-invariant so the worst-rank is correct regardless of
   join fan-out (this is exactly why `linked_risks_max_severity` can use a bare
   filtered `Max` next to it). The serializer assembles `{count, worst_status}` from the
   two annotations, mapping rank → status string (null when count is 0).

3. **Web surfaces:**
   - **Task-list row** (`TaskListRow`): a compact link glyph + count, tinted by worst
     status, immediately left of `AssigneeChips`. Hidden when the task is a
     summary/milestone task or `count === 0`. `aria-label` carries the human text
     ("3 links, worst status: closed") since the color alone is not accessible.
   - **Gantt bar** (`GanttRenderer`): an 8px worst-status dot at the bar's right edge,
     **Day/Week zoom only**, drawn under the critical-path z-order, with a strong fill +
     dark text (brand §15 — never white-on-color). `aria-hidden` (the list row carries
     the accessible text; the canvas is decorative here).

4. **ADR envelope:** small new ADR (this one) that **extends ADR-0049/ADR-0076** rather
   than amending them — the data contract is unchanged; #767 only adds a read-only
   aggregate surface.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Two flat serializer fields (`external_link_count`, `external_link_worst_status`) | Slightly simpler annotation→field mapping | Two correlated fields the client must keep coherent; nested object reads better and matches the "summary" intent. Rejected. |
| `Subquery`-based count + worst-rank instead of aggregates | Immune to join fan-out by construction | Diverges from the immediate `linked_risks_*` neighbors which use filtered aggregates; `distinct=True` (count) + multiplication-invariant `Min` already make aggregates correct here. Rejected for consistency. |
| Compute worst status client-side from the full link list | No serializer change | Forces the list endpoint to embed every task's links (heavy, N+1-ish payload) — defeats the at-a-glance goal. Rejected. |
| Surface on the sprint board card / epic rollup now (Alex, Jordan asks) | Higher agile resonance | Out of #767 scope; different surfaces and an aggregation grain. Filed as follow-ups. |

## Consequences
- **Easier:** a dev/PM sees worst PR state while scanning the list or schedule without
  opening the drawer; one shared precedence prevents API/web drift.
- **Harder:** the task-list serializer gains two more annotations (hot path) — must pass
  `/perf-check` (no N+1, indexed). The Gantt renderer gains a per-bar decoration — must
  stay within the ≤10ms/frame canvas budget (Day/Week only, skipped at Month+ zoom).
- **Risks:** precedence drift between Python and TS (mitigated by a single shared map +
  a unit test in each language asserting the same ordering); canvas perf regression
  (mitigated by zoom gating + a render-budget check).
- **Follow-ups filed:** sprint-board-card link glyph (Alex); epic/sprint-level rollup +
  Definition-of-Done tie-in (Jordan); optional clickable deep-link from the row glyph to
  the PR (Priya).

## Implementation Notes
- P3M layer: Programs and Projects (Operations-adjacent dev workflow).
- Affected packages: api (serializer + queryset annotation, registry helper), web
  (shared `lib/linkStatus.ts`, `TaskListRow`, `GanttRenderer`, `ExternalLinksSection`
  refactor to consume the shared map, `Task` type).
- Migration required: **no** — read-only aggregate over existing `integrations.TaskLink`.
- API changes: yes — additive read-only `external_link_summary` on the task list
  serializer (no request-shape change).
- OSS or Enterprise: **OSS**.

### Durable Execution
1. Broker-down behaviour: **N/A** — pure read annotation + UI; zero async side effects, no `.delay()`.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — read path only; annotation lives in `apps/projects/views.py::annotate_tasks_queryset()`.
5. API response on best-effort dispatch: **N/A** — synchronous read; field is part of the normal list response.
6. Outbox cleanup: **N/A** — no outbox.
7. Idempotency: **N/A** — read-only; repeated reads are inherently idempotent.
8. Dead-letter / failure handling: **N/A** — no task. If a link's cached `status` is stale, that is governed by #637's existing refresh path, unchanged here.
