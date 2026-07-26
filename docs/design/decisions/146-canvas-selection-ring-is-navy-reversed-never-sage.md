# Rule 146 — Canvas selection ring is navy/reversed, never sage

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Design System v2.0 — Navy/Sage Brand (ADR-0103)*

**Canvas selection ring is navy/reversed, never sage** (rule 83). Because sage carries both action and positive-state, the navy ring is what stays visible on a sage complete bar. Triad: complete = sage *fill*, today = sage *line*, selected = navy *ring*. Two sage meanings on one surface must differ by component geometry + a text/icon label, never hue alone (1.4.1).
