---
title: Known Issues
description: The maintained list of defects and limitations in what 0.4 will ship — each one naming its tracking issue and the release that fixes it.
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

### The risk register does not affect the forecast — planned for 0.5

The risk register and Monte Carlo are separate systems that do not exchange
information. A risk's severity is the product of two 1–5 ordinals; a simulated
finish date is computed from three-point estimates and team velocity. Nothing
connects them.

The register's `probability × impact` score therefore says nothing about the
schedule. A high-severity risk sitting on a task with weeks of total float moves
the finish date not at all, while a low-severity risk on the critical path may be
the single largest driver of the P80 — and the register ranks them the other way
around. Linking a risk to a task (which the register supports) records the
relationship for a human to read; it does not reach the engine.

- **Impact:** P80 does not reflect known risks. The register cannot answer "what
  would mitigating this buy me?", so mitigation work completes without the forecast
  moving.
- **Workaround:** widen the pessimistic value of the three-point estimate on the
  affected task. This is a genuine workaround with genuine costs, and it is worth
  knowing what they are: a 40%-likely 10-day event is not a wider spread but a
  second peak, and PERT-Beta cannot represent one — it spreads probability across a
  gap the real distribution does not have. The padding is also unattributable
  (nothing records which risk it was for, so it is never removed when the risk
  closes) and uncorrelated (one risk affecting five tasks becomes five independent
  spreads, which understates the tail rather than overstating it).
