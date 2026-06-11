# ADR-0116: Iteration-Label Inheritance (Workspace → Program → Project)

## Status
Accepted

## Context
ADR-0111 (#862) shipped a **project-level** display label for the iteration container
(`Project.iteration_label`, default `"Sprint"`, relabelable to Iteration / PI / custom).
Issue #1106 extends it so the label can be set **once at the Workspace** (or per
**Program**) and inherited down — a solo team relabels in one place instead of per
project, and a program of related projects shares one vocabulary. This is the **first
real inheritance resolver** in the codebase: ADR-0107 (workspace methodology preset)
defined the same shape but is accepted-unshipped, so #1106 establishes the pattern.

`enterprise-check` (done) drew the line: per-scope **configuration** + the
`INHERIT`/`SUGGEST` resolution is OSS adoption ergonomics (Scrum-Master/Agile-Coach VoC,
8/10); the `ENFORCE`/lock-downstream policy + change-audit is governance → Enterprise
(`trueppm-enterprise#154`), exactly mirroring ADR-0107's `methodology_override_policy`.

**P3M layer:** Programs and Projects (single workspace/program/project config). OSS.

### Ground truth being extended
- `Project.iteration_label = CharField(max_length=32, default="Sprint")` — **non-null**,
  display-only (ADR-0038/0111; never gates tabs/routes/CPM; the code symbol stays `Sprint`).
  Serializer `validate_iteration_label` strips and rejects empty.
- `Workspace` is a lazily-created singleton (ADR-0081). `Program` exists (ADR-0070);
  `Project.program` is a nullable FK (NULL = standalone).
- Frontend `useIterationLabel(projectId?)` reads `project.iteration_label` and derives
  forms in `lib/iterationLabel.ts`. It is the single chokepoint every sprint surface reads.

## Decision

### 1. "Inherit" = NULL (make the project & program overrides nullable)
- `Project.iteration_label` becomes **nullable**; `NULL` = "inherit from program/workspace",
  a non-empty string = an explicit override. New rows default to `NULL` (was `"Sprint"`).
- `Program.iteration_label` is added **nullable** (NULL = inherit from workspace).
- `Workspace.iteration_label` is the **non-null root** (`default="Sprint"`), so resolution
  always terminates without the hardcoded literal leaking past the workspace.
- **Backfill** (data migration): existing `Project.iteration_label == "Sprint"` → `NULL`.
  Rationale: ADR-0111 shipped ~1 day before #1106, so an *explicit* "Sprint" is
  indistinguishable from the default and visually identical under resolution — until a
  workspace later sets a different default, where **inherit is the desired behavior** for a
  project nobody customized. Non-`"Sprint"` values are preserved as explicit overrides.
  `validate_iteration_label` is relaxed to allow `None` (clear → inherit) while still
  rejecting empty/whitespace strings.

Chosen over a blank-string sentinel (the serializer rejects `""`, and `NULL` is the
idiomatic "unset" for an optional override) and over a separate boolean (redundant with
nullability, and a second field to keep in sync).

### 2. The resolver — `resolve_effective_iteration_label(project)`
Pure function in a new `apps/projects/iteration_label.py` (no Django signal, no stored
column — **computed on read**, consistent with ADR-0108):

```
def resolve_effective_iteration_label(project) -> str:
    workspace = Workspace.load()
    if (workspace.iteration_label_override_policy == TermOverridePolicy.ENFORCE
            and terminology_enforcement_active()):      # provider hook, OSS → False
        return workspace.iteration_label
    program_label = project.program.iteration_label if project.program_id else None
    return (project.iteration_label
            or program_label
            or workspace.iteration_label
            or DEFAULT_ITERATION_LABEL)                  # "Sprint" backstop
```

Precedence: **project override ?? program override ?? workspace default ?? "Sprint"**,
with the `ENFORCE` short-circuit only when an enterprise provider is active.

### 3. New fields + policy enum + enterprise seam
- `TermOverridePolicy(models.TextChoices)`: `INHERIT`, `SUGGEST`, `ENFORCE`.
- `Workspace.iteration_label` (CharField default `"Sprint"`) +
  `Workspace.iteration_label_override_policy` (default `SUGGEST`).
- `Program.iteration_label` (CharField, `null=True, blank=True`).
- **OSS semantics:** `INHERIT` and `SUGGEST` both mean "override allowed" — they differ
  only in a UI nuance (SUGGEST pre-fills the workspace default into a new project's create
  form; INHERIT leaves the override blank so it defers up). `ENFORCE` **degrades to
  `SUGGEST` (no-op, no lock)** unless an enterprise provider is registered.
- **`TERMINOLOGY_ENFORCEMENT_PROVIDER`** — a new settings string (dotted path, default
  `None` in OSS), following the ADR-0029 / ADR-0107 §4 registry pattern. A
  `terminology_enforcement_active()` helper resolves it (cached) and returns `False` in
  OSS. When a provider is registered (Enterprise), it (a) makes the resolver return the
  workspace label and (b) the serializers return `403` on a `Program`/`Project`
  `iteration_label` PATCH. The `ENFORCE` card renders `<EnterpriseBadge/>` in Community
  (web-rule 121). Policy-change **audit** is Enterprise (`trueppm-enterprise#154`).

