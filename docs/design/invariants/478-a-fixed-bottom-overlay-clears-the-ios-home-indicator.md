# Rule 478 — A fixed bottom overlay clears the iOS home indicator

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the rule's headline; this file carries its full text (#3150).

**A `fixed`, bottom-anchored overlay (a nudge card, a sheet, a sticky action) offsets its bottom edge by `env(safe-area-inset-bottom)`, for example `bottom-[calc(1rem+env(safe-area-inset-bottom))]`. It is mounted as an overlay, never by adding a row to the shell chrome.**

**Why.** In the installed app (ADR-1523) the page runs full-screen, so on a Face ID iPhone the last ~34px of the viewport sits under the home indicator. A card anchored at `bottom-4` puts its buttons in the swipe-up gesture zone, where a tap can send the app to the background instead. In a browser tab the inset is 0, so the same class costs nothing there. Keeping overlays out of the chrome's flow is what lets them ship without a shell layout change.

**How to apply.** Add the inset to whatever bottom offset the design asks for, and keep touch targets at 44px (`min-h-[44px]` on the shared `Button`, whose largest size is 40px). Reference: `PwaInstallPrompt` in `src/features/pwa/PwaInstallPrompt.tsx`, asserted in `e2e/pwa-install-nudge.spec.ts`.
