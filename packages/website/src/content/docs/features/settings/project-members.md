---
title: Project members
description: Invite teammates to a project, change their role, and remove or leave a project — the management UI for the 5-role RBAC model.
---

The **Project Settings → Members** page is where a project Owner manages who is on a project and what each person can do. Open it at **Project → Settings → Members** (`/projects/:id/settings/members`).

It is the management surface for the [5-role RBAC model](/administration/rbac/): the roles and their permissions are defined there; this page is how you assign them.

## What you can do

| Action | Minimum role |
|--------|-------------|
| View the member list | Viewer |
| Invite a member, change a role, remove a member | Owner |
| Set the default role for new members | Project Manager (Admin) |
| Leave the project (remove your own membership) | Any member |

Any project member sees the full member list. The invite form, role picker, and remove controls are shown only to Owners; the API enforces the same gate server-side regardless of what the UI shows.

## Inviting a member

The invite form is a typeahead. Start typing a name and TruePPM searches existing accounts (`GET /api/v1/users/search/`, debounced), returning up to 10 matches by username and display name. Pick a result, choose a role, and add them.

The invited user **must already have a TruePPM account** — this page does not create accounts. To bring in someone who has never signed in, send them a [workspace invite](/administration/workspace-settings/#invites-settingsmembers--invite-flow) first; once they accept and have an account, they appear in the project member search.

For privacy, the search returns username, display name, and initials only — never email addresses.

## Default role for new members

Every project has a **default role for new members** — the role a person receives when they are added without one chosen. The invite form's role picker starts on this default (Team Member unless you change it), so adding a contributor is a two-click action instead of re-selecting the same role each time. Any role you pick explicitly on the invite form still wins over the default.

Set it when you create the project, or change it any time on **Settings → Members** (a Project Manager, i.e. Admin, or above can edit it). "[Copy settings from…](/administration/project-settings/#copy-settings-from-an-existing-project)" carries the default role along with the project's other settings when you seed a new project from an existing one.

This is a convenience default only — there are **no locks, no enforcement, and no audit trail**. It never grants Project Admin (Owner) by default, and it does not change the roles of members who are already on the project.

## Changing a role

Each member row carries a role picker. Selecting a new role updates it immediately. You cannot assign a role above your own, and the last Owner cannot be demoted — the project must always have at least one Owner. The API rejects a last-Owner demotion with `HTTP 400`.

## Transferring ownership

To hand the project to someone else, use **Transfer ownership** on **Project → Settings → Lifecycle**. It opens a member picker: the chosen member becomes the project Owner and you are demoted to Admin in the same atomic step. The new owner must already be a project member — invite them first if needed. Only an Owner can transfer ownership; the API enforces this with `POST /api/v1/projects/{id}/transfer/` and rejects a non-owner with `HTTP 403`.

## Removing a member and leaving a project

An Owner can remove any other member from their row. Any member can remove **their own** membership — surfaced as a **Leave** action on your own row, and also as a **Leave project** item in the user menu so you can leave without opening Settings. Removing the last Owner is blocked by the same last-Owner guard.

Removing a member revokes their access immediately; it does not delete the user or any work they were assigned. Reassign their tasks separately on the [Resources](/features/resources/) surface — project membership (access) and resource assignment (staffing) are deliberately separate concerns.

## Related

- [Roles and Permissions](/administration/rbac/) — the 5-role model and full permission matrix
- [Workspace Settings → Members](/administration/workspace-settings/) — workspace-level membership and email invites
- [Resources & Skills](/features/resources/) — staffing and task assignment (distinct from access control)
