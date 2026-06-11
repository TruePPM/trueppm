---
title: Seed data schema
description: The canonical JSON seed format — its design choices, and how to author a new sample.
---

This page is for developers authoring or modifying a bundled sample, or building
an importer that targets the canonical format. If you just want to load or
export demo data, see [Sample projects & JSON import/export](/getting-started/sample-projects/).

## The format

One seed document describes one program and all of its projects. The JSON
Schema is the contract:

- **v2** — `packages/api/src/trueppm_api/apps/projects/schemas/seed_v2.json`
  ([ADR-0114](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/0114-seed-schema-v2-relative-dates-event-replay.md)).
- **v1** — `seed_v1.json` ([ADR-0109](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/0109-canonical-json-seed-import-export-schema.md));
  still loads. v2 is an additive superset.

`validate_seed()` checks a document against the schema for its major version and
then runs a referential-integrity pass (no dangling slug or task references)
that JSON Schema cannot express. Every error is anchored to a JSON path.

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
([ADR-0093](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/0093-msproject-three-point-pert-mapping.md))
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
([#1109](https://gitlab.com/trueppm/trueppm-suite/-/issues/1109),
[#926](https://gitlab.com/trueppm/trueppm-suite/-/issues/926)).

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
