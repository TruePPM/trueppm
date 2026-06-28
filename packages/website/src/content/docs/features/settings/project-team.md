---
title: Project team & agile roles
description: Assign team roles and the Scrum Master / Product Owner facets per member, on agile and hybrid projects.
---

:::note[Added in 0.3]
The **Project Settings → Team** tab was added in 0.3 (the agile team release), available since the `0.3.0-alpha.1` pre-release (Jun 28, 2026).
:::

The **Project Settings → Team** tab is where you set who fills the agile roles on a project. It manages two independent things per member:

- a **team role** — *Member* or *Admin*, and
- two **facets** — *Scrum Master* and *Product Owner*.

Open it at **Project → Settings → Team** (`/projects/:id/settings/team`).

Every project has one default team, created automatically. Managing more than one team per project is not part of this release.

## Role and facets are independent

The team role controls who can manage the team. The two facets mark who holds the agile responsibilities. They are **orthogonal** — a person's facets do not depend on their role, and you set them separately:

- An **Admin** can also be the Scrum Master.
- A plain **Member** can be the Product Owner.
- One person can hold both facets, or neither.

Modeling the facets as toggles rather than as extra roles is deliberate: in real teams the Scrum Master and Product Owner are responsibilities layered on top of being a contributor, not a different tier of access. See [Roles and Permissions](/administration/rbac/) for the underlying RBAC model.

## Who can edit

| Action | Who |
|--------|-----|
| View the team list and who holds each facet | Any project member (including Viewers) |
| Change a member's team role, assign Scrum Master / Product Owner | Project **Admin** *or* team **Admin** |

A project Admin can always manage the team. A team Admin — someone given the *Admin* team role on this tab — can manage the team without being a project Admin, so an agile team can run its own roles without involving project administration.

Viewers and plain Members see the tab read-only. They still see who the current Scrum Master and Product Owner are; they just cannot change assignments. The API enforces the same gate server-side regardless of what the UI shows.

## Assigning Scrum Master and Product Owner

Each member row carries a **Scrum Master** toggle and a **Product Owner** toggle. Turn one on to assign that facet to that member.

There is **at most one Scrum Master and one Product Owner per team**. If you turn on a facet for someone while another member already holds it, TruePPM prompts **"Reassign?"** to confirm — accepting moves the facet from the previous holder to the new one in a single step. Decline, and nothing changes. There is no separate "remove from the old person first" action; the reassign is the move.

To leave a facet unfilled, turn it off on the member who holds it.

## Where this appears

The Team tab is shown on **agile** and **hybrid** projects. It is **hidden on Waterfall** projects, where these agile roles do not apply — consistent with how the [methodology preset](/features/methodology-preset/) hides tabs that do not fit the project's planning model.

## Related ADRs

- [ADR-0078](/architecture/decisions/) — Composable agile roles: team role plus orthogonal Scrum Master / Product Owner facets

## Related

- [Project members](/features/settings/project-members/) — project access and the 5-role RBAC model (distinct from team roles)
- [Roles and Permissions](/administration/rbac/) — the full permission model
- [Project methodology preset](/features/methodology-preset/) — which tabs appear per planning model
