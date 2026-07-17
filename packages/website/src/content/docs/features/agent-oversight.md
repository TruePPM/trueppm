---
title: Agent oversight
description: A per-program, read-only view of what your team's agents did and what the engine refused — every row a link in a tamper-evident chain you can verify yourself. Governance of agents, never surveillance of people.
---

:::note[Coming in 0.4]
The agent-oversight panel ships in 0.4, alongside the read-only
[MCP server](/features/mcp-server/). On unreleased builds the layout may still be
changing.
:::

Every program gets an **Agents** tab — a read-only window onto what your team's
agents have done in that program, and what the scheduling engine refused. It is a
projection of the tamper-evident agent-action log (the same hash-chained record the
`audit_verify` command validates), never a separate data store. It sits in the
program rail between **Resources** and **Members**: governance of execution next to
capacity for it.

## Three views

The tab hosts three sub-views behind a segmented control:

- **Activity** — the chronological log of every agent action in the program: when
  it happened, which action and capability, which token acted (by its 8-character
  prefix, never the token itself), the accountable human it acted on behalf of, and
  the verdict (allowed / refused). Every column maps to a real recorded field —
  nothing is inferred. Click a row to open its detail, including the chain fingerprints
  (`record_hash`, `payload_hash`, `sequence`) you can locate in an `audit_verify` run.
- **Refusals** — the concentrated view of what the engine *stopped*: an expired or
  invalid token (identity), or a denied capability (policy), each with a plain-language
  reason. When the gated-write surface lands in a later release, a write refused as
  schedule-infeasible will appear here too, with the binding constraint and the
  projected impact on your plan.
- **Forecast impact** — the program's P80 completion date from the forecast rollup,
  with a contribution line showing how much of the plan agents have actually
  completed. Agent-finished work is already folded into the committed schedule the
  forecast runs on, so this is the agent-conditioned forecast by construction.

## Verify it yourself

The panel is credible because the rows underneath it are chain-verifiable, not
because it says so. The **Verify locally** badge explains that every action is one
link in a tamper-evident chain — each row's fingerprint is computed from the one
before it, so a removed or altered row breaks the chain — and hands you the command
to check the full chain on your own instance:

```bash
python manage.py audit_verify
```

The authoritative integrity check runs on your box, against your own data. The panel
points at it honestly rather than claiming a proof the browser cannot make.

## Governance of agents, not surveillance of people

This surface governs **agents**. It never becomes a productivity dashboard for
people. There is no per-person leaderboard, no actions-per-human count, no ranking.
The accountable human appears only as *attribution* — whose agent took an action —
exactly as an audit log names who holds a credential, and never as a throughput
metric. Team-health signals like velocity and pulse are governed separately by their
own consent model and are not rendered here.

## What stays in the paid edition

The community Agents tab is a team's read on **its own** agents in **one program**.
Cross-program fleet oversight, org-wide agent trust scores, and notarized or
streamed audit trails are portfolio-governance concerns and live in the enterprise
edition. The community components are the seam the enterprise fleet view composes
against — the split is *your team's agents in your program* (community) versus
*governing agents across the whole organization* (enterprise).
