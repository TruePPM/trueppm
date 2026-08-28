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

### External references, blockers, and risk narrative

Three capabilities the product models had no seed surface for until 0.4, so no
bundled sample could demonstrate them.

**`tasks[].attachments[]`** is **URL-only**: `{external_url, external_title?,
is_pinned?, uploaded_by?}`. `TaskAttachment` enforces file XOR `external_url` at
the database level, and a seed is a text document with no bytes to carry, so the
file half is deliberately inexpressible rather than half-supported. Note that
`links` is a different key entirely — it is the task-to-task `TaskRelation`
graph (*relates to* / *blocks* / *duplicates*), not external references.

**`tasks[].blocked`** is the explicit human blocker flag (ADR-0124), not the
derived "has incomplete predecessors" signal the board card owns:
`{reason, since?, type?, blocking_task?, by?}`. `reason` is the flag of record —
non-empty means blocked. `blocking_task` is a **soft** "waiting on" link that
never enters CPM; a scheduling constraint is a `dependencies[]` edge.

`since` matters more than it looks. `Task.save()` stamps `blocked_since` with
`timezone.now()`, but the importer inserts through `bulk_create_tasks`, so
`save()` never runs and nothing stamps it — an unstamped blocker renders no age,
and age is the entire triage signal ("3 tasks blocked more than a week"). The
importer therefore sets it explicitly, falling back to the task's planned start
and then the project's, so the value is never null while the flag is raised.

**`task.block` / `task.unblock` events** give a blocked span a real duration on
the timeline. `task.block` writes the flag and backdates `blocked_since` to the
beat; `task.unblock` empties `reason` only and lets `Task.save()` run its own
cascade (clearing `blocked_since`, `blocker_type`, `blocking_task` and
`blocked_by`), so "unblocked" has exactly one definition.

**`risk.note` events** append a `RiskComment`, giving a `risk.status` flip its
reason. Without it a risk walks `OPEN → MITIGATING → RESOLVED` with no artifact
of the work — the register records *that* a risk was mitigated and never *how*.
Unlike `risk.status`, notes are reconstructed on export: a comment is
append-only and does not depend on the risk's current status, so replaying it
reproduces the rows it came from.

### The schema is a two-way contract

`additionalProperties: false` is set on every definition, so an **unknown** key
is a validation error. The reverse — a key the schema *declares* that no reader
implements — is the more dangerous direction, because the schema tells an author
it works. Four keys shipped that way and were only found by audit:
`task.dor`, `project.board_columns`, `project.agile_features`, and
`baseline.captured_at`.

`test_declared_keys_are_implemented` now closes that direction: every key
declared in either schema must be mentioned by `importer.py`, `replay.py`, or
`forecast_backfill.py`. A key that is genuinely read some other way needs an
entry in that test's `_EXEMPT` map **with the reason** — an unexplained
exemption would let the gate be silenced by adding a line, which is the failure
it exists to prevent.

Three consequences worth knowing when authoring:

- **`baseline.captured_at` is honored.** It sets `Baseline.created_at`, which is
  otherwise `auto_now_add`. The interval between two baselines is what
  planned-vs-actual is measured over, so a rebaseline authored 75 days after its
  contract baseline must land 75 days after it.
- **`board_columns` mirrors `BoardColumnConfig`**, not a list of labels. Each
  entry is `{status, label, visible, color?, wip_limit?, age_threshold_days?,
  lanes?}` and all five canonical statuses must appear exactly once — `status` is
  what every downstream reader (burndown, WIP, velocity) keys on, and a label
  list cannot carry it. Omit the key entirely to leave a project on the API's
  defaults; emitting them would turn "uses the defaults" into "pinned today's
  defaults", which is a different claim on re-import.
- **`project.health` is a PM override, not a computed value.** Omit it (or set
  `AUTO`) to leave the project's chip to the rollup. The explicit values —
  `ON_TRACK`, `AT_RISK`, `CRITICAL` — say a human made a judgment, so a pack that
  sets one on every project turns the chip into decoration. Atlas sets exactly
  one, on Migration Tooling, and leaves the other two on `AUTO` so the difference
  is legible.

### Who can see a project: `accounts[].role` vs `projects[].members[]`

