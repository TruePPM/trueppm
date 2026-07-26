# Rule 18 — No always-visible mini-histogram strip in the MC row

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Monte Carlo Row Rules*

**No always-visible mini-histogram strip in the MC row** — the always-visible surface is chips-only (`P50 {date}` · `P80 {date}` · `P95 {date}`) plus a "Detail ›" hint. Real-world inputs without PERT estimates collapse to a single histogram bar that misleads more than it informs; the chips are the persona-aligned signal. Distribution shape lives only in the hover/focus tooltip (desktop) and the bottom-sheet (mobile).
