# Rule 433 — The `hidden` attribute is authoritative over display utilities, and a collapsed state is proven in a real browser

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Controls and composition*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**The `hidden` attribute is authoritative over display utilities, and a collapsed state is proven in a real browser — never by a jsdom `not.toBeVisible()`.** Tailwind 3's preflight declares `[hidden] { display: none }` in the *base* layer, so any display utility on the same element (`flex`, `grid`, `block`, `inline-flex`) outranks it. `SprintPanel`'s body was `<div hidden={!isOpen} className="px-4 py-4 flex flex-col gap-4">`: its chevron reported `aria-expanded="false"` while the velocity / capacity / WIP cards stayed painted, 330px tall, pushing the board columns on Board and Today below the fold at 1334x896 (#4181). `BacklogDrawer`'s `grid` body had the same defect. Every vitest in `SprintPanel.test.tsx` that asserted the collapsed default passed throughout, because jsdom loads no Tailwind: `toBeVisible()` sees the attribute and nothing that overrides it.

(a) `src/styles/globals.css` carries `[hidden]:where(:not([hidden='until-found'])) { display: none !important; }` (the rule Tailwind v4's preflight ships). Do not remove or weaken it; `src/styles/hiddenAttribute.test.ts` guards its presence.

(b) To toggle an element that must stay in the DOM (an `aria-controls` target, a body whose drop targets must stay registered), use the `hidden` attribute. Do not swap display classes (`isOpen ? 'flex' : 'hidden'`) for that job, and do not rely on a display class to show an element the attribute hides.

(c) When a change's acceptance is "X is collapsed / hidden / off-screen", the proof is a Playwright assertion (`toBeHidden()`, or a `boundingBox()` against the viewport), not a component test. A jsdom visibility assertion checks the attribute, not the paint.

Reference: `packages/web/src/styles/globals.css`, `packages/web/src/features/board/SprintPanel.tsx`, `packages/web/src/features/board/BacklogDrawer.tsx`, `packages/web/e2e/today-board-above-fold.spec.ts` (#4181).
