# Rule 55 — GanttEngine.on() always returns an unsubscribe function — always call it

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Architecture*

**`GanttEngine.on()` always returns an unsubscribe function — always call it.**
Every `engine.on(event, handler)` call must be paired with the returned teardown
in a `useEffect` cleanup. Do not use `engine.on()` outside of a `useEffect`.
This fixes the SVAR `intercept()` memory leak (handlers accumulated on remount).
