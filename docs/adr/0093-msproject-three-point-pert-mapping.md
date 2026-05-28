# ADR-0093 — MSPDI three-point / PERT estimate mapping

**Status:** Accepted
**Date:** 2026-05-28
**Issue:** [#798](https://gitlab.com/trueppm/trueppm/-/work_items/798)
**Parent epic:** [#796 — MS Project import/export migration on-ramp](https://gitlab.com/trueppm/trueppm/-/work_items/796)
**Supersedes / amends:** Extends [ADR-0021](0021-msproject-import-export.md). ADR-0021 predates ExtendedAttribute parsing and the three-point estimate fields; it remains the charter for basic XML import/export. This ADR adds the PERT mapping contract on top.

## Context

TruePPM's scheduler engine consumes three-point PERT estimates
(`Task.optimistic_duration`, `most_likely_duration`, `pessimistic_duration` —
IntegerField, working days, nullable) to drive Monte Carlo risk analysis
(ADR-0012). The MS Project (MSPDI) importer and exporter shipped per
ADR-0021 do not move these fields across the boundary, which means a project
migrated from MS Project loses its PERT estimates on import and a project
exported back to MS Project loses them on export.

MS Project has had no native PERT fields since 2013. The idiomatic storage,
shared by Microsoft's published guidance and by every third-party tool that
emits MSPDI three-point estimates (MPXJ, Project Web App, Smartsheet
exports), is four aliased custom `Duration` fields stored as `ExtendedAttribute`
entries:

| Field | Purpose |
|---|---|
| `Duration1` | Optimistic estimate |
| `Duration2` | Most Likely estimate |
| `Duration3` | Pessimistic estimate |
| `Duration4` | PERT Expected — formula `([Duration1] + 4*[Duration2] + [Duration3]) / 6` |

This ADR records the decisions made implementing the bidirectional mapping
for this convention.

## FieldID constants (sourced, not guessed)

The `Duration` family is **non-contiguous** within MS Project's Custom Field
enumeration. The four PERT slots are:

| Field | FieldID | Note |
|---|---|---|
| `Duration1` | `188743783` | Optimistic |
| `Duration2` | `188743784` | Most Likely |
| `Duration3` | `188743785` | Pessimistic |
| `Duration4` | `188743955` | PERT Expected (formula slot) |

`Duration1–3` are contiguous, but `Duration4` lives 170 IDs higher in a
separate sub-range. Inferring `Duration4 = Duration1 + 3` produces FieldID
`188743786` which is actually `Cost1`. Treat the four IDs as named
constants — never a range.

Sourcing: extracted from MPXJ 16.x's `TaskField` enum via the
`mpp-sample-generator` tool (see its `docs/field_id_reference.md`), then
cross-checked against Microsoft's one documented anchor
`pjCustomTaskText1 = 188743731`. The constants live in
`packages/api/src/trueppm_api/apps/msproject/extended_attributes.py`.

## Decision

### 1. Alias detection — trust the FieldID, confirm with alias

The importer detects which `Duration` slots carry PERT estimates by walking
the project-level `<ExtendedAttributes>` block:

1. Accept a binding when the canonical PERT `FieldID` is present AND the
   alias text either confirms the role (case-insensitive substring match
   for "optimistic" / "most likely" / "pessimistic") or is empty / missing.
2. Refuse the binding and emit a warning when the canonical `FieldID`
   is present but the alias text contradicts the role
   (e.g. `Duration1` aliased "Risk Score") — a repurposed slot importing
   as PERT would silently corrupt Monte Carlo input.
3. Files with no `<ExtendedAttributes>` block produce no PERT bindings and
   no warnings — most MSPDI files do not carry estimates.

**Why FieldID-first:** the alias is human-editable display text. Trusting
alias-based detection would break non-English MS Project installs
("Optimistico", "Optimiste", "楽観的") and would mis-detect Custom Field
names that happen to contain the word "optimistic" without semantic
relationship. FieldID is the numeric interchange contract.

### 2. Non-standard FieldIDs are unsupported in v1

If a file uses, say, `Duration5`/`Duration6`/`Duration7` for PERT estimates,
the importer ignores them. Only the four canonical FieldIDs are honored.
An admin-configurable alias map can be added if customer feedback warrants
it; the constants module is structured so the change would be additive.

### 3. All-or-none on import

If a task carries fewer than all three of (Optimistic, Most Likely,
Pessimistic), the importer drops all three values to `None` and emits a
warning. The scheduler engine requires all three for PERT-Beta sampling
(`engine.py:892`), so a partial import would surface as a half-populated
UI with no Monte Carlo effect.

### 4. `estimate_status` is always `accepted` on import

Imported three-point values are written with
`Task.estimate_status = "accepted"`, regardless of the project's
`estimation_mode`. The uploading user holds project-admin permission
(ADR-0070 — `IsProjectAdmin` on the import endpoint) and the values are
PM-authored migration data, not contributor suggestions. Forcing the PM to
re-approve every imported task under `SUGGEST_APPROVE` would add no
governance value (they chose to import the values).

### 5. Summary tasks and milestones — skip both, both directions

- **Import:** Three-point fields are not written on rows the importer
  detects as summary tasks (any later task's WBS path strictly descends
  from this one's) or milestones (`<Milestone>1</Milestone>`). Real MS
  Project files almost never carry estimates on these rows; when they do,
  importing them would create data the scheduler ignores and round-trip
  would drift.
- **Export:** Per-task `<ExtendedAttribute>` values are omitted for
  summary and milestone tasks even if the model fields are set.

The project-level `<ExtendedAttributes>` definition block is emitted only
when at least one non-summary, non-milestone task carries all three
values.

### 6. Constants module

`packages/api/src/trueppm_api/apps/msproject/extended_attributes.py` holds
the four FieldID constants, the role-to-FieldID map, the alias and
field-name lookups, and the PERT-Expected formula string. Importer and
exporter both import from this module so a future MPXJ change that shifts
the FieldIDs surfaces in one place.

### 7. Round-trip tolerance

Round-trip equality is **exact for durations that are integer multiples of
8 hours**. MS Project encodes durations as ISO-8601 `PT<hours>H...` and
TruePPM stores integer working days at 8h/day; the existing parser helper
`_parse_duration_to_days` floor-divides by 8. Files written by other tools
at non-8h boundaries (e.g. `PT23H`) round *down* to the next lower whole
day on import; re-export emits the rounded value.

This is the same tolerance the primary `Duration` field has had since
ADR-0021. Changing the parser to round-nearest is out of scope and would
shift calibration for users already on the floor convention.

### 8. Summary contents

The importer's result summary (`TaskRun.result_summary`, surfaced via the
WebSocket "import complete" event per ADR-0092) gains two new keys:

- `tasks_with_three_point_estimates: int` — leaf tasks that received all
  three values.
- `tasks_skipped_partial_three_point: int` — tasks for which the file
  supplied a subset (1 or 2 of the three values); the parser dropped
  them to `None` per Q3.

These let the post-import card surface lines like "3-point estimates
imported for 17 of 23 work tasks (skipped 2 with partial data)".

## Consequences

**Positive:**
- Migrators bringing MS Project plans with PERT estimates retain their
  Monte Carlo inputs end-to-end.
- A TruePPM project with three-point estimates can be exported and opened
  in MS Project, where the values appear under the standard `Duration1–3`
  custom fields and `Duration4` displays the PERT-Expected computation.
- Edge cases (partial data, repurposed slots, summary noise) fail safely
  with warnings the user can read in the import summary.

**Limitations:**
- Round-trip drift on non-8h-multiple durations (Q7).
- Files using non-standard `Duration` slots for PERT estimates are not
  honored (Q2).
- The MS Project `Duration4` PERT-Expected value is derived by the formula
  on file open; TruePPM does not write or read a per-task `Duration4`
  value.

## Out of scope

- ExtendedAttribute mapping for other custom field families (Cost, Text,
  Flag, Number, Date). Only `Duration1–4` for PERT.
- Frontend UI for three-point estimates — already exists per ADR-0032.
- Changes to the scheduler engine's PERT consumption or to the
  `EstimationMode` governance model.
- Importing or exporting cost estimates, baseline data, or risk scoring.

## Implementation

- Constants: `packages/api/src/trueppm_api/apps/msproject/extended_attributes.py`
- Parser: `packages/api/src/trueppm_api/apps/msproject/parser.py`
  (functions `_parse_pert_extended_attribute_defs`,
  `_extract_pert_task_values`)
- Importer: `packages/api/src/trueppm_api/apps/msproject/importer.py`
  (helper `_summary_indices`)
- Exporter: `packages/api/src/trueppm_api/apps/msproject/exporter.py`
  (helpers `_summary_pks_from_tasks`,
  `_add_pert_extended_attribute_defs`, `_add_pert_task_values`)
- Tests: `packages/api/tests/apps/msproject/test_pert_mapping.py`
- Integration fixture: `packages/api/tests/apps/msproject/fixtures/cloud_migration.xml`
  (vendored via #801 / MR !427; produced by `mpp-sample build --three-point`)
