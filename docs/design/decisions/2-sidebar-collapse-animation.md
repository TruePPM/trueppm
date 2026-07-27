# Rule 2 — Sidebar collapse animation

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Layout & Visual*

**Sidebar collapse animation** — `transition-[width] duration-200 ease-out` on the sidebar element itself; do not animate `grid-template-columns`
