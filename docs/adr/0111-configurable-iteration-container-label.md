# ADR-0111: Configurable Iteration-Container Label (Sprint / Iteration / PI / custom)

## Status
Proposed

## Context

TruePPM hard-codes the word **"Sprint"** as the name of the time-boxed iteration
container (`Sprint` model, ADR-0037) across every user-facing surface. In the 0.3
agile-cohort VoC panel this is the **single near-hard-NO from the primary persona**
(Alex, Scrum Master): forcing strict Scrum-Guide terminology reads as a mandate to
Scrumban / SAFe-adjacent teams, who disengage within one cycle. At a ~120-engineer /
2–3-team design partner, some teams certainly run cadences that don't call the
container a "Sprint". Kanban `delivery_mode` (#410) only partially covers this — a team
can run timeboxes *and* want to call them "Iterations" or "PIs".

The container noun is purely **display text**. It has no behavioral consequence: it
does not gate tabs (that's `effective_methodology`, ADR-0041/0107), does not change
routes, API semantics, CPM, or any computation. This is the direct analogue of the
"Schedule view" vs "Gantt" rename pattern in the terminology glossary (ADR-0038):
the user-facing term changes; the code symbols (`Sprint`, `sprint`, `SprintPanel`,
`/sprints`) never do.

**P3M layer:** Programs and Projects (single-project configuration metadata). **OSS.**
A PM/team needs this to adopt the product; it has zero portfolio/governance scope.

### Forces
- The issue scopes this as a **project-level** setting with a methodology-driven default.
- ADR-0107 (Proposed) introduces a `Workspace` experience-preset with methodology
  *inheritance* (INHERIT/SUGGEST/ENFORCE) — but only for **methodology** (a behavioral
  toggle), and `effective_methodology` is the single source of truth for tab gating. A
  display string must not shadow or intercept that machinery.
- No `ProjectSettings` side table exists, by repeated explicit decision (ADR-0101 §4,
  ADR-0105): per-project policy lives flat on `Project` (`methodology`,
  `agile_features`, `estimation_mode`, `prioritization_model`).
- The container word appears as **both singular** ("Sprint Goal", "Close sprint",
  "Active sprint") **and plural** ("Sprints" tab, "No sprints yet", "Last 8 sprints"),
  and occasionally possessive ("the sprint's commitment"). A correct relabel must
  handle all forms without becoming an i18n project.
- `Sprint.name` (per-instance, PM-authored, e.g. "Sprint 23") is **orthogonal** to the
  container noun and must not be conflated.

## Decision

### 1. Storage — a flat, free-text field on `Project`

```python
# Project (models.py, alongside methodology / prioritization_model)
iteration_label = models.CharField(
    max_length=32,
    default="Sprint",
    help_text="Display noun for the time-boxed iteration container "
              "(e.g. Sprint, Iteration, PI). Display-only; never gates behavior.",
)
```

- **Flat field, not the ADR-0107 inheritance model.** 0107's INHERIT/SUGGEST/ENFORCE
  machinery exists for a *behavioral* preset; applying it to a display string is
  over-engineering. The label follows the established flat-policy pattern
  (`prioritization_model` is the closest precedent).
- **Free-text, no `choices=`.** The presets Sprint / Iteration / PI are a *UI
  affordance* (suggested chips + a custom field), not a DB enum. Consequence: **zero
  drf-spectacular enum-name-collision risk** — no `TextChoices` class, no
  `ENUM_NAME_OVERRIDES` pin required (confirmed against the 16 currently-pinned enums).
- **`default="Sprint"`** (not blank-as-fallback). Every row — existing and new — holds
  a literal display value, so the resolver reads the field directly with only a
  defensive empty-guard. The migration backfills existing rows to `"Sprint"` →
  **zero visible behavior change** (acceptance criterion met by construction).
- **Validation** (serializer): `strip()`; reject empty-after-strip; `max_length=32`
  (a container noun longer than this breaks tab/heading layouts). No HTML/control chars
  (standard DRF char escaping on render covers XSS; React escapes by default).
- `Project` subclasses `VersionedModel`, so the field auto-participates in delta sync
  (`server_version` bump on save) and `HistoricalRecords` — no extra wiring.

### 2. Grammatical forms — store singular, derive the rest client-side

Store **only the singular** noun. A single shared pure util derives every form the UI
needs. This is the minimal-correct line that avoids both an i18n engine and a
multi-field input UX.

```ts
// packages/web/src/lib/iterationLabel.ts
export interface IterationLabelForms {
  singular: string;       // "Iteration"      — headings, "X Goal", "X Backlog"
  plural: string;         // "Iterations"     — tab, "No Xs yet", "Last 8 Xs"
  lower: string;          // "iteration"      — mid-sentence "Close iteration"
  lowerPlural: string;    // "iterations"
  possessive: string;     // "Iteration's"    — "the X's commitment"
}
export function iterationLabelForms(singular: string): IterationLabelForms;
```

- Pluralization is naive English (`+s`, `-s/-x/-z/-ch/-sh → +es`, consonant-`y → -ies`).
  This is correct for **Sprint→Sprints, Iteration→Iterations, PI→PIs, Cycle→Cycles,
  Increment→Increments** and every reasonable custom noun. The rare irregular is an
  accepted v1 limitation (a `iteration_label_plural` override field is a clean additive
  follow-up if a real team hits one).
- Possessive is always `${singular}'s` — grammatically valid for any common noun.

### 3. Read contract — one hook, fed by the existing Project query

The backend serializes the raw `iteration_label` string on the Project payload (plain
field in `ProjectSerializer.Meta.fields`). No computed/method field. The web reads it
through a single hook so **no surface ever touches the literal "Sprint" again**:

```ts
// packages/web/src/hooks/useIterationLabel.ts
function useIterationLabel(projectId?: string): IterationLabelForms;
// reads project.iteration_label from the TanStack project-query cache,
// defaults to "Sprint" when blank/absent, returns iterationLabelForms(value).
```

Every container surface (enumerated in the issue + research) substitutes the
appropriate form: tab/nav → `plural`; headings/section titles → `singular`;
mid-sentence copy → `lower`/`lowerPlural`; the bridge dialog possessive → `possessive`.

### 4. Settings UI

A control in **Project settings** (agile-config cluster, next to methodology): three
preset chips (Sprint / Iteration / PI) + a "Custom…" text input, defaulting to the
current value. Admin+-gated write (mirrors `prioritization_model`, enforced in
`ProjectViewSet`). Detailed layout is the `ux-design` pass's job; this ADR fixes only
that it lives on the project settings surface and writes the single field.

### 5. Glossary

Add an **ADR-0038 entry in the same MR**: code symbol is always `sprint`/`Sprint`;
the user-facing noun resolves from `Project.iteration_label` (default "Sprint"); the
label is display-only with no behavioral consequence.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Flat free-text `Project.iteration_label`, singular-stored, client-derived forms** (chosen) | Matches flat-policy precedent; no enum → no spectacular collision; custom strings free; one DB field; one resolver hook | Naive pluralization fails on rare irregulars (accepted, follow-up field) |
| B. `choices=` enum (SPRINT/ITERATION/PI/CUSTOM) + separate custom string | Closed set is easy to validate | Two fields; needs `ENUM_NAME_OVERRIDES` pin; "CUSTOM + string" is just free-text with extra steps; doesn't serve arbitrary nouns cleanly |
| C. Store singular **and** plural columns | No pluralization helper; handles irregulars | Two columns + double the input UX for a problem naive rules already solve; more migration/serializer surface |
| D. Put it in ADR-0107 workspace preset (inherit) | Org-wide consistency for free | Over-engineers a display string into the methodology enforcement machinery; contradicts "as simple as the issue allows"; the issue is project-scoped |
| E. Workspace default + project override now | New projects inherit org vocabulary | Adds a `Workspace` field + resolver this milestone doesn't need; deferred as additive follow-up (see Consequences) |

## Consequences

**Easier:**
- Scrumban/SAFe teams self-serve their vocabulary → removes Alex's near-hard-NO.
- One hook + one util = a single chokepoint; the grep gate ("no hard-coded container
  'Sprint'") becomes mechanically verifiable.
- No enum means no schema-drift / enum-collision risk — a known recurring failure class.

**Harder / larger than first scoped:**
- The substitution sweep is **bigger than the initial ~12 estimate**: ~40 web strings
  across `features/{sprints,board,schedule,settings,shell,reports}`, plus **~25 e2e
  specs** that assert on "Sprint"/"Sprints" text/roles, which must be updated in the
  same MR (CLAUDE.md e2e rule). The e2e specs run against the default "Sprint", so most
  keep passing; the new behavior needs **one new spec** proving propagation under a
  custom label. This is mechanical but broad — the bulk of the work is here, not the model.

**Explicitly deferred (out of v1 scope — noted, not built):**
1. **Workspace-level default** (new projects inherit an org vocabulary): clean additive
   follow-up using the ADR-0087 `default_project_view` seed-on-create precedent (copy
   workspace default into `Project.iteration_label` at creation). Not live inheritance.
2. **API error-message relabeling**: DRF 400 validation strings (`serializers.py`,
   `views.py`) that say "Sprint" are developer-facing contract messages; v1 relabels
   **UI surfaces only**. If a 400 string is surfaced verbatim in a user toast, that
   specific string moves in the follow-up.
3. **`Sprint.short_id` prefix (`SP-`) and per-sprint default names** ("Sprint 1") stay
   as-is — storage-neutral internal decoration (ADR-0037 precedent). The label does not
   make short-ids "IT-…".
4. **Irregular-plural override field** — add only if a real team needs it.

**Risks:**
- A custom label that is very long or lowercase could look odd in Title-Case headings —
  mitigated by `max_length=32` and rendering the stored value as-typed (UI suggests
  Title Case).
- Naive pluralization on an exotic custom noun — accepted; follow-up field available.

## Implementation Notes
- **P3M layer:** Programs and Projects (project config metadata).
- **Affected packages:** api (1 field + migration + serializer), web (1 util + 1 hook +
  ~40 string substitutions + settings control + 1 new e2e spec + ~25 spec updates).
  Mobile reimplements the pure `iterationLabelForms` util later (no shared-pkg coupling now).
- **Migration required:** yes — additive `CharField(default="Sprint")`, `projects/0062`.
  No enum, no `ENUM_NAME_OVERRIDES` change. `makemigrations --check` clean.
- **API changes:** yes — `iteration_label` added to `ProjectSerializer` (read for any
  member; write admin+-gated in `ProjectViewSet`). OpenAPI schema regenerates (plain
  string field; no new enum).
- **OSS or Enterprise:** OSS. Boundary scan clean (zero `trueppm_enterprise` imports).

### Durable Execution
1. Broker-down behaviour: **N/A** — synchronous `PATCH /projects/{id}/` writing one
   `CharField`; no task dispatch, no outbox.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no `on_commit` dispatch.
4. Service layer: **N/A** — plain serializer `update()` on `Project`; no new service fn.
5. API response on best-effort dispatch: **N/A** — standard synchronous 200 with the
   updated Project representation.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: a `PATCH` setting `iteration_label` is naturally idempotent (last-write-
   wins on a single scalar; `server_version` bumps via `VersionedModel.save()`).
8. Dead-letter / failure handling: **N/A** — synchronous validation error (400) returned
   to caller; nothing queued.

## Open Questions for Review
None blocking (🔴). Two scope choices the architect has **defaulted** and will proceed
on unless redirected:
- 🟡 Singular-stored + client-derived plural (Option A) over an explicit plural column
  (Option C). Chosen for minimalism; irregular-plural override deferred.
- 🟡 v1 relabels **UI surfaces only**; API error strings, the workspace-level default,
  and `short_id`/per-sprint-name label-awareness are deferred as noted follow-ups.
