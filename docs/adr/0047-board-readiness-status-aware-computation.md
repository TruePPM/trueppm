# ADR-0047: Board Readiness — Status-Aware Computation and BACKLOG Boundary

## Status
Accepted (2026-05-31) — implemented in #261

## Context

The board's `readiness` field is a `SerializerMethodField` computed server-side from:
1. `baseline_start` annotation (non-null → `"baselined"`)
2. `assignee_id is None` → `"idea"`
3. `has_predecessors` annotation → `"ready"`
4. Default → `"estimated"`

**Problem 1 — BACKLOG exit does not clear ghost styling.** When a card is dragged from
BACKLOG to NOT_STARTED, `status` changes via `PATCH /tasks/{id}/` but `readiness` is
recomputed purely from `assignee_id`. An unassigned card in NOT_STARTED continues to show
"idea" ghost styling (dashed border, italic name, `?` avatar), which is semantically wrong:
the PM has committed the task to the working queue.

**Problem 2 — Demotion semantics.** When a card is dragged NOT_STARTED → BACKLOG, the
VoC panel (avg 7.2/10, all OSS personas) concluded: retain assignee and readiness on
demotion. Moving back to BACKLOG is re-sequencing, not de-commitment. Stripping assignee
would destroy refinement work. A deliberate "cold backlog" action (explicitly strip
refinement) should be an explicit card-menu action, not a drag side-effect (tracked as
backlog issue #261).

**P3M layer**: Programs and Projects → **OSS** (single-project board operation)

**Affected by**: ADR-0013 (board status vocabulary and `task_status_changed` signal),
ADR-0023 (status-transition side effects on actual dates), ADR-0038 (canonical status
definitions), ADR-0039 (board column config — all 5 statuses always present)

### Why `readiness` cannot be patched directly

`readiness` is a `SerializerMethodField` — it is in `Meta.read_only_fields` and has no
corresponding model column. `PATCH /tasks/{id}/` with `{"readiness": "estimated"}` is
silently ignored. The underlying fields that drive it are `assignee_id`,
`has_predecessors` (annotation), and `baseline_start` (annotation). Any approach that
changes when a card shows `idea` must change either the underlying fields or the
computation logic itself.

## Decision

**Use status-aware readiness computation (Option B). No schema change. No migration.**

Change `get_readiness()` in `TaskSerializer` (`serializers.py:222`) to factor in
`Task.status`:

```python
def get_readiness(self, obj) -> str:
    if getattr(obj, 'baseline_start', None) is not None:
        return 'baselined'
    if obj.assignee_id is None:
        # 'idea' means unrefined and uncommitted. Once a PM promotes a task out of
        # BACKLOG to any working column they have made a commitment decision — suppress
        # ghost styling even if no assignee has been set yet.
        return 'idea' if obj.status == TaskStatus.BACKLOG else 'estimated'
    if getattr(obj, 'has_predecessors', False):
        return 'ready'
    return 'estimated'
```

### "Retain on demotion" requires no additional logic

A status `PATCH` never touches `assignee_id`. After NOT_STARTED → BACKLOG:
- Card **with** assignee → recomputes to `estimated` or `ready` ✓ (assignee retained)
- Card **without** assignee → recomputes to `idea` ✓ (was never refined; correct to return to ghost state)

A card with no assignee that is demoted to BACKLOG naturally re-shows ghost styling.
This is semantically correct: the card was never refined; returning it to BACKLOG means
it is again an unrefined idea. No special-case state machine is needed.

### Semantic rationale

The `idea` state signals: *"this task has not been refined or committed to the project
working queue."* BACKLOG is the semantic boundary for this state. Once a PM drags a card
to any working column (NOT_STARTED, IN_PROGRESS, REVIEW), they have made a commitment
decision. The absence of an assignee in a working column is an **incomplete committed
task**, not an unrefined idea — better represented by `estimated` (the needs-work
default) than `idea` (the not-yet-considered state).

ADR-0038 (Terminology Glossary) must be updated to note that `"estimated"` can describe
either "has owner, no predecessors" or "committed to working queue but unassigned."

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| A. Gate drag — require assignee before leaving BACKLOG | Prevents orphaned unassigned working cards | VoC-rejected; blocks quick planning; anti-Agile |
| B. Status-aware computation (chosen) | No migration; VoC-aligned; self-healing on demotion | `estimated` label covers two sub-cases; documented in ADR-0038 |
| C. Stored `readiness_override` nullable field | Fully explicit; PM-overridable | Schema change + migration; overrides go stale when underlying fields change |
| D. New state `"committed_unassigned"` | Precise semantics for the gap case | New chip state needed everywhere `readiness` is consumed; more frontend churn |

## Consequences

**Easier**:
- Ghost styling is automatically removed when a card leaves BACKLOG — no additional PATCH payload or client-side logic required
- Demotion retains readiness naturally; no explicit state machine
- No migration, no API contract change

**Harder**:
- `"estimated"` now covers two cases: "has owner, no predecessors" and "committed but unassigned." Must be documented in ADR-0038.
- If a future feature needs to distinguish "committed without owner" from "committed with owner" in the chip label, a stored field (Option C) would need to be revisited.

**Risks**:
- The `"estimated"` chip label on an unassigned working-column card may confuse users.
  Mitigation: change chip copy to `"Committed"` when `status != BACKLOG` and no assignee
  (tracked as issue #261 — backlog).

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (serializers.py only); `web` (no change — chip rendering already handles `estimated` and `idea` correctly)
- **Migration required**: No
- **API changes**: No (`readiness` remains a computed read-only field; value changes only for the narrow case: `assignee_id IS NULL AND status != BACKLOG`)
- **OSS or Enterprise**: OSS

### Durable Execution

1. **Broker-down behaviour**: N/A — readiness is computed at serialization time from stored DB fields; no async dispatch path
2. **Drain task**: N/A — no outbox rows created by this change
3. **Orphan window**: N/A
4. **Service layer**: N/A — change is confined to `TaskSerializer.get_readiness()`
5. **API response on best-effort dispatch**: N/A — synchronous read-time computation
6. **Outbox cleanup**: N/A
7. **Idempotency**: N/A — pure function; calling twice with same inputs returns same result
8. **Dead-letter / failure handling**: N/A — serialization failures surface as HTTP 500; no retry semantics apply
