---
title: Public sharing (board & schedule)
description: Generate a public, revocable, read-only link to a project's board or schedule so external stakeholders can view status without a TruePPM login.
---

**Public sharing** lets a project Admin hand a stakeholder — a client, a sponsor,
anyone without a TruePPM account — a link that opens the project's **board** or
**schedule** in a browser, read-only, with no sign-in. Links are revocable at any
time, can be given an expiry, and the shared view is deliberately minimized so
internal detail never leaks.

## Generating a link

You can create a link two ways:

- From the **Schedule** or **Board** toolbar, choose **↗ Share** (Admin or Owner
  only). The dialog is scoped to the view you launched it from.
- From **Project Settings → Sharing**, choose **Create link…** and pick whether to
  share the **schedule** or the **board**.

In the dialog:

1. Optionally give the link a label (e.g. *"Client review — Q3 steering"*).
2. Choose when it **expires** — *Never*, *In 30 days* (the default), or a date you
   pick. An expired link stops resolving on its own.
3. Decide whether to **show assignee names** — **off by default**, so no individual on
   the team is exposed unless you opt in.
4. The link is shown **exactly once**. Copy it immediately — for security it is stored
   only as a hash and can never be retrieved again. If you lose it, revoke it and create
   a new one.

The Sharing page groups active links by kind (**Schedule** / **Board**) and shows each
link's label, a non-revealing prefix, its expiry, who created it, and how many times it
has been viewed.

## What a viewer sees — and doesn't

A shared **board** shows the working columns (task ID, name, status, percent-complete,
due date); the backlog column is never shown. A shared **schedule** shows a read-only
timeline — WBS structure, task bars with percent-complete, the critical path, and
milestone dates.

Neither view ever includes:

- comments, notes, or attachments
- story points, business value, cost, or any estimate
- schedule float, slack, or Monte Carlo risk figures
- blocker details
- assignee names (unless you explicitly enabled *Show assignee names* for that link)

Viewers cannot edit anything — there is no drag, no detail popover, no create action.

## Revoking and expiry

Revoke a link from the **Sharing** page or the toolbar dialog. Revocation takes effect
immediately: the link stops resolving and anyone who opens it sees a *"This link is no
longer active"* page. The same page appears once a link's expiry passes. A revoked or
expired link can never be reactivated — create a new one instead.

## Requirements

Public sharing is **opt-in at two levels**:

- **Public sharing** must be enabled for the project (Project Settings → General →
  *Public sharing*). This policy inherits from the workspace and program, and is **off
  by default**. If it is off, minting is blocked and turning it off later immediately
  disables every existing link for the project — both board and schedule.
- The self-hoster's operator must not have disabled sharing instance-wide (see
  [Configuration](/administration/configuration/)).

## Related

- [Board (Kanban)](/features/board/) — the board a shared board view mirrors
- [Configuration](/administration/configuration/) — the `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED` operator kill switch (governs board **and** schedule links)
