---
title: Sample projects & JSON import/export
description: Load a whole program from a JSON seed file, and export any program back out.
---

:::note[Added in 0.3]
Sample projects and JSON seed import/export were added in 0.3, available since the `0.3.0-alpha.1` pre-release (Jun 28, 2026). See the [roadmap](/overview/roadmap/).
:::

TruePPM uses one canonical JSON format to seed sample projects and to move whole
programs in and out of an instance. A single seed document describes a program
and all of its projects — tasks (with WBS paths and three-point estimates),
dependencies, sprints, baselines, risks, resources, and memberships.

The format is **v2** (the JSON Schema lives at
`packages/api/src/trueppm_api/apps/projects/schemas/seed_v2.json`, with the
design rationale in [ADR-0114](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0114-seed-schema-v2-relative-dates-event-replay.md)).
v2 is an additive superset of v1 ([ADR-0109](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0109-canonical-json-seed-import-export-schema.md));
v1 files still load. The developer-facing
[seed data schema reference](/architecture/seed-data-schema/) explains the
format if you want to author your own sample.

The headline of v2 is that **a sample imports as a program already in flight,
not a snapshot.** Dates are anchor-relative, so a freshly loaded demo always
reads as current rather than aging into a fixed-date museum piece. And an event
timeline is replayed with backdated history, so:

- tasks show **dated status transitions, reassignments, and comments by named
  people** in their History tab — including the occasional review bounce-back,
- closed sprints show **real burndown curves**, a **velocity trend with a
  spread**, and an honest **goal verdict**,
- mid-sprint scope changes and **risk-status lifecycles** are recorded as dated,
  attributed history, and
- completed work carries actuals you can compare against the **baseline**.

:::tip[Evaluating TruePPM?]
The [Evaluation guide](/getting-started/evaluation-guide/) maps every 0.3
capability to a sample, a persona login, the exact screen, and what you should
see — a ~30-minute walkthrough.
:::

## Load the demo data

The fastest way to see TruePPM with real data is a bundled demo. On a fresh
install the **Programs** page shows a **Load demo data** button — it offers a
short menu of samples; pick one and you land on a fully populated program. A
dismissable **Start exploring** guide appears on the landing page with a couple
of suggested first steps for the sample you chose.

You can also load a demo straight from **My Work** when you have nothing assigned
yet: that path drops you on a project **Board** with the demo's first open sprint
already assigned to you, so your own work is visible immediately rather than a
PM-facing overview.

While the first schedule pass runs after a load, the Schedule view shows a
non-blocking *Recalculating…* badge, so dashed dates read as "processing", not
"broken." A *this is sample data* banner sits on the program, and a compact
*Demo project — part of …* indicator appears on each project view so you always
know you are in demo data. **Remove sample data** (program owner only) tears the
whole demo down when you are ready to start your own work — it also removes any
changes you made to the demo, but never touches your own projects.

### What each sample demonstrates

Four samples ship. Every one exercises the five-role RBAC model
(Owner / Admin / Scheduler / Member / Viewer), realistic **capacity profiles**
(full-time, part-time, and 10% advisors — not everyone is at 100%), and a
**non-default working calendar** attached to at least one resource so
calendar-aware capacity is visible.

#### Atlas Platform Launch — hybrid-large (the flagship)

A fictional B2B SaaS launch: one program, three projects that span the
methodology mix, 68 tasks, a 15-plus person resource roster across calendars,
and a **20-risk register**.

- **Platform Core** (agile) — sprints with a velocity history feeding a release
  forecast.
- **Migration Tooling** (waterfall) — a CPM-scheduled plan with three-point
  estimates and a captured baseline.
- **GTM Readiness** (hybrid) — gated launch planning with agile enablement work.

**Look at first:** the cross-project critical path — Platform Core gates
Migration, which gates the public-launch milestone — and the **Monte Carlo**
modal: several risks are schedule-driving, so toggling a high
probability × impact risk visibly shifts the P80.

**Personas:** the program-level story — a program manager (and Sarah, the PM, on
the waterfall project) running related agile, waterfall, and hybrid projects at
once, with Alex's sprints on Platform Core feeding Jordan's release forecast and
Sarah's CPM plan on Migration Tooling. This is the bridge demo at program scale.

