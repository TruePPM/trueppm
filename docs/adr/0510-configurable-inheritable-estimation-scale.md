# ADR-0510: Configurable, Inheritable Estimation Scale (Workspace → Program → Project)

## Status
Proposed

## Context

Agile estimates in TruePPM are stored as a single integer — `Task.story_points`
and `BacklogItem.story_points`, both `PositiveSmallIntegerField(null=True)`
(ADR-0037, ADR-0418). The **input widget**, however, is hardcoded to a Fibonacci
scale in one place (`StoryDetailDrawer`, `const FIBONACCI = [1,2,3,5,8,13,21]`)
and left as a free `<input type=number>` everywhere else (board `TaskFormModal`,
schedule `EstimatesTab`, backlog detail create/view). Teams that estimate in a
linear 1–10 band or in T-shirt sizes (XS–XL) have no supported way to express
that, and the three duplicated Fibonacci arrays (`StoryDetailDrawer`,
`poker/FibonacciCardRow`, `poker/pokerOutlier`) have already begun to fork.

Issue #2027 asks for a **configurable estimation scale** — Fibonacci, Linear, or
T-shirt — that a PM sets once and every point input across the program honors,
with the same **Workspace → Program → Project inheritance** the platform already
uses for calendars (ADR-0441), duration-change policy (ADR-0151), attachment
policy (ADR-0153), and iteration terminology.

**P3M layer:** Programs and Projects. The scale is a setting a single PM or
program manager chooses for **their own** program — it is not cross-program
governance, org policy, or compliance evidence. It stays **OSS**, exactly as
the duration-change *policy* stays OSS while the enterprise hard-*enforcement*
of one policy across many programs is the Enterprise extension registered
against the same override-policy seam (ADR-0135). No enterprise enforcement seam
is in scope here — the scale is freely overridable at every level.

### Product-locked decisions (from #2027 + prior review — not reopened here)

- **Presets only:** Fibonacci `(1,2,3,5,8,13,21)`, Linear `(1..10)`, T-shirt
  `(XS,S,M,L,XL)`. Custom scales are **out** (deferred).
- **Inheritance:** Workspace → Program → Project, `NULL = inherit`, overridable
  at each scope. Non-null **root at Workspace**, default **Fibonacci**.
- **T-shirt carries a hidden numeric map** `XS→1, S→2, M→3, L→5, XL→8` so
  velocity, burndown, and rollup math keep operating on integers. `story_points`
  stays an integer field — T-shirt is a *label skin* over the stored integer.
