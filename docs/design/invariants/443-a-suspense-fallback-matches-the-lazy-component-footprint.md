# Rule 443 — A Suspense fallback must occupy the lazy component's final footprint

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**The fallback of a `Suspense` around a `lazy()` component has the same width and height the resolved component will render at (fixed `w-[..] h-[..]` taken from the component's own loading/settled box), including any caption or chrome beneath it.**

**Why.** When the chunk resolves, a smaller fallback is swapped for a larger component and the container reflows. Anything positioned against the pre-swap layout moves: a hovered card slides out from under the pointer, and a click on its overflow menu lands on the wrong target or on nothing. On the board, lazy-loading `BurnChart` behind a 160x32 placeholder (#1536) made the real 220x84 chart push the board down mid-interaction, so "Actions for ..." was clicked but the "Move to..." menu never opened (`board-sprint-view.spec.ts` "a failed status move", #1518). The user hits the same thing on a slow connection.

**How to apply.**

1. Read the settled size from the component (e.g. `CompactBurnChart`: 220x64 plot + gap + one caption line) and copy it onto the fallback.
2. If the settled size varies, reserve the minimum that cannot shrink, or render the lazy part inside a wrapper with a fixed box.
3. Verify against a fresh `vite build`: Playwright serves the prebuilt `dist/`, so a stale bundle hides the shift.

Reference: `features/board/BoardSprintHeader.tsx`.
