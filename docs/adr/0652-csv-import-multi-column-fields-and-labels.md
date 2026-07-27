# ADR-0652: Multi-column mapping and a labels channel for spreadsheet import

## Status
Accepted

## Context

Reconciling the `CSV Import Wizard.html` design against the API that shipped in
#743 (!1668) surfaced two claims the implementation did not honor.

**1. `labels` was not a mappable field at all.** `csvimport/mapping.py`'s
`TARGET_FIELDS` carried the alias table inherited from #111, which predates
labels entirely — ADR-0400 landed later. A spreadsheet with a `Tags` or
`Labels` column imported with that column silently unmapped.

That matters disproportionately for 0.4, where labels are a headline: the
#2332 family (#2331 API filter, #2383 shared facet, #2384 Schedule, #2385 saved
views, #2334 ⌘K) all ship this cycle. An import path that drops the label
column hands the spreadsheet migrator a project where every one of those
features is empty — on their first five minutes with the product. The adoption
on-ramp landing a user in the least convincing possible state.

**2. `detect_mapping` was strictly one-column-per-field.** A second column
claiming a taken field was reported `duplicate` and dropped. That is the *right*
default for `Task.name` — two name columns is a mistake — but wrong for the two
fields that are naturally many. A sheet routinely carries `Tags`, `Component`
and `Team` that should all become labels; an MS Project CSV export spreads
dependencies across `Predecessor 1` / `Predecessor 2`.

## Decision

**1. `FieldSpec.multi: bool`.** When set, the field is *not* consumed from
`taken` on match, so later columns can also claim it. `labels` and
`predecessors` set it; everything else keeps exactly-one behavior and today's
`duplicate` reporting. Opt-in per field, not a global relaxation.

**2. `by_field` becomes `dict[str, list[int]]` uniformly** — a list even for
single-valued fields, rather than a union of `int` and `list[int]`. Every
single-valued read goes through an explicit `_one(by_field, field)` accessor.

This shape is the safety property, not an aesthetic one. A mixed-type map would
let a `by_field["labels"]` written before this change keep type-checking while
silently dropping every column but the first. Making the container uniformly a
list turns each of the ~30 read sites into a `mypy --strict` error until it is
visited and its one-to-one-ness restated at the call site.

**3. `FieldSpec.exact_only`** — aliases that match in the exact tier but are
withheld from the fuzzy substring tier. Needed immediately by `tag`: the fuzzy
tier admits any alias of 3+ characters, and `"tag"` is a substring of
`"Percentage"` and `"Stage"`. Without this, adding the obvious `tag` alias would
have quietly routed a percentage column into labels — a regression on an
existing, shipped importer introduced by an unrelated feature.

Raising the global fuzzy floor from 3 to 4 characters was the alternative, and
was rejected: it silently changes matching for six existing aliases (`day`,
`who`, `due`, `end`, `ref`, `key`) on a shipped importer, to fix a problem
scoped to one new alias.

**4. `TaskData.labels: list[str]`** — label *names*, not slugs or ids. The
parser is deliberately Django-free and cannot see the database, so resolving a
name to a catalog entry belongs to `import_project`. This keeps CSV on the
shared `import_project` path per ADR-0632, and immediately gives the Jira
adapter a channel for the components/labels it drops today.

**5. Match-or-create in `import_project`, case-insensitively, per project.**
`Label` is project-scoped (ADR-0400), so matching is scoped to the target
project — a same-named label in another project is not a match. On a match the
**existing catalog spelling wins**: the catalog is curated, the spreadsheet is
not, and an import must not mint `Safety` beside an existing `safety`.

Idempotent across re-import in both directions: labels resolve by name, and the
`TaskLabel` rows are `bulk_create(ignore_conflicts=True)` against the
`unique(task, label)` constraint.

**6. Bounded.** A label column is free text under the operator's control, so an
accidental mapping (a Notes column landing on `labels`) would otherwise mint one
catalog entry per row. Caps: 100 distinct labels per import, 20 per task, names
truncated to `Label.name`'s 50 characters. All three degrade by dropping the
excess with a row error or warning rather than failing the import — the tasks
are still worth having.

### Colors

