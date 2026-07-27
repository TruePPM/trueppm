# Rule 107 — Board card readiness states

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Board card readiness states** (issue #179) — every `BoardCard` renders a `ReadinessChip` when `task.readiness` is present. Four states:
 - `idea`: no assignee — dashed-border chip, italic task name, `?` avatar circle, no progress ring, no accent bar
 - `estimated`: has owner — neutral chip with dot prefix
 - `ready`: has owner + predecessor links — brand-primary chip with ⛓ icon
 - `baselined`: in active baseline — neutral chip with 🔒 icon, accent bar uses `semantic-on-track`
 The left accent bar follows readiness, overridden by `isCritical` (→ `semantic-critical`). Absent `readiness` field → no chip rendered (backwards compat with pre-#179 API responses).
