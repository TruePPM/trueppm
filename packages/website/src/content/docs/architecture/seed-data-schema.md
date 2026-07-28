---
title: Seed data schema
description: The canonical JSON seed format — its design choices, and how to author a new sample.
---

This page is for developers authoring or modifying a bundled sample, or building
an importer that targets the canonical format. If you just want to load or
export demo data, see [Sample projects & JSON import/export](/getting-started/sample-projects/).

:::note[The seed is the normalization target]
Every importer normalizes to this format rather than writing to the database
directly — that is what keeps one validation pass and one round-trip guarantee in
front of every ingress path. The contract around the schema (fidelity tiers,
identity model, limits, error model, and how CSV differs) is the
[data interchange specification](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/specs/data-interchange.spec.md)
and [ADR-0634](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0634-file-interchange-contract-json-seed-and-csv.md).
:::

## The format

One seed document describes one program and all of its projects. The JSON
Schema is the contract:

- **v2** — `packages/api/src/trueppm_api/apps/projects/schemas/seed_v2.json`
  ([ADR-0114](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0114-seed-schema-v2-relative-dates-event-replay.md)).
- **v1** — `seed_v1.json` ([ADR-0109](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0109-canonical-json-seed-import-export-schema.md));
  still loads. v2 is an additive superset.

`validate_seed()` checks a document against the schema for its major version and
then runs a referential-integrity pass (no dangling slug or task references)
that JSON Schema cannot express. Every error is anchored to a JSON path.

## Worked examples: the bundled fixtures

The prose below explains the format's shape. The four bundled fixtures *are* the
format — correct, non-trivial, and validated on every CI run. Reading one beats
inferring from a description, so they are downloadable from any running instance
rather than only from a repository checkout:

| Sample | Download | What it demonstrates |
| --- | --- | --- |
| Atlas Platform Launch | `GET /api/v1/programs/samples/atlas-platform-launch/download/` | The largest surface — a hybrid multi-project program, cross-project dependencies, three-point estimates, baselines, and a populated risk register. |
| Aurora Mobile App | `.../aurora-mobile-app/download/` | Pure agile — an epic-grouped backlog, sprints with velocity history, no CPM. |
| Bayside Civic Center | `.../bayside-civic-center/download/` | Pure waterfall — all four dependency types, working calendars, calendar-aware lag, a contract baseline plus a change-order rebaseline. |
| Helios CRM Replacement | `.../helios-crm-replacement/download/` | The entry-level hybrid — a completed waterfall phase feeding an agile build phase across one cross-phase dependency. |

In the UI the same list lives at **Settings → System → Demo data**, with each
file's size, entity counts and SHA-256. The catalog endpoint
(`GET /api/v1/programs/samples/`) returns the same metadata as JSON.

The counts shown beside each file come from the same `inspect_seed()` that backs
the dry run (`POST /api/v1/programs/import/validate/`,
[ADR-0651](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0651-seed-import-dry-run.md)),
so the catalog and the validator cannot disagree about a document.

:::note[Two demo programs are not files]
`seed_demo_project` and `seed_ga_launch_program` build their data procedurally in
Python rather than from a fixture, so there is nothing to download or verify for
those two. The four above are the inspectable ones — auditing them is not the
same as auditing every way this codebase can produce demo data.
:::

## Why the format looks the way it does

**ltree WBS paths.** Tasks are identified within a project by an ltree path
(`"1.2.3"`) rather than a UUID, so a seed file carries stable, human-readable,
per-project task identity. Cross-project references use `"<project-slug>:<wbs>"`.

**File-local stable slugs.** Seed files carry no UUIDs — they would collide
across instances and re-imports. Instead, accounts, calendars, resources, and
sprints use kebab-case slugs that are a **file-local symbol table**: the
importer resolves them to freshly-minted UUIDs at import time. The one slug that
persists is the **program slug**, which is written into `Program.code` as the
program's natural key. That is what makes re-import idempotent — a program with
a matching `code` is replaced (wipe-then-recreate), not duplicated.

**Three-point estimates as an all-or-none sub-object.** A task's PERT estimate
is an `estimate: { optimistic, most_likely, pessimistic }` sub-object. Modelling
it as a single object makes the all-or-none invariant
([ADR-0093](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0093-msproject-three-point-pert-mapping.md))
structurally enforceable: a task has all three points or none. Imported
estimates are written as accepted, bypassing estimation governance.

**Anchor-relative dates + an events timeline (v2).** A v1 seed pins absolute
dates, so a bundled demo ages. v2 instead authors dates as offsets from an
import-day **anchor** (`"A-120"`, `"A+15"`), weekend-snapped to a working day
via the project calendar — so the demo always reads as current. On top of that,
an ordered `events` array is **replayed with backdated history**: each beat
writes a history row dated to the event, so a completed task shows dated
transitions by named people, closed sprints accumulate real burndown snapshots,
and velocity is actual history. A deterministic synthesizer fills the unauthored
"boring middle" — any task whose final column implies it passed through earlier
ones gets synthetic transitions, seeded reproducibly per program and task so
re-import is stable.

The implemented v2.0 action set covers status, assignment, estimate, points,
comment, AC-met, sprint activate/close, scope inject/resolve, baseline capture,
and risk status. `retro.*` and `time.log` are deferred — they need the retro and
time-entry models respectively
([#1109](https://gitlab.com/trueppm/trueppm/-/issues/1109),
[#926](https://gitlab.com/trueppm/trueppm/-/issues/926)).

## Authoring a new sample

The bundled samples are **generated** by developer scripts, then committed as
schema-validated fixtures — never hand-edited as raw JSON:

- `scripts/seeds/build_atlas_seed.py` — Atlas (hybrid-large).
- `scripts/seeds/build_samples.py` — Aurora, Bayside, Helios.

Each script builds the document in Python, validates it against the schema, and
writes the fixture under
`packages/api/src/trueppm_api/apps/projects/fixtures/seeds/`. To add a sample:

1. Add a builder to one of the scripts (or a new one), emitting `schema_version`
   `"2.0"` and anchor-relative dates.
2. Re-run the script to regenerate and validate the fixture.
3. Register the sample's key and filename in
   `apps/projects/seed/samples.py` so the loader and picker surface it.

Seed files are **self-contained** by design (ADR-0109) — a document carries
everything it needs, with no references to external files. The shared demo cast
(consistent people, roles, and capacity profiles reused across samples) is
therefore a **shared authoring convention in the build scripts**, not a separate
`sample-resources.json` the importer would have to dereference.