### 4. API — one resolved value, API-first
- Add read-only `effective_iteration_label` (SerializerMethodField → the resolver) to
  `ProjectSerializer`. The raw, now-nullable `iteration_label` (the override) stays
  writable. Program serializer exposes its `iteration_label` (writable); Workspace
  settings serializer exposes `iteration_label` + `iteration_label_override_policy`.
- **Frontend switches `useIterationLabel` to read `project.effective_iteration_label`**
  (falls back to the raw field then `"Sprint"` while loading) — so web, mobile, and
  MCP/API all read the **server-resolved** value, never re-implementing precedence
  client-side (API-first contract, [[feedback_api_first_contract]]).
- **drf-spectacular:** `TermOverridePolicy` adds a new enum → pin it in
  `ENUM_NAME_OVERRIDES` (`TermOverridePolicyEnum`) to avoid the "Removed schemas"
  schema-drift regression (the known enum-collision gotcha).

### 5. Settings UI
- **Workspace settings → General** (or a small "Terminology" row): the default label
  (reuse the `IterationLabelField` control) + the policy selector; the `ENFORCE` option
  carries `<EnterpriseBadge/>` and is read-only in Community.
- **Program settings → General:** an override `IterationLabelField`; empty = "Inherit
  ({workspace default})" shown as the placeholder.
- **Project settings (existing #862 `IterationLabelField`):** when the project override is
  `null`, the input shows the **inherited** effective value as its placeholder and a
  "Using {scope} default" hint, with a clear-to-inherit affordance; saving blank clears
  the override (PATCH `iteration_label: null`).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **NULL = inherit, nullable overrides (chosen)** | Idiomatic unset; clean precedence; backfill makes uncustomized projects follow workspace default | One nullable migration on a field shipped yesterday + a data backfill |
| Blank-string `""` sentinel | No nullability change | Serializer rejects `""`; `""` vs `NULL` ambiguity; non-idiomatic |
| Separate `inherit_iteration_label` boolean | Explicit | Redundant with nullability; two fields to keep consistent |
| Stored/denormalized effective label (signal-maintained) | O(1) read | Violates ADR-0108 computed-on-read; cache-invalidation across 3 levels = the bug factory |

## Consequences
- **Easier:** relabel once at the workspace; programs share vocabulary; every surface
  (incl. mobile/MCP) reads one server-resolved value; the enterprise lock drops in against
  a stable slot with zero OSS changes.
- **Harder:** a 3-level precedence to test; the Project field gains an inherit/placeholder
  state; one more nullable migration + backfill on a day-old field.
- **Risks:** (1) the `"Sprint"→NULL` backfill assumes no one explicitly chose "Sprint" —
  true given the 1-day window, documented, and visually identical until a workspace
  default diverges. (2) drf enum drift if the `ENUM_NAME_OVERRIDES` pin is forgotten —
  covered by `make pre-push` schema-drift. (3) resolver must never raise on a missing
  workspace — `Workspace.load()` lazily creates the singleton, so it can't.

## Implementation Notes
- P3M layer: Programs and Projects. OSS (`trueppm-suite`); enterprise registers the
  enforcement provider in `trueppm-enterprise#154`.
- Affected packages: api (models, migration, serializers, resolver, settings slot), web
  (useIterationLabel, Workspace + Program + Project settings).
- Migration required: **yes** — Workspace (2 fields) + Program (1 field) + Project
  (nullable + default change) + `HistoricalRecords` parity (HistoricalProject /
  HistoricalProgram / HistoricalWorkspace) + a data migration (`"Sprint"→NULL` on Project).
  Use `makemigrations` (never hand-write the historical tables); run `migration-check`.
- API changes: yes — `effective_iteration_label` (read-only) on ProjectSerializer;
  nullable `iteration_label` write on Project/Program; `iteration_label` +
  `iteration_label_override_policy` on the Workspace settings serializer;
  `ENUM_NAME_OVERRIDES` pin; regenerate `docs/api/openapi.json`.
- OSS or Enterprise: **OSS** (config + INHERIT/SUGGEST). Enterprise = ENFORCE provider + audit.

### Durable Execution
1. Broker-down behaviour: **N/A** — synchronous config writes + computed-on-read resolution; no async dispatch, no Celery task.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: the resolver `apps/projects/iteration_label.py::resolve_effective_iteration_label` is the single read path; no dispatch service.
5. API response on best-effort dispatch: **N/A** — settings PATCH is synchronous (`200` with the resolved `effective_iteration_label`).
6. Outbox cleanup: **N/A** — no outbox.
7. Idempotency: settings PATCH is naturally idempotent (last write wins on a single column); the resolver is a pure function of current rows.
8. Dead-letter / failure handling: **N/A** — no async path. A bad write fails the PATCH synchronously with a serializer `400`; `ENFORCE`-blocked writes return `403`.