- **Where points show:** leaf work (story/task/bug/spike/chore). Feature hidden.
  Epic shows a **read-only rolled-up total**, project product-backlog only (the
  flat program backlog already hides Epic/Feature — #2026).
- **Off-scale safety:** a stored integer that is not on the current scale must
  **still display and stay selectable** (legacy data, or a post-hoc scale
  switch). **No backend validation** rejects an off-scale value.

### Forces

- **Consistency with a proven pattern.** The platform has a mature
  NULL-means-inherit precedent (Shape A). Inventing a new inheritance shape for
  one more enum would be pure divergence.
- **Math integrity.** Velocity/rollup consumers read integers today and must
  keep doing so. The scale must not leak into any numeric computation.
- **Display safety.** A value off the active scale can never disappear from the
  UI — that would silently drop a real estimate.
- **DRY.** Three hardcoded Fibonacci arrays should collapse to one source.

## Decision

Mirror the **ADR-0151 duration-change-policy shape** (a nullable enum with a
non-null Workspace root) and the **ADR-0441 calendar resolver** structure
(computed-on-read `resolve_effective` / `resolve_inherited` / `source`), applied
to a new `estimation_scale` enum. The stored estimate stays an integer; the scale
governs only the **input widget shape** and the **display label**, never the math.

### Backend (`packages/api`)

1. **Enum.** Add `EstimationScale(models.TextChoices)` to
   `apps/projects/models.py`:
   ```python
   class EstimationScale(models.TextChoices):
       FIBONACCI = "fibonacci", "Fibonacci (1, 2, 3, 5, 8, 13, 21)"
       LINEAR = "linear", "Linear (1–10)"
       TSHIRT = "tshirt", "T-shirt (XS–XL)"
   ```

2. **Fields** (additive migration, one `makemigrations` for the feature):
   - `Workspace.estimation_scale` — non-null, `default=FIBONACCI` (the root of
     the chain; the additive migration reproduces today's Fibonacci behavior
     exactly). Lives in `apps/workspace/models.py`.
   - `Program.estimation_scale` and `Project.estimation_scale` — nullable
     (`null=True, blank=True`, `# noqa: DJ001 — null = inherit`), `NULL = inherit`.
     Both in `apps/projects/models.py`. Not added to `_HISTORY_EXCLUDED_BASE`, so
     each admin override write is captured by `HistoricalRecords` (audit), exactly
     as duration-policy and attachment-policy overrides are.

3. **Resolver.** New module `apps/projects/estimation_scale.py`, copied from
   `calendar_settings.py` structure (minus the enforcement seam — there is no
   OSS/Enterprise lock for the scale):
   - `resolve_effective_estimation_scale(obj, *, workspace=None) -> EstimationScale`
   - `resolve_inherited_estimation_scale(obj, *, workspace=None) -> EstimationScale`
     (drives the settings "Inherited from {scope}" affordance)
   - `resolve_estimation_scale_source(obj, *, workspace=None) -> Literal["project","program","workspace"]`

   Precedence (most specific wins): `project → program → workspace`. There is
   **no** `system_default` terminal — the Workspace root is non-null, so the chain
   always terminates in a real value (unlike the calendar's Mon-Fri/8h/UTC
   backstop). Computed-on-read (ADR-0108); no denormalized effective column.

4. **Serializers** (`apps/projects/serializers.py`), mirroring the duration-policy
   trio verbatim:
   - Program + Project serializers expose the **raw nullable** `estimation_scale`
     field plus `effective_estimation_scale` and `inherited_estimation_scale`
     `SerializerMethodField`s.
   - `WorkspaceSettingsSerializer` (`apps/workspace/serializers.py`) exposes the
     **raw non-null** `estimation_scale` field only (no effective/inherited — it
     is the root).

5. **No validation of on-scale values.** The write path accepts any
   `PositiveSmallIntegerField`-valid integer for `story_points`. The scale is a
   display/input constraint only, honoring the locked off-scale-safety rule. The
   only new validation is that `estimation_scale`, when non-null, is a member of
   `EstimationScale.choices` (DRF enum validation, free).

### Frontend (`packages/web`)

6. **`lib/storyPoints.ts` — single source of truth** for scale value lists, the
   T-shirt label↔numeric map, and two helpers:
   ```ts
   export const SCALE_VALUES = {
     fibonacci: [1, 2, 3, 5, 8, 13, 21],
     linear:    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
     tshirt:    [1, 2, 3, 5, 8],          // XS,S,M,L,XL mapped ints
   } as const;
   export const TSHIRT_LABELS: Record<number, string> = {1:'XS',2:'S',3:'M',5:'L',8:'XL'};
   export function scaleValues(scale): number[];           // ordered selectable ints
   export function formatStoryPoints(value, scale): string; // int → display label
   ```
   `formatStoryPoints` returns the T-shirt letter under `tshirt`, the raw number
   otherwise, and **always renders an off-scale integer as its raw number** (never
   blank). The T-shirt numeric map lives **here in the frontend only** — see
   Q1 below.

7. **Options constant** `features/settings/estimationScale.ts` (peer of
   `durationChangePolicy.ts`): the three `InheritableSelectOption`s + shared hint
   copy.

8. **Settings wiring** (Settings sub-page shell already designed — ADR-0428 seam):
   - `WorkspaceGeneralPage`: a bare `<select>` bound to the raw non-null field.
   - `ProgramGeneralPage` + `ProjectGeneralPage`: `InheritableSelectField` call
     sites (the same control duration-policy uses), reading `effective_*` /
     `inherited_*` from the serializer.

9. **Point-input widgets read the resolved scale.** Every leaf-work point input
   switches shape by the project's effective scale (Q3 below):
   - `StoryDetailDrawer` (already a `<select>`, currently hardcoded Fibonacci) →
     driven by `scaleValues(effectiveScale)` / `formatStoryPoints`.
   - board `TaskFormModal`, schedule `EstimatesTab`, backlog detail create/view
     (currently free `<input type=number>`) → become `<select>`s over the
     resolved scale, with the same off-scale-preserving behavior.
   - Epic rows render a **read-only** rolled-up total via `formatStoryPoints`.

### Out of scope (follow-up)

- **Planning poker stays Fibonacci-only.** `poker/FibonacciCardRow` and
  `poker/pokerOutlier` are refactored to *import their Fibonacci list from
  `lib/storyPoints.ts`* (killing two of the three duplicate arrays) but are **not**
  made scale-aware. Poker's spread/outlier math assumes a Fibonacci gap ladder;
  generalizing it is a separate design. File a follow-up issue.
- **Custom scales** (locked out).
- **Re-mapping stored values on a scale switch** (locked out — off-scale display
  is the deliberate answer instead).

## Design Questions (resolved)

**Q1 — Where does the T-shirt numeric map live?** **Frontend only**, in
`lib/storyPoints.ts`. `story_points` is already an integer and the client always
stores the *mapped int* (`M` → `3`), so the backend never needs to know a scale
is T-shirt to keep velocity/rollup correct. Off-scale display is a required
frontend behavior regardless, so the label↔int table has to exist client-side;
duplicating it as a backend constant would create a second source of truth for
zero benefit. The backend stays estimation-scale-*agnostic* for the numeric
value. (The backend still stores the `estimation_scale` enum for inheritance and
to tell the widget which shape to render — it just never maps labels to ints.)

**Q2 — Backend validation of on-scale values?** **None.** The locked off-scale
safety rule (legacy values, post-switch values must still display and stay
selectable) makes hard validation actively wrong — it would reject or hide real
estimates. `story_points` keeps only its existing `PositiveSmallIntegerField`
bound. The scale constrains the *picker*, not the *domain*.

**Q3 — How does the input widget switch shape, and how does an off-scale value
render?** One `<select>` component, its option list derived from
`scaleValues(effectiveScale)`:
- **Fibonacci / Linear:** options are the numeric list; label == value.
- **T-shirt:** options are the five mapped ints, labeled via `TSHIRT_LABELS`
  (user sees `XS…XL`, the form submits `1…8`).
- **Off-scale stored value:** if the current `story_points` is not in
  `scaleValues(scale)`, prepend it as an extra selectable option rendered by
  `formatStoryPoints` (raw number, or `"5 (off scale)"`-style affordance). It
  stays selected and submittable; the user is never forced to change it to save
  an unrelated field. This is what makes a scale switch non-destructive.

**Q4 — Does a Workspace `estimation_scale` change fan out a recompute?** **No.**
Unlike the calendar (which feeds CPM and must re-run the schedule on change), the
scale is an **input-widget and display concern only** — no stored `story_points`
value changes when the scale changes, and no server-side computation reads the
scale. A workspace-level switch instantly changes which options future pickers
show; existing values are untouched and simply render under the new scale (with
off-scale ones preserved per Q3). Zero async side effects — see Durable Execution.

**Q5 — Consolidating the three hardcoded Fibonacci arrays?** `lib/storyPoints.ts`
becomes the single source. `StoryDetailDrawer` drops its local `FIBONACCI` and
reads the resolved scale. `poker/FibonacciCardRow` and `poker/pokerOutlier` import
the Fibonacci list from `lib/storyPoints.ts` but remain Fibonacci-only (poker
scale-awareness is a tracked follow-up, not this ADR).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Nullable enum + computed-on-read resolver (ADR-0151/0441 shape)** — chosen | Reuses the platform's proven inherit pattern; no new migration risk; serializers/settings controls already have the exact template; `story_points` untouched | One more resolver module (but a near-verbatim copy) |
| B. Mirror `methodology` (non-null at every scope, policy-driven inheritance) | Fewer NULLs to reason about | **Wrong shape** — `methodology` uses an override *policy*, not NULL-means-inherit; forces a value at every scope and can't express "just inherit"; diverges from the calendar/duration/attachment family |
| C. Store the scale label as a string on each estimate (e.g. `"M"`) | Self-describing values | Breaks every velocity/burndown/rollup consumer (they read ints); a scale change would need a data migration; contradicts the locked "story_points stays integer" decision |
| D. Backend owns the T-shirt map + validates on-scale | One authority for the mapping | Adds a second source of truth for the map, forces backend to know scale to keep math right, and makes off-scale display (locked requirement) impossible without a validation carve-out anyway |

## Consequences

**Easier:**
- Adding the scale is a well-worn path — the diff is structurally identical to
  ADR-0151's, so review, tests, and settings UI are near-templated.
- Three duplicate Fibonacci arrays collapse to one.
- A PM picks an estimation vocabulary once and every point input obeys it.

**Harder / risks:**
- Every leaf point input must be migrated from free-number to scale-driven
  `<select>` in one pass; a missed widget would silently keep free entry. The
  `grep` for `story_points` / `storyPoints` inputs (board `TaskFormModal`,
  schedule `EstimatesTab`, backlog detail create/view, `StoryDetailDrawer`) is the
  checklist — all five must land in the same MR.
- Off-scale rendering must be exercised by tests (a Linear value shown under a
  T-shirt scale, and vice-versa) or the "preserve legacy value" guarantee can
  regress unnoticed.
- Poker staying Fibonacci-only while the rest of the app is scale-aware is a
  deliberate, documented inconsistency; the follow-up issue must be filed so it is
  tracked, not forgotten.

## Implementation Notes

- **P3M layer:** Programs and Projects (a per-program PM setting; not
  cross-program governance).
- **Affected packages:** api (models, resolver, serializers, migration), web
  (settings controls, `lib/storyPoints.ts`, point inputs). No scheduler, no
  mobile in this ADR, no helm.
- **Migration required:** yes — additive only. Non-null `estimation_scale` on
  `Workspace` with `default=FIBONACCI`; nullable `estimation_scale` on `Program`
  and `Project`. One `makemigrations` for the feature; follow with
  `ruff check --fix && ruff format` on the generated file.
- **API changes:** yes — raw `estimation_scale` on Workspace/Program/Project
  serializers; `effective_estimation_scale` + `inherited_estimation_scale`
  method fields on Program + Project. Regenerate `docs/api/openapi.json` (merge
  `origin/main` first).
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). No enterprise import, no
  enforcement seam.

