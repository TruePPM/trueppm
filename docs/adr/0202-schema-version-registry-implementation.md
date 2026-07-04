# ADR-0202: Forward-Migration Registry Implementation for User-Saved JSON State

## Status
Accepted — implements ADR-0086.

> Numbering note: ADR-0086 reserved this implementation rollout to #645. The
> issue text referenced "ADR-0199", but 0199 and 0200 were already committed on
> `main` (`board-filter-bar-facets`, `stale-task-daily-detection`) by the time
> this branch landed, so this record takes the next genuinely-free number. 0199/0200 were taken on main, and 0201 collided with a parallel branch (#374), so this record uses 0202.

## Context

**P3M layer:** Cross-cutting persistence convention. Repo: **OSS**.

ADR-0086 adopted the convention that every user-saved JSON payload carries a
top-level `schema_version: int` and is read through a forward-migration registry
keyed on `(surface, version)`. ADR-0086 is documentation + a review gate only; it
explicitly deferred the *implementation rollout* to #645:

- build the registry helper on both `packages/api` and `packages/web`;
- retro-apply the field to existing saved-state surfaces, starting with
  `useBoardSavedViews`;
- upgrade already-saved payloads transparently on read.

This ADR records the concrete implementation decisions. It adds no new design;
it makes ADR-0086 real.

**Surface inventory (grounded, not invented).** A codebase sweep for user-saved
JSON state found exactly one surface that matches ADR-0086's "saved views /
filters / dashboards" scope and is wired to a user-facing hook today:

| Model.field | Hook | In scope now? |
|---|---|---|
| `BoardSavedView.config` | `useBoardSavedViews` (#191) | **Yes** — the ADR-0086 named target |
| `BoardColumnConfig.columns` | board column editor | Deferred — per-project *admin* config, not a saved view; registers later |
| `UserProfile.hidden_views` | nav prefs | Out of scope — a flat key list, not a versioned payload |

So this rollout versions **`BoardSavedView.config`** and builds the generic
registry that the deferred surfaces register against with one line each.

## Decision

### 1. `schema_version` column on `BoardSavedView`

Add `schema_version = models.IntegerField(default=1)`. Default `1` = the current
6-key config shape. New rows are born current; the column also stamps the version
the writer emitted so a future reader can tell what it is looking at.

### 2. A generic surface-keyed registry module (api side)

New module `packages/api/src/trueppm_api/apps/projects/schema_migrations.py`
(the projects app already owns `BoardSavedView`, its serializer, and the
`_VALID_*` config constants, so this is the natural home; a genuinely cross-app
surface later can promote it to an `integrations.registry`-style module):

```python
SURFACE_BOARD_SAVED_VIEW = "board_saved_view"

# {surface: {from_version: fn(payload) -> payload_at (from_version + 1)}}
_MIGRATIONS: dict[str, dict[int, Migration]] = {}
CURRENT_VERSIONS: dict[str, int] = {}

def register_migration(surface, from_version, current, fn): ...
def current_version(surface) -> int: ...
def migrate_payload(surface, payload, from_version) -> tuple[dict, int]:
    """Apply the ordered v(n)->v(n+1) chain until payload is current."""
```

- Absent `schema_version` on a stored payload ⇒ treated as version `0`.
- A payload at a version **newer** than the code's current ⇒ hard `ValueError`
  (not a silent best-effort read), per ADR-0086.
- `board_saved_view` current version is `1`; a `v0 -> v1` migration backfills the
  six canonical config keys (`sort`, `show_wip`, `show_col_tints`, `evm_mode`,
  `show_cost`, `risk_linked_only`) with their documented defaults, so any legacy
  row written before a key existed upgrades to the full shape on read.

### 3. Read-time upgrade wired into the serializer

`BoardSavedViewSerializer.to_representation` runs `config` through
`migrate_payload(SURFACE_BOARD_SAVED_VIEW, config, stored_version)` and returns
the upgraded config plus the resolved `schema_version`. The upgrade happens on
**read** for every client (web, mobile, MCP) — no data migration rewrites rows.
Writes continue to normalize via `validate_config` and stamp the current version.

### 4. Mirrored web registry

`packages/web/src/lib/schemaMigrations.ts` mirrors the same surface key, current
version, and per-step transform semantics so a payload upgraded client-side and
one upgraded by the API reach an identical shape. `useBoardSavedViews` reads the
API-normalized `config` (already current) but also runs incoming payloads through
the mirror as defense-in-depth and to cover any future web-only persisted state.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Data-migration backfill (rewrite every row to current shape)** | Rows uniform at rest | ADR-0086 explicitly chose read-time upgrade; a backfill can't cover web-only `localStorage` state and re-runs on every future shape change. Rejected. |
| **B. Structural sniffing in the serializer** | No new module | The exact fragility ADR-0086 rejects. Rejected. |
| **C (chosen). `schema_version` column + read-time forward-migration registry** | Implements ADR-0086 verbatim; localized shape evolution; explicit unknown-version failure | A small registry per side + the day-one discipline. Accepted. |

## Consequences

- **Easier:** the next config-shape change is a one-line `v1 -> v2` transform plus
  a version bump on the writer; old rows upgrade transparently. New surfaces
  register with one call.
- **Harder:** a small registry now exists on each side and must stay mirrored
  (guarded by the shared surface-key constant and unit tests on both sides).
- **Risks:** api/web drift — mitigated by shared constants + tests; a forgotten
  version bump on a breaking change — mitigated because the transform chain is the
  only read path, so a missing step is a visible gap, not a silent mis-read.

## Implementation Notes

- P3M layer: **Cross-cutting (persistence convention)**
- Affected packages: **api** (model + migration + registry + serializer), **web**
  (mirror registry + hook)
- Migration required: **yes** — add `schema_version` (IntegerField, `default=1`,
  non-null, safe additive column)
- API changes: **yes** — `BoardSavedViewSerializer` gains a read-only
  `schema_version` field and read-time config upgrade; OpenAPI regenerated
- OSS or Enterprise: **OSS** (Enterprise saved-state surfaces inherit the contract)

### Durable Execution
1. Broker-down behaviour: **N/A** — the upgrade is a synchronous, in-process,
   pure-function transform on the read path. No task is dispatched.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no async work.
4. Service layer: `schema_migrations.migrate_payload()` is the single read-path
   entry; the serializer is the only caller.
5. API response on best-effort dispatch: **N/A** — synchronous read.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: the transform chain is a pure function of `(surface, payload,
   from_version)` — re-running it on an already-current payload is a no-op
   (`from_version == current` ⇒ empty chain). Reads are naturally idempotent.
8. Dead-letter / failure handling: a payload at a version newer than the code
   raises `ValueError` (surfaced as a 500, deliberately loud — a downgraded
   deployment reading forward-version data is an operator error, not silent data
   loss). Malformed non-dict config is coerced defensively to the current default
   shape rather than crashing a list read.

## Related
- **ADR-0086** — the parent convention this ADR implements.
- **#645** — this implementation rollout.
- **#191** — `BoardSavedView` / `useBoardSavedViews`, the first versioned surface.
- **ADR-0039 / ADR-0139 / ADR-0193** — deferred saved-state surfaces that will
  register against this registry as they adopt the field.
