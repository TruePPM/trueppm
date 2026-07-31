# ADR-0752: A Task's Span and Its Remaining-Work Window Are Two Named Fields, Never One Polysemic Pair

## Status

Proposed

## Context

**P3M layer:** Programs and Projects (single-project scheduling and its presentation).
**OSS** — core scheduling IP and the schedule surfaces a PM uses daily; no cross-program
aggregation.

ADR-0132 made the forward pass progress-aware. Since then `early_start`/`early_finish`
describe **the remaining work** on an in-progress task, not the task's span:

```python
# packages/scheduler/src/trueppm_scheduler/engine.py:434  _effective_duration_days
elapsed = int(duration_days * min(pct, 100.0) / 100.0)
return max(0, duration_days - elapsed)
```

A 4-day task at 83% therefore carries a **one-day** `early_start..early_finish`. The stored
`duration` field is untouched. Nothing anywhere names the difference, so every surface prints
both quantities side by side as though they described the same thing (#2622):

| Surface | Shows | Source |
|---|---|---|
| Gantt bar | 1 day | `early_start..early_finish` |
| Grid Start / Finish | Jul 24 / Jul 24 | `early_start`, `early_finish` |
| Grid Dur column | `4d` | stored `duration` |
| Drawer vitals strip | Jul 24 / Jul 24 / `4d` | both, in one bordered frame |
| API / MCP payload | `duration: 4`, `early_start == early_finish` | both, undiscriminated |
| Resource utilization | 1 day of load | `early_start..early_finish` (#2623) |

### The field is polysemic, which is the root defect

`early_start`/`early_finish` mean *task span* for a not-started task, *task span* for a
completed one (ADR-0136 pins completed tasks at full duration), and *remaining-work window*
for an in-progress one — under one name, with no discriminator. Any consumer that assumes
`finish − start ≈ duration` is silently wrong for exactly the tasks a PM is watching most
closely. `packages/mcp/src/trueppm_mcp/tools.py:316,777` relays these as named "CPM
quantities" to agent clients, which propagate a number they cannot account for.

### The Gantt applies progress twice

This is the part that makes the schedule actively misleading rather than merely unlabeled.
`GanttRenderer` already draws the MS Project convention — a fill boundary inside the bar:

```ts
// packages/web/src/features/schedule/engine/GanttRenderer.ts:1134-1153
function drawProgressOverlay(ctx, progress, barLeft, barTop, barWidth) {
  if (progress <= 0 || progress >= 100) return;
  const progressWidth = barWidth * (progress / 100);
  // …tint the unprogressed remainder
}
```

`barLeft`/`barWidth` derive from `task.start`/`task.end` (`:1021-1024`), which are
`early_start`/`early_finish`. So the overlay divides the **already-shrunken remaining
window** at the progress percentage: a 4-day task at 83% renders as *83% of one day*.
Progress is subtracted from the geometry and then subtracted again from the fill. The
renderer is not missing the convention — it is being fed the wrong window.

The consequence is worse than an unlabeled number: because the bar shrinks, **progress is
visually indistinguishable from a duration cut**, and a PM reviewing a board sees work
disappearing rather than advancing.

### Two claims in ADR-0132 that the code does not match

Both were verified against `main` while writing this ADR, and both change what there is
left to decide.

**§2 says in-progress work is not floored at the data date. It is.** Both engines take the
data-date floor for the in-progress branch:

```python
# engine.py:840-856
start_base, start = _calendar_floors(cal, project_start, status_date, floors)
…
duration_days = _effective_duration_days(task)
es_constraints = [start]          # ← the data-date-floored value
```

`packages/wasm-scheduler/src/forward.rs:138` is the same shape. So the floor exists; ADR-0132
§2's prose ("It is *not* floored at the status date") describes an engine we do not ship.

**§1 says a null `status_date` resolves to today. On the CPM path it does not.** The
persisted deterministic run and the read-time `current` block both pass it raw:

```python
# packages/api/src/trueppm_api/apps/scheduling/views.py:1021-1022
cpm_status_date = project.status_date                       # None ⇒ no floor at all
mc_status_date = project.status_date or timezone.localdate()
```

`Project.status_date` is nullable and unset on essentially every project, so **in practice
there is no data-date floor on the CPM path** — which is precisely the condition under which
#2621's repro drifts (remaining work slides to its earliest network slot, and the project
forecast finish moves *earlier* on every progress update). The floor is implemented and
almost never armed.

This matters for scoping: question 4 of #2622 ("should `status_date` default to today on the
CPM run too?") is not a request for new engine capability. It is a request to arm a floor
that already exists, by fixing where the null is resolved.

### Related decisions this one sits between

- **ADR-0132** — progress-aware forward pass. Amended by §4 below; not superseded.
- **ADR-0136** — completed tasks retain their full-duration span. This ADR generalizes
  0136's instinct (a bar should show the work's shape) from completed tasks to in-progress
  ones.
