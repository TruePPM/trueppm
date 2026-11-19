# ADR-1434: Enforce project and program visibility (WORKSPACE vs PRIVATE)

- **Status:** Accepted
- **Date:** 2026-11-19
- **Issue:** #2066 (split from #2011)

## Context

`Project.visibility` and `Program.visibility` (`WORKSPACE` / `PRIVATE`) have been stored,
editable and rendered since #520/#523, but no authorization path read them: every project
and program was membership-scoped whatever the value. #2011 disabled the General-settings
control with a "not enforced yet" note so PRIVATE stopped promising a distinction that did
not exist. This ADR ships the enforcement.

Two facts shape it:

1. **The column defaulted to `WORKSPACE`.** Every existing row is WORKSPACE because nobody
   chose otherwise. Enforcing WORKSPACE as written would silently open every project and
   program on every install to the whole workspace on upgrade.
2. **Child data is reached through ~200 project-scoped routes**, the board WebSocket, the
   sync protocol, search and MCP, almost all built on `ProjectMembership` directly
   (`ProjectScopedViewSet`, `_membership_role`). Widening all of them is a much larger and
   riskier change than the issue's scope.

## Threat model (STRIDE, authorization boundary)

| Threat | Where | Mitigation |
|---|---|---|
| **E** — a non-member writes a WORKSPACE project/program | update/partial_update/destroy and every unsafe action | The widened object gate grants on `SAFE_METHODS` only; the widened queryset applies to `list` / `retrieve` only, so a write's `get_object()` runs against the membership-only queryset and 404s. Pinned by tests. |
| **I** — child data leaks through the widened record | tasks, board, schedule, rollups, WS | Not widened (decision 3). Detail actions on the viewsets keep the membership queryset. Pinned by tests with a positive control (the route exists for the owner). |
| **I** — a guest enumerates the workspace | list | Guests and deactivated accounts are not eligible (decision 2). |
| **I** — a draft project is browsable | list | Drafts are excluded from the WORKSPACE arm. |
| **I** — upgrade widens access silently | migration | Existing rows are pinned to PRIVATE and the default becomes PRIVATE (decision 1). |
| **E** — self-grant via `POST /projects/` | org-level gates | Not used: eligibility reads `WorkspaceMembership.status`, not `IsOrgAdmin` / `IsOrgScheduler`. |
| **D** — list query cost | list | Both OR arms are row predicates (`pk IN (subquery)`, column tests) — no join, no fan-out, no `.distinct()`. Pinned by a query-ceiling test. |
| **S/R** | — | No new authentication path; no new write, so no new audit surface. |

## Decision

1. **Default and backfill: PRIVATE.** Migration `projects.0180` changes the column default
   to `PRIVATE` and sets every existing project and program to `PRIVATE`. That is exactly
   the access every install had before this change, so the upgrade widens nothing. A
   project or program becomes workspace-visible only when an Admin chooses WORKSPACE.
   This is a user-facing change: the documented default flips from Workspace to Private.
2. **Who "any workspace member" is.** An authenticated user whose `WorkspaceMembership` is
   `ACTIVE`, or who has no membership row (the implicit active MEMBER). **Guests are
   excluded** — a guest is an external collaborator limited to what they are invited to —
   and so are deactivated accounts. (`access.permissions.workspace_visibility_eligible`.)
3. **What WORKSPACE grants: read-only access to the record, nothing under it.** A
   non-member workspace member can **list** and **retrieve** the project or program row
   (`GET /projects/`, `GET /projects/{id}/`, `GET /programs/`, `GET /programs/{id}/`) —
   Viewer-equivalent for that row, with `my_role: null` as the honest "not a member"
   signal. They get **no** write on either, and **no** child reads: tasks, board, sprints,
   schedule, overview, calendars, program rollups and project lists, and the board
   WebSocket channel join all stay membership-scoped. Search, sync and the other list
   surfaces stay membership-scoped too. Widening any of those is a separate decision.
   Drafts stay member-only.
4. **PRIVATE and the program roster.** `GET /programs/{id}/projects/` already lists every
   non-draft project in a program to every program member (the program is the
   coordination unit). That stays: a PRIVATE project's *row* still appears to members of
   its program, and its child data stays members-only. PRIVATE narrows the
   workspace-wide audience; it does not hide a project from its own program.
5. **Mechanism.** `ProjectScopedViewSet.workspace_visible_actions` (empty by default — fail
   closed) admits WORKSPACE projects into the Project queryset; only `ProjectViewSet`
   opts in, for `list` / `retrieve`, and gates those two with
   `IsProjectMemberOrWorkspaceVisible`. `ProgramViewSet.get_queryset` ORs
   `visibility=WORKSPACE` into its membership `Exists` for `list` / `retrieve`, and
   `retrieve` is gated by `IsProgramMemberOrWorkspaceVisible`. Both new classes keep the
   parent's `has_permission` so a nested route still requires membership.

## Consequences

- The General-settings Visibility control is enabled again (Admin+, via the page's
  read-only fieldset). Its copy says what WORKSPACE does not open, so it does not promise
  more than decision 3.
- A non-member who opens a WORKSPACE project from the list reaches a project whose child
  reads refuse them. The web app has no dedicated "you can see this project but are not a
  member" state yet; that UX is follow-up work.
- The backfill is a bulk `.update()` and does not bump `server_version`, so an offline
  client may show a stale WORKSPACE label until the row next changes. The label is
  display-only on the client; the server decides access.
- Install operators who relied on the old WORKSPACE default being a no-op lose nothing.
  Anyone who explicitly chose WORKSPACE before #2011 disabled the control is reset to
  PRIVATE, because that choice never did anything and cannot be told apart from the default.
