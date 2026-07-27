# Rule 106 — 5-column board model

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**5-column board model** (issue #178) — the canonical status set is `BACKLOG | NOT_STARTED | IN_PROGRESS | REVIEW | COMPLETE`. `ON_HOLD` is a legacy value kept for data compatibility; it must never appear as a column in new board configs. The `_CANONICAL_STATUSES` frozenset in `serializers.py` is the authoritative list.