- **ADR-0698** — the resolved *state* rides the payload; the client never re-derives it from
  a raw number. That is the governing precedent for §3.
- **ADR-0603 / web-rule 276** — the drawer's `computed` qualifier chip, the existing pattern
  for "this value is not what you would assume."

## Decision

### 1. `early_start`/`early_finish` mean the remaining-work window — always

They keep their ADR-0132 semantics and stop being renamed by task state. For a not-started
or completed task the remaining window *is* the span, so no value changes; the field simply
acquires one meaning instead of two.

Successors continue to key off these dates. This is the network-scheduling truth and it is
correct: a task that is 83% done really does release its successor in one day.

### 2. `scheduled_start`/`scheduled_finish` are the span, and the schedule renders them

New CPM output describing where the task's **whole** duration sits.

- `scheduled_finish` **≡ `early_finish`**, always — remaining work ends when the task ends.
  It is exposed under its own name for symmetry so a consumer never has to mix the two
  vocabularies in one expression. It is **not** a new column.
- `scheduled_start` is one new persisted `DateField`, derived in the engine:

| Task state | `scheduled_start` |
|---|---|
| Not started | `early_start` (windows coincide) |
| Complete | `early_start` (ADR-0136 already pins full duration) |
| In progress, `actual_start` set | `actual_start` |
| In progress, no `actual_start` | `_start_from_finish(early_finish, duration, calendar)` — back off the full duration, calendar-aware (`engine.py:419`) |

When `actual_start` is set, the span may exceed `duration` — a task that started Jul 20, is
half done, with remaining work scheduled Jul 31..Aug 1 has an eleven-day span against a
four-day estimate. **That divergence is real and is the point**: it is the visible form of
work that is taking longer than estimated, and flattening it back to `duration` would hide
the single most useful thing the span can say.