#### Aurora Mobile App — agile-only

A mobile product team running the sprint lifecycle: an **epic-grouped backlog**
of user stories, a board, a multi-sprint **velocity trend** with a spread, and a
lightweight 4-risk register.

**Look at first:** the burndown of the closed sprints and the velocity chart —
this is the pure-scrum tour, with no CPM or estimates to distract.

**Personas:** the agile team — Alex (Scrum Master) running the sprint lifecycle,
Jordan (Product Owner) owning the backlog and the velocity-based release
forecast, and Priya (team member) working the board. No PM and no schedule:
this is the surface those three live on.

#### Bayside Civic Center — waterfall-only

A construction program: CPM with **all four dependency types** (FS / SS / FF /
SF), three-point estimates, a baseline, a 4-day concrete-crew calendar, and a
**12-risk register** spanning the full status lifecycle (permits, supply chain,
weather, inspections).

**Look at first:** the critical path and the baseline-vs-actual slip.

**Personas:** Sarah (the construction PM) — a single waterfall project, CPM with
all four dependency types, a baseline to defend, and a risk register. This is her
home turf: no sprints, no backlog, just the schedule and what moves when a task
slips.

#### Helios CRM Replacement — hybrid-small

A completed waterfall planning phase feeding an agile build phase, joined by a
cross-phase dependency, with a **5-risk register** that includes one realized
risk with a captured impact.

**Look at first:** how the finished plan hands off to the live build sprints.

**Personas:** the hybrid bridge — Sarah's completed waterfall planning phase
handing off across a cross-phase dependency to Alex and Jordan's agile build
sprints. The entry-level story for a PM and an agile team sharing one plan
without maintaining two representations of the same work.

### Loading from the command line

```bash
python manage.py load_sample_project                          # Atlas (default)
python manage.py load_sample_project --sample aurora-mobile-app
python manage.py load_sample_project --sample bayside-civic-center
python manage.py load_sample_project --sample helios-crm-replacement
```

Or over the API: `POST /api/v1/programs/load-sample/` (any authenticated user;
the caller becomes the program owner).

## Import a seed file

### From the web app

On the **Programs** page, choose **Import from JSON** and pick a seed file. The
program is created and owned by you, and you land on it once the import
finishes. If the file fails validation, the page lists each problem with its
JSON path so you can fix the file and try again.

### From the command line

```bash
python manage.py import_seed path/to/seed.json [--owner <username>] [--create-users]
```

- `--owner` sets the program owner (defaults to the first superuser).
- `--create-users` creates the user accounts the seed references if they do not
  already exist. Use it for local demos; leave it off in
  production. The REST endpoint always runs with user creation **off** — an
  import never mints logins on a live instance.

Re-importing the same file is idempotent: a program with the same slug is
replaced rather than duplicated.

### Over the API

```
POST /api/v1/programs/import/
```

Send either a JSON body or a `multipart/form-data` upload with a `file` field.
Any authenticated user may import (they become the program owner). A validation
failure returns `400` with `{"errors": [ ... ]}`.

## Export a program

See [Data export](/administration/data-export/) for the full operator
reference. In short:

- **Web:** open **Program → Settings → General** and choose **Export to JSON**.
- **CLI:** `python manage.py export_program <program-slug> --out program.json`
- **API:** `GET /api/v1/programs/{id}/export/` (any program member, Viewer and
  above).

:::caution
An exported seed file includes the email addresses of the program's members and
resources (the same details members already see in the app). Treat exported
files as you would any file containing contact information. No passwords,
tokens, or internal IDs are ever exported.
:::

## Round-trip guarantee

Export emits a **final-state** seed: exporting a program, re-importing the
result into a clean database, and exporting again produces a byte-identical
file. Derived data — internal IDs, schedule (CPM) results, sync versions — is
never written into a seed file; it is recomputed on import.

:::note
Export currently writes the program's **final state**, not its replayed event
history. A v2 sample therefore exports as a final-state document, and
re-importing it materializes that final state without re-running the backdated
timeline. Exporting the full event timeline is tracked as a follow-up
([#1109](https://gitlab.com/trueppm/trueppm/-/issues/1109)).
:::
