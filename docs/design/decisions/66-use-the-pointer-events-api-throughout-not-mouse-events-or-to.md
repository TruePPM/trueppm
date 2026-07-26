# Rule 66 — Use the Pointer Events API throughout — not Mouse Events or Touch Events

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Interaction*

**Use the Pointer Events API throughout — not Mouse Events or Touch Events.**
`touch-action: none` on all canvas elements. Pinch-to-zoom is handled via two
simultaneous active pointers (pointer span delta). This unifies mouse and touch
without branching. Touch navigation on the desktop canvas (tablets, 768–1024px)
is first-class (#2160): a single finger on **empty** canvas pans both axes
(bar / resize / link-dot hits still win, so a finger on a bar drags the bar);
a second active finger switches the gesture to a pinch-zoom, canceling the pan.
`touch-action: none` is what makes this possible — it is required, not a bug:
the browser must not steal the touch for native scroll, because the virtualized
canvas content is drawn, not laid out, so only the JS pan/pinch can move it.
