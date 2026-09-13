---
title: Agent oversight
documentedFor: "0.4"
description: A read-only view — per program, and per project on your own Activity tab — of what your team's agents read and which agent calls were refused. Every row is a link in a tamper-evident chain you can verify yourself. Governance of agents, never surveillance of people.
---

:::note[Ships in 0.4]
The agent-oversight panel ships in 0.4, alongside the read-only
[MCP server](/features/mcp-server/). On the current release there is no Agents tab and
no agent-action log to project — nothing on this page describes behavior you can
exercise on it yet. On unreleased builds the layout may still be changing.
:::

This page is for a PM, Scrum Master, or program lead who wants to know what an AI
assistant connected to TruePPM has actually looked at, and what it was refused —
without turning the log into a performance tool for people.

Every program gets an **Agents** tab — a read-only window onto what your team's
AI assistants have read in that program, and which of their calls were refused. It
is a view onto a tamper-evident record — each entry is chained to the one before
it, so any entry edited or removed after the fact shows up as a broken chain when
the log is checked.
It is not a separate data store you have to maintain; it just shows you that record.
It sits in the program rail between **Resources** and **Members**: governance of
execution next to capacity for it.

What lands in that log is every read an assistant makes with its own read-only
access token, and every rejection of a token that has been revoked or has expired.
The scheduling engine's own "this isn't feasible" refusals apply to every caller,
human or agent, and are *not* recorded here — there is no agent write yet for them
to refuse. They join the log once assistants can make changes, in a later release,
as the **Refusals** view notes below.

## Three views

The tab hosts three sub-views behind a segmented control:

- **Activity** — the chronological log of recorded agent actions in the program:
  when it happened, which action it was, which token acted (shown only by a short
  prefix, never the full token), the accountable human it acted on behalf of, and
  the verdict (allowed / refused). Every column shows a real recorded fact — nothing
  is guessed or inferred. Click a row to open its detail, including the technical
  fingerprint values that let an administrator match this row against the result of
  a full integrity check (see [Verify it yourself](#verify-it-yourself) below).
- **Refusals** — the concentrated view of what was *stopped*. Today that means one of
  two things: the assistant's token was expired or invalid, or it tried something its
  capability doesn't allow — each shown with a plain-language reason. Once assistants
  can make changes, in a later release, a change the scheduling engine refuses because
  it isn't feasible will appear here too, with the reason and what it would have done
  to your plan.
- **Forecast impact** — your program's **P80 finish date** — the date the schedule's
  forecast is confident about roughly 8 times out of 10 — together with a line showing
  how much of the plan your assistants have actually completed. Work an assistant
  finished is already counted in that forecast, so this view always reflects what
  agents have contributed.

## Your own project, on your own tab

You do not have to go up to the program to see what was read on your project. Every
project's **Activity** tab has an **Agents** sub-view beside **Changes**, scoped to
that project alone:

- **Changes** answers *"what changed here?"* — the unified changelog across tasks,
  sprints, risks, dependencies, and project settings.
- **Agents** answers *"who read or acted on it, and what was refused?"* — the same
  agent-action rows the program tab renders, filtered to this project.

The two are kept apart on purpose. An agent *read* changed nothing, so folding it
into the changelog would make it look as though it had.

The sub-view carries a **Refusals only** filter and a time-range control, and it is
deep-linkable: `…/activity?view=agents` opens straight onto it, so you can paste
"what the agents did on our project this week" into a team channel. Links written
before this existed still open on **Changes**, unchanged.

This is the same read, one level down — not a second log and not a weaker one. The
API behind both has always been membership-scoped: you see agent actions on projects
you belong to, and an admin sees no more of your project than you do.

## Verify it yourself

The panel is credible because the record underneath it can be checked, not because
it says so. The **Verify locally** badge explains that every action is one link in
a tamper-evident chain — if any row were ever removed or altered, the chain would
visibly break — and hands you the command your **TruePPM administrator** can run on
the server to check the full chain:

```bash
python manage.py audit_verify
```

That check runs on your own server, against your own data — it is the authoritative
proof, not something the browser can fake. The panel points you to it honestly
rather than claiming a guarantee it cannot make on its own.

## Governance of agents, not surveillance of people

This surface governs **agents**. It never becomes a productivity dashboard for
people. There is no per-person leaderboard, no actions-per-human count, no ranking.
The accountable human appears only as *attribution* — whose agent took an action —
exactly as an audit log names who holds a credential, and never as a throughput
metric. Team-health signals like **velocity** (how much work the team finishes per
sprint) and team pulse are governed separately, under their own privacy rules, and
are not shown here.

## What stays in the paid edition

The community Agents tab is a team's read on **its own** agents in **one program**.
Cross-program fleet oversight, org-wide agent trust scores, and notarized or
streamed audit trails are portfolio-governance concerns and live in the enterprise
edition. The community components are the seam the enterprise fleet view composes
against — the split is *your team's agents in your program* (community) versus
*governing agents across the whole organization* (enterprise).
