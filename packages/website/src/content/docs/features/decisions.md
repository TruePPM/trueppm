---
title: Decisions
description: A durable, low-friction decision log built on task notes — project- and sprint-scoped, with team-owned visibility.
---

:::note[Ships in 0.3 (Underway)]
Decisions is part of the **0.3 "agile team"** milestone, which is still
underway. This page describes the feature as built; it is not yet in a tagged
build — see the [roadmap](/overview/roadmap/).
:::

Every team makes calls it later has to explain: *why did we drop that story, why did we
choose this approach?* Decisions turns any task note into a durable record of that call,
and collects those records into a project- and sprint-scoped log — so the answer is one
click away at a Sprint Review instead of buried in a chat thread.

## How it works

A **note** is the per-author why/decision log on a task (see [task collaboration](/features/task-collaboration/)).
Marking a note as a **Decision** is a single tap — a chip next to **Pin** on the note row.
Any team member or project manager can flag a note; flagging is curation, not authorship,
so you can mark a teammate's note as a decision too. The flag is the only structured
marker — there is no taxonomy, no required fields, nothing else to fill in.

Flagged decisions roll up into the **Decisions** view under **Reports → Decisions**:

- **All decisions** — every decision across the project, grouped by sprint, with closed
  sprints kept browsable so you can revisit a call made three sprints ago.
- **Current sprint** — the same log scoped to the active sprint, for walking decisions at
  the Sprint Review or Retro.

Each row shows the decision text, who recorded it, when, and a link back to the task.
A decision toggled by a teammate appears in an open Decisions view in real time.

## Who can see decisions

Decisions are **team-owned**. By default the log is visible to the team and to project
managers — not to read-only oversight stakeholders. A project admin can extend visibility
with a single **Oversight visibility** switch on the Decisions view; until they do, an
oversight viewer sees an explanatory message rather than the log. The team controls whether
its decisions are shared upward — the switch is enforced on the server, not just hidden in
the UI.

This is single-project, team-level consent. Rolling decisions up *across* projects for a
portfolio view is part of the enterprise edition.

## Notes

- Marking a note as a decision never sends a notification — it is a quiet, low-friction act.
- A note's body is immutable after a short edit window, so a recorded decision can't be
  silently rewritten after the fact.
- Decisions are project- and sprint-scoped only. There is no separate decision lifecycle
  (accepted/superseded) or immutable audit trail in the community edition.