- **Fix planned for 0.5** — [#2556](https://gitlab.com/trueppm/trueppm/-/issues/2556)
  makes risks first-class simulation inputs, with one shared draw per risk per
  iteration across every task it touches. See
  [ADR-0711](/architecture/decisions/).
- **Cost impact is a separate axis and lands later.** ADR-0711 treats schedule and
  cost as the two axes a simulation can answer. Only schedule is in scope for 0.5:
  TruePPM has no cost data model yet, and resource costs are a 1.0 item
  ([#2557](https://gitlab.com/trueppm/trueppm/-/issues/2557)). Risk impact on scope,
  quality, safety, and compliance is recorded but deliberately never simulated or
  folded into a combined score.

### Velocity-driven P80/P95 is a lower bound — planned for 0.6

For sprint-delivered work sampled from team velocity, each run's sprint horizon is
clamped. Runs that have not burned down by that horizon are clamped to it rather
than sampled further, which truncates the slow right tail.

The weekly-throughput sampler used by a continuous-flow board clamps its horizon the
same way, so the same caveat applies to the throughput forecast.

- **Impact:** for a team with high throughput variance, the agile P80/P95 is
  optimistic — a loose lower bound rather than an unbiased estimate. The bias runs in
  the unhelpful direction.
- **Workaround:** treat a velocity-driven P95 as a floor. Three-point (PERT) estimates
  are not affected.
- **Surfaced in the product:** every affected number carries a "a floor, not a
  percentile" qualifier and a help icon explaining the clamp — on the backlog
  forecast, the sprint release-horizon chips, and the board's flow analytics card.
  See [Interpreting results](/features/monte-carlo/#velocity-and-throughput-forecasts-are-a-floor).
- **Fix planned for 0.6** — [#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469).

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

## Test and quality gates

### Mutation testing does not cover the engine core — planned for 0.5

Mutation testing proves the suite's assertions catch regressions rather than merely
executing lines. Its scope is `models.py`, `derive.py`, and `cli.py`. **`engine.py`
— the CPM and Monte Carlo core — is out of scope.** The score floor within that
scope does gate: `MUTATION_MIN` is 0.92 against an observed 93.0–93.1%, and a
nightly below it reds.

- **Impact:** the strongest available evidence of assertion strength deliberately
  excludes the code that matters most. Where the roadmap describes "mutation testing
  on the scheduler", read it as covering the models/serialization layer, not the
  engine.
- **Fix planned for 0.5** — [#2468](https://gitlab.com/trueppm/trueppm/-/issues/2468).

## Accessibility

### A foothold, not full WCAG 2.1 AA conformance

The CI pipeline enforces an axe-core WCAG 2.1 A/AA scan inside the Playwright E2E suite,
and a **critical** or **serious** violation fails the pipeline — that gate runs today, on
every merge, not just in a future release. The 0.4 remediation pass — focus traps across
roughly seventy dialogs, drawers, and popovers, 44px touch targets on the board and
schedule surfaces, contrast fixes in both light and dark themes, live-region
announcements for route changes and async writes, and keyboard operability on the Gantt,
board, and outline — is already merged to `main` and lands with the 0.4 beta. The axe
gate itself is [#1685](https://gitlab.com/trueppm/trueppm/-/issues/1685) and
[#2202](https://gitlab.com/trueppm/trueppm/-/issues/2202); the remediation ran across the
release rather than under one tracking issue.

What that gate does **not** prove:

- **`moderate` axe findings do not block a merge.** They are being ratcheted in route by
  route as each surface's audit lands, so the enforced floor is narrower than the stated
  commitment.
- **There has been no formal, end-to-end WCAG 2.1 AA audit of the product.** The gate
  above is automated and partial; a professional audit — including manual screen-reader
  and keyboard-only passes — has not been run.

- **Impact:** an evaluator doing PMO due diligence on accessibility will not find a
  conformance statement anywhere in the product docs before this page, because there
  isn't one to give yet. Treat 0.4 as "actively improving, automated-gate-enforced, and
  not yet audited" — not as "WCAG 2.1 AA compliant."
- **Fix planned for 0.9** — the formal audit is a GA-hardening item on the
  [roadmap](/overview/roadmap/).

## Performance and scale

The measured ceilings themselves are covered on
[What TruePPM Doesn't Do Yet](/overview/what-it-does-not-do/#scale--a-measured-ceiling-and-an-unflattering-one)
and in the [sizing guide](/administration/sizing/#tested-envelope). These are the
specific defects behind them.

| Issue | Symptom | Fix planned for |
|---|---|---|
| [#3119](https://gitlab.com/trueppm/trueppm/-/issues/3119) | The Schedule view loads the whole project before it draws anything, which is what sets the ~1 000-task comfort ceiling | 0.5 |
| [#2340](https://gitlab.com/trueppm/trueppm/-/issues/2340) | The Kanban board renders every card as a DOM node with no virtualization | 0.5 |
| [#2341](https://gitlab.com/trueppm/trueppm/-/issues/2341) | A remote `task_updated` event triggers a full multi-page task-list refetch instead of splicing the changed row | 0.5 |
| [#2346](https://gitlab.com/trueppm/trueppm/-/issues/2346) | `TaskRelationViewSet` is unpaginated and returns every relation across all member projects | 0.5 |

## Findability and filtering

Filtering matured on the Board first and will reach the other views unevenly. Label
filtering lands on the Table/Grid and the Product Backlog with 0.4; the Schedule will
not get it, and today no view except the Board can save a filter by name.

| Issue | Symptom | Fix planned for |
|---|---|---|
| [#2443](https://gitlab.com/trueppm/trueppm/-/issues/2443) | The Schedule is the only task view with no label filter — the Board, Table/Grid, and Product Backlog all get one with 0.4, the Gantt does not | 0.5 |
| [#2444](https://gitlab.com/trueppm/trueppm/-/issues/2444) | The Schedule has no text search and no owner/status filter — you cannot find a task on the Gantt | 0.5 |
| [#2445](https://gitlab.com/trueppm/trueppm/-/issues/2445) | Saved views are Board-only; Grid, Schedule, Backlog and My Work cannot save a named filter | 0.5 |
| [#2443](https://gitlab.com/trueppm/trueppm/-/issues/2443) | Filter state does not survive a view switch, and the vocabulary differs per view | 0.5 |
| [#2446](https://gitlab.com/trueppm/trueppm/-/issues/2446) | My Work has no project filter, so a PM running several projects gets one undifferentiated list | 0.5 |

## Schedule editing and export

The Schedule is the surface an evaluator reaches first. These are open against the 0.4
milestone at the time of writing: each is either fixed before the tag comes off, or it
moves to 0.5. The issue is the authority on which happened, not this page.

### Drag-to-link between tasks is hard to discover

Dragging from one task bar to another to create a dependency works, but its only
rest-state cue is an invisible 8–12px hotspot at the bar's right edge plus a cursor
change. The one text hint lives in the Schedule legend, which is collapsed by default
and hidden entirely below 1024px.

- **Impact:** an evaluator who has not been told the interaction exists is unlikely to
  find it, and may conclude dependencies can only be created from the task drawer.
- **Workaround:** create dependencies from the task drawer's **Dependencies** tab, or
  right-click a row and use the predecessor/successor picker — both are fully
  supported paths, not fallbacks.
- **Tracked on** [#2702](https://gitlab.com/trueppm/trueppm/-/issues/2702).

### The PDF export is only in the overflow menu, and disappears on a narrow screen

The client-ready PDF's single entry point is the **Project actions** (···) overflow
menu on the Schedule, which is hidden below the `md` breakpoint.

- **Impact:** a weekly steering-pack export is three interactions deep, and on a
  narrow window or a tablet there is no path to it at all.
- **Workaround:** widen the window to at least the `md` breakpoint and use **Project
  actions → Export schedule as PDF…**. The export itself is unaffected — this is the
  route to it, not the artifact.
- **Tracked on** [#2703](https://gitlab.com/trueppm/trueppm/-/issues/2703).

## Baselines

### Baseline comparison is a table, not a Gantt overlay — planned for 0.5

0.4 brings baseline capture, management, and comparison into the app, but the
comparison is a text table in the task drawer. The planned-vs-current **ghost-bar
overlay on the Gantt is deliberately not in this release** —
[ADR-0376](/architecture/decisions/) defers it to 0.5 in its own Consequences section.

- **Impact:** you can see that a task slipped and by how much, but you cannot see the
  slip drawn against the plan on the timeline, which is the reading most people expect
  from the word "baseline".
- **Workaround:** none — use the drawer's comparison table.
- **Fix planned for 0.5.** The Schedule legend still renders a "Planned baseline"
  swatch with no matching draw call behind it; that stray swatch is
  [#2696](https://gitlab.com/trueppm/trueppm/-/issues/2696).

## Time capture

### A submitted week looks locked but can still be edited

Submitting a timesheet week is a **marker**, not a lock —
[ADR-0224](/architecture/decisions/) specifies the 0.4 state machine as "no approver,
no lock, no return", and approval lands with #100 at 0.5. The timesheet grid, however,
renders a submitted week's cells inert and names **Reopen week** as the remedy, which
reads as a formal lock.

**Nothing is being circumvented and this is not a permissions defect** — there is no
lock to bypass. The gap is that the grid claims one, so the two surfaces disagree about
what submission means.

- **Impact:** a submitted week can still be edited from My Work, which the grid implies
  is closed. Someone correcting an entry that way is not doing anything wrong, but they
  will reasonably think they found a hole.
- **Workaround:** treat submission as "marked submitted", not "frozen". If your process
  needs a week to stop changing after submission, that control arrives with timesheet
  approval at 0.5.
- **Tracked on** [#2701](https://gitlab.com/trueppm/trueppm/-/issues/2701) — the fix is
  to the grid's language, deliberately **not** a server-side lock, which would pre-empt
  an accepted design decision.

## MCP and agents

### The team-level agent opt-out exists at project scope only

The instance → workspace → program → project cascade that decides whether agents may
read a scope is real and correctly enforced, and the `mcp_enabled` field is already
writable at all three scopes over the API. The **UI** to set it exists only at
**Project settings → Agents**; there is no Agents section on program or workspace
settings yet.

- **Impact:** an operator following the runbook to "Program settings → Agents" or the
  workspace equivalent finds nothing there.
- **Workaround:** set project-scope opt-outs in the UI; workspace and program scope are
  settable through the API (`PATCH /api/v1/workspace/` or
  `PATCH /api/v1/programs/{id}/`), and the instance-wide kill switch is the
  `TRUEPPM_MCP_ENABLED` environment variable (which is enforced first, ahead of every
  other check).
- **Tracked on** [#2688](https://gitlab.com/trueppm/trueppm/-/issues/2688) (this
  documentation correction) and
  [#2700](https://gitlab.com/trueppm/trueppm/-/issues/2700) (building the workspace-
  and program-scope settings sections).

### A refused agent request does not say why

The API records a structured, two-axis refusal taxonomy — identity vs. policy, with the
specific constraint — on every refused agent action. The MCP client raises an error
built from the HTTP status alone and never reads the response body, so the reason does
not reach the caller.

- **Impact:** an operator whose question is refused sees a bare HTTP error in session.
  For a release whose pitch names *refuse* as one of the four parts of **computed, not
  guessed**, a refusal that will not explain itself is the wrong first impression.
- **Workaround:** the reason is recorded and retrievable — query
  `GET /api/v1/agent-actions/?constraint=…` for the refusal detail after the fact.
- **Tracked on** [#2689](https://gitlab.com/trueppm/trueppm/-/issues/2689). The separate
  provenance-envelope gap is [#2642](https://gitlab.com/trueppm/trueppm/-/issues/2642) —
  the two are deliberately kept apart.

## Data import

### Imported assignees match the whole resource catalog, not project membership — planned for 0.5

When a CSV, Excel, MS Project, or Jira import reads an assignee column, it matches
each value against the **workspace-wide resource catalog by display name**, and
creates a new resource for anything it does not match. It does not check whether that
person is a member of the destination project, and it does not accept a UUID, email,
or username as an identifier.

Two consequences:

- **Name collisions bind to the wrong person.** A cell reading `A. Rivera` attaches to
  whichever resource in the catalog carries that name, even one used only on projects
  you have no access to. Nothing tells you it happened.
- **The catalog grows from cell text.** Every unmatched value becomes a new resource,
  so a column of inconsistent spellings leaves a trail of near-duplicates behind.

**This is not a disclosure vector.** The resource catalog is already readable by any
authenticated user by design, so an import reaches nothing you could not already list;
and an assignment is not project membership, so no permission is granted by one. The
defect is in what gets *written* — mis-attributed work and a polluted catalog — not in
what can be read.

- **Impact:** assignments can land on the wrong person's record, and the resource
  catalog accumulates duplicates that someone has to merge by hand.
- **Workaround:** before importing, check that the names in your assignee column match
  the resources you intend, and review **Resources** afterward for near-duplicates. On
  a first import into a fresh workspace neither problem can arise.
- **Fix planned for 0.5** — [#2485](https://gitlab.com/trueppm/trueppm/-/issues/2485)
  moves resolution onto a membership-scoped index that accepts UUID, email, or
  username, and reports an unmatched value instead of inventing a resource for it.

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
