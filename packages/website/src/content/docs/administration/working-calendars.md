---
title: Working Calendars
description: Set the working-day calendar at the workspace, program, and project scope, with parent-to-child inheritance and an Enterprise lock-down policy.
---

A project's **working calendar** — its working days, hours per day, timezone, and
holiday/shutdown exceptions — can be set at the **workspace** and **program** scope, not
just per project. A value set higher **inherits down** to every program and project
below it, where an Owner or Admin can override it for that scope. This page explains how
the Workspace → Program → Project inheritance model resolves the calendar that actually
schedules a project, who may override it, and how a calendar change ripples through the
schedule.

For what a calendar itself contains — working days, hours per day, timezone, holiday
exceptions, and how multiple calendars compose as overlays on one project — see
[Calendars](/features/calendars/). This page is about **which** calendar applies at a
given scope, not what a calendar contains.

:::note[Edition]
Per-scope working-calendar assignment (inherit, then override) is part of the
**Community (OSS)** edition. The ability to *lock* the workspace calendar as a hard
ceiling that downstream scopes cannot override (the **Enforce** policy) is an
**Enterprise** capability.
:::

## The working calendar setting

| Scope | Field | What it controls |
|---|---|---|
| **Workspace** | `calendar` | The default calendar for every program and project in the workspace that has no override. |
| **Program** | `calendar` | Overrides the workspace default for every project in the program that has no override of its own. |
| **Project** | `calendar` | Overrides the program (or workspace) default for that one project. Unchanged from today — this is the calendar a project has always carried. |

Leaving a scope's `calendar` unset (`null`) means "inherit" — it is not the same as
"no calendar." A project, program, or workspace that sets no calendar of its own always
resolves to *something*, down to the system default described below.

## The inheritance model

The **effective calendar** — the one CPM actually schedules against — is **resolved on
the server** and returned to every client (web, mobile, API), so no client re-implements
the precedence. The chain is:

```
Workspace calendar  →  Program override  →  Project override
    (the default)         (optional)             (optional)
```

**Precedence — most specific wins:**

1. If the **project** sets an explicit calendar, that calendar applies.
2. Otherwise, if the project's **program** sets an explicit calendar, that calendar applies.
3. Otherwise, the **workspace** calendar applies.
4. If nothing in the chain sets a calendar, the **system default** applies: Monday–Friday,
   8 hours/day, UTC.

A standalone project (one not in a program) inherits directly from the workspace. A
program inherits directly from the workspace; a project in that program inherits the
program's resolved calendar. The system default is a code-level fallback, not a calendar
record — no "System Default" calendar is created in your calendar library.

In the community edition, the parent value is a **default, not a ceiling**. A program or
project may override the inherited calendar with a different one even when the workspace
(or program) sets its own — swap in a four-day week for one project even though the
workspace runs Monday–Friday. (The Enterprise **Enforce** policy changes this; see
[Locking the workspace calendar](#locking-the-workspace-calendar-enterprise).)

### Inherit vs. override

Each program or project stores its calendar assignment as a nullable field:

- **No calendar set** → the scope **inherits** the resolved parent calendar. This is the
  default for every new program and project.
- **Calendar set** → the scope uses that calendar, regardless of the parent.

Choosing **Inherit** on the settings page clears the override and the scope falls back
to the parent's resolved calendar. The settings page shows an **"Inherited from
{scope}"** indicator naming where the current calendar actually comes from — which may
be the program, the workspace, or the system default — and overriding is presented as a
first-class, equal choice, not a warning-worthy exception.

## Effect on the schedule

CPM, Monte Carlo, the program schedule view, and MS Project export all schedule a
project against its one resolved **effective calendar** — there is only ever one
precedence computation, in one place on the server, so every consumer agrees.

Changing a calendar at the workspace or program level is not just a settings edit: it
**automatically reschedules** every project that inherits it. Reassigning the workspace
calendar recomputes every project in the workspace that has no program or project
override; reassigning a program's calendar recomputes that program's non-overriding
projects. Recomputes are dispatched asynchronously through the existing scheduling
queue, so a large workspace change enqueues many jobs rather than blocking the request
that made it.

A project's own [calendar overlays](/features/calendars/#composable-working-calendars)
(holiday and shutdown calendars applied on top) are a separate, orthogonal mechanism —
inheritance picks the **base** calendar; overlays still compose on top of whichever base
resolves.

## Locking the workspace calendar (Enterprise)

The workspace carries a **calendar override policy** (`calendar_override_policy`) with
three values:

- **Suggest** (the default) — the workspace calendar pre-fills new programs and
  projects, but any scope can override it.
- **Inherit** — every program and project follows the workspace calendar; the per-scope
  calendar picker renders read-only.
- **Enforce** — the workspace calendar is mandatory and cannot be overridden below it.

:::caution[Enforce is an Enterprise capability]
**Enforce only takes effect in the Enterprise edition.** In the community edition the
field exists but there is no enforcement provider registered, so **Enforce silently
degrades to Suggest** — no lock is applied and downstream overrides still work normally.
Do not rely on Enforce to restrict calendar overrides on a community-edition deployment.
:::

## Who can change it

| Action | Required role |
|---|---|
| View the resolved calendar | Any member of the scope |
| Change the workspace calendar | Workspace **Owner / Admin** |
| Override a program's calendar | Program **Admin** (or higher) |
| Override a project's calendar | Project **Admin** (or higher) |

Members, Schedulers, and Viewers see the resulting schedule but cannot change which
calendar produced it.

## Where to find it

Open **Settings → Working calendar** at the scope you want to configure:

- **Workspace** — the root default for the whole workspace. Also carries the override
  policy above.
- **Program** — overrides the workspace for every project in the program that inherits.
  Shows "Inherited from workspace ({name})" when no override is set.
- **Project** — overrides the program (or workspace) for that one project.
  `General → Working calendar` shows the true resolved source, which may now be the
  project's program rather than the workspace.

## Backing API

The resolved calendar and the scope it came from are exposed as read-only facts on the
Project and Program API — first-class, additive fields so an agent or integration reads
the effective calendar without re-implementing the precedence chain itself:

| Field | Where | Meaning |
|---|---|---|
| `effective_calendar` | Project, Program | The resolved calendar that actually applies at this scope. |
| `calendar_source` | Project, Program | Where the effective calendar came from: `project`, `program`, `workspace`, or `system_default`. |
| `inherited_calendar` | Program | The calendar the program would use if its own `calendar` override were cleared — what drives the "Inherited from workspace" indicator. |

The writable `calendar` field on Project, Program, and Workspace is unchanged in shape —
this is an additive, non-breaking change. Existing projects that already set an explicit
`calendar` are unaffected: their resolved calendar is byte-identical to before this
feature.

See also [Calendars](/features/calendars/) for what a calendar contains and how overlays
compose, [Sharing & Access Inheritance](/administration/sharing-and-access/) and
[Attachment Policy](/administration/attachment-policy/) for the same
Workspace → Program → Project inheritance model applied to other settings, and
[Workspace Settings](/administration/workspace-settings/) and
[Project Settings](/administration/project-settings/) for the rest of each scope's
settings pages.
