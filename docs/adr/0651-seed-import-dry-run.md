# ADR-0651: Dry-run validation for the JSON seed import

## Status
Accepted

## Context

`validate_seed` (#614, ADR-0109) is a genuinely good linter: JSON-Schema
conformance, referential integrity across accounts / calendars / resources /
tasks / sprints / risks, node budgets, three-point estimate ordering, and v2
event target resolution — every diagnostic anchored to a JSON path. **There was
no way to run it without committing to an import.**

That gap is asymmetric with the sibling format. CSV import has had a preview
endpoint since #743 (`POST /projects/{id}/import/csv/preview/`); the JSON seed
had nothing, and `manage.py import_seed` had no `--check`.

It matters more for seed than for CSV because `import_seed` is
**wipe-then-recreate on the program slug** (ADR-0109). Re-importing a document
whose slug matches a live program hard-deletes that program's subtree and
rebuilds it. The whole operation is one transaction, so a validation failure
rolls back cleanly — but the operator still could not answer *"is this file
going to be accepted?"* before pointing a destructive operation at a live slug.

A second, smaller defect compounded it: `validate_seed` accumulated schema and
referential errors into a list, but **short-circuited with an early `raise` on
the two `schema_version` checks**. A document missing its version reported one
problem and hid the other twenty — the opposite of the "report everything at
once" property the rest of the validator was built for.

## Decision

**1. Split the validator into a total form and a raising form.**

```python
inspect_seed(payload) -> SeedReport   # pure, total, never raises
validate_seed(payload) -> None        # unchanged contract; wraps inspect_seed
```

`SeedReport` carries `valid`, the full `errors` list, and the identity the
document *claims* (`schema_version`, `program_slug`, `program_name`,
`project_count`, `task_count`, `resource_count`). The claim fields are read
defensively — they are most useful on a document that failed.

`validate_seed` keeps its exact prior contract: every document that raised
before still raises, with at least the same diagnostics. The refactor only ever
*adds* errors; it never turns a failure into a pass.

**2. Report all diagnostics — with one deliberate asymmetry on the version.**

- **Missing `schema_version`** — report it, then run the structural pass anyway
  against the newest supported schema. v2 is an additive superset of v1
  (ADR-0114), so a v1-shaped document validated against v2 still passes
  structurally. The version is injected into a **shallow copy** for that pass
  only: both bundled schemas list `schema_version` as `required`, so without
  the injection the schema would re-report the same problem in vaguer language,
  and the caller's parsed document must come back out unmutated.
- **Unsupported major** — report it and stop. There is no defensible schema to
  substitute; checking a `3.x` document against the v2 schema would bury the one
  diagnostic that matters under a wall of misleading ones.

**3. `POST /api/v1/programs/import/validate/`** — same request shapes
(multipart `file` or raw JSON body), same upload ceiling, same authorization as
the real import. Persists nothing.

**4. `manage.py import_seed <path> --check`** — same validation, exit 0/1,
human-readable output led by the claimed identity. Owner resolution is skipped
on this path, so a dry run works on an instance with no superuser.

### An invalid document is `200 {"valid": false}`, not `400`

The request succeeded. The *document* is what failed, and the caller needs the
diagnostics either way — a `400` invites clients to treat the body as an error
envelope and discard exactly the payload they asked for.

The line between the two status codes is **document problem vs. request
problem**:

| Condition | Status | Why |
|---|---|---|
| Fails validation | `200 {"valid": false, "errors": [...]}` | The answer to the question asked |
| Body is not parseable JSON | `200 {"valid": false, "errors": [...]}` | Also a fact about the file; telling the operator is the job |
| Upload over `SEED_MAX_UPLOAD_MB` | `400` | We never read it — there is nothing to diagnose |

Note this deliberately diverges from `POST /programs/import/`, which returns
`400` for unparseable JSON. That is correct for *import*, where the request
genuinely could not be carried out, and wrong for a dry run, whose entire
purpose is to characterize the file.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Chosen: separate `/import/validate/` action + `--check`** | Matches the CSV preview precedent; dry run is discoverable; no flag threading through the import path | One more route |
| `?dry_run=true` on `POST /programs/import/` | No new route | Overloads a destructive endpoint's success shape with a non-destructive one — a client that forgets the flag wipes a program. The blast radius of a typo should not be "deleted the program" |
| Return `400` on an invalid document | Consistent with the import endpoint | Fights every HTTP client's error handling to deliver the payload the caller explicitly requested |
| Restructure diagnostics into `{severity, code, location}` now | Better long-term shape | Races ADR-0634 (!1669), which changes that shape underneath. Deferred to the follow-up; this ships against the shape that exists |
| Make `validate_seed` itself non-raising | One function | Breaking change to the importer's contract for no gain — `import_seed` genuinely wants to abort |

## Consequences

**Easier**
- An operator can lint a 5,000-task seed before pointing a destructive import
  at a live slug — the answer costs one request and no writes.
- A version-less document now reports every problem in one pass instead of one
  problem per run.
- `--check` is CI-gateable, and a regression test asserts **every** committed
  fixture passes it — discovered by globbing the fixtures directory, so the
  guard extends to fixtures that do not exist yet.

**Harder**
- Two entry points into validation. Mitigated by `validate_seed` being a
  four-line wrapper — they cannot drift.

**Risks**
- Validating a version-less document against the v2 schema could in principle
  emit a v2-specific error on a v1-shaped file. Bounded: v2 is a strict additive
  superset, `anchor` is not required, and the document is already invalid.
- A dry run parses an untrusted document, so it is **not** a lighter-privilege
  surface. It carries the same `IsAuthenticated` gate as import and its own
  throttle scope (below).

### Throttling

New `seed_validate` scope (`SeedValidateThrottle`, default 20/min via
`TRUEPPM_THROTTLE_SEED_VALIDATE_RATE`), deliberately **not** a
`_SeedImporterThrottle` subclass. The dry run never reaches the importer, so it
carries none of the teardown-and-rebuild cost that bucket exists to bound — but
JSON-Schema validation is still CPU proportional to a caller-sized document, so
it needs a bound of its own. It gets a *separate* bucket for a usability reason
as much as a cost one: the point of a dry run is to iterate on a file until it
passes, and spending the real import allowance to do that would lock an operator
out of the import their fixed file just earned. Follows `UserRateThrottle`, not
`ScopedRateThrottle`, for the reason documented on `_SeedImporterThrottle`.

## Implementation Notes

- P3M layer: **Programs and Projects** — a single program's document, no
  cross-program scope.
- Affected packages: `api`
- Migration required: **no** — no model change.
- API changes: **yes** — one new action, `POST /api/v1/programs/import/validate/`.
- OSS or Enterprise: **OSS**. Importing your own program's seed is table stakes
  for a self-hoster; nothing here aggregates above the program.

### Durable Execution
1. **Broker-down behaviour**: N/A — the dry run is fully synchronous and has
   zero async side effects. It reads a request body, runs a pure function, and
   returns. Nothing is enqueued and nothing is written, so there is no
   commit-without-dispatch window to protect.
2. **Drain task**: N/A — no async work, so no drain.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: `seed/validation.py::inspect_seed`. Pure and Django-free;
   the module never imports the ORM, which is what makes "persists nothing"
   structural rather than merely intended.
5. **API response on best-effort dispatch**: N/A — synchronous. Returns `200`
   with the report.
6. **Outbox cleanup**: N/A — no outbox rows.
7. **Idempotency**: Trivially idempotent — a pure function of the request body
   with no state. Running it N times is indistinguishable from running it once.
8. **Dead-letter / failure handling**: N/A for async. On the synchronous path a
   document problem is the `200 {"valid": false}` result (not a failure), and a
   request problem is a `400`. `--check` maps the same distinction onto exit
   codes: `CommandError` (exit 1) for an invalid document, exit 0 for a valid
   one.

## Related
- ADR-0109 — canonical JSON seed import/export schema (the wipe-then-recreate
  semantics this exists to de-risk)
- ADR-0114 — seed schema v2, the additive superset the missing-version fallback
  relies on
- ADR-0634 — file interchange contract; the diagnostic-shape restructure is
  deliberately **out of scope** here and lands after it
- #743 — the CSV preview endpoint this follows