**Persisted, not serializer-derived.** The calendar-aware back-off cannot be expressed in
SQL, and utilization (#2623) filters tasks by window intersection in the database
(`utilization.py:158-160,383-385`). A read-time derivation would leave that query with
nothing correct to filter on. This is the deliberate exception to ADR-0698's
"derive at read time" — that ADR governs a *presentational state*; this is a queryable
scheduling output, and it is written by the same `bulk_update` that already writes
`early_start`.

**`remaining_duration` is serializer-computed**, not persisted: it is
`duration − floor(duration × pct/100)` with no query behind it.

### 3. Two named fields, not a mode discriminator

#2622 offered `schedule_window_type: full_span | remaining_work` as an alternative. Rejected.
A discriminator keeps one field polysemic and adds a warning label; every consumer must then
branch, and a task list can contain both meanings at once. Two fields each carry exactly one
meaning for every task in every state, and a consumer picks the one it means.

This is ADR-0698's rule applied to dates: **put the resolved fact on the payload; never make
the client re-derive it.** A client cannot recover the span from
`(early_start, early_finish, duration, percent_complete)` anyway — the back-off is
calendar-aware and the client does not have the calendar.

### 4. Amend ADR-0132 — correct §2's prose, and arm the floor in §1

- **§2's prose is corrected to match the shipped engines**: in-progress remaining work *is*
  floored at the data date. No engine change. The original rationale — "work already
  underway stays where it actually started" — is now carried by `scheduled_start`, which is
  where it belonged; the remaining window was never the right place to preserve it.
- **§1 is restored on the CPM path**: a null `status_date` resolves to today in the shared
  input builder, so both the persisted recalculation and the read-time `current` block use
  the same resolved date the Monte Carlo path already uses. The resolved date is **echoed on
  the schedule payload**, so a consumer always knows which data date produced the dates it
  is holding.

  The invariant the current raw-pass comment protects (`current.cpm_finish` identical to the
  persisted deterministic finish) is preserved, because both paths move to the same
  convention together. Persisting the resolved date on `MonteCarloRun` stays with **#2638**;
  this ADR covers only the CPM half.

  **Accepted cost, stated plainly:** stored CPM dates become correct *as of the last
  recalculation* rather than as of today. A project untouched for a week carries a
  week-old floor. This is not new — stored dates have always been as-of-last-recalc — but
  arming the floor makes the staleness observable where it previously was not. The echoed
  data date is the mitigation: the payload says what it is as-of. A scheduled re-anchor is
  **not** in scope here and should not be added reflexively; file it if the staleness turns
  out to bite.

### 5. The span is explainable — `scheduled_start` joins the derivation contract

The derivation endpoint answers "why is this task's start this date?" against a **closed
allow-list**:

```python
# packages/api/src/trueppm_api/apps/scheduling/views.py:1859-1868
_CPM_DERIVATION_QUANTITIES = frozenset({
    "early_start", "early_finish", "late_start", "late_finish",
    "total_float", "free_float",
})
```

which mirrors `trueppm_scheduler.derive.Quantity` (`derive.py:60-65`), and the MCP
`get_schedule_derivation` tool re-publishes the same list. Adding the span fields without
adding them here would fix the polysemy for humans and leave it in place for agents: an MCP
client asking why a task starts when it does would still get the remaining-window start,
with no way to ask about the span at all.

Therefore `SCHEDULED_START = "scheduled_start"` is added to `Quantity`, to
`_CPM_DERIVATION_QUANTITIES`, and to the MCP tool's documented enumeration
(`packages/mcp/src/trueppm_mcp/tools.py:316,777`). Its derivation is the §2 table: the
binding rule (recorded actual vs. calendar back-off), and for the back-off case the
`early_finish` and duration it was computed from.

`scheduled_finish` is deliberately **not** added — it is identically `early_finish`, and a
second name for one quantity in an explanation allow-list would invite an agent to ask the
same question twice and report two answers.

**This grows a public enum on the `trueppm-scheduler` PyPI package**, so it takes a minor
version bump with a changelog note, exactly as ADR-0132 did.

### 6. `actual_start` floors `early_start` (#2621) is a hard prerequisite

Without it, an in-progress task's remaining window can begin before its `actual_start`, and
`scheduled_start = actual_start` would then produce a span whose start is *after* the
remaining window's start — an incoherent bar. **#2621 must land before, or in the same MR
as, the `scheduled_start` field.**

### 7. The one-time date shift is announced, not fanned out as user activity

Arming the floor (§4) moves dates once, at the first recalculation after the change ships,
on every project that carries progress and no explicit `status_date`. ADR-0091 broadcasts
CPM date deltas per task, and the activity feed renders them as ordinary movement — #2621
records the existing shape, `4 tasks moved · finish −3d`. Left alone, an engine correction
would reach every PM as *"someone moved my schedule,"* attributed to no one, on a project
they did not touch.

The first recalculation that arms the floor therefore **does not** emit per-task movement
activity. It is not a user action and must not be recorded as one. The disclosure channel is
the release changelog, in user terms ("in-progress work is now scheduled from the data date;
projects with progress will see dates shift once on upgrade") — not a per-task feed entry
that implies an actor.

Implementation is a one-shot suppression on the arming recalculation, not a permanent
carve-out: subsequent data-date-driven movement is genuine schedule movement and stays in
the feed.

### 8. The public share-link Gantt gets the span, and that widens what it discloses

`_public_schedule_task` (`projects/share_services.py:205-236`) is an explicit allow-list —
"excluded by omission" — and it emits `early_start`/`early_finish` but **not**
`actual_start`/`actual_finish`. Read-only share links are a 0.4 headline surface, so this
ADR cannot leave it undecided, and both directions have a cost:

- **Omit `scheduled_start`** and the public Gantt keeps drawing the remaining-work window
  as the bar. The one surface a beta evaluator is most likely to be shown would retain
  exactly the defect this ADR exists to fix, with progress shrinking bars in a demo.
- **Include it** and, for an in-progress task, `scheduled_start` **is** `actual_start` (§2).
  A field the projection deliberately withholds becomes readable under a different name by
  anyone holding the share URL.

**Decision: include it, and record the widening rather than let it happen by rename.**
The projection already discloses `percent_complete` and `planned_start`; when work actually
began is the same class of delivery-status fact, and it is what the surface exists to
communicate. `_public_schedule_task`'s docstring is updated so its omission list stays
honest — the failure mode being guarded against is a future reader trusting a docstring that
silently stopped being true.

**Rejected: emit a back-off-derived span publicly** (ignoring `actual_start`) to avoid the
disclosure. It keeps the field list unchanged but makes the public bar differ from the
in-app bar for any task whose work has dragged — a share link that draws a different
schedule than the product is a worse problem than the one it solves, on the surface where
trust matters most.

**This is the one decision in this ADR that widens a public, unauthenticated surface.** It
should be confirmed explicitly rather than accepted as a consequence of the bar change; if
it is not wanted, the fallback is a third share-link toggle beside `show_assignees` /
`show_milestone_dates`, at the cost of another configuration knob in a beta.

### 9. Presentation

**Gantt bar = the span.** Feed `GanttRenderer` `scheduled_start`/`scheduled_finish`. The
existing `drawProgressOverlay` then means what it looks like, and the double-application in
the Context section disappears — a one-line change at the data boundary, not a renderer
rewrite. The bar keeps its planned length and the fill advances, which is the convention
every user arrives with from MS Project.

**Grid Start / Finish = the span**, matching what the bar draws on the same row. `Dur` keeps
`duration`. The three columns then describe one quantity and reconcile by inspection.

**Drawer**: the vitals strip's Start/Finish show the span. Remaining work is a **qualifier on
Duration**, not a fifth cell — `4d` with a `1d left` chip, reusing the rule-276 qualifier
treatment (`TaskScheduleStrip.tsx:300`) rather than inventing a new one. Two reasons this is
a qualifier and not a cell: web-rule 284 (a value renders once per surface, and the strip is
the read surface), and the remaining window is a *property of* the duration, so subordinating
it to the Duration cell is what it is.

The chip is `aria-hidden` with an sr-only long form, per rule 276's precedent, and carries a
shared `Tooltip` (rule 287) — `1d left` is shorthand, and shorthand does not ship with a bare
`title`.

**Not in scope:** a status-date progress line drawn against the fill boundary (the classic
"progress line" variance cue). It is a genuinely good idea and it is a separate feature; file
it rather than growing this one.

### 10. Security posture (threat model summary)

STRIDE was run over the three boundaries this change crosses. Only one finding altered the
design (§8); the rest are recorded so they are not re-derived.

| Boundary | Finding |
|---|---|
| Internet ↔ API, **unauthenticated** share link | **Information disclosure — §8.** `scheduled_start` makes `actual_start` readable on a surface that withholds it. Decided in §8, not accepted silently. |
| Internet ↔ API, authenticated | No change. `scheduled_start` is read-only CPM output on serializers the caller already reads; no new role, scope, or object-access path. **Elevation: none.** |
| API ↔ Redis pub/sub (ADR-0091) | The per-task CPM date delta already fans out `early_start`; adding `scheduled_start` reaches the same project subscribers. **No new field-leak** — but the §7 suppression must be implemented in the broadcast path, not only in the feed renderer, or the entries reappear on a different surface. |
| Sync delta (ADR-0686) | **Tampering: none new.** CPM outputs are server-written and read-only; a client cannot push `scheduled_start`, so last-writer-wins on `server_version` gains no surface. |
| MCP derivation | The quantity allow-list sits inside an endpoint already behind the ADR-0678 opt-out cascade, so the new member inherits the gate. **Verify at implementation** that the derivation view filters through the opt-out hook rather than a hand-built queryset — that bypass has shipped before and it fails *open* (#2494). |

**Repudiation — not a regression.** §7 suppresses feed entries for the arming
recalculation. CPM date fields are already in `_HISTORY_EXCLUDED_TASK`, so task history
never recorded these changes; the feed entry was never the audit record and none is lost.

**Denial of service:** one nullable date column and one enum member. No unbounded growth,
no new query shape — utilization's window filter moves from one indexed date pair to
another.

**SOC 2 mapping:** §8 is CC6.1 (logical access — an explicit, recorded decision on what an
unauthenticated principal may read). The sync and broadcast rows above are CC6.7 (restricting
transmission to authorized parties). §7's changelog disclosure is CC7.2 (change
communication), *not* an audit control.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Two named fields (chosen)** | Every field has one meaning in every state; no consumer branches; span is queryable for utilization | One new column + migration; both engines must emit it |
| `schedule_window_type` discriminator | No new column | Keeps `early_*` polysemic with a warning label; every consumer branches; a list mixes both meanings; the client still cannot compute the span (no calendar) |
| Bar keeps shrinking, add a visible label | No engine or API change | Fights the convention users arrive with; the double-applied fill remains; a label cannot make a shrinking bar read as progress; leaves the API and utilization defects untouched |
| Two bars (ghost span + solid remaining) | Shows both quantities at once | Doubles row ink on the densest surface in the product; ADR-0280 already spends the border channel on risk; does nothing for the API or utilization |
| Derive the span at read time in the serializer | No migration | Utilization's window filter is a DB query (`utilization.py:158-160`) and cannot filter on a Python-computed value; the calendar back-off is not expressible in SQL |
| Revert ADR-0132's remaining-duration rule | Removes the ambiguity at the source | Throws away correct in-flight forecasting — the successor of an 83%-done task really is released in one day. The defect is the *naming*, not the math |

## Consequences

**Easier:**

- A bar that shrinks now means the estimate shrank; a bar that fills means work advanced.
  Those stop being the same picture.
- The API stops requiring a consumer to know a task's status to know what its date fields
  mean. MCP clients relay a span that is a span.
- #2623 becomes mechanical: point utilization at `scheduled_start`/`scheduled_finish` and
  reporting progress stops deleting allocated load.
- The `duration` / `Start` / `Finish` trio reconciles by inspection on every surface, which
  is the acceptance criterion #2622 actually asks for.

**Harder / risks:**

- **Core-IP change to both engines.** `scheduled_start` must be emitted by Python and Rust
  identically. `wasm:conformance` compares the engines to each other, so — exactly as
  #2621 documents — it **cannot** catch a shared divergence from this ADR. New fixtures must
  assert `scheduled_start` against the table in §2, in each engine's own suite.
- **Three start-ish fields on `Task`** (`planned_start` = SNET constraint / PM input,
  `early_start` = remaining-work start / CPM output, `scheduled_start` = span start / CPM
  output). Naming risk is real; the field help and `docs/api/` must carry the distinction
  explicitly, and the alternative names considered (`span_start`, `work_start`) are recorded
  here because this is the decision most likely to be re-litigated.
- **Arming the data-date floor moves dates** on any project that carries progress and no
  explicit `status_date` — which is most of them. Dates will move once, at the first recalc
  after the change ships. This needs a changelog entry that says so in user terms, not a
  silent correction.
- Span > duration will look like a bug to someone. It is not, and `docs/features/` has to
  say why before a user files it.

**Edge cases (specify tests for each):**

- In progress, `actual_start` set, span longer than `duration` → span is
  `actual_start..early_finish`, not clamped.
- In progress, no `actual_start` → calendar-aware back-off; span length equals `duration` in
  working days, skipping non-working days.
- In progress at 100% with status still `IN_PROGRESS` → remaining factor 0; span must still
  have its full duration, not collapse (this is the ADR-0136 failure re-run on the new field).
- Milestone (`duration = 0`) → `scheduled_start == scheduled_finish == early_start`.
- Complete → `scheduled_*` equals `early_*` (ADR-0136 already pins full duration).
- No progress anywhere in the project → every `scheduled_*` equals its `early_*`, byte for
  byte. This is the regression fixture that proves the change is inert for planning-only
  projects.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** `scheduler` (minor version bump — `Quantity` grows a member),
  `wasm-scheduler`, `api`, `web`, `mcp` (derivation quantity enumeration). `mobile` reads the
  sync payload and inherits the field; no mobile UI work in scope.
- **Migration required:** **yes** — one nullable `DateField` `Task.scheduled_start`,
  additive, no data migration (the next recalculation populates it). Also add it to
  `_HISTORY_EXCLUDED_TASK` (`projects/models.py:194-204` — it is CPM output, not a
  user-meaningful audit fact, and tracking it would name it on every recalc in the ADR-0217
  merge header) and to the sync task serializer
  (`apps/sync/serializers.py:157`, beside `early_start`).
- **API changes:** **yes** — `TaskSerializer` gains `scheduled_start`, `scheduled_finish`
  (mirror of `early_finish`), `remaining_duration` (computed), all read-only. The schedule
  payload echoes the resolved `status_date`. `docs/api/openapi.json` regenerates;
  `docs/api/` and `packages/web/src/api/types.ts` are **hand-maintained** (#2609) and must be
  updated by hand.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`).

### Sequencing

1. **#2621** — `actual_start` floors `early_start` in both engines. Hard prerequisite (§6).
2. **This ADR's engine half** — `scheduled_start` in both engines, `Quantity.SCHEDULED_START`
   and its derivation, conformance fixtures written against §2's table, minor version bump on
   `trueppm-scheduler`.
3. **API half** — model field, migration, serializer, sync payload, resolved `status_date`
   echo, `_CPM_DERIVATION_QUANTITIES`, the public share projection and its docstring (§8),
   one-shot activity suppression on the arming recalculation (§7), OpenAPI regenerate.
4. **Web half** — bar geometry, grid columns, drawer qualifier chip, public share renderer.
5. **MCP half** — `get_schedule_derivation`'s documented quantity enumeration.
6. **#2623** — utilization reads the span. Mechanical once 3 lands.
7. **#2638** — Monte Carlo data-date provenance. Independent; shares the §4 convention.

### Durable Execution

1. **Broker-down behaviour:** N/A — this ADR adds no new async work. `scheduled_start` is
   written by the existing CPM Celery task in the same `bulk_update` that already writes
   `early_start`. Dispatch continues to route through
   `scheduling/services.py::enqueue_recalculate` (the transactional outbox), never a bare
   `.delay()`.
2. **Drain task:** Reuses the existing schedule-request drain. No new category of async
   work — only a new *output column* on the existing CPM job.
3. **Orphan window:** N/A — no new outbox rows; the existing 10-minute schedule-request
   threshold applies unchanged.
4. **Service layer:** Existing. The `status_date` resolution of §4 lands in the shared
   `build_sched_project()` (ADR-0132 §4) so the CPM and Monte Carlo paths cannot drift on it
   again — that builder exists precisely to make this class of divergence impossible, and
   §4's defect is that the resolution was done *outside* it.
5. **API response on best-effort dispatch:** N/A — no new dispatch path. A recalculation
   triggered by a task edit returns as it does today.
6. **Outbox cleanup:** N/A — no new outbox rows; the existing purge schedule covers schedule
   requests.
7. **Idempotency:** Unchanged. CPM recalculation is idempotent on `project_id`, and
   `scheduled_start` is a pure function of `(task state, calendar, network, resolved
   status_date)`. Running twice against the same inputs yields the same column value. Note
   that "the same inputs" now includes the resolved data date, so two runs on different days
   legitimately differ — which is what the echoed `status_date` exists to disclose.
8. **Dead-letter / failure handling:** Unchanged — existing schedule-request retry and
   dead-letter handling. `scheduled_start` introduces no new failure mode: the back-off
   reuses `_start_from_finish`, whose calendar-scan-bound failure (#908) is already surfaced
   as `InvalidScheduleInput` → 400, never a 500.
