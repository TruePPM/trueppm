# ADR-0954: Forecast staleness is server-declared, from the sync sequence

## Status

Accepted (2026-08-30)

Implemented by #3140. Amends **ADR-0175** (adds a field to `MonteCarloRun`), extends
**ADR-0698 §2**'s derive-per-response contract with a second derived family, and
**inverts** a documented prior decision — #2912's deliberate exclusion of
`monte-carlo-latest` from the WebSocket invalidation set, and its prose in
`packages/web/CLAUDE.md` rule 331(d).

## Context

A forecast is a statement about a plan at a moment. The plan moves; the forecast does
not. Every surface that renders one therefore has to answer *"is this still about the
plan I am looking at?"* — and until now each surface answered it for itself.

The Schedule view's forecast bar answered it with a `useState(0)` counter in
`ScheduleView`, incremented from exactly one path: `useScheduleCommit`'s drag/resize
commit. That made the answer a fact about **one component instance's lifetime** rather
than about the data. It missed inline cell edits, add/delete row, dependency changes,
paste-many, bulk edit, three-point estimate edits (the actual Monte Carlo inputs), and
every collaborator write arriving over the WebSocket — and it reset to zero on every
reload and route re-entry.

While the counter drove only a *notice*, this was a cosmetic defect: the stamp lied, but
the user still had the action. #3132 then gated the **Rerun button itself** on the same
predicate, for a good reason (a recompute button parked on every forecast row is a debug
affordance on a user surface). That promoted the defect to a **reachability** one: the
state a user most needs the button in — a plan edited before the page was opened — is
precisely the state the counter reports as "nothing to do".

Two independent gates on the #3132 branch, `regression-check` and `ux-review`, raised it.

The adjacent server fact, `risk_premium_state`, already has a `stale` value, but it is
age-based (`STALE_AFTER_DAYS = 7`). It covers "came back a week later" and not "edited an
estimate two minutes ago" — part of an answer, not the whole one.

## Decision

**The classification is server-computed and ships on the Monte Carlo payload.** Per
ADR-0599, the authoritative classification of a server-computed outcome is itself
server-computed; no client re-derives it.

### 1. Reuse `Project.last_sync_version` — do not invent a counter

