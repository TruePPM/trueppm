---
title: Where the Free Edition Ends
description: The one rule that separates the free edition from the enterprise edition — OSS gives you reality and why, Enterprise gives you alternatives and which — with the free half named down to the endpoint.
documentedFor: "0.5"
---

Open-core products usually leave you to discover the boundary by hitting it. This page
states TruePPM's boundary up front, in one sentence, so you can tell which side of it any
capability falls on without reading the source.

> **OSS gives you reality and why. Enterprise gives you alternatives and which.**

- **Reality** is what the plan says, computed by the engine: the dates, the critical path, the
  float, the forecast.
- **Why** is the derivation behind any computed value, and, on dependency writes, the
  engine's refusal (with its reason) of a link that would create a cycle.
- **Alternatives** are several competing futures held side by side, named and kept.
- **Which** is the decision between them, and the act of committing it to the plan.

A PM and their team can run a project completely, and understand every number in it, without
paying. The enterprise edition is for an organization that wants to hold many competing
futures across many programs and choose among them.

This restates the internal rule contributors use when deciding where a feature goes:
*explaining a computed value is OSS; making or recommending a scheduling decision is
Enterprise.* For the same line drawn through identity, see
[SSO is not an enterprise feature](/overview/sso-is-not-enterprise/). The
[roadmap](/overview/roadmap/) is the source of truth for what has shipped.

:::note[Ships in 0.5]
Everything in the free-edition table below is in the 0.4 release unless the row says
otherwise. Rows marked **0.5** or **0.6** are planned, not built, and are written in future
tense on purpose. The single-project, non-mutating `dry_run` plan mode ships in 0.5; the
committing write path with the engine as referee ships in 0.6. Only the rows marked as such
are unreleased; everything else on this page is in the 0.4 release.
:::

## What the free edition does

Each row names where you can reach it. If a row is not reachable at the place named, that is
a bug in this page: [open an issue](https://gitlab.com/trueppm/trueppm/-/issues).

| Capability | Where you reach it | Status |
|---|---|---|
| Deterministic schedule model: CPM with all four dependency types, cycle detection | The Schedule view; recomputed by `POST /projects/{id}/schedule/`; MCP `get_schedule_summary` | Shipped |
| Critical path and float, per task | The Schedule view; MCP `get_schedule_summary` | Shipped |
| Working-time calendars (durations in working days; lag in calendar days, snapped to a working day) | Project settings, Working calendars; `/calendars/` and `/calendars/{id}/exceptions/`; applied by the engine on every schedule pass | Shipped |
| Monte Carlo risk analysis (P50 / P80 / P95) | `POST /projects/{id}/monte-carlo/`, `GET /projects/{id}/monte-carlo/latest/`; MCP `get_monte_carlo_forecast` | Shipped |
| Single-project what-if: perturb one task's duration, recompute CPM and Monte Carlo, persist nothing | `POST /projects/{id}/monte-carlo/whatif/`; MCP `whatif` | Shipped |
| The derivation behind any computed date, float, or P80 | `GET /projects/{id}/schedule/derivation/`; MCP `get_schedule_derivation` | Shipped |
| The engine rejecting a dependency that would create a cycle or a self-reference, with the reason | Dependency writes (`/dependencies/`) and imports | Shipped |
| Agent plan mode: a proposed change answered with verdict and projected impact, committing nothing | MCP `dry_run` | Ships in 0.5 |
| Engine as referee: a write that would make the plan infeasible is refused with its derivation, for humans and agents | Write endpoints and MCP write tools | Ships in 0.6 |

None of these is rate-limited, seat-limited, or gated by a flag. Every one of them works on
a single project or within a single program, which is the unit one PM runs.

## What the enterprise edition is for

The enterprise edition is a separate, proprietary repository that overlays the open core. It
is for organizations that need to compare and choose between futures across programs:

- Named portfolio scenarios that are saved and kept.
- Side-by-side comparison of scenarios.
- Promoting a chosen scenario into the plan.
- Financial and strategic-coverage deltas between scenarios.
- Constraint-solving optimization that proposes a schedule.

These are planned for the enterprise edition and are not available today. They sit
alongside the rest of the enterprise list on the [roadmap](/overview/roadmap/#planned-enterprise-edition),
including portfolio governance, cross-program resource leveling, and organization-wide
identity governance.

## How to apply the line to a new capability

Ask two questions, in order:

1. **Does it tell you what is true, or why?** A computed value, its derivation, a forecast,
   or the engine rejecting a cyclic dependency is reality and why. It is free.
2. **Does it hold several alternatives, or choose between them?** A saved scenario, a
   comparison, a promotion into the plan, or a solver that recommends a schedule is
   alternatives and which. It belongs to the enterprise edition.

The single-project what-if is the boundary case, and it is free deliberately: asking
"what happens if this slips three days" answers a question about reality. It is the saved,
named, compared, and promoted version of the same question, across a portfolio, that
belongs to the enterprise edition.

The line is drawn on the kind of answer, not on the size of your team. Other carve-outs
follow the same adoption-versus-governance logic: login through your own identity provider
is free, while provisioning and governing accounts from a directory is enterprise; a
personal, read-only external task source is free, while the org-wide bidirectional
integration hub is enterprise; surviving a pod or node loss in one cluster is free, while
cross-region disaster recovery is enterprise.

## What this page does not promise

The free edition never imports from the enterprise repository, and the dependency runs one
way only. The free edition's interface does not carry "upgrade to model this" prompts. If
you find one, treat it as a defect and report it.
