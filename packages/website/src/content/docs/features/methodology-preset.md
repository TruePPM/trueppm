---
title: Project methodology preset
description: Tab visibility per planning model (Waterfall / Agile / Hybrid).
---

A project-level preset that tells TruePPM which planning model the team uses, and hides the irrelevant tabs by default. The API surface is unchanged — methodology hides tabs but does not gate routes.

## Where this lives in the story

The system-level encoding of the [hybrid PM flow](/the-story/)'s central thesis: *one model, multiple persona views*. Without methodology, every persona sees nine tabs and the workspace overwhelms.

## The matrix

| Tab | Waterfall | Agile | Hybrid |
|---|---|---|---|
| Overview | ✅ | ✅ | ✅ |
| Board | ✅ | ✅ | ✅ |
| Sprints | ❌ | ✅ | ✅ |
| Schedule | ✅ | ❌ | ✅ |
| WBS | ✅ | ❌ | ✅ |
| Table | ✅ | ✅ | ✅ |
| Calendar | ✅ | ❌ | ✅ |
| Team | ✅ | ✅ | ✅ |
| Risks | ✅ | ✅ | ✅ |

The default for new projects is **Hybrid** — every tab visible. Existing projects (created before ADR-0041 landed) all default to Hybrid; no behaviour change.

## Why hide tabs but not gate routes

The preset communicates *"this is not how we work here"*, not *"this is not allowed."* Power users who know what they want can always reach a hidden view by direct URL. Mobile or API consumers are unaffected. Hiding lowers cognitive load at onboarding without restricting the system.

## Where to find it

- **Project creation wizard** — step 3 prompts for the methodology with one-line descriptions per choice
- **Project settings** — the same selector, editable post-creation; takes effect immediately

## Iteration terminology

Not every team that runs timeboxes calls them "Sprints." Scrumban and SAFe-adjacent teams
use "Iteration" or "PI", and forcing strict Scrum-Guide vocabulary reads as a mandate.
Coming in **0.3**, an Agile or Hybrid project will be able to label its iteration container —
**Sprint** (the default), **Iteration**, **PI**, or a custom word — under **Project → Settings → General**.

The chosen label will flow through every iteration surface: the tab, the sprint workspace,
the board, planning, guardrails, the burndown, and the milestone-bridge dialog. It is
**display-only** — like the methodology preset, it changes what you *see*, never what the
system *does*: scheduling, permissions, and the API are untouched. Existing projects keep
"Sprint", so nothing changes unless a team opts in.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/` | Includes `methodology` and `iteration_label` fields |
| `PATCH` | `/api/v1/projects/{id}/` | Accepts `methodology` (`WATERFALL` \| `AGILE` \| `HYBRID`) and `iteration_label` (free text, ≤32 chars; Admin+ only) |

## Related ADRs

- [ADR-0041](/architecture/decisions/) — Project methodology preset
- [ADR-0111](/architecture/decisions/) — Configurable iteration-container label

## If you are…

- **Sarah (construction PM)** — set Waterfall. Sprint chrome disappears; Schedule and WBS dominate.
- **Maya (Scrum Master)** — set Agile. Schedule, WBS, and Calendar disappear; Sprints and Board dominate.
- **Diana (PMO Director)** — leave Hybrid as the default for projects that span teams. Override per project where the team's method is clear.
