---
title: Agent oversight
description: A read-only view — per program, and per project on your own Activity tab — of what your team's agents read and which agent calls were refused. Every row is a link in a tamper-evident chain you can verify yourself. Governance of agents, never surveillance of people.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
The workspace **Agents** page — pause, capability scope, token revoke, the
"Action log verified" line and the refused-agent Inbox item — ships in 0.5 and is
described under [Workspace Agents page](#workspace-agents-page). In the current
release, agents are visible per program and per project only, and you stop an agent
by revoking its token under **Settings › API tokens**.
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

## Workspace Agents page

The **Agents** item in the left rail opens one page for every agent you can see,
across every program you belong to. An agent is a personal access token with the
read-only MCP scope; it acts for one person, the person who created it. Personal
tokens with other scopes, such as a webhooks token, are not agents and are not listed
here: pausing them would not stop anything. A workspace Admin's list shows at most
200 agents, and says so when there are more.

**Who sees which agents.** You see your own agents, and any agent that has acted in
a project you are a member of. A workspace Admin sees every agent. When an agent's
latest action was in a project you cannot read, the row says so instead of showing
it.

Each row shows who the agent acts for, its scope in words, its last action, and how
many of its calls were **refused in the last 7 days** — counting only actions you can
see. Select a row to open its panel:

- **Pause** stops the agent. Every call it makes is refused until someone resumes
  it — on the MCP read tools and on key resolution alike. The panel says who paused it. The agent itself is told only that it is
  paused, never by whom.
- **Edit scope** sets what the agent may do in each area (Schedule & tasks,
  Dependencies, Resources, Baselines). **Read** lets it read that area. **Dry run**
  can be granted now but has no effect yet: it takes effect when plan mode ships,
  which will let the agent ask what a change would do without changing anything.
  **Write** is shown but disabled: the write path ships in 0.6, and
  the server refuses a write grant whatever the page sends.
- **Revoke token** ends the agent for good, on its next call.

**What each area covers.** The server decides which area every read falls in, and
the matrix shows the same list under each area's name:

| Area | What an agent without **Read** here is refused |
|---|---|
| Schedule & tasks | Projects, programs, tasks, phases, sprints, risks, labels, custom fields, acceptance criteria, history, status updates, forecasts, Monte Carlo, My Work and search. Task-level summaries such as a task's predecessor count and readiness belong here. |
| Dependencies | Dependency links between tasks, the schedule's driving chain, and the derivation that explains a computed date. |
| Resources | Project cost and rates, utilization, resource allocation, the resource heat map and resource summary. A task read still works, but leaves out the task's resource assignments and its overallocation flags. |
| Baselines | Baselines and their task snapshots. |

A refused read is answered with the area's name, never with the data. The resource
list endpoints themselves are not on the agent read surface at all, so no agent can
read them whatever its scope.

An agent can never do more than the person it acts for. The server checks the
agent's scope against that person's **current** project roles on every call, so
removing the person from a project, or lowering their role, narrows the agent at
once. A workspace Admin who edits someone else's agent is held to the same limit:
an edit that **raises** an area above what the person can do now is refused. After a
person's role is lowered, their agent's stored scope can sit above their new limit;
the matrix still shows the stored level, and you can always lower it or change any
other area.

Only the person an agent acts for, or a workspace Admin, can pause, resume, edit or
revoke it, and only from a signed-in session: the endpoints refuse every API token,
including the agent's own, so an agent cannot resume itself or widen its own scope.
Every pause, resume, scope change and revoke made on this page is written to the
same tamper-evident chain as the agent's own calls, with who made it and why. The
record belongs to the person the agent acts for — it appears in their action log
beside the agent's calls — and names the person who made the change. Revoking a
token elsewhere, such as under **Settings › API tokens**, is not written to this
chain yet.

For a workspace Admin, the line under the page title — **Action log verified · N
records · as of …** — is the result of the same check as `audit_verify`, run by the
server and reused for up to ten minutes, so it can trail the newest records by that
long; the "as of" time says when it ran. The check covers the whole workspace's chain,
so only workspace Admins see the line; everyone else sees the same page without it.

### Refused agents in your Inbox

When one of your agents is refused because it is paused or outside its scope, you
get an Inbox item. It leads with the reason, then names what the agent attempted
and the agent, and ends with "Nothing changed in the schedule." The title names the
agent and its token prefix, such as "Refused: agent Claude (tppm_ab12cd34) is paused",
so two agents with the same name get separate items. Repeats from the
same agent for the same reason within 15 minutes update one item with a count, so a
looping agent cannot fill your Inbox. Opening the item takes you to the Agents page.
You can turn these items off with **When one of your agents is refused** in your
notification settings.

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