### Durable Execution
1. **Broker-down behaviour:** N/A — the feature has **zero async side effects**.
   Writing `estimation_scale` (a settings enum) and reading a resolved scale are
   synchronous DB operations; no Celery task is dispatched. No outbox row is
   needed because nothing is queued.
2. **Drain task:** N/A — no async work, so no drain.
3. **Orphan window:** N/A — no `transaction.on_commit()` dispatch.
4. **Service layer:** N/A — no dispatch path. Resolution goes through the pure
   read helper `apps/projects/estimation_scale.py::resolve_effective_estimation_scale`;
   settings writes go through the standard serializer `update()`.
5. **API response on best-effort dispatch:** N/A — settings writes return the
   updated resource synchronously (standard DRF 200); nothing is queued, so there
   is no `{"queued": true}` path.
6. **Outbox cleanup:** N/A — no outbox rows produced.
7. **Idempotency:** Setting `estimation_scale` is naturally idempotent — it is a
   last-write-wins column update, safe to replay; re-applying the same value is a
   no-op. No numeric data is transformed, so there is nothing to double-apply.
8. **Dead-letter / failure handling:** N/A — no task to fail. A rejected settings
   write surfaces synchronously as a DRF 400.

## Blockers

**None (🟢).** The approach is a near-verbatim application of the established
ADR-0151 / ADR-0441 inheritable-settings pattern to a new enum, with the numeric
integrity guaranteed by keeping `story_points` an integer and the scale
display-only. The one design tension — off-scale values — is resolved
non-destructively (Q3) and is consistent with the locked product decision. The
poker inconsistency is deliberate and tracked as a follow-up, not a blocker.
