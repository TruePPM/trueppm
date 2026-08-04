---
title: Project templates
description: Reusable project shapes — phases, gates, dependencies and durations — that never carry owners, dates, or anyone else's progress.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
Project templates ship in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the latest release)
there is no template system at all: "Copy settings from" on the new-project form
copies *settings values only* — no tasks, no phases, no dependencies — and every
project starts from zero rows.
:::

A template captures a project's **shape** so the next project like it does not
start from an empty outline.

## What a template carries — and what it refuses to

This is the whole design, so it is worth stating as a table rather than burying in
prose.

| Carried | Stripped |
|---|---|
| Phase / task tree | Owners and assignees |
| Dependencies, with lag and type | Planned, actual and baseline dates |
| Durations | Percent complete and status |
| Milestones and gates | Comments, files, time entries |
| Delivery modes (waterfall / scrum / kanban) | Baselines |
| Sprint length | |

The right column is not a limitation, it is the point. A template applied in
November must not schedule to the publisher's March, and a user id from the
publishing workspace is either unresolvable in yours or — worse — resolvable to the
wrong person. Adopting a template can never import somebody else's moment into your
plan.

Durations *are* carried, because a duration is an estimate of effort: a property of
the shape, not of when the shape ran.

## Structure over content

Templates deliberately seed **phases, gates, milestones and dependencies** rather
than sixty guessed task names. The working assumption is that teams delete most of
what a template writes, and deleting is treated as a first-class act rather than a
failure — see the seeded-row provenance that makes "delete untouched rows"
computable.

If it turns out teams keep the detail, nothing is lost by having started small.

## Provenance, before you adopt

Every template in the gallery carries a chip:

| Chip | Meaning |
|---|---|
| **Workspace** | Published for everyone in this workspace |
| **Community** | Published by someone else, shared into view |
| **Yours** | You published it |

The chip is visible *before* adoption, because who published a skeleton is the
first thing most delivery leads judge it by. Workspace and Community are stored on
the template, so every reader sees the same answer; **Yours** is the one label
resolved per reader, since it is the only one that is genuinely relative to who is
asking.

Alongside the chip, each row states how many rows it will write and what it
carries.

## Applying one

Pick a template in the new-project flow. **Blank project** is the default and a
first-class choice, not an escape hatch.

Seeding runs in the background: the create sheet never blocks on it. You land on
your project and the rows arrive as the job completes, then TruePPM schedules them
against *your* calendar and start date — the dates never come from the template.

Applying a template requires the **Project Manager** role or above on the target
project. Publishing one requires the same on the source project. Anyone can *see*
the gallery.

## Undo is one step — and it keeps what you have typed

An application can be undone as a single step. It removes exactly the rows that
application wrote — nothing that was already in the project, and nothing another
application added.

It deliberately **keeps any row somebody has since edited**, and tells you how
many it kept. Undoing a template five minutes after a teammate started filling in
one of its rows must not take their work with it: leaving a row behind is
disappointing, deleting a sentence somebody wrote is not recoverable.

## Publishing

Publish from a project that already has the shape you want to reuse. TruePPM reads
its task tree and dependency edges, strips everything in the right-hand column
above, and freezes the result.

Frozen is the operative word: the template does **not** stay linked to the project
it came from. Editing, archiving or deleting that project afterwards leaves every
published template untouched — otherwise a skeleton two teams had already adopted
could change under them, or vanish.

A project can carry at most 2,000 rows into a template.
