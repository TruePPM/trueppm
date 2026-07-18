# ADR-0528: Per-Task Custom-Field Value Store (OSS, typed columns, rides Task version)

## Status

Proposed (2026-07-18)

> **Amends [ADR-0050](0050-task-detail-drawer-section-extension-points.md).** ADR-0050
> filed the Custom Fields drawer *section* as Enterprise-only (`trueppm-enterprise#59`).
> Since then #521 shipped project-scoped custom-field *definitions* (`ProjectCustomField`)
> in OSS, and #1989/#2143 place team-level, single-project custom fields on the OSS side
> of the adoption/governance line. This ADR designs the OSS per-task **value** store and
> reclassifies the OSS drawer/board rendering of those values as OSS. The Enterprise line
> moves to the *org-governed* EAV backend (`CUSTOM_FIELD_BACKEND` extension point, #2064,
> 0.6): cross-program field catalogs, org policy, and directory-scoped value governance.

## Context

**P3M layer:** Programs and Projects (single-project task metadata). **Repo:** OSS.

TruePPM already has project-scoped custom-field **definitions** — `ProjectCustomField`
(`projects/models.py:6145`, #521): `name`, `field_type` from `CustomFieldType` (`TEXT`,
`NUMBER`, `DATE`, `SINGLE_SELECT`, `MULTI_SELECT`, `USER`, `BOOLEAN`), an `options` JSON
list for the select types, plus `order`, `required`, and a manually-bumped
`server_version`. CRUD at `/projects/<id>/fields/` (`ProjectCustomFieldViewSet`),
read = Viewer+ (`IsProjectMember`), write = Scheduler+ (`IsProjectScheduler`).

There is **no per-task value store yet** — both the `CustomFieldType` and
`ProjectCustomField` docstrings defer it and name the intended model
`TaskCustomFieldValue`. `Task` (`projects/models.py:1961`, `VersionedModel`) has discrete
typed columns and **no JSON catch-all**. Board cards are served by `TaskSerializer`
(`serializers.py:2469`).

We must persist a **typed** value per `(Task, ProjectCustomField)` so it can:
(1) be exposed on the Task read payload (API-first / agent-reachable, ADR-0112);
(2) offline-sync via the WatermelonDB delta;
(3) return documented **400** shapes for typed writes;
(4) avoid **N+1** on the board task feed.
We also add the additive `show_on_card` boolean to `ProjectCustomField`.

### Precedent that anchors this design — ADR-0400 labels

Task labels solved the identical shape: a bounded, per-task typed collection.
`TaskLabel` is a **plain** `models.Model` (through table, hard-deleted on detach); the
`Label` **catalog** is a `VersionedModel` synced as its own delta collection; and the
per-task assignment reaches clients as a flat **`label_ids` array on the Task payload**
that rides `Task.server_version` — "attaching/detaching a label bumps `Task.server_version`
so this delta pulls" (ADR-0400; `TaskSerializer.labels` / `SyncTaskSerializer.label_ids`).
No per-assignment `server_version`, no per-assignment tombstone — array replacement on the
task handles removal. This ADR follows that pattern exactly, one level richer (a
`{<field_id>: value}` *map* instead of an id *array*, because each value is typed).

## Decision

**Store each value as one `TaskCustomFieldValue` row per `(task, field)` with
type-specific columns (Option A), and sync it by riding `Task.server_version` as a flat,
read-only `custom_fields: {<field_id>: value}` map on both `TaskSerializer` and
`SyncTaskSerializer` — not as a new synced collection.** This mirrors ADR-0400 `label_ids`.

`TaskCustomFieldValue` is a **plain model** (like `TaskLabel`): no `VersionedModel` base,
no per-value `server_version`/tombstone. Setting a value upserts the row and **bumps the
parent `Task.server_version`**; clearing a value hard-deletes the row and bumps
`Task.server_version` — so the map re-syncs and the client drops the absent key.

