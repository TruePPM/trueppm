# Rule 58 — GanttEngineStub is the only permitted test double for GanttEngine

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Architecture*

**`GanttEngineStub` is the only permitted test double for `GanttEngine`** — do not
hand-roll mock objects with `{ on: vi.fn(), scales: null, ... }`. The stub is a
typed class that will fail to compile if the interface changes, surfacing test
staleness immediately.