`Project.last_sync_version` (ADR-0686 / #2491) is the per-project monotonic sequence every
synced row write draws its `sync_seq` from. It is atomic, monotonic, and authoritative
rather than a derived cache. It is exactly the "cheap per-project mutation counter" that a
comment in `risk_premium.py` said did not exist — that comment predates ADR-0686, and its
pointer to "#2483 open question 2" was misnumbered besides. Both are corrected.

Three properties make it the right counter:

* **It over-approximates, and that is the safe direction.** It advances on *any* synced
  write in the project, so a description edit moves it without moving a date. The forecast
  can read stale when it is not; it can never read fresh when it is not. Since the defect
  is an unreachable action, false-stale costs a button nobody needed and false-fresh costs
  the action entirely.
* **A CPM recompute does not bump it** (`bulk_update`, ADR-0091, allocates nothing), so a
  recalc cannot manufacture staleness on a plan nobody touched.
* **A Monte Carlo run does not bump it** (`MonteCarloRun` is outside the sync union), so a
  run cannot make itself stale.

### 2. A second term, because the second property is also the one hole

A run's `cpm_finish` is read from *persisted CPM output*. A recalc rewrites that output
without touching the counter. So: an edit bumps the counter to N+1 and queues a recalc; the
user reruns before the recalc lands, recording `plan_version = N+1` against pre-recalc
dates; the recalc lands and moves every `early_finish`. N+1 == N+1 reads `current` while
the run's `cpm_finish` — and its whole risk-premium family — describe a schedule that no
longer exists. The window is not exotic: Rerun sits beside the drag that queues the recalc.

`Project.recalculated_at` (ADR-0114) closes it at zero query cost. This hole was found by
the `architect` gate and is the reason the discriminant is two terms rather than one.

### 3. One new field: `MonteCarloRun.plan_version`

`BigIntegerField(null=True, blank=True)`, nullable with **no backfill** — the same
discipline `distribution` (#1231), `diagnostic` (#2483) and `status_date` (#2638) already
follow on this model.

It is captured **before** the committed task set is loaded, and the ordering is a
correctness property: a write landing mid-simulation then leaves the run behind the
project's value and it reads stale. Capturing it afterwards would claim the run covered a
write it never saw.

`plan_version` rides **both** the `mc_latest` cache entry and the persisted row. This
breaks the ADR-0698 §2 pattern deliberately: it is a run-time *observation*, not a
derivation, and it cannot be recovered later from the project or the clock. Carrying it on
the cache entry is not redundancy — a run triggered by a **Member** refreshes the cache but
persists no attributed row (#1502), so for those runs the cache entry is the only place it
exists. Only `plan_version_current` and the classification are derived per response.

### 4. Four values, and `current` is unreachable without evidence

`current` · `project_changed` · `aged` · `unknown`, decided in that priority order (a
priority, not a partition — a run can satisfy several and reports the strongest).

The missing-input branch is decided **first**. Every run in every install is version-less
on the day this ships, so a decision order that let a young version-less run fall through
to `current` would hide Rerun across the entire fleet — the defect reintroduced by its own
fix. Within that branch the age rule still runs, because a version-less run past the
threshold is provably `aged`, which is strictly more useful than `unknown`.

`unknown` is deliberately distinct from `current`: "we cannot tell" is not "it is fine",
and conflating them is how the original defect read.

### 5. `project_changed`, not `plan_changed` — the name is the contract

The counter advances on any write in the project. `plan_changed` would be an assertion the
evidence does not reach, and the value goes to LLM and MCP callers that will narrate it as
fact with nothing in the payload to check it against.

**The contract, binding on every consumer: `project_changed` gates the *action* and may
never be narrated as "your plan changed".** Only `plan_version`, `plan_version_current` and
`last_run_at` support a claim. The web bar implements this by splitting the two: it offers
Rerun, and says only *"Edited since this run"*.

This matters more than it looks, because on a project with time tracking in use
`project_changed` is close to a steady state — `TimeEntry`, `Label`, `Risk`,
`ProjectMembership` and others all allocate. A permanently-on notice that overstates its
evidence would be ignored, which is the original defect reached from the other side.

### 6. Composes with `risk_premium_state`; does not supersede it

`risk_premium_state` answers a different question (is the added-time *number* still worth
reporting) and its `stale` occupies the same enum slot as `premium`/`zero`/`negative`, so
folding plan drift into it would cost the Overview card its premium classification. The new
module **imports** `STALE_AFTER_DAYS` so the two can never disagree about the age term, and
`risk_premium_state` is otherwise untouched.

### 7. Surfaces that carry it

`POST /monte-carlo/`, `GET /monte-carlo/latest/` (all three branches), the ADR-0218
derivation endpoint, and `GET /projects/<pk>/overview/`. The last two are not scope creep:
leaving them out means `get_project` reports a forecast as sound at the same moment
`get_monte_carlo_forecast` reports the same run as stale. Two tools, one run, opposite
trustworthiness is worse than either answer alone. Both read already-loaded data.

### 8. The client's refresh trigger enumerates nothing

`monte-carlo-latest` joins `OVERVIEW_KEYS` in `useProjectWebSocket`, so the same events
that already invalidate tasks and dependencies — own edits and collaborators' alike —
refresh the verdict. **This inverts #2912**, which excluded the key on the grounds that
"invalidating it on a task edit would re-fetch the identical row". True then; false now.
The other half of #2912's note stands: propagating a *collaborator's completed simulation*
still needs a server-side event that does not exist.

A WS-gated 30 s `refetchInterval` (the same shape `useScheduleTasks` uses) covers a dead
socket, so the fix is not transport-dependent. It sits on the **hook**, so it applies to
every `useMonteCarloResult` consumer — the Overview card, the shell health cluster, the
mobile card — not only the bar. That is deliberate: the reason a stale verdict matters is
that a surface renders a forecast the reader will act on, which is true of all of them, and
scoping the interval per-consumer would recreate exactly the per-site enumeration this ADR
removes. It only ever runs while the socket is down, and pauses on a hidden tab.

## Consequences

* The predicate survives a reload, a route re-entry, and a collaborator's write. The
  issue's falsification line — open the bar in the state that should show Rerun, then
  reload — is pinned as a Playwright test.
* `mcMutationVersion`, the `mutationVersion` prop, and `useScheduleCommit`'s now-unused
  `onCommitSuccess` option are deleted rather than left as a shipped callback nothing reads.
* **`plan_version` is NOT added to `MonteCarloRunSerializer`.** `ai-review` asked for it (it
  would let an agent segment drift by plan version); `threat-model` argued against it, and
  that argument wins: the history serializer gates `triggered_by_name` to Admin/Owner
  precisely so forecast drift cannot become a named-individual signal (ADR-0175 / VoC
  Morgan), and `plan_version` beside each run's `taken_at` is a per-interval write-volume
  timeline — joinable to named individuals in the admin view. Recorded here because it is a
  decision, not an omission.
* **Publishing `plan_version_current` is not new disclosure.** `Project.last_sync_version`
  is already returned verbatim to the same Viewer+ audience as the `timestamp` cursor of
  every sync pull. The model's own comment ("excluded from the sync serializer") is true of
  the row serializer and easy to misread as "never leaves the server". The residual
  information-flow property — the counter advances on writes whose *content* the caller
  cannot see — is pre-existing at identical granularity via that cursor.
* **Do not extend this pattern to programs.** `ProgramSyncSequence` (ADR-0747) is
  installation-wide; exposing it would be a genuine cross-tenant write-volume oracle rather
  than a per-project one.
* This module is now a **consumer of the sync allocator's monotonicity invariant**, whose
  writer-side precondition is tracked in #2617. A future change to the allocator changes
  what "stale" means here — a coupling invisible from either file alone, and the strongest
  single reason this is an ADR.
* **The `unknown` tail is permanent in Enterprise.** The nullable-no-backfill precedent
  rests on "legacy runs age out under the retention cap", but Enterprise overrides
  `MC_HISTORY_CAP` to unlimited (ADR-0175), so nothing ages out. Harmless for clients
  (`unknown` fails toward offering the action), but an Enterprise drift digest reading
  deep history will see it indefinitely.
* **`unknown` currently conflates "never run" with "run, but unplaceable".** Unreachable in
  OSS — `/latest/` 404s when no run exists — so it is live only for an importer or an
  Enterprise consumer calling `forecast_staleness_from_run(None, …)`. If one is built,
  split the value before it does.
* **Known residual: an inherited-calendar FK repoint is covered by neither term.** The
  simulation reads the *effective* calendar, which a project can inherit from its workspace
  or program. `Workspace` is not a `VersionedModel` and `Program` allocates from its own
  sequence, so repointing that FK moves a simulation input without moving the project's
  `last_sync_version`; and if the repoint does not enqueue a recalc, `recalculated_at` does
  not move either. Editing a calendar's *contents* or its exceptions is covered — that path
  runs `_recalc_projects_for_calendar`, which resolves inheriting projects and stamps
  `recalculated_at`. The exposure is narrow and the action is never fully unreachable (the
  project Overview's **Rerun forecast** is permanent by design), but this *is* the same
  capability-stranding class the ADR exists to remove, so it is recorded rather than
  implied. The cheapest fix is to have the workspace/program calendar-assignment handlers
  enqueue the same `CALENDAR_CHANGE` recalc `CalendarViewSet.perform_update` already does,
  which puts the path under term 2. `ProjectCalendarLayer` has the same shape and is
  latent only because its `bulk_create` handler incidentally re-saves `project.calendar`.
  Found by `rbac-check`; file separately.

## Alternatives considered

**Widen the client-side bump** so every mutating path in `ScheduleView` marks the forecast
stale. Cheaper, and rejected: it is still session-scoped, so it does not survive a reload —
the issue's own falsification line still fails — and it requires enumerating mutation
sites, which is the fragility that produced the defect.

**Fold plan drift into `risk_premium_state`.** Rejected: it would destroy the Overview
card's premium classification (§6).

**A new plan-relevance counter on `Project`**, advanced only by schedule-bearing writes.
It would remove the `project_changed` over-approximation entirely. Rejected for now: a new
model field plus receivers, against a reuse that is already correct in the safe direction.
If the notice proves too noisy in practice, this is the upgrade path.

**Compare `MAX(Task.edited_at)` at read time** instead of the sync counter. More precise
(`edited_at` is stamped only on a human write, never on a recalc), and rejected as the
primary term because it costs an aggregate query on a hot read where the counter costs
nothing. It remains the obvious corroborating fact if a consumer ever needs to support the
stronger claim §5 forbids.

## Related

* **#3140** — the issue; **#3132** — the gate that promoted this from notice to
  reachability defect.
* **#2798** (OSS, 0.5) proposes the same mechanism from the risk-premium side and cites the
  same stale comment. This ADR delivers the discriminant; #2798's residual is that
  `/overview/`'s `risk_premium_band` is still age-only. Cross-link before closing either.
* **`trueppm-enterprise#192`** (scheduled recompute + org drift digest) names three OSS
  deliverables: the counter, the stale state, and a `forecast_recompute_requested` signal.
  This ADR supplies the first two. **The signal does not exist in the OSS tree**, so EE#192
  registers against a hook nobody built; that gap belongs on #2798, not here — a
  speculative extension signal with no dispatcher is dead surface.
* `apps/scheduling/forecast_staleness.py` is kept pure and value-shaped (not request- or
  response-bound) specifically so an Enterprise digest can import the OSS fact rather than
  re-derive its own beside it.
* **Pre-existing defect found in passing, not fixed here:** `IsProjectNotArchived` is a
  no-op on `POST /projects/<pk>/monte-carlo/`. The route spells the project as `pk` and the
  view is function-based, so `has_object_permission` is never called and the in-body check
  covers membership only — a Monte Carlo run on an archived project succeeds. File
  separately.