> **Scope resolution (2026-07-18, orchestrator).** The value map ships on **both**
> `TaskSerializer` and `SyncTaskSerializer` now — so the online web board (#2144) and the
> task delta both carry values. The **offline definition-sync fold-in is deferred** (was
> 🔴 #1): `ProjectCustomField` is *not* converted to `VersionedModel` and *no*
> `project_custom_fields` delta collection is added in this MR. Rationale: #2143's job is
> to unblock the **online** web board card — the web client reads definitions from
> `GET /projects/<id>/fields/` (online) and merges them with the value map. Offline mobile
> *rendering* of custom fields (which needs the definitions client-side) is a genuine but
> separable follow-up; folding a VersionedModel conversion + a new sync collection +
> watermark wiring into this change needlessly widens the migration and delta-protocol
> surface for a slice nothing in 0.4 renders yet. Tracked as a follow-up. The rest of this
> ADR's "Offline sync → definitions" subsection describes that deferred work, not this MR.

### Two decisions, kept separate

- **Storage = Option A (typed columns).** `USER` becomes a real FK with defined
  `on_delete` and write-time membership validation; each type is a first-class column the
  DB can back; MULTI_SELECT uses one JSON column. This is what gives the value store
  integrity a JSON blob cannot. (Options B/C below.)
- **Sync = ride `Task.server_version`** (ADR-0400 precedent), *not* a per-value
  `VersionedModel` collection. See "Sync alternative weighed" for why.

### Why Option A over B and C (storage)

- **Option C — JSON blob on `Task` keyed by field slug/id — rejected.** No FK for `USER`
  values (no existence/membership guarantee, undefined on user deletion); no DB-level
  constraints; couples every card render to deserializing an unindexed blob. (The
  original #2143 brief also cited "no per-value `server_version`" — moot here since even
  Option A rides the task version, but the integrity/constraint objections stand and are
  decisive on their own.)
- **Option B — one row per `(task, field)` with a single JSON `value`, coerced by
  `field_type`.** Wins on migration simplicity and native MULTI_SELECT. But a JSON
  `value` still cannot hold a real `USER` FK (relocates C's integrity problem) and cannot
  be DB-constrained per type.
- **Option A — typed columns + resolver — chosen.** Real `USER` FK, per-type columns,
  matches the `TaskResource.units` / blocker-field precedent. Cost: seven mostly-null
  columns and a `field_type`→column resolver — a small, understood tradeoff.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — typed columns** (chosen) | Real USER FK (integrity + defined on_delete); per-type DB backing; matches `TaskResource`/blocker precedent | 7 mostly-null columns/row; a resolver; MULTI_SELECT needs one JSON column |
| **B — single JSON `value`** | Fewest columns; native MULTI_SELECT list | No real USER FK; no per-type DB constraint; all typing in app code |
| **C — JSON blob on `Task`** (rejected) | Zero new tables | No USER FK; no constraints; re-validates a blob on every card render |

**Sync alternative weighed — per-value `VersionedModel` collection vs ride-Task-version.**
A dedicated `task_custom_field_values` delta collection (each value a `VersionedModel`
with its own `server_version` + tombstone) would give per-value sync granularity: a single
field edit would not re-send the whole task. We **rejected** it for the ADR-0400
precedent's reasons: (a) custom values are a **bounded** per-task collection (≤32 fields,
small scalars) — the whole-task re-sync on edit is the same cost labels already pay and is
negligible; (b) it avoids widening the delta protocol with a new collection plus the
watermark-union and `register_watermark_receivers()` wiring that must be kept in lockstep;
(c) deletion is handled correctly by **map replacement** on the task (absent key = cleared)
— no per-row tombstone needed. The one thing given up — per-value `server_version` — buys
nothing at this cardinality. If a future field type becomes high-churn or large, promoting
values to their own collection is a clean, additive protocol bump.

## Concrete model

```python
class TaskCustomFieldValue(models.Model):
    """A typed per-task value for one ProjectCustomField (#2143).

    Plain model (mirrors TaskLabel): the value is NOT independently synced —
    it reaches clients as a flat ``custom_fields`` map on the Task payload that
    rides ``Task.server_version`` (ADR-0400 label_ids pattern). Setting a value
    upserts this row and bumps the parent Task's version; clearing hard-deletes
    it and bumps the Task's version, so the map re-syncs with the key removed.

    Exactly one value_* column is meaningful per row, chosen by
    ``field.field_type``. ``field.project_id`` must equal ``task.project_id``
    (serializer-enforced; no cross-FK DB CHECK). ``project_id`` bridges to the
    owning project for IDOR/permission resolvers, mirroring TaskLabel.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        Task, on_delete=models.CASCADE, related_name="custom_field_values"
    )
    field = models.ForeignKey(
        ProjectCustomField, on_delete=models.CASCADE, related_name="values"
    )

    # Exactly one is populated per field_type; the rest stay at their empty default.
    value_text = models.TextField(blank=True, default="")                   # TEXT
    value_number = models.DecimalField(                                     # NUMBER
        max_digits=20, decimal_places=6, null=True, blank=True
    )
    value_date = models.DateField(null=True, blank=True)                    # DATE
    value_bool = models.BooleanField(null=True, blank=True)                 # BOOLEAN (null = unset)
    value_option = models.CharField(max_length=32, blank=True, default="")  # SINGLE_SELECT (option key)
    value_multi = models.JSONField(default=list, blank=True)                # MULTI_SELECT (list of keys)
    value_user = models.ForeignKey(                                        # USER
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_taskcustomfieldvalue"
        constraints = [
            models.UniqueConstraint(
                fields=["task", "field"], name="uniq_taskcustomfieldvalue_task_field"
            ),
        ]
        indexes = [
            models.Index(fields=["task", "field"]),  # board-feed prefetch by task
            models.Index(fields=["field"]),          # cascade + per-field queries
        ]

    @property
    def project_id(self) -> Any:
        return self.task.project_id
```

- **No `VersionedModel`, no per-row `server_version`/`is_deleted`** — the parent Task's
  version carries these rows into the delta (ADR-0400 pattern). Clearing = hard delete.
- **`value_number`:** `DecimalField(20,6)` for exactness; the resolver emits a JSON number
  (`coerce_to_string=False`), not a string.
- **`value_user` on delete:** `SET_NULL`. Write-time validation additionally requires the
  user be a **member of the task's project**. (Version-bump caveat in Consequences.)
- **`ProjectCustomField` changes (this MR):** add `show_on_card = models.BooleanField(default=False)`
  only — additive, non-breaking. The `VersionedModel` rebase (`is_deleted`/`deleted_version`,
  `soft_delete()` on destroy) is **deferred** with the definition-sync collection (see the
  scope-resolution note above); it stays a plain model with its existing manual
  `server_version` bump for now.

## API surface

### Read — `custom_fields` map on `TaskSerializer` + `SyncTaskSerializer`

Read-only `SerializerMethodField` on both serializers (aggregate map shape ⇒ method field,
not a nested list serializer):

```python
custom_fields = serializers.SerializerMethodField()

def get_custom_fields(self, obj: Task) -> dict[str, Any]:
    """{<field_id>: <resolved typed value>} for every value row on the task.

    Reads obj.custom_field_values.all() straight from the prefetch cache — no
    per-task query. Unset fields are omitted; the web client merges this map
    against the /fields/ definition list (which carries show_on_card).
    """
    return {str(v.field_id): _resolve_value(v) for v in obj.custom_field_values.all()}
```

Resolver `_resolve_value`, by `field.field_type`:

| field_type | column | map value |
|---|---|---|
| `TEXT` | `value_text` | string |
| `NUMBER` | `value_number` | number (Decimal, un-stringified) |
| `DATE` | `value_date` | ISO-8601 `YYYY-MM-DD` |
| `BOOLEAN` | `value_bool` | boolean |
| `SINGLE_SELECT` | `value_option` | option-key string |
| `MULTI_SELECT` | `value_multi` | array of option-key strings |
| `USER` | `value_user` | `{id, name, initials}` object — the board renders the avatar + name with no second fetch (mirrors the assignee shape), initials falling back to username |

`show_on_card` is **not** applied server-side — the map carries every set value (the drawer
needs them all); the board card filters to `show_on_card` fields it already holds from the
definition list. One payload serves both.

### Prefetch (no N+1)

In `annotate_tasks_queryset()` (`views.py:3107`), beside the labels/assignments prefetch:

```python
db_models.Prefetch(
    "custom_field_values",
    queryset=TaskCustomFieldValue.objects.select_related("field", "value_user"),
)
```

`select_related("field")` feeds the resolver `field_type` with no extra query. Reverse-FK
lookup by `task_id` is covered by the `(task, field)` index. Cost: one extra query per
board page.

### Write — nested APIView, mirrors `TaskLabelView`

```
PUT    /projects/<project_pk>/tasks/<task_pk>/field-values/<field_id>/   -> upsert (200)
DELETE /projects/<project_pk>/tasks/<task_pk>/field-values/<field_id>/   -> clear  (204)
```

- **Body:** `{"value": <typed>}` — scalar for most types, array for MULTI_SELECT.
- **Upsert:** `get_or_create(task, field)`, set the typed column; unchanged → no-op
  (idempotent, mirrors `TaskLabelView` attach). Clear = hard-delete the row.
- **Version bump:** after set/clear, **bump `task.server_version`** (attach/detach
  precedent) so the task's `custom_fields` map re-syncs.
- **Permission:** **`IsProjectMemberWriteOrOwn`** (Member+) — a value write **is a task
  edit**, distinct from the field *definition* which stays Scheduler+. Gated behind
  `IsProjectNotArchived`.
- **Actor:** **human-only until 0.6** — no MCP token write path (ADR-0186); an agent token
  is refused on this endpoint the same way it is on other task-mutation surfaces until the
  0.6 agent-write track opens. Reads (the `custom_fields` map) remain agent-reachable now.
- **Broadcast:** value renders on the board card ⇒ defer a board event on commit —
  `transaction.on_commit(lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id}))`
  (subject to `broadcast-check`).
- **`show_on_card` toggle** rides the existing `ProjectCustomField` PATCH — Scheduler+ by
  construction.

### 400 error contract (typed writes)

Dict-keyed `{"value": "..."}`, mirroring `ProjectCustomFieldSerializer`:

| Case | HTTP | Body |
|---|---|---|
| SINGLE_SELECT value not an option | 400 | `{"value": "'<x>' is not a valid option for field '<name>'."}` |
| MULTI_SELECT unknown option | 400 | `{"value": "'<x>' is not a valid option for field '<name>'."}` (duplicates are silently de-duped, not rejected) |
| USER user missing / not a member | 400 | `{"value": "user '<id>' is not a valid member of this project."}` (one message for both, so the endpoint is not a user-existence oracle) |
| NUMBER not parseable | 400 | `{"value": "value must be a number."}` |
| NUMBER NaN / Infinity | 400 | `{"value": "value must be a finite number."}` |
| NUMBER magnitude > 14 integer digits | 400 | `{"value": "value is out of range (at most 14 integer digits)."}` (bounds the `numeric(20,6)` column — a raw APIView has no DRF `DecimalField` guard, so this prevents a Postgres `DataError` 500) |
| DATE not ISO-8601 | 400 | `{"value": "value must be an ISO-8601 date (YYYY-MM-DD)."}` |
| BOOLEAN not a bool | 400 | `{"value": "value must be a boolean."}` |
| task/field in a different project (IDOR) | 404 | standard not-found — `_get_field` scopes the field to the task's project |

`required` is **advisory at value-write time in v1** — not a task-save block (that would
invalidate every task predating the field). The web layer surfaces "required, not set" as
a soft warning. (See 🔴.)

## Offline sync (WatermelonDB delta)

**Values ride the task.** `SyncTaskSerializer` gains the same read-only `custom_fields`
map (fed by the same prefetch, added to the existing `tasks` source in `sync/views.py`).
A value edit bumps `Task.server_version`, so the task re-enters the delta and the map
re-syncs; a cleared field is simply absent from the map and the client drops the key. No
`task_custom_field_values` collection, no watermark-union entry, no receiver — exactly the
`label_ids` shape.

**Definitions must also reach the client** (to render/validate values offline) — same role
`Label` plays for `label_ids`. **⚠ Deferred (see scope-resolution note under Decision): the
following definition-sync collection is NOT built in this MR.** When offline custom-field
rendering is picked up, append **one** pull-only collection, last, to preserve the stable
protocol order:

```python
(
    "project_custom_fields",
    ProjectCustomField.objects.filter(project=project, server_version__gt=since),
    SyncProjectCustomFieldSerializer,   # id, server_version, is_deleted, name,
                                        # field_type, required, options, order, show_on_card
),
```

Watermark wiring for this one collection (both must mirror the `sources` list — conformance
test enforces it): a `MAX(server_version)` branch in `_snapshot_max_version()`'s union and
a resolver in `register_watermark_receivers()`:

```python
ProjectCustomField: lambda i: [i.project_id],
```

`TaskCustomFieldValue` needs **no** watermark wiring — it is not independently synced.
**Mobile write** of values is pull-shaped in v1 (written via REST); offline authoring is a
tracked follow-up.

## Consequences

**Easier**
- Agents/MCP and every API client read task custom values as a first-class server fact
  (`custom_fields` map) — API-first / ADR-0112 satisfied; no new sync collection for
  values.
- Deletion is trivially correct via map replacement — no per-value tombstone bookkeeping.
- Minimal protocol surface: one new pull-only definitions collection, values piggyback on
  the existing `tasks` source.
- USER values have real referential integrity; board feed stays N+1-free.

**Harder / caveats**
- A single value edit re-sends the **whole task** payload (rides `Task.server_version`) —
  acceptable at ≤32 small values, identical to the cost labels already pay.
- Seven mostly-null columns + a `field_type`→column resolver kept in lockstep with
  `CustomFieldType`.
- **USER `SET_NULL` version gap:** Django `SET_NULL` is a bulk UPDATE that bypasses
  `save()`, so hard user deletion nulls `value_user` **and does not bump
  `Task.server_version`** — offline clients won't see the value cleared until the task next
  changes. Mitigation: a `pre_delete` receiver on the user model that bumps the affected
  tasks' versions, or accept the staleness (TruePPM deactivates users far more often than
  it hard-deletes them). Documented, low-severity.
- Converting `ProjectCustomField` to `VersionedModel` changes `destroy` from hard- to
  soft-delete (deliberate, for tombstone sync); existing rows migrate `is_deleted=False`.

**Risks**
- MULTI_SELECT `value_multi` is a JSON list (not DB-constrained to the option set) —
  membership enforced at the serializer, matching how `options` itself is validated.
- Value/definition drift on `field_type` change — mitigated by the existing rule that
  `field_type` is immutable after create.

## Implementation Notes

- **P3M layer:** Programs and Projects (single-project task metadata).
- **Affected packages:** `api` (models, serializers, view, sync), `web` (board card +
  drawer render the `custom_fields` map; `types.ts` gains `custom_fields` + `show_on_card`
  — hand-maintained), `mobile` (WatermelonDB gains the `project_custom_fields` table +
  `custom_fields` on the task record; pull-only).
- **Migration required:** yes — new `TaskCustomFieldValue` table; `ProjectCustomField`
  gains `show_on_card` (`BooleanField(default=False)` — additive, non-breaking). One
  migration. (The `VersionedModel` rebase of `ProjectCustomField` is deferred with the
  offline definition-sync collection.)
- **API changes:** yes — new nested value endpoint (PUT/DELETE), `custom_fields` +
  `show_on_card` on read payloads. **No** new sync collection in this MR (deferred).
  Regenerate `docs/api/openapi.json` after merging `origin/main`.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Registers against no enterprise hook
  (`grep trueppm_enterprise` stays clean). Org-governed EAV backend stays Enterprise
  (#2064, 0.6).

### Durable Execution
1. **Broker down at dispatch:** N/A for durability — value writes enqueue no Celery work.
   The only side effect is a best-effort `broadcast_board_event` deferred with
   `transaction.on_commit()`; a dropped push self-heals on the next delta pull (the delta
   is the source of truth). Custom values do not feed CPM, so no schedule recompute.
2. **Drain task:** N/A — no new async category.
3. **Orphan window:** N/A — no drain.
4. **Service layer:** new synchronous `set_task_custom_field_value(task, field, raw)` in
   `projects/services.py` (validate → resolve column → upsert/clear → bump
   `Task.server_version` → schedule broadcast). Does **not** call `enqueue_recalculate()`.
5. **API response on best-effort dispatch:** synchronous `200` with the value
   (`DELETE` → `204`). Not `{"queued": true}` — no async handoff.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** upsert keyed by the `(task, field)` unique constraint
   (`get_or_create`); a duplicate PUT with the same payload is a no-op (skip save when the
   resolved column is unchanged, so `Task.server_version` does not churn). Re-`DELETE` on
   an already-cleared field is a no-op.
8. **Dead-letter / failure handling:** synchronous request/response — validation → `400`,
   permission/agent-token → `403`, cross-project/IDOR → `404`. No async failure surface.

## Blocking questions — resolved (2026-07-18, orchestrator)

1. **Definition-sync fold-in — DEFERRED.** The `ProjectCustomField` → `VersionedModel`
   conversion and the `project_custom_fields` pull-only sync collection are **out of scope
   for this MR** and tracked as a follow-up. #2143's mandate is the **online** web board
   card (#2144), which reads definitions from `GET /projects/<id>/fields/` and merges them
   with the value map — nothing in 0.4 renders custom fields *offline*, so shipping the
   VersionedModel rebase + a new delta collection + watermark wiring now would widen the
   migration/protocol surface for a slice with no consumer. The value map still ships on
   `SyncTaskSerializer` (forward-compatible, one-line resolver); when offline rendering is
   picked up, the deferred subsection above is the recipe.
2. **`required` enforcement — CONFIRMED advisory.** v1 treats `required` as advisory at
   value-write time (no task-save block) — matches the approved design note §5 (a
   required-but-empty field is never a card scold; enforcement, if ever wanted, is a
   drawer/validation surface, not this write path). No change.
3. **ADR-0050 reconciliation — NOTED, non-blocking.** The OSS `ProjectCustomField` value
   track (this ADR) is a distinct system from the Enterprise EAV custom-*forms* builder
   (`trueppm-enterprise#59` / OSS seam #2064). #1989/#2143/#2144 were filed OSS by the
   product owner under the documented #2143 = OSS mandate; this ADR renders **OSS** values
   of an **OSS** field, so no previously-filed Enterprise line is actually crossed. The
   amends-ADR-0050 header records the repositioning for the Enterprise owner's awareness.

> **Resolved (was a 🔴 in draft):** value-write permission is **Member+**
> (`IsProjectMemberWriteOrOwn`) — a value write is a task edit — with the field
> **definition** staying Scheduler+. Writes are **human-only until 0.6** (ADR-0186).
