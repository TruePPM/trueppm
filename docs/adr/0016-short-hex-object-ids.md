# ADR-0016: Short Hex Object IDs — Human-Readable Project-Scoped Identifiers

## Status
Accepted

## Context

Every core object in TruePPM uses a UUID primary key. UUIDs are excellent for
distributed sync and collision avoidance but unusable in human communication.
When a PM on a construction site says "look at task 3f7a8b21-4c2d-..." the
conversation breaks down. When a team member gets a Slack message with a task
reference, they need something they can paste into search.

Issue #50 asks for a short, human-readable identifier on Task and Risk objects
(milestones are `Task(is_milestone=True)`, not a separate model) so that users
can reference them verbally, in search, in exports, and in notifications.

### VoC signal
| Persona | Score | Key takeaway |
|---------|-------|-------------|
| Priya (Team) | 8/10 | "When someone pings me on Slack with #3F8A, I can search immediately" |
| Sarah (PM) | 7/10 | "Short ID on mobile card cuts coordination time to two seconds" |
| Marcus (PMO) | 6/10 | "Must appear in exports and audit — not just the UI" |

### P3M layer
Programs and Projects — single-project scope. The `short_id` is scoped per
project; cross-project aggregation is irrelevant. This belongs in OSS.

## Decision

### Per-project sequential counter

Add a `task_sequence` BigIntegerField on `Project`. On every Task or Risk
INSERT, atomically increment the counter and hex-encode the result into an
8-character uppercase `short_id` field.

```python
# Atomic increment — no race conditions, no collision checks
Project.objects.filter(pk=self.project_id).update(
    task_sequence=F('task_sequence') + 1
)
seq = Project.objects.values_list('task_sequence', flat=True).get(pk=self.project_id)
self.short_id = f'{seq:08X}'
```

### Display format

`{short_id}` in project context (e.g. `000A3F` in a task list), or
`{project_slug}#000A3F` in cross-project contexts (notifications, search
results spanning multiple projects). The project slug is cosmetic — not stored
on the object.

### Model changes

```python
# Project
task_sequence = models.BigIntegerField(default=0, editable=False)

# Task (add field + composite unique constraint)
short_id = models.CharField(max_length=8, editable=False, db_index=True)

# Risk (same pattern)
short_id = models.CharField(max_length=8, editable=False, db_index=True)
```

Unique constraint: `UniqueConstraint(fields=['project', 'short_id'], name='...')`
on both Task and Risk.

### Why a single shared counter (not per-entity)

Tasks and Risks share one counter per project. Benefit: the `short_id` is
globally unique within a project regardless of entity type, which avoids the
confusion of "task #0003 vs risk #0003". A user can paste `#0003` into search
and get exactly one result.

### API surface

- `short_id` added to `TaskSerializer`, `RiskSerializer` as **read-only**
- `short_id` added to `SyncTaskSerializer`, `SyncRiskSerializer` for mobile
- Lookup filter: `GET /api/v1/tasks/?short_id=000A3F&project=<uuid>`
- No new endpoints — the field rides existing serializers

### Backfill migration

A data migration assigns `short_id` to all existing Tasks and Risks, ordered
by `created_at` (history table) or PK (if no timestamp), then sets
`task_sequence` on each Project to the max assigned value. This is a one-time
operation that respects the sequential ordering invariant.

### Sync

`short_id` is immutable after creation — it never changes, even if the task is
reordered or re-parented in the WBS. Mobile clients receive it in delta pulls
and cache it in WatermelonDB. Zero extra sync cost (it's just another column).

### History

`short_id` is included in `HistoricalTask` / `HistoricalRisk` — it's set on
INSERT and never changes, so it appears in every history row without noise.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| A — Per-project sequential counter, hex-encoded (chosen) | Guaranteed unique, deterministic ordering, atomic, no collision check, readable aloud | Requires counter on Project; gap-free only if no rollbacks |
| B — Truncated UUID (first 8 chars) | No schema change on Project | Collision probability: ~1 in 4B per project, but grows with O(n^2) birthday paradox. At 10k tasks ≈ 0.001% collision rate — low but nonzero, and requires retry logic |
| C — Nanoid / KSUID prefix | Sortable by time | Not sequential (gaps are large and random); harder to read aloud; 12+ chars for collision safety |
| D — Integer auto-increment displayed as decimal | Simplest implementation | Decimal IDs feel like database internals; less compact than hex for the same range |
| E — `{TYPE}-{SEQ}` format (TASK-001, RISK-002) | Self-documenting type | Longer; type prefix is redundant when context is clear; complicates cross-type search |

## Consequences

- **Easier**: Users can reference objects verbally, in Slack, in emails, in exports.
  Search by `short_id` is O(1) via the composite index. Mobile sync gets the
  ID for free.
- **Harder**: Bulk import must allocate counter ranges atomically (one UPDATE to
  reserve N IDs, then assign locally). Documented in implementation notes.
- **Risks**: Gaps in the sequence if a transaction rolls back after incrementing
  the counter. This is acceptable — gaps are cosmetic, not a correctness issue.
  Users of MS Project and Primavera are accustomed to non-contiguous IDs.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `api` (model + migration + serializers), `web` (display in
  task list, Schedule view row, risk table, search)
- Migration required: yes — 0014 (schema) + 0015 (data backfill)
- API changes: yes — `short_id` read-only field on Task and Risk serializers;
  `?short_id=` filter on TaskViewSet and RiskViewSet
- OSS or Enterprise: **OSS** (`trueppm-suite`)
- Build order: implement before object audit history (ADR-0011) — the history
  UI should display `short_id` in change records
