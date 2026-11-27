---
title: Decisions
description: A durable, low-friction decision log built on task notes — project- and sprint-scoped, with team-owned visibility.
documentedFor: "0.5"
---

:::note[Added in 0.3]
Decisions was added in the **0.3 "agile team"** milestone, available since the
`0.3.0-alpha.1` pre-release (Jun 28, 2026).
:::

Every team makes calls it later has to explain: *why did we drop that story, why did we
choose this approach?* Decisions turns any task note into a durable record of that call,
and collects those records into a project- and sprint-scoped log — so the answer is one
click away at a Sprint Review instead of buried in a chat thread.

## How it works

A **note** is where anyone can record the reasoning behind a call on a task — see
[task collaboration](/features/task-collaboration/). Marking a note as a
**Decision** is a single tap — a chip next to **Pin** on the note row. Any team
member or project manager can flag a note; flagging is curation, not authorship,
so you can mark a teammate's note as a decision too. That flag is all there is to
it — no category to pick, no required fields, nothing else to fill in.

Flagged decisions roll up into the **Decisions** view under **Reports → Decisions**:

- **All decisions** — every decision across the project, grouped by sprint, with closed
  sprints kept browsable so you can revisit a call made three sprints ago.
- **Current sprint** — the same log scoped to the active sprint, for walking decisions at
  the Sprint Review or Retro.

Each row shows the decision text, who recorded it, when, and a link back to the task.
A decision toggled by a teammate appears in an open Decisions view in real time.

## Getting to the log

:::note[Ships in 0.5]
The shortcuts below ship in 0.5. In 0.4, open **Reports** and select the
**Decisions** tab; flagging a note shows no confirmation.
:::

In 0.5 flagging a note will show a **Flagged as a decision** confirmation with a
**View Decisions** button. The command palette (<kbd>⌘K</kbd> / <kbd>Ctrl K</kbd>)
will offer **Go to Decisions** for the project you are in, and the log will have
its own address, `/projects/:projectId/reports?tab=decisions`, that you can
bookmark or share.

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
