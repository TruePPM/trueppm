---
title: Known Issues
description: The maintained list of defects and limitations in what 0.4 actually ships — each one naming its tracking issue and the release that fixes it.
---

This page lists **defects and limitations in what TruePPM already ships**. It is the
companion to [What TruePPM Doesn't Do Yet](/overview/what-it-does-not-do/), which
covers capabilities that were never built. The split is worth keeping straight:

- *Doesn't do yet* — resource leveling, cost and earned value, a mobile app. Absent
  by plan.
- *Known issues* (this page) — something that exists but is wrong, incomplete, or
  slower than it should be.

Every entry names the issue tracking it and the release it is fixed in. When an
issue closes, its entry comes off this page.

:::caution[0.4 is a beta]
0.4 is the first release we ask anyone to run a real project on. It is a beta, not a
GA. The [roadmap](/overview/roadmap/) is the authoritative Shipped / Underway /
Planned record; where this page and the roadmap disagree, the roadmap wins.
:::

## Scheduling engine

The deterministic single-project CPM pass is the most mature part of TruePPM and the
part we are most confident in. These are its edges.

### Monte Carlo runs on the request thread — planned for 0.5

A Monte Carlo simulation executes inline in the HTTP request cycle, gated only by a
per-user rate-limit scope. On a large project at a high run count this occupies a
web worker for the duration of the simulation.

- **Impact:** a slow simulation can crowd out other requests on a small deployment.
- **Workaround:** lower the run count; the P50/P80/P95 converge well before the
  default 1 000 runs on most networks.
- **Fix planned for 0.5** — [#2273](https://gitlab.com/trueppm/trueppm/-/issues/2273) moves
  it into Celery.

### Program-scoped Monte Carlo is not exposed — planned for 0.5

The program schedule view computes a **program-true critical path** across member
projects, but only deterministically. There is no program-scoped Monte Carlo
endpoint and no MCP tool for it, so the one scope where a confidence date matters
most is the scope that cannot produce one.

The engine restriction that made this impossible lifts in 0.4
([#1385](https://gitlab.com/trueppm/trueppm/-/issues/1385) — `monte_carlo()` will
honor per-task calendars, see [ADR-0672](/architecture/decisions/)). What remains
after that is the API surface, which is why this entry is separate.

- **Impact:** a program manager gets a deterministic finish date with no band around
  it. Ask for a what-if at program scope over MCP and the tool cannot answer.
- **Workaround:** run Monte Carlo per member project and reason about the
  combination manually — this understates joint risk and is not a substitute.
- **Fix planned for 0.5** — [#2467](https://gitlab.com/trueppm/trueppm/-/issues/2467).

### Velocity-driven P80/P95 is a lower bound — planned for 0.6

For sprint-delivered work sampled from team velocity, each run's sprint horizon is
clamped. Runs that have not burned down by that horizon are clamped to it rather
than sampled further, which truncates the slow right tail.

- **Impact:** for a team with high throughput variance, the agile P80/P95 is
  optimistic — a loose lower bound rather than an unbiased estimate. The bias runs in
  the unhelpful direction.
- **Workaround:** treat a velocity-driven P95 as a floor. Three-point (PERT) estimates
  are not affected.
- **Fix planned for 0.6** — [#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469).

### Open correctness defects

Found by the 2026-07-27 red-team pass and under active fix:

| Issue | Symptom | Fix planned for |
|---|---|---|
| [#2460](https://gitlab.com/trueppm/trueppm/-/issues/2460) | `monte_carlo()` pins a completed task's start one working day back regardless of duration, so its forecast diverges from `schedule()` on the same input | 0.4 |
| [#2462](https://gitlab.com/trueppm/trueppm/-/issues/2462) | A calendar's exception index cache goes stale after a same-length in-place mutation, so `is_working_day` returns the previous answer | 0.4 |

## The second engine (Rust / WASM)

TruePPM ships two coordinated CPM implementations: the Python library
(`trueppm-scheduler`, the authority) and a Rust engine compiled to WebAssembly.
**They are not yet at parity**, and the gap is wider than the architecture diagram
suggests.

### The WASM engine is not wired into the browser — planned for 0.5

The Rust engine ships as a CI-validated conformance reference. The browser's
drag-preview path still uses a TypeScript CPM worker that approximates the calendar
as a fixed Mon–Fri week.

- **Impact:** the sub-100 ms in-browser drag preview is calendar-approximate. The
  authoritative server CPM reconciles exact dates on commit, so a committed schedule
  is always correct — but a preview can differ from what lands.
- **Fix planned for 0.5** — [#1777](https://gitlab.com/trueppm/trueppm/-/issues/1777) wires
  the WASM engine in, or retires the parity claim.

### The Rust engine has no Monte Carlo — not scheduled

The Rust engine implements forward pass, backward pass, floats, and incremental
recompute. It has **no Monte Carlo at all**. Offline and in-browser recompute is
therefore deterministic-only; every probabilistic answer requires the server.

### The Rust engine refuses per-task calendars — planned for 0.4

`validate.rs` rejects a project declaring a non-empty `calendars` registry, so the
Rust engine cannot schedule a program-scoped, multi-calendar project that the Python
engine handles.

- **Fix planned for 0.4** — [#1504](https://gitlab.com/trueppm/trueppm/-/issues/1504).

### Cross-engine conformance fixtures do not cover per-task calendars — planned for 0.4

The conformance suite compares both engines against shared fixtures, and the gate
itself is sound (a missing snapshot hard-fails). The **fixtures** have one real
hole: none exercises per-task calendars, so the semantics the two engines most
recently diverged on are the semantics the suite cannot check. Dependency lag
(including negative leads) and non-standard working-day masks *are* covered.

- **Fix planned for 0.4** — [#1497](https://gitlab.com/trueppm/trueppm/-/issues/1497).

## Test and quality gates

### Mutation testing does not cover the engine core — planned for 0.5

Mutation testing proves the suite's assertions catch regressions rather than merely
executing lines. Its scope is `models.py`, `derive.py`, and `cli.py`. **`engine.py`
— the CPM and Monte Carlo core — is out of scope**, and the score floor is currently
report-only.

- **Impact:** the strongest available evidence of assertion strength deliberately
  excludes the code that matters most. Where the roadmap describes "mutation testing
  on the scheduler", read it as covering the models/serialization layer, not the
  engine.
- **Fix planned for 0.5** — [#2468](https://gitlab.com/trueppm/trueppm/-/issues/2468).

## Performance and scale

The measured ceilings themselves are covered on
[What TruePPM Doesn't Do Yet](/overview/what-it-does-not-do/#scale--a-measured-ceiling-and-an-unflattering-one)
and in the [sizing guide](/administration/sizing/#tested-envelope). These are the
specific defects behind them.

| Issue | Symptom | Fix planned for |
|---|---|---|
| [#2277](https://gitlab.com/trueppm/trueppm/-/issues/2277) | The Schedule view loads the entire project into memory at once, which is what sets the ~1 000-task comfort ceiling | 0.5 |
| [#2340](https://gitlab.com/trueppm/trueppm/-/issues/2340) | The Kanban board renders every card as a DOM node with no virtualization | 0.5 |
| [#2341](https://gitlab.com/trueppm/trueppm/-/issues/2341) | A remote `task_updated` event triggers a full multi-page task-list refetch instead of splicing the changed row | 0.5 |
| [#2346](https://gitlab.com/trueppm/trueppm/-/issues/2346) | `TaskRelationViewSet` is unpaginated and returns every relation across all member projects | 0.5 |

## Findability and filtering

Filtering matured on the Board first and has not yet reached the other views.

| Issue | Symptom | Fix planned for |
|---|---|---|
| [#2444](https://gitlab.com/trueppm/trueppm/-/issues/2444) | The Schedule has no text search and no owner/status filter — you cannot find a task on the Gantt | 0.5 |
| [#2445](https://gitlab.com/trueppm/trueppm/-/issues/2445) | Saved views are Board-only; Grid, Schedule, Backlog and My Work cannot save a named filter | 0.5 |
| [#2443](https://gitlab.com/trueppm/trueppm/-/issues/2443) | Filter state does not survive a view switch, and the vocabulary differs per view | 0.5 |
| [#2446](https://gitlab.com/trueppm/trueppm/-/issues/2446) | My Work has no project filter, so a PM running several projects gets one undifferentiated list | 0.5 |

## Reporting a new one

If you hit something that is not on this page, the user menu and the ⌘K palette both
have a **Report a bug** entry that opens the tracker with your version, edition,
build SHA, and current route already filled in. It is a link, not a beacon — nothing
is transmitted by rendering it, and you can read and edit the context before
submitting.

---

**Maintainers:** every issue linked from this page carries a comment pointing back
here. When you close one, update this page in the same merge request — remove the
entry, or move it to the roadmap as shipped.
