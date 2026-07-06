---
title: Public board sharing
description: Generate a public, revocable, read-only link to a project's board so external stakeholders can view status without a TruePPM login.
---

**Public board sharing** lets a project Admin hand a stakeholder — a client, a sponsor,
anyone without a TruePPM account — a link that opens the project's Kanban board in a
browser, read-only, with no sign-in. The link is revocable at any time, and the shared
view is deliberately minimized so internal detail never leaks.

## Generating a link

1. Open **Project Settings → Sharing** (Admin or Owner only).
2. Choose **Create link…**. Optionally give it a label (e.g. *"Client review board"*)
   and decide whether to **show assignee names** — this is **off by default**, so no
   individual on the team is exposed unless you opt in.
3. The link is shown **exactly once**. Copy it immediately — for security it is stored
   only as a hash and can never be retrieved again. If you lose it, revoke it and
   create a new one.

Each link in the list shows its label, a non-revealing prefix, who created it, and how
many times it has been viewed (with the last-viewed time).

## What a viewer sees — and doesn't

The public view is a read-only snapshot of the board's working columns. Cards show the
task ID, name, status, percent-complete, and due date. The **backlog column is never
shown**.

The public view **never** includes:

- comments, notes, or attachments
- story points, business value, or any estimate
- blocker details
- assignee names (unless you explicitly enabled *Show assignee names* for that link)

Viewers cannot edit anything — there is no drag, no card detail, no create action.

## Revoking

Revoke a link from the same **Sharing** page. Revocation takes effect immediately: the
link stops resolving and anyone who opens it sees a *"This link has been revoked"* page.
A revoked link can never be reactivated — create a new one instead.

## Requirements

Public board sharing is **opt-in at two levels**:

- **Public sharing** must be enabled for the project (Project Settings → General →
  *Public sharing*). This policy inherits from the workspace and program, and is **off
  by default**. If it is off, the Sharing page won't let you mint a link, and turning it
  off later immediately disables every existing link for the project.
- The self-hoster's operator must not have disabled sharing instance-wide (see
  [Configuration](/administration/configuration/)).

## Related

- [Board (Kanban)](/features/board/) — the board the shared view mirrors
- [Configuration](/administration/configuration/) — the `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED` operator kill switch
