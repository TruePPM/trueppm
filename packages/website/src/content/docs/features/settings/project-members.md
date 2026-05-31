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
| Leave the project (remove your own membership) | Any member |

Any project member sees the full member list. The invite form, role picker, and remove controls are shown only to Owners; the API enforces the same gate server-side regardless of what the UI shows.

## Inviting a member

The invite form is a typeahead. Start typing a name and TruePPM searches existing accounts (`GET /api/v1/users/search/`, debounced), returning up to 10 matches by username and display name. Pick a result, choose a role, and add them.

The invited user **must already have a TruePPM account** — this page does not create accounts. To bring in someone who has never signed in, send them a [workspace invite](/administration/workspace-settings/#invites-settingsmembers--invite-flow) first; once they accept and have an account, they appear in the project member search.

For privacy, the search returns username, display name, and initials only — never email addresses.

## Changing a role

Each member row carries a role picker. Selecting a new role updates it immediately. You cannot assign a role above your own, and the last Owner cannot be demoted — the project must always have at least one Owner. The API rejects a last-Owner demotion with `HTTP 400`.

## Removing a member and leaving a project

An Owner can remove any other member from their row. Any member can remove **their own** membership — surfaced as a **Leave** action on your own row, and also as a **Leave project** item in the user menu so you can leave without opening Settings. Removing the last Owner is blocked by the same last-Owner guard.

Removing a member revokes their access immediately; it does not delete the user or any work they were assigned. Reassign their tasks separately on the [Resources](/features/resources/) surface — project membership (access) and resource assignment (staffing) are deliberately separate concerns.

## Related

- [Roles and Permissions](/administration/rbac/) — the 5-role model and full permission matrix
- [Workspace Settings → Members](/administration/workspace-settings/) — workspace-level membership and email invites
- [Resources & Skills](/features/resources/) — staffing and task assignment (distinct from access control)
