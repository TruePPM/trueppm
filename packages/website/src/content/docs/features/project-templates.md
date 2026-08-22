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

Seeding runs in the background: the create sheet never blocks on it. TruePPM
schedules the new rows against *your* calendar and start date as soon as they
land — the dates never come from the template.

Applying a template requires the **Project Manager** role or above on the target
project. Publishing one requires the same on the source project. Anyone can *see*
the gallery.

## Landing on a seeded schedule

For a waterfall or hybrid template, applying it lands you straight on the
**Schedule** with the skeleton already scheduled, not on an empty Overview you
have to leave to find it. An agile template still lands on Overview today — its
own backlog landing is separate, later work.

A banner across the top states what just happened and gives you the fastest way
to disagree with it:

- **What was written** — the template's name, and how many rows, milestones and
  dependencies it created, plus which calendar they were scheduled against.
- **Delete untouched rows (N)** — a one-click sweep that removes every row the
  template wrote that nobody has looked at since. It only ever touches rows a
  machine wrote and a person hasn't edited; the moment you rename, reschedule, or
  otherwise touch a row, it drops out of the count and is safe from the sweep.
  Requires Project Manager or above, and asks you to confirm before it runs.
- **Undo apply (⌘Z)** — reverses the whole application in one step, same as
  described below.

Every seeded-and-untouched row also carries a small tick mark in the outline
margin, so you can see at a glance which rows are still exactly as the template
wrote them.

None of this is a commitment you have to act on. Dismiss the banner and keep
working — the tick marks and the delete offer stay available for **seven days**
after a row is seeded, whether or not you ever open the banner again.

### The Next strip

Below the schedule, a second strip — separate from the banner — surfaces a few
things worth doing, in plain language, derived from the plan itself rather than a
fixed checklist:

- rows nobody has assigned an owner to,
- milestones nobody has confirmed since the template wrote them,
- and phases that are not yet connected to the rest of the plan by any
  dependency.

Like the banner, none of this is required — it states so plainly — and it
disappears entirely once there is nothing left worth flagging, rather than
nagging about rows you have already looked at.

## Undo is one step — and it keeps what you have typed

An application can be undone as a single step. It removes exactly the rows that
application wrote — nothing that was already in the project, and nothing another
application added.

It deliberately **keeps any row somebody has since edited**, and tells you how
many it kept. Undoing a template five minutes after a teammate started filling in
one of its rows must not take their work with it: leaving a row behind is
disappointing, deleting a sentence somebody wrote is not recoverable.

## What ships with the install

Three starters ship with TruePPM, one per methodology, so the **Template** way in
is never empty on a fresh install:

| Starter | Methodology | Shape |
| --- | --- | --- |
| **Scrum product team** | Agile | Discovery, then two sprints that build a walking skeleton before a real slice |
| **Stage-gate delivery** | Waterfall | Five gated phases with a hold point at each |
| **Regulated release** | Hybrid | A gated validation branch beside a sprint-driven build branch |

They carry a **Bundled** provenance chip and sort last in the gallery: on a
workspace that has published its own shapes, those are the ones worth reading
first.

They are deliberately small. A starter is a shape to argue with, not a plan —
enough structure that the phases and the dependency spine are visible, few enough
rows that deleting the half that does not apply is a minute's work.

## Publishing a template

**Project → Settings → Templates.** The page opens on six counts — tasks, phases,
gates, dependencies, milestones and methodology — computed by the server from the
same extraction the publish itself runs, so the number you approve is the number
that gets written.

Publishing needs **Project Manager** role on the source project. Everything a
template would carry is already visible to any member in the Schedule; publishing
is the only act that is gated.

The form asks for a name, a description and a methodology, then states — read
only — what will and will not be carried. That inventory is not a set of toggles
on purpose: per-publish "carries" switches produce templates that differ in
invisible ways, and two templates with the same name that bring different things
destroy the comparability templates exist for.

The methodology also decides where an adopting project lands: an **Agile**
template opens on a seeded Product Backlog, not on a Schedule of dateless bars.

Below the inventory sits **the card itself** — the same card a delivery lead will
meet in the gallery, rendered live from what you have typed. The choice your
template actually faces is a side-by-side one against every other shape on the
list, and a name that reads fine in a text field can still be the one nobody
picks. The description is the only line that argues for it, which is why the
field asks who the template is *for* rather than what it contains.

### Republishing writes a new version

A name that is already taken comes back as a conflict, not a silent overwrite,
and offers to publish the next version instead. The earlier version stays
published and selectable, marked **superseded**.

That is deliberate. Projects already created from v1 are the only record of why
they look the way they do, and a version edited underneath them turns that record
into a lie.

Nobody is notified when you publish. A template is an option that appears, not an
announcement — if the PMs should know, that is a message you send.

### Frozen at publish

Frozen is the operative word: the template does **not** stay linked to the project
it came from. Editing, archiving or deleting that project afterwards leaves every
published template untouched — otherwise a skeleton two teams had already adopted
could change under them, or vanish.

Deleting the source project clears the provenance line and leaves the template
working.

A project can carry at most 2,000 rows into a template.

## Template divergence

Once a template has been applied, **Project → Settings → Template divergence**
states how the project has moved away from it. Four counts, over the rows the
template wrote:

| Count | What it means |
| --- | --- |
| **Unchanged** | Still exactly as the template wrote them — nobody has touched the row. |
| **Adapted** | Someone on the project edited the row after it was seeded. |
| **Removed** | The row was deleted after the template wrote it. |
| **Added** | Rows in the project that no template wrote, including any that predate the adoption. |

Above the counts is the provenance line — which template, which version, who
applied it and when. That line survives the template being deleted: the name and
version are recorded on the project's adoption record, so "this came from Delivery
Skeleton v3" outlives v3.

A project that was never created from a template says so, and reports nothing else.

### The digest is symmetric — the team reads it first

The page is readable by **every member of the project, Viewer included**, and it
is the same page for everyone. There is no fuller version for a PMO, no second
endpoint, and no audience parameter — a program manager looking at one project's
divergence and that project's own team are reading the identical report.

That is not a courtesy. A report about a team's decisions that the team cannot
read is surveillance with better typography, so the team-side page ships first and
the API has exactly one route for it.

### It is a signal, never a gate

Nothing on this page approves, rejects, queues, or scores anything. There is no
compliance percentage, no health band, and no action that submits the project for
review. Divergence is information, and adapting a template is the expected
outcome — the parts a team changed are the parts that did not fit, which says as
much about the template as about the project.

Templates are authorable centrally and adoptable locally. Hard enforcement is
deliberately not here.