The issue specified "the palette's next free slot, as the normal create path
does." The normal create path does **not** do this — `Label.color` simply
defaults to `SLATE` unless the client picks one. Rather than reproduce a
behavior that does not exist, new labels cycle `LabelColor.choices` starting
from the end of the current catalog, which satisfies the evident intent (a
distinguishable set, not a wall of the default) without inventing a shared
"next free slot" allocator this change has no call to design.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Chosen: `multi` flag + uniform `list[int]`** | Opt-in per field; the type forces every read site to be visited | Touches ~30 call sites |
| `by_field: dict[str, int \| list[int]]` | Smaller diff | The union type is exactly what lets an unvisited call site keep compiling while dropping columns |
| Separate `by_field_multi` map | No change to existing reads | Two maps that must be kept in sync; a reader has to know which to consult |
| Relax duplicates globally | One-line change | Two `Name` columns silently becoming a union is a data-quality bug, not a feature |
| Raise the fuzzy floor to 4 chars instead of `exact_only` | No new field | Changes matching for six existing aliases on a shipped importer to fix one new one |
| Resolve labels in the parser | Fewer moving parts | The parser is deliberately Django-free (ADR-0632) so the preview endpoint and the Celery task share it; a DB lookup there would break both |

## Consequences

**Easier**
- A migrated spreadsheet lands with its labels intact, so the 0.4 label features
  are populated on first contact rather than empty.
- MS Project CSV exports with numbered predecessor columns import fully.
- The Jira adapter now has a labels channel to fill (`TaskData.labels`), which
  is the natural home for the components/labels it currently drops.
- `field_choices()` reports `multi`, so the wizard (#746) can render frame 2.1's
  Labels card as an additive list.

**Harder**
- `by_field` reads are one call longer (`_one(by_field, "name")`). Deliberate —
  the verbosity is the point at which "this field is one-to-one" becomes an
  explicit claim.

**Risks**
- `field_choices()` gained a `multi` key; the preview endpoint's
  `available_fields` shape changed. No web consumer exists yet (the wizard is
  #746), and the API test asserting the exact key set is updated in this change.
- A label column mapped by mistake mints catalog entries. Bounded by the caps
  above, and visible in the preview before commit.

## Implementation Notes

- P3M layer: **Programs and Projects** — single-project import, no cross-program
  scope.
- Affected packages: `api`
- Migration required: **no** — `Label` / `TaskLabel` already exist (ADR-0400);
  `TaskData` is a plain dataclass.
- API changes: **yes, additive** — `labels` joins the mappable field catalog and
  `multi` joins each entry in `available_fields` on
  `POST /projects/{id}/import/csv/preview/`. No endpoint added or removed.
- OSS or Enterprise: **OSS**. Single-project spreadsheet import is core
  adoption-path functionality.

### Durable Execution
1. **Broker-down behaviour**: Unchanged — this modifies the *body* of the
   existing CSV import, which already runs inside the `csvimport.tasks` Celery
   task dispatched through the established request-row + drain pattern. No new
   dispatch site is introduced, so no new commit-without-dispatch window exists.
2. **Drain task**: Reuses the existing CSV import drain. Semantics match
   exactly — this is the same task doing more inside one `import_project` call,
   not a new category of async work.
3. **Orphan window**: Unchanged — the existing `_DRAIN_MIN_AGE_MINUTES = 10` and
   `_IMPORT_ORPHAN_MINUTES = 15` continue to apply to the whole import.
4. **Service layer**: `msproject/importer.py::import_project`, the shared
   interchange entry point (ADR-0632). Label attachment is a new private step
   (`_import_labels`) inside it, not a new dispatch path.
5. **API response on best-effort dispatch**: Unchanged — the CSV import endpoint
   already returns the async request row and the client polls it.
6. **Outbox cleanup**: N/A — no new outbox rows; the existing import-request
   retention is untouched.
7. **Idempotency**: Labels resolve by name against the project catalog and
   `TaskLabel` rows are created with `ignore_conflicts=True` against
   `unique(task, label)`, so a duplicate execution of the import task creates no
   duplicate catalog entries and no duplicate assignments. Asserted by
   `test_re_import_is_idempotent`.
8. **Dead-letter / failure handling**: Unchanged — inherits the existing CSV
   import task's retry limit and failure status on the `CsvImportRequest` row.
   Label-specific *degradation* is deliberately not a failure: exceeding a cap
   or a name ceiling records a row error or warning and imports the rest, since
   a project with its tasks and most of its labels beats a failed import.

## Related
- ADR-0400 — task labels (the project-scoped `Label` / `TaskLabel` model)
- ADR-0632 — the CSV/Excel import adapter onto `ProjectData`
- #743 — the CSV import API this extends
- #746 — the 3-step wizard whose frame 2.1 Labels card this unblocks
- #111 — the parent spreadsheet-import epic and the source of the alias table
