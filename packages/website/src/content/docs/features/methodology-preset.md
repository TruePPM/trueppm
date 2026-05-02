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

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/` | Includes `methodology` field |
| `PATCH` | `/api/v1/projects/{id}/` | Accepts `methodology` (`WATERFALL` \| `AGILE` \| `HYBRID`) |

## Related ADRs

- [ADR-0041](/architecture/adr/) — Project methodology preset

## If you are…

- **Sarah (construction PM)** — set Waterfall. Sprint chrome disappears; Schedule and WBS dominate.
- **Maya (Scrum Master)** — set Agile. Schedule, WBS, and Calendar disappear; Sprints and Board dominate.
- **Diana (PMO Director)** — leave Hybrid as the default for projects that span teams. Override per project where the team's method is clear.
