# Rule 152 — Accept/reject are not offline-queueable — disable, do not queue

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)*

**Accept/reject are not offline-queueable — disable, do not queue.** When offline (`!navigator.onLine`), the pending chip still renders from synced data, but every accept/reject control is **disabled with an explanatory `title`** and the action is **never queued**. A stale offline accept could re-commit work the team rejected (or vice-versa) on reconnect; the decision must be made against live state. This is the deliberate exception to the optimistic-write pattern used elsewhere — scope decisions fail closed offline.
