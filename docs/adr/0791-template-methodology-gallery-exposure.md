# ADR-0791: Expose a template's methodology to the gallery without exposing its structure

## Status

Accepted — 2026-08-04, for #2728 (0.4); child of epic #2740, sibling of #2729/ADR-0789.

## Context

#2728 replaces the 3-step "New project" modal with a one-screen Start sheet. The
sheet derives — never asks — a read-only "this project will carry these views" line
from whichever of the three ways-in (Template / Blank / Import) is selected, per
ADR-0041 (methodology only ever hides tab chrome; it is not enforcement).

For Blank and Import, deriving this is already solved entirely client-side:
`Program.effective_methodology` (already on every row `usePrograms()` returns) and
`WorkspaceSettings.methodology` (already on `useWorkspaceSettings()`) cover the
`project ?? program ?? workspace` chain from ADR-0107 with zero new requests.

For Template, there is no client-side source at all. `ProjectTemplate.structure`
stores `"methodology": project.methodology` at publish time
(`project_templates.py::extract_structure`), but `ProjectTemplateSerializer`
deliberately excludes `structure` from the gallery list response — ADR-0789 §1's own
rationale, reaffirmed by MR !1906's ai-review finding: a list endpoint is read by a
wider audience than the source project's members, and `structure` carries a whole
project's shape (task names included). That exclusion is correct and this ADR does
not revisit it. The gap is narrower: the gallery has no way to say *which planning
model* a template implies, at all — not even the enum, let alone the task list.

`carries` (`structure`, `dependencies`, `durations`, `milestones`, `delivery_modes`,
`sprint_length`) is the wrong field to overload for this — it is a presence-tag list
answering "what shape did this template freeze", not an enum answering "which
methodology does adopting this select". Conflating the two would make `carries`
lie about its own contract for every existing consumer (`TemplateGallery`'s "Carries
…" caption, #2729's own tests).

## Decision

Add one additive `SerializerMethodField` to `ProjectTemplateSerializer`:

```python
methodology = serializers.SerializerMethodField()

def get_methodology(self, obj: ProjectTemplate) -> str:
    """The methodology the source project carried at publish time.

    Read off the frozen ``structure`` document, mirroring ``get_task_count`` —
    never re-queries the (possibly since-edited/archived/deleted) source project,
    and can never disagree with what `apply` will actually seed. Every template's
    structure has carried this key since ADR-0789 (#2729) shipped it; the fallback
    below only guards a structure a future format change edits out from under an
    already-published row, or a row written directly against the DB outside the
    publish path — it is not expected to fire in practice.
    """
    structure = obj.structure or {}
    methodology = structure.get("methodology")
    return methodology if methodology in Methodology.values else Methodology.HYBRID
```

- **Field name**: `methodology` (matches the vocabulary already used everywhere
  else on `Project`/`Program`/`Workspace` — no synonym invented for this one reader).
- **Shape**: a bare `str` from `Methodology.values` (`WATERFALL` / `AGILE` / `HYBRID`),
  not a nested object — there is nothing else to carry, and every other consumer of
  the enum (the Start sheet's own Blank/Import derivation) already receives it this
  way from `Program`/`Workspace`.
- **Null-handling**: never null. Falls back to `Methodology.HYBRID`, mirroring
  `methodology.py`'s own `DEFAULT_METHODOLOGY` system backstop for the same reason —
  Hybrid is the lossless default (shows every tab) rather than a guess that could
  hide a view the template actually needs.
- **Still excluded**: `structure` itself. `carries` is untouched — it keeps meaning
  "what shape", and `methodology` means "which planning model". Nothing about
  ADR-0789's audience boundary changes: the new field is a three-value enum, not a
  document.
- **No migration.** `ProjectTemplate.structure` (JSONB) already stores the value;
  this is a read projection, not a new column.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Dedicated `methodology` SerializerMethodField (chosen)** | Additive, no migration; mirrors `task_count`'s existing pattern of reading off frozen `structure`; keeps `carries` semantically pure | One more field on a list serializer (negligible payload cost — a 3-value enum) |
| B. Overload `carries` with a `"methodology:AGILE"`-style tag | No new field | Breaks `carries`' existing contract for every current reader (`TemplateGallery`'s caption, tests); a string a UI must parse instead of read |
| C. Expose `structure.methodology` via a separate `/project-templates/{id}/methodology/` detail action | Keeps the list endpoint minimal | Extra round-trip per way-card selection on a form the design requires to feel instant (panel swap "without changing the sheet's height class" — no loading state budgeted); re-litigates ADR-0789's audience boundary for one scalar for no benefit, since a scalar carries none of the exposure risk `structure` does |
| D. Denormalize a `ProjectTemplate.methodology` column at publish time | Queryable/filterable if ever needed | New migration for a value already durably frozen in `structure`; two sources of truth that must never drift, for a field with no current filter/sort use case |

## Consequences

- The Start sheet can derive its methodology line for all three ways-in from data
  already in flight (the gallery list fetch, `usePrograms()`, `useWorkspaceSettings()`)
  — no new request, no loading state on way-card selection.
- `ProjectTemplateSerializer` grows one read-only field; every existing caller
  (gallery, publish response) is unaffected — additive fields never break additive
  consumers, and the OpenAPI schema regen is the only required follow-up.
- Any future template list/detail surface inherits the same field for free.
- Risk: a hand-edited or pre-versioning `structure` document missing the key falls
  back to Hybrid rather than surfacing an error — judged correct because Hybrid is
  never wrong to *show* (it under-hides rather than over-hides tabs), matching the
  workspace-level system default's own failure mode.

## Implementation Notes

- P3M layer: Programs and Projects (single-project creation flow)
- Affected packages: api (serializer field only), web (Start sheet reads it)
- Migration required: no
- API changes: yes — additive read-only field `methodology` on
  `ProjectTemplateSerializer` (`GET /api/v1/project-templates/`,
  `POST /api/v1/project-templates/publish/` response). `docs/api/openapi.json`
  regenerated in the same MR.
- OSS or Enterprise: OSS (extends an existing OSS-only endpoint; no enterprise
  surface touched)

### Durable Execution

1. Broker-down behaviour: N/A — synchronous serializer read of an already-persisted
   JSONB column, no dispatch involved.
2. Drain task: N/A — no async work introduced.
3. Orphan window: N/A — no `transaction.on_commit()` involved.
4. Service layer: N/A — a `SerializerMethodField`, not a service call.
5. API response on best-effort dispatch: N/A — this is a synchronous read field, not
   a dispatch endpoint.
6. Outbox cleanup: N/A — no outbox row created.
7. Idempotency: N/A — read-only, no write side effect; reading the field twice
   always returns the same value for an unchanged row.
8. Dead-letter / failure handling: N/A — no task, no failure mode beyond the
   documented in-serializer fallback to `Methodology.HYBRID`.