A seed carries two different membership levels, and confusing them produces a
pack whose personas cannot open anything:

- **`accounts[].role`** grants a **program** membership. That reaches the program
  rail and **no project**.
- **`projects[].members[]`** grants **project** memberships — `{account, role}` —
  and project access is scoped by these. This is the one a persona needs in order
  to see a project at all.

Omit `members` and every account is granted its program-level role on that
project, so a pack written before the key existed still works. Declare it and it
**replaces** the fallback for that project: only the accounts listed become
members. That replacement is the point — it is what lets one person hold
different roles on different projects, which is the only way a seed can
demonstrate project-scoped RBAC:

```json
{
  "slug": "platform-core",
  "members": [
    { "account": "priya", "role": "ADMIN" },
    { "account": "jordan", "role": "MEMBER" }
  ]
}
```

In `atlas-platform-launch.json`, `priya` is `ADMIN` on Platform Core, `MEMBER` on
Migration Tooling, and absent from GTM Readiness.

Two rules the importer enforces regardless of what a seed says. The importing
user is always granted `OWNER` and can never be demoted by a `members` entry
naming them. And an account that resolved to `None` — a pre-existing real user on
an untrusted import — is skipped, so a crafted seed cannot pull a stranger into a
program. A `members` entry naming no `accounts[]` slug is a validation error
rather than a silent skip, because the silent version reproduces exactly the
blindness the key exists to fix.

## Worked examples: the bundled fixtures

The prose below explains the format's shape. The four bundled fixtures *are* the
format — correct, non-trivial, and validated on every CI run. Reading one beats
inferring from a description, so they are downloadable from any running instance
rather than only from a repository checkout:

| Sample | Download | What it demonstrates |
| --- | --- | --- |
| Atlas Platform Launch | `GET /api/v1/programs/samples/atlas-platform-launch/download/` | The largest surface — a hybrid multi-project program, cross-project dependencies, all four dependency types plus a lead, three-point estimates, two baselines on one project (a kickoff capture and the re-plan that superseded it), a calendar exception that moves the program finish, a manual health override, and a populated risk register with mitigation arcs. |
| Aurora Mobile App | `.../aurora-mobile-app/download/` | Pure agile — an epic-grouped backlog and a sprint history that goes wrong and recovers: an epic descoped mid-sprint after beta feedback, the velocity dip that causes and the sprint that climbs back out, a cancelled sprint whose scope folds forward, capacity that moves with leave and holidays, and a sprint-zero baseline to measure the pivot against. No CPM. |
| Bayside Civic Center | `.../bayside-civic-center/download/` | Pure waterfall under constraint — all four dependency types, calendar-aware lag, a contract baseline plus a change-order rebaseline captured months apart, and a site calendar whose stand-downs actually bite: a crane window that stretches the framing tail and is absorbed by its float, and a contract weather allowance that pushes the certificate of occupancy. Its risk register carries triggers and contingencies, one **realized** risk whose mitigation failed and whose contingency shows up as baseline variance, and the only `TRANSFER` response in any pack, with its terms and its limits stated. |
| Helios CRM Replacement | `.../helios-crm-replacement/download/` | The entry-level hybrid — a completed waterfall phase feeding an agile build phase across one cross-phase dependency, sprints that state the goal their outcome is judged against, a mid-sprint injection the team **rejects**, and a mitigation arc that costs something: a dry-run harness scheduled against the migration risk, paid for by displacing another story out of the sprint. |

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
a matching `code` is replaced, not duplicated. The seed format carries no stable
entity ids until 0.5 ([#1959](https://gitlab.com/trueppm/trueppm/-/issues/1959)),
so there is nothing for a field-level merge to key on: replace-then-rebuild is
the correct idempotency model for this format. Because it is destructive, the
REST import refuses a collision until the caller confirms it, and the
replacement is a **soft** delete — the replaced program's projects move to
project Trash, where each can be restored individually as a standalone project.
The program shell itself is **not** recoverable, and a restored project does not
return to it. Only the disposable demo path (`is_sample`) still hard-deletes.
See [ADR-0726](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0726-seed-import-confirmed-replacement-and-async-rebuild.md).

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
