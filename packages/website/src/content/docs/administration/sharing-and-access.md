---
title: Sharing & Access Inheritance
description: How public sharing and guest access inherit from the workspace down to programs and projects, who can override each scope, and which General settings live at which scope.
documentedFor: "0.4"
---

Two access settings — **public sharing** and **guest access** — are set once at the
workspace and **inherit down** to every program and project, where an Owner or Admin
can override them for that scope. This page explains what the two settings do, how the
Workspace → Program → Project inheritance model resolves a value, who may override it,
and how the "Inherit (On/Off)" indicator reads.

It also documents the broader **scope matrix**: which General settings live at which
scope, and why — so it is clear at a glance why some settings are workspace-only, some
inherit per scope, and some are deliberately scope-specific.

:::note[Ships in 0.4]
The **public sharing** setting governs a feature — tokenized read-only share
links — that ships in **TruePPM 0.4**, the first beta. In `v0.3.0-alpha.3`, the
latest release, the setting exists and inherits exactly as described below, but
there is nothing yet to share: no link can be minted. **Guest access** and the
scope matrix are unaffected and work today.
:::

:::note[Edition]
Per-scope sharing overrides are part of the **Community (OSS)** edition. The ability
to *lock* the workspace value as a hard ceiling that downstream scopes cannot loosen
(the **Enforce** policy) is an **Enterprise** capability — see
[Locking the workspace value (Enterprise)](#locking-the-workspace-value-enterprise).
:::

## The two sharing settings

| Setting | API field | What it controls |
|---|---|---|
| **Public sharing** | `public_sharing` | When on, designated read-only views can be shared via link so that **anyone with the link can view, without signing in**. When off, every view requires authentication. |
| **Guest access** | `allow_guests` | When on, **external collaborators** (users with `guest` status) may be added to projects. When off, only full workspace members may be added. |

Both are booleans, both default at the workspace, and both behave the same way under
inheritance.

### What the Share dialog does when the setting is off

Public sharing is **off by default**, so on a fresh install the Share dialog opens into
its blocked state. It says so up front — "Public sharing is turned off for this
workspace" — and the **Create link** button is disabled, rather than letting you fill in
the form and receive a `403` from the server on submit.

A workspace admin gets a link straight to **Workspace Settings → General**, where the
switch lives. Anyone else is told that a workspace admin can turn it on: that page is
admin-gated, so sending a project admin who is a plain workspace member there would only
bounce them.

Already-minted links stay manageable while the setting is off. The dialog's Manage panel
still lists them and **Revoke** still works — turning the workspace switch off withdraws
links from *recipients* (below) but does not remove them, and closing them for good is
still something you may want to do.

### Turning Public sharing off revokes existing links

The switch is **retroactive and immediate**. The effective policy is re-checked on
every request to a public link, so turning Public sharing off at any scope stops
every already-minted link below it from resolving — no restart, no cache flush, and
no need to revoke links individually.

A recipient who opens a withdrawn link gets **`410 Gone`** and the "this link is no
longer active" page — the same response as a link that was revoked by hand, that
expired, or whose project was moved to Trash. `410` rather than `404` is deliberate:
the link was real and was deliberately withdrawn, and the recipient is told to ask
the project owner for a new one rather than that the link never existed.

The recipient is **not** told which of those four causes applied. That is the link
owner's business, and the recipient's next step is the same either way.

Turning the setting back on restores the links that were not otherwise revoked or
expired — withdrawal is a policy check at read time, not a change to the links.

## The inheritance model

The value that actually applies at a given scope is **resolved on the server** and
returned to every client (web, mobile, API), so no client re-implements the
precedence. The chain is:

```
Workspace value  →  Program override  →  Project override
   (the default)      (optional)            (optional)
```

**Precedence — most specific wins:**

1. If the **project** sets an explicit override, that value applies.
2. Otherwise, if the project's **program** sets an explicit override, that value applies.
3. Otherwise, the **workspace** value applies.

A standalone project (one not in a program) inherits directly from the workspace. A
program inherits directly from the workspace; a project in that program inherits the
program's resolved value.

In the community edition, the parent value is a **default, not a ceiling**. A program
or project may **loosen or tighten** the inherited value — a single project can be made
public even when the workspace has public sharing off, and vice versa. (The Enterprise
**Enforce** policy changes this; see below.)

### How a scope inherits vs. overrides

Each program or project stores its override as a nullable value:

- **No override set** → the scope **inherits** the resolved parent value. This is the
  default for every new program and project.
- **Override set to On or Off** → the scope uses that explicit value, regardless of the
  parent.

Clearing an override returns the scope to inheriting from its parent.

### The "Inherit (On/Off)" indicator

When a program or project has **no override**, its General settings show the control as
**Inherit (On)** or **Inherit (Off)**. The On/Off in parentheses is the value the scope
*would* receive from its parent — i.e. the resolved parent value — so an admin can see
the consequence of leaving inheritance in place before deciding whether to override.

When a scope **does** override, the control shows the explicit On/Off it has set, not an
inherit label.

## Who can override

Setting (or clearing) an override at a scope uses the **same General-settings write
gate** as the rest of that scope's identity settings: the scope's **Owner or Admin**.

- **Owner / Admin** of a program or project can set, change, or clear that scope's
  override.
- **Lower roles** (Scheduler, Member, Viewer) receive the same resolved values on read
  and see the setting as a **read-only inherited indicator** — they cannot change it.

Override rights are evaluated **server-side** and reflected in the API payload, so the
UI never has to guess whether a control should be editable.

### Auditing overrides

Every override change is captured automatically in the program's or project's change
history (actor, timestamp, old → new value) through the standard settings write path —
no separate audit step is required.

## Locking the workspace value (Enterprise)

The workspace carries a **public sharing override policy** (`public_sharing_override_policy`)
with two values:

| Policy | Behavior |
|---|---|
| **Suggest** (default) | The workspace value is a default. Downstream programs and projects may override it (loosen or tighten). This is the community-edition behavior. |
| **Enforce** | The workspace value is a **hard ceiling**: downstream scopes cannot *loosen* it (cannot turn sharing on when the workspace has it off). |

:::caution[Enforce is an Enterprise capability]
**Enforce only takes effect in the Enterprise edition.** In the community edition the
field exists but there is no enforcement provider registered, so **Enforce silently
degrades to Suggest** — no lock is applied and downstream overrides still work normally.
Do not rely on Enforce to restrict sharing on a community-edition deployment.
:::

When Enforce is active (Enterprise), an Owner/Admin downstream can still *tighten*
sharing for their scope, but cannot loosen it past the workspace ceiling, and the
resolved effective value is clamped to the workspace value.

## Scope matrix — which General settings live where

The settings surface spans three scopes. Not every setting exists at every scope —
this is by design. The table below documents where each General setting lives and why.

### Workspace-only

These describe the installation as a whole; a single value is correct and overriding
them per program or project would be meaningless or contradictory.

| Setting | Why workspace-only |
|---|---|
| **Fiscal year start** | A fiscal calendar is an organization-wide accounting anchor; per-project fiscal years would make rollups and quarter labels incoherent. |
| **Work week** (working-day flags) | Per-project working time is expressed through project **calendars**, not a second copy of this flag — which is why there is no per-scope override here. Note that the workspace field itself is **currently inert**: nothing reads it, and working days resolve entirely from the [working calendar](/administration/working-calendars/) chain. See [Settings that are stored but not yet read](/administration/workspace-settings/#settings-that-are-stored-but-not-yet-read). |

### Per-scope, inheritable

These are set once at the workspace and inherit down, but a program or project may
override them when a local exception is genuinely needed.

| Setting | Why inheritable |
|---|---|
| **Public sharing** | Sharing posture is usually uniform, but one program or project may legitimately need to be public (or kept private) independent of the rest. |
| **Guest access** | Whether external collaborators are allowed is usually a workspace default, but a single program/project may need to admit (or exclude) guests on its own. |
| **Iteration label** (sprint/iteration terminology) | Teams differ in vocabulary; the term inherits the workspace default but a program or team may rename it locally. |

### Scope-specific by design

These deliberately exist only at certain scopes — they describe something about *that*
scope and there is nothing to inherit.

| Setting | Where it lives | Why scope-specific |
|---|---|---|
| **Visibility** | Project | Describes a single project's discoverability; it is not a value a parent hands down. |
| **Health** | Project | A RAG health indicator is a property of one project's current state; it is not inherited. |
| **Methodology** | Project | The Waterfall/Agile/Hybrid preset drives that project's tab visibility and defaults; each project chooses its own. |
| **Time zone** | Workspace **and** Project | Both scopes carry the field, but they do not form a cascade: a project's time zone anchors that project's [quiet hours](/features/settings/project-notifications/#quiet-hours) and falls back to the server's UTC, not to the workspace value. Neither one changes how dates are displayed to you — that follows your [personal time zone](/features/timezone-and-date-format/#timezone). A **program has no time zone** — it is a coordination grouping, not a place where work is scheduled, so there is nothing to set or inherit. |
| **Accent color** | Program | A program's accent color is part of its visual identity for wayfinding; projects and the workspace do not carry one. |
| **Export** | Program | Program-level export packages the program's projects together; it is a program operation with no per-project or workspace equivalent. |

## Backing API

The inheritance model is exposed entirely through the existing settings endpoints —
there are no new endpoints.

| Scope | Endpoint | Override fields (writable) | Resolved fields (read-only) |
|---|---|---|---|
| Workspace | `PATCH /api/v1/workspace/` | `public_sharing`, `allow_guests`, `public_sharing_override_policy` | — |
| Program | `PATCH /api/v1/programs/{id}/` | `public_sharing`, `allow_guests` (nullable; `null` = inherit) | `effective_public_sharing`, `inherited_public_sharing`, `effective_allow_guests`, `inherited_allow_guests` |
| Project | `PATCH /api/v1/projects/{id}/` | `public_sharing`, `allow_guests` (nullable; `null` = inherit) | `effective_public_sharing`, `inherited_public_sharing`, `effective_allow_guests`, `inherited_allow_guests` |

- The **override** fields on a program or project are nullable: send `null` to clear the
  override and return to inheriting; send `true`/`false` to set an explicit value.
- The **`effective_*`** fields report the resolved value that actually applies at the
  scope, after walking the precedence chain.
- The **`inherited_*`** fields report what the scope *would* inherit if its own override
  were cleared — this is what drives the "Inherit (On/Off)" indicator.

See [Workspace Settings](/administration/workspace-settings/) and
[Project Settings](/administration/project-settings/) for the rest of each scope's
General page.
