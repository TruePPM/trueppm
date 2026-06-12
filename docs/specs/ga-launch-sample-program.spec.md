# Spec: "1.0 GA Launch" hybrid sample program (seed data)

**Type:** Feature — seed/demo data
**Edition:** OSS (`trueppm-suite`) — see Boundary Check below
**Tracking:** [#1151](https://gitlab.com/trueppm/trueppm/-/issues/1151); blocked by [#1150](https://gitlab.com/trueppm/trueppm/-/issues/1150) (cross-project dependencies, [ADR-0120](../adr/0120-cross-project-dependencies-within-program.md))
**Goal:** Ship a realistic, multi-project sample **program** that demonstrates TruePPM's hybrid P3M story end to end: CPM scheduling, an agile overlay, cross-project dependencies, shared-resource contention, and the 5-role RBAC matrix — all inside a single OSS `Program`.

---

## 1. Why this exists (intent — read before coding)

The current demo seed (`seed_demo_project`) creates standalone projects. It does **not** show the thing that makes a P3M tool worth using: **a program of related projects where shared people and cross-project dependencies create real coordination pressure.**

The design principle for the data: **projects are outcomes/workstreams, not departments.** Do not model "the Marketing project" and "the Compliance project" as isolated silos. Model four workstreams that ship one outcome (1.0 GA), and let the same handful of people span them so that (a) cross-project dependencies form a critical path *across* projects and (b) shared resources are over-allocated in overlapping windows. The overlap is the point, not an incidental detail.

This is an OSS deliverable. It creates *data* that surfaces within-program contention; it does **not** implement cross-program resource leveling (that's Enterprise). See §9.

---

## 2. Target entities (already exist — do not create new models)

Reference the real models. All use UUID PKs and extend `VersionedModel` (auto-incrementing `server_version`, `is_deleted` soft-delete) unless noted.

| Concept | Model | Path |
|---|---|---|
| Program | `Program` | `packages/api/src/trueppm_api/apps/projects/models.py` |
| Project | `Project` | `apps/projects/models.py` |
| Task | `Task` | `apps/projects/models.py` |
| Dependency | `Dependency` | `apps/projects/models.py` |
| Sprint | `Sprint` | `apps/projects/models.py` |
| Sprint burndown | `SprintBurnSnapshot` | `apps/projects/models.py` |
| Board columns | `BoardColumnConfig` | `apps/projects/models.py` |
| Calendar / exception | `Calendar`, `CalendarException` | `apps/projects/models.py` |
| Resource | `Resource` | `apps/resources/models.py` |
| Task assignment | `TaskResource` | `apps/resources/models.py` |
| Project resource pool | `ProjectResource` | `apps/resources/models.py` |
| Role enum | `Role` (IntegerChoices) | `apps/access/models.py` |
| Project membership | `ProjectMembership` | `apps/access/models.py` |
| Program membership | `ProgramMembership` | `apps/access/models.py` |

Key field facts to honor:

- `Dependency.dep_type` ∈ `{"FS","SS","FF","SF"}`; `Dependency.lag` is an **integer of calendar days** (negative = lead). Unique on `(predecessor, successor, dep_type)`.
- `Task.duration` is **working days**; CPM outputs (`early_start/finish`, `late_start/finish`, `total_float`, `free_float`, `is_critical`) are **computed by the scheduler — never set them in the seed.** Use `planned_start` (SNET floor) to anchor tasks where needed.
- `Task.is_milestone=True` ⇒ duration 0.
- Agile fields on `Task`: `sprint` (FK), `story_points`, `type` ∈ `{EPIC,STORY,TASK,BUG,SPIKE}`, `governance_class` ∈ `{GATED,FLOW,HYBRID}`, `delivery_mode` ∈ `{WATERFALL,SCRUM,KANBAN,MILESTONE}`.
- `Resource.max_units` and `TaskResource.units` are decimals where `1.0 = 100%`. Over-allocation = sum of overlapping `units` for one resource exceeding `max_units`.
- `Role`: `VIEWER=0, MEMBER=100, SCHEDULER=200, ADMIN=300, OWNER=400`.
- `Sprint.state` ∈ `{PLANNED, ACTIVE, COMPLETED, CANCELLED}`; velocity-excludable via `exclude_from_velocity`.
- Set `Project.is_sample=True` and `Project.agile_features` appropriately per project (below).

---

## 3. Decision: how to ship the seed (resolve first)

There are two existing mechanisms. **Pick one and justify in the MR description.**

1. **Canonical seed JSON (ADR-0109)** — author a JSON document validated by `validate_seed()` and loaded by `import_seed()` (`apps/projects/seed/`), wrapped in a thin idempotent management command. **Preferred** if the schema can express everything this spec needs.
2. **Imperative management command** — mirror `apps/projects/management/commands/seed_demo_project.py` (idempotent: clear-by-name then re-create; create User personas; activate baseline after CPM settles).

**Before choosing, read:** `docs/adr/` entry for ADR-0109, the seed JSON Schema + `apps/projects/seed/importer.py`, and `seed_demo_project.py`. Then verify the canonical format can represent **all** of: `Program` + `ProgramMembership`, multiple `Project`s under one program, **cross-project `Dependency` rows**, `Sprint` + `SprintBurnSnapshot`, `BoardColumnConfig`, `Resource`/`TaskResource`/`ProjectResource`, `is_sample`, and `CalendarException`. If any of these can't be expressed in the canonical schema, either (a) extend the schema + importer (document in the MR and the ADR), or (b) fall back to the imperative command. **Do not silently drop a requirement to fit the format.**

Command name (either path): `seed_ga_launch_program`, idempotent, with `--with-personas` semantics matching `seed_demo_project`.

---

## 4. ⚠️ Open question to resolve before building tasks: cross-project dependencies

The whole demo hinges on dependencies whose predecessor and successor live in **different projects** (e.g. Marketing launch ← Security sign-off). **Verify the CPM scheduler supports cross-project `Dependency` edges** (`packages/scheduler` + the API's schedule trigger):

- **If supported:** model the cross-project links as real `Dependency` rows (listed in §6).
- **If not supported:** represent each cross-project linkage by setting the downstream task's `planned_start` (SNET) to the upstream milestone's expected finish, and add an inline comment + a note in the sample-data doc explaining the modeled intent. Open a `TODO(#NNN)` issue for true cross-project CPM if one doesn't exist.

State which path you took in the MR description. Do not assume.

---

## 5. People (personas → `User` + `Resource`)

Create each as a `User` (`username`, email `<username>@trueppm.demo`, password `demo`, matching `seed_demo_project` persona convention) **and** a linked `Resource` (`user` FK set, `job_role`, `max_units=1.0`, shared calendar).

| Persona | username | Role on the program | Spans projects |
|---|---|---|---|
| Dana Okafor | `dana` | Program manager | All (program Owner) |
| Malcolm Reed | `malcolm` | Platform engineer | Platform (lead) + Security (remediation) |
| Janus Vela | `janus` | InfoSec engineer | Security (lead) + SOC 2 (evidence) |
| Bob Tran | `bob` | Compliance officer | SOC 2 (lead) |
| Jane Castellano | `jane` | Marketing lead | Marketing (lead) |
| Lena Fischer | `lena` | Technical writer | Marketing (content) + SOC 2 (policy docs) |
| Sam Ortiz | `sam` | Backend engineer | Platform + Security (remediation) |

**Deliberate contention (must be visible after scheduling):**

- **Janus** is allocated to Security `C1–C4` at `units=1.0` while also on SOC 2 `B3` (evidence) at `units=0.5` in an overlapping window → > 100%.
- **Malcolm** is on Platform `A2` at `1.0` while pulled into Security remediation `C3` at `0.5` in the same window.
- **Lena** is on Marketing `D2/D3` and SOC 2 `B2` (policy authoring) concurrently.

---

## 6. Program & project structure

### Program
`Program(name="1.0 GA Launch", code="GALA", methodology=HYBRID, health=AUTO, visibility=WORKSPACE, lead=dana, is… )`. Description: one paragraph stating the outcome (ship TruePPM 1.0 to GA with platform scale, security sign-off, SOC 2 audit-readiness, and a coordinated launch).

Anchor all projects at **`start_date = 2026-07-06` (Monday)**. Shared `Calendar` "Standard 5-day" (`working_days=31` Mon–Fri, `hours_per_day=8`, tz `UTC`) with **one `CalendarException`** (a company holiday, e.g. `2026-09-07` Labor Day) to exercise calendar-aware scheduling/lag.

### Project A — Platform Hardening & Scale
`methodology=WATERFALL`, `agile_features=False`, lead `malcolm`, `is_sample=True`.

| id | Task | dur (d) | deps | assignees (units) | notes |
|---|---|---|---|---|---|
| A1 | Capacity baseline & load test | 5 | — | malcolm 1.0, sam 1.0 | |
| A2 | Autoscaling & HA rollout | 8 | FS A1 | malcolm 1.0 | contention w/ C3 |
| A3 | DB failover hardening | 6 | FS A1 | sam 1.0 | |
| A4 | Observability & alerting | 4 | SS A2 | malcolm 0.5 | starts with A2 |
| A5 | **Platform GA-ready** (milestone) | 0 | FS A2, FS A3, FS A4 | malcolm | gate for D5 |

### Project B — SOC 2 Type II Readiness
`methodology=WATERFALL`, `agile_features=False`, lead `bob`, `is_sample=True`. `governance_class=GATED` on tasks.

| id | Task | dur (d) | deps | assignees (units) | notes |
|---|---|---|---|---|---|
| B1 | Control gap assessment | 5 | — | bob 1.0 | |
| B2 | Policy authoring | 8 | FS B1 | bob 1.0, lena 0.5 | lena overlap w/ D2/D3 |
| B3 | Evidence collection | 6 | FS B2, **FS C5 (cross-project)** | bob 1.0, janus 0.5 | janus overlap w/ C-work |
| B4 | Internal readiness review | 3 | FS B3 | bob 1.0 | |
| B5 | **Audit-ready** (milestone) | 0 | FS B4 | bob | |

### Project C — Security Pen-Test & Remediation
`methodology=HYBRID`, `agile_features=True` (remediation Kanban), lead `janus`, `is_sample=True`. Remediation tasks `governance_class=FLOW`, `delivery_mode=KANBAN`; give the project a `BoardColumnConfig` (columns derived from `Task.status`: e.g. Backlog / Not started / In progress / Review / Complete with sensible labels + a WIP limit on In progress).

| id | Task | dur (d) | deps | assignees (units) | notes |
|---|---|---|---|---|---|
| C1 | Pen-test execution | 5 | — | janus 1.0 | |
| C2 | Findings triage | 2 | FS C1 | janus 1.0 | |
| C3 | Remediate critical findings | 7 | FS C2 | janus 1.0, malcolm 0.5, sam 0.5 | contention w/ A2/A3 |
| C4 | Re-test & verification | 3 | FS C3 | janus 1.0 | |
| C5 | **Security sign-off** (milestone) | 0 | FS C4 | janus | gate for B3 and D5 |

### Project D — GA Marketing & Launch
`methodology=AGILE`, `agile_features=True`, lead `jane`, `is_sample=True`. Two sprints (below). Stories carry `type=STORY`, `story_points`, `delivery_mode=SCRUM`.

| id | Task | type | pts | sprint | deps | assignees |
|---|---|---|---|---|---|---|
| D1 | Messaging & positioning | STORY | 5 | S1 | — | jane |
| D2 | Website & landing pages | STORY | 8 | S1 | — | jane 1.0, lena 0.5 |
| D3 | Launch blog & docs | STORY | 5 | S1 | FS D1 | lena 0.5 |
| D4 | Press & analyst outreach | STORY | 5 | S2 | FS D1 | jane |
| D5 | **GA announcement go-live** (milestone) | — | — | S2 | **FS A5, FS C5 (cross-project)** | jane |

**Cross-project dependency summary (the showcase):**

- `B3` (SOC 2 evidence) ← `C5` (Security sign-off)
- `D5` (GA launch) ← `A5` (Platform GA-ready) **and** ← `C5` (Security sign-off)

These three edges form a critical path that runs *across* projects — the visual payoff of the program view.

### Sprints (Project D)
- **S1 "Launch Readiness"** — 2 weeks, `state=COMPLETED`, `capacity_points≈18`, `committed_points=18`, `completed_points` slightly under commit (e.g. 16) to produce a realistic velocity number. Generate daily `SprintBurnSnapshot` rows across the sprint (declining `remaining_points`, at least one `scope_change_*` entry).
- **S2 "Launch Week"** — 2 weeks, `state=ACTIVE` (or `PLANNED`), `committed_points` set, partial burndown snapshots if `ACTIVE`. Set `target_milestone=D5` if milestone-binding is supported.

Velocity should be computable from S1; ensure S1 is **not** `exclude_from_velocity`.

---

## 7. RBAC (memberships)

Program: `ProgramMembership(dana, OWNER)`; add the four project leads as program `MEMBER`.

Per-project `ProjectMembership` (exercise all five roles across the program):

| Project | OWNER | ADMIN | SCHEDULER | MEMBER | VIEWER |
|---|---|---|---|---|---|
| A Platform | malcolm | dana | — | sam | janus |
| B SOC 2 | bob | dana | — | lena, janus | — |
| C Security | janus | dana | malcolm | sam | bob |
| D Marketing | jane | dana | — | lena | bob |

---

## 8. Acceptance criteria

1. `python manage.py seed_ga_launch_program` (idempotent) creates: 1 `Program`, 4 `Project`s (`is_sample=True`), 7 `User`+`Resource` personas, all tasks/deps/assignments/memberships, the shared `Calendar`+exception, both sprints + burndown snapshots, and the Security board config.
2. Re-running the command does not duplicate rows.
3. After the post-seed CPM run, the cross-project edges resolve (or the SNET fallback from §4 is applied) and **`D5`'s scheduled start is at or after both `A5` and `C5`**.
4. At least two resources (`janus`, `malcolm`) show **>100% allocation** in an overlapping window (verifiable via the resource pool / assignment query).
5. CPM outputs are populated by the scheduler, **not** hard-coded in the seed.
6. S1 produces a non-zero velocity; burndown snapshots exist.
7. `grep -r "trueppm_enterprise" packages/` still returns zero results.

---

## 9. OSS / Enterprise boundary check

This is **OSS**. A `Program` is an OSS entity (related projects under one PM); cross-*project* dependencies and within-program resource contention are OSS. This seed only **creates data that surfaces contention** — it does **not** implement cross-program resource leveling, portfolio rollups, or governance, which remain Enterprise. Do not add `enterprise`/`portfolio` labels to the issue. If unsure, run the `enterprise-check` agent before filing.

---

## 10. Tests & docs (same MR — required)

**Three-layer coverage (per CLAUDE.md):**

- **pytest (API):** test the management command / `import_seed` path — row counts per entity, idempotency (run twice), cross-project dependency creation (or the SNET fallback), resource over-allocation is present, and that CPM outputs populate after the scheduler runs. Place under `packages/api/tests/…` matching existing seed tests.
- **vitest (web units):** **N/A** unless you touch web. If you add any sample-program affordance in the UI (e.g. a "Load sample program" action), add unit tests for the new hook/util.
- **Playwright E2E (`packages/web/e2e/`):** if a user-visible "load sample program" surface is added, add a golden-path spec (load → program view shows 4 projects + cross-project dependency) plus one empty/error state. If the seed is CLI-only with no UI surface, note that explicitly in the MR and skip E2E. **Grep `packages/web/e2e/` for any string you change** before committing.

**Docs (same MR):**

- Add/extend a sample-data page under `docs/getting-started/` (or `docs/features/`) describing the program, the four workstreams, the cross-project critical path, and the intentional contention — and how to load it. Use the **`docs-writer`** agent.
- If you added/changed any endpoint, serializer field, or permission, use the **`api-docs`** agent and regenerate the OpenAPI schema (`git merge origin/main` first, then `scripts/export-openapi.sh`).
- Version-tense: if you reference a TruePPM version anywhere in docs, check it against `roadmap.md` (Shipped/Underway/Planned) and use the correct tense.
- Add a changelog fragment: `changelog.d/<slug>.added.md` (do **not** edit `CHANGELOG.md`).

---

## 11. Workflow

1. Branch off latest `origin/main`: `feat/ga-launch-sample-program` (use `scripts/wt new <issue>` if other work is in flight).
2. Implement seed + tests + docs + changelog fragment.
3. `make pre-push` (lint incl. `ruff format --check`, typecheck, `makemigrations --check`, schema drift) — must pass.
4. Run new specs locally: `cd packages/api && pytest <new test>`; any Playwright spec via `cd packages/web && npx playwright test e2e/<spec>.spec.ts`.
5. Open MR to `main`, wait for **green pipeline**, then merge. Never push to `main` directly; never merge on a red pipeline.

---

## 12. Out of scope

No new models or migrations unless §3 forces a canonical-schema extension (and if so, keep it minimal and documented). No cross-program/portfolio features. No resource-leveling algorithm — only the data that makes contention visible.
