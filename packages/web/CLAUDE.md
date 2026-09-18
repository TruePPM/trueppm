# TruePPM Web Frontend — Design Rules

These rules are enforced at review time. Violations block merge.

> ## ⭐ Design System v2 — the golden standard (ADR-0126)
>
> The canonical UI is the **v2 redesign** (`docs/design/v2-golden-standard.md`,
> upstream `design_handoff_trueppm_v2/`). Every new screen, component, fix, and
> feature must conform. Foundation tokens are in `globals.css` + `tailwind.config.ts`;
> conformance is machine-checked by `scripts/check-design-system-v2.sh` (in `make lint`
> / CI). Key invariants beyond the numbered rules below:
> - **Warm-paper canvas:** page backgrounds use `bg-app-canvas` (warm `#F2EEE5`),
>   cards use `bg-neutral-surface` (white) and pop against it. Never a cool-grey or
>   pure-white app canvas.
> - **Sage has two roles (ADR-0126 §3):** `--sage` `#3E8C6D` is the **fill/accent**
>   (with navy or white text); normal-weight **text/border/ring** use
>   `brand-primary` (sage-700, AA). sage-600 is 4.06:1 on white — never body text.
> - **One status vocabulary:** a **dot** = health, a **pill/chip** = state; color is
>   signal only, calm-neutral by default.
> - **Borders over shadows:** `shadow-card`/`shadow-pop` are reserved for
>   popover/drawer/modal/command-palette/toast (see rule 1).
> - **Full Light/Dark/Auto** via the `.dark` token swap on `<html>` — never a dark
>   sidebar on a light app.
> Staged adoption of the remaining surfaces is tracked in epic #1163.

## Foundations

*What every file in `packages/web` obeys.*

9. **No default exports** — all components use named exports → [rule](../../docs/design/invariants/9-no-default-exports.md)
10. **No CSS-in-JS** — Tailwind utility classes only; use `style` prop only for dynamic values (e.g., CSS custom properties, inline widths derived from state) → [rule](../../docs/design/invariants/10-no-css-in-js.md)
11. **Stub hooks over mock network** — while real API hooks don't exist, return fixture data from the hook (`src/hooks/`). → [rule](../../docs/design/invariants/11-stub-hooks-over-mock-network.md)
12. **Responsive breakpoints** (from `tailwind.config.ts`): `xs`=320px, `sm`=375px, `md`=768px, `lg`=1024px, `xl`=1280px, `2xl`=1440px → [rule](../../docs/design/invariants/12-responsive-breakpoints.md)
1. **No drop shadows anywhere** — use `border border-neutral-border` for separation instead of `shadow-*` → [rule](../../docs/design/invariants/1-no-drop-shadows-anywhere.md)
299. **Every optimistic edit to a cached *list* goes through `optimisticListUpdate` / `optimisticListAppend` (`src/lib/optimisticCache.ts`) — never `setQueryData(key, [...(previous ?? []), row])` or `(prev ?? []).map/filter` by hand.** → [rule](../../docs/design/invariants/299-every-optimistic-edit-to-a-cached-list-goes-through.md)
300. **A design rule that has needed a second manual sweep does not have a working mechanism — fix the mechanism in the same MR, and watch it fail before you fix the violations.** → [rule](../../docs/design/invariants/300-a-design-rule-that-has-needed-a-second-manual-sweep-does.md)
301. **A client-side severity map over a server-owned token vocabulary must fail LOUD, and its unknown branch must never be the neutral one.** → [rule](../../docs/design/invariants/301-a-client-side-severity-map-over-a-server-owned-token.md)
302. **"No rights" and "chose read-only" are different states, and only one of them gets a disabled control.** → [rule](../../docs/design/invariants/302-no-rights-and-chose-read-only-are-different-states-and-only.md)
312. **When a new dimension subdivides an existing key, the derived key must be BYTE-IDENTICAL to the old one wherever the dimension is unused — and a test must pin that identity.** → [rule](../../docs/design/invariants/312-when-a-new-dimension-subdivides-an-existing-key-the-derived.md)
382. **An exported symbol with no importer fails `web:knip`. The fix is to delete it, or to name the real root in `entry` — never to add an `ignore`.** → [rule](../../docs/design/invariants/382-an-exported-symbol-with-no-importer-fails-web-knip-the-fix.md)
394. **A `QueryErrorState` inside a COLLAPSED `<details>`, accordion, or hidden tab panel satisfies rule 246 and defeats it — a failure must reach the always-visible chrome.** → [rule](../../docs/design/invariants/394-a-queryerrorstate-inside-a-collapsed-details-accordion-or.md)
395. **When a fix's acceptance is "N surfaces state one message", a source scan for the canonical LITERAL cannot enforce it — the scan sees re-typing, and re-typing is never the failure mode; divergence is.** → [rule](../../docs/design/invariants/395-when-a-fix-s-acceptance-is-n-surfaces-state-one-message-a.md)
414. **A forbidden-shape source scan must match the code SHAPE the violation takes, not a bare substring search for the forbidden text — a substring search also flags the prose that documents the bug it forbids.** → [rule](../../docs/design/invariants/414-a-forbidden-shape-source-scan-must-match-the-code-shape.md)

## Accessibility floors

*Non-negotiable minimums. A surface that misses one is not shippable.*

4. **Focus rings on all interactive elements**: `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1` → [rule](../../docs/design/invariants/4-focus-rings-on-all-interactive-elements.md)
214. **Rail tabs, the "More" trigger, and `MoreSheet` nav rows use `focus:ring-*`, not `focus-visible:ring-*`.** → [rule](../../docs/design/invariants/214-rail-tabs-the-more-trigger-and-moresheet-nav-rows-use-focus.md)
357. **Rule 4's `ring-brand-primary` is measured against an ordinary canvas — on an INVERSE surface it fails, and an alpha modifier on a ring voids the published figure entirely.** → [rule](../../docs/design/invariants/357-rule-4-s-ring-brand-primary-is-measured-against-an-ordinary.md)
5. **Touch targets** — minimum 44×44px at all breakpoints → [rule](../../docs/design/invariants/5-touch-targets.md)
6. **Color dots** (8px project color indicators) are always `aria-hidden="true"` — health state must also be conveyed via text or `aria-label` → [rule](../../docs/design/invariants/6-color-dots.md)
50. **Every `text-[Npx]` below 12px is prohibited — `text-[11px]` and `text-[10.5px]` included.** → [rule](../../docs/design/invariants/50-every-text-npx-below-12px-is-prohibited-text-11px-and-text.md)
87. **`text-neutral-text-disabled` on `bg-neutral-surface-sunken` is prohibited** → [rule](../../docs/design/invariants/87-text-neutral-text-disabled-on-bg-neutral-surface-sunken-is.md)
169. **`neutral-text-disabled` is for inert/disabled affordances ONLY — never for readable content.** → [rule](../../docs/design/invariants/169-neutral-text-disabled-is-for-inert-disabled-affordances.md)
118. **Settings-surface density exception (rules 5, 45, 50).** Pages and components under `features/settings/` use a compact admin density: `text-[11px]` / `text-[10px]` for secondary and label text, and `h-6` / `h-7` controls, are permitted — an explicit override of rules 5, 45, … → [rule](../../docs/design/invariants/118-settings-surface-density-exception-rules-5-45-50.md)
288. **Inside a `useFocusTrap` container, a `tabIndex={-1}` programmatic focus target must never be the first or last element in the trap's *tab* order — seat focus on a real focusable, or give the trap a focusable sentinel before/after it.** → [rule](../../docs/design/invariants/288-inside-a-usefocustrap-container-a-tabindex-1-programmatic.md)
289. **A server-derived advisory signal may be cleared by client state only for the specific item the user acted on — never re-derived, and never allowed to drain a count the server owns.** → [rule](../../docs/design/invariants/289-a-server-derived-advisory-signal-may-be-cleared-by-client.md)
290. **A fixed-height chrome strip that can grow (a status cluster, a tab rail, a filter row) gets an explicit overflow rule — it scrolls; it never pushes its neighbours — and the rule is the whole contract below, not just `overflow-x: auto`.** → [rule](../../docs/design/invariants/290-a-fixed-height-chrome-strip-that-can-grow-a-status-cluster.md)
291. **A "the baseline is already on screen" predicate must also be checked against whether the *derived value* is already on screen — the component that supplies the baseline is usually printing the delta too (#2531).** → [rule](../../docs/design/invariants/291-a-the-baseline-is-already-on-screen-predicate-must-also-be.md)
325. **A copy helper that writes a user-facing sentence is not shipped until something imports it — and on a surface where N gestures route a sentence, all N do, or the one that does not is the frequent one.** → [rule](../../docs/design/invariants/325-a-copy-helper-that-writes-a-user-facing-sentence-is-not.md)
330. **A touch target built as a `before:` pseudo-element must be SIZED, never `inset`-ed — an inset box is `size − 2×border` wide, and no vitest assertion in this repo can see the difference.** → [rule](../../docs/design/invariants/330-a-touch-target-built-as-a-before-pseudo-element-must-be.md)
366. **Raising a control to the 44px touch floor is a LAYOUT change in every container that control renders in — enumerate them and measure each, because the one that overflows does it silently.** → [rule](../../docs/design/invariants/366-raising-a-control-to-the-44px-touch-floor-is-a-layout.md)
367. **A sized glyph that is a DIRECT FLEX CHILD needs `shrink-0`, and `inline-block` / `align-[…]` on one are inert — they do not merely fail to help, they misdirect the next reader into a cascade hunt.** → [rule](../../docs/design/invariants/367-a-sized-glyph-that-is-a-direct-flex-child-needs-shrink-0.md)
368. **A control that hides its own container must hand focus somewhere BEFORE the unmount, and the right somewhere is the control that undoes the act.** → [rule](../../docs/design/invariants/368-a-control-that-hides-its-own-container-must-hand-focus.md)
369. **Merging two controls into one transfers two things, and the second is the one that gets missed: every ACT the retired control performed, and every SENTENCE elsewhere in the product that described its shape.** → [rule](../../docs/design/invariants/369-merging-two-controls-into-one-transfers-two-things-and-the.md)
370. **When a `shrink-0` pane and a `flex-1 min-w-0` pane share a row, the flexible one pays for EVERY pixel the row loses — so the floor that matters must be taken out of the container FIRST, not expressed as a `min-` on the pane that never gets asked.** → [rule](../../docs/design/invariants/370-when-a-shrink-0-pane-and-a-flex-1-min-w-0-pane-share-a-row.md)
371. **A card that names where it will take you and the function that chooses the destination are two sources for one fact — derive them from the same input, in the same module, or they will disagree and nothing will notice.** → [rule](../../docs/design/invariants/371-a-card-that-names-where-it-will-take-you-and-the-function.md)
389. **A pane with a RENDER clamp has two widths, and every consumer must be told which one it is reading — the width the pane ASKED for positions nothing.** → [rule](../../docs/design/invariants/389-a-pane-with-a-render-clamp-has-two-widths-and-every.md)
399. **A `::before`/`::after` overhang — a touch target, a hit-area cushion, a decorative bleed — is INVISIBLE to the eye and to `boundingBox()`, but it is real content for an ancestor's `scrollWidth`. "The control is inside the viewport" is therefore not the same assertion as "the container does not overflow", and a surface that asserts only the first is not guarded.** → [rule](../../docs/design/invariants/399-a-before-after-overhang-a-touch-target-a-hit-area-cushion-a.md)
417. **`opacity-0` + a hover-reveal variant (`hover:opacity-100`, `group-hover:opacity-100`) needs a focus-reveal counterpart in the same class string — without one, a keyboard user can Tab onto the control and never see it. Machine-checked: `scripts/check-hover-reveal-focus.sh`.** → [rule](../../docs/design/invariants/417-opacity-0-a-hover-reveal-variant-needs-a-focus-reveal.md)

## Color and tokens

*Color is a token, never a literal, and a shade carries a role.*

8. **No custom hex colors in components** — always use Design System tokens from `tailwind.config.ts`. → [rule](../../docs/design/invariants/8-no-custom-hex-colors-in-components.md)
8a. **`--chrome-*` tokens are for fixed UI furniture** (sidebar, Schedule task-list panel, TopBar) that follows the active theme. → [rule](../../docs/design/invariants/8a-chrome-tokens-are-for-fixed-ui-furniture.md)
8b. **`--sem-*-bg` tokens are for badge pill fills and status cards** — `bg-semantic-critical-bg`, `bg-semantic-at-risk-bg`, `bg-semantic-on-track-bg`, `bg-semantic-warning-bg`. → [rule](../../docs/design/invariants/8b-sem-bg-tokens-are-for-badge-pill-fills-and-status-cards.md)
8c. **`.tppm-mono` applies JetBrains Mono with tabular numerals** — use it on every numeric value: KPIs, percentages, dates, durations, counts, build hashes. → [rule](../../docs/design/invariants/8c-tppm-mono-applies-jetbrains-mono-with-tabular-numerals.md)
8d. **`bg-neutral-overlay` is the scrim token for a modal/slide-out's full-screen backdrop** → [rule](../../docs/design/invariants/8d-bg-neutral-overlay-is-the-scrim-token-for-a-modal-slide-out.md)
286. **A `--sem-*-bg` token may never be the sole background of a floating surface — a portaled, `position:fixed` or `absolute` panel needs an opaque base (`bg-neutral-surface`), with its warning/error tone carried by the border, icon and text (#2447).** → [rule](../../docs/design/invariants/286-a-sem-bg-token-may-never-be-the-sole-background-of-a.md)
7. **Health state color encoding**: → [rule](../../docs/design/invariants/7-health-state-color-encoding.md)
143. **Sage shade discipline (WCAG).** sage-500 `#4FA884` = **fills only**, always with navy text (navy-on-sage 6.8:1); it is ~2.9:1 on white so it is **never** body text, a foreground icon, or a thin border on a light surface. → [rule](../../docs/design/invariants/143-sage-shade-discipline-wcag.md)
145. **Semantic amber/red: brand hue is a FILL, on-light text keeps the AA-dark variant.** → [rule](../../docs/design/invariants/145-semantic-amber-red-brand-hue-is-a-fill-on-light-text-keeps.md)
147. **Body ink and dark surfaces are navy.** `--neutral-text-primary` = navy `#1B2A4A` (light) / reversed `#E9EDF3` (dark). → [rule](../../docs/design/invariants/147-body-ink-and-dark-surfaces-are-navy.md)
144. **Primary actions use the shared `Button` component** (`src/components/Button.tsx`), not ad-hoc `bg-brand-primary` fills. → [rule](../../docs/design/invariants/144-primary-actions-use-the-shared-button-component.md)
148. **Three type families (brand §06):** `font-display` (Space Grotesk) for display/wordmark/big numbers; `font-sans` (Inter) for UI/body; `.tppm-mono` (JetBrains Mono, rule 8c) for data. → [rule](../../docs/design/invariants/148-three-type-families-brand-06.md)

## Signal encoding

*How a value tells the truth about itself — including to someone who cannot see it.*

120. **Health/variance values pair color with a non-color signal (rule-12 reinforcement for rollups).** → [rule](../../docs/design/invariants/120-health-variance-values-pair-color-with-a-non-color-signal.md)
119. **A configured-but-not-computable metric renders as a muted card with a reason, never hidden.** → [rule](../../docs/design/invariants/119-a-configured-but-not-computable-metric-renders-as-a-muted.md)
161. **A responsive abbreviation must always carry its full accessible name.** → [rule](../../docs/design/invariants/161-a-responsive-abbreviation-must-always-carry-its-full.md)
171. **`aria-label` on a non-widget element (`<p>`/`<div>`/`<span>`) does NOT suppress its descendant text in NVDA/JAWS — to expose a multi-span line as ONE accessible string, mark every visible child `aria-hidden`.** → [rule](../../docs/design/invariants/171-aria-label-on-a-non-widget-element-p-div-span-does-not.md)
216. **A status adornment inside a header decides `aria-hidden` vs `role="img"`+`aria-label` by whether its meaning is ALREADY in the header's accessible name — never by "it's a small glyph, hide it".** → [rule](../../docs/design/invariants/216-a-status-adornment-inside-a-header-decides-aria-hidden-vs.md)
220. **A live region (`role="status"` / `role="alert"` / `aria-live`) must not carry a per-tick-updating accessible name — announce discrete state transitions (start / stop / appear), never a running clock or counter; put the ticking value in an `aria-hidden` element and keep the region's name stable.** → [rule](../../docs/design/invariants/220-a-live-region-role-status-role-alert-aria-live-must-not.md)
255. **Any `line-clamp-*` or `truncate` element that renders user-authored or variable-length data (titles, filenames, comment previews, risk names) must expose the full value via `title` — and via `aria-label` where the clamped line is the sole channel for that value.** → [rule](../../docs/design/invariants/255-any-line-clamp-or-truncate-element-that-renders-user.md)
341. **Whether a value is COMPUTED or COMMITTED is a property of the value, not of the record's workflow state — gate the cue on the value alone, and derive it from the same predicate the surfaces that act on it use.** → [rule](../../docs/design/invariants/341-whether-a-value-is-computed-or-committed-is-a-property-of.md)
342. **A control that asks the user to supply a value the system has already computed is friction wearing a form's clothes — seed it, and offer the computed answer as a one-click commit.** → [rule](../../docs/design/invariants/342-a-control-that-asks-the-user-to-supply-a-value-the-system.md)
343. **A fixed-height control strip that cannot wrap and must not scroll needs a MEASURED concession ladder, and the ladder's rungs are two different kinds of thing.** → [rule](../../docs/design/invariants/343-a-fixed-height-control-strip-that-cannot-wrap-and-must-not.md)
396. **A `<select>` whose `value` can fall outside its rendered `<option>` set does not fail — it silently paints the FIRST option, so the control states a fact the record does not hold.** → [rule](../../docs/design/invariants/396-a-select-whose-value-can-fall-outside-its-rendered-option.md)
397. **A health band word is the SERVER's band, printed from `lib/healthBand`'s `HEALTH_BAND_LABEL` — never a surface-private synonym, and never re-derived from counts by a surface whose payload could have carried the band.** → [rule](../../docs/design/invariants/397-a-health-band-word-is-the-server-s-band-printed-from-lib.md)
403. **When a displayed signal stops being derived from the evidence its own drill-through lists, the drill-through must say where the value now comes from — a header that disagrees with every row beneath it is worse than the derivation it replaced.** → [rule](../../docs/design/invariants/403-when-a-displayed-signal-stops-being-derived-from-the.md)
400. **A `FieldRow`'s `help` popover is an EDITOR-only affordance, so every fact a read-only user needs lives in `hint` — a `help`-only row explains itself to Admins and to nobody else.** → [rule](../../docs/design/invariants/400-a-fieldrow-s-help-popover-is-an-editor-only-affordance-so.md)
401. **A role-tier name and a display-only FK must never share a phrase, and UI copy names a tier with the SCOPE's role label — never the raw `Role` enum key.** → [rule](../../docs/design/invariants/401-a-role-tier-name-and-a-display-only-fk-must-never-share-a.md)
402. **On the consolidated `#hash`-anchored settings page (ADR-0146), an in-page deep link whose hash equals the current hash WILL NOT SCROLL — the destination section must scroll itself.** → [rule](../../docs/design/invariants/402-on-the-consolidated-hash-anchored-settings-page-adr-0146-an.md)
405. **A dialog or drawer that is deliberately never unmounted must leave the accessibility tree AND the tab order when closed — `aria-hidden={!isOpen}` plus `invisible pointer-events-none`, never one without the other.** → [rule](../../docs/design/invariants/405-a-dialog-or-drawer-that-is-deliberately-never-unmounted.md)
406. **A lane reserved only on some pointer classes is not a lane — and an `absolute` control shifts nothing, so no width, alignment or bounding-box test can see it lying on its neighbour. Hit-test.** → [rule](../../docs/design/invariants/406-a-lane-reserved-only-on-some-pointer-classes-is-not-a-lane.md)
407. **Promoting a client constant to a server fact does not end the drift — it MOVES it to every prose restatement of that constant, and those are louder than the control they contradict.** → [rule](../../docs/design/invariants/407-promoting-a-client-constant-to-a-server-fact-does-not-end.md)
408. **A "previous value" ref that drives an announcement, a change badge, or a diff highlight must be keyed to the ENTITY the value describes — a component that outlives the entity turns NAVIGATION into a change event.** → [rule](../../docs/design/invariants/408-a-previous-value-ref-that-drives-an-announcement-a-change.md)
410. **A value read from an async query that SEEDS a mount-frozen draft must be gated on that query RESOLVING — every other consumer of the same value self-corrects on re-render, and that is exactly what hides the one that cannot.** → [rule](../../docs/design/invariants/410-a-value-read-from-an-async-query-that-seeds-a-mount-frozen.md)
413. **A chart label that collides with its neighbor moves to a new ROW — the marker it names never moves, and the packing is a generic N-label layout problem, not a special case for one named pair.** → [rule](../../docs/design/invariants/413-a-chart-label-that-collides-with-its-neighbor-moves-to-a.md)
416. **A real, nonzero-denominator computed zero is a value, not a health signal — it must never wear the on-track/success color.** → [rule](../../docs/design/invariants/416-a-real-nonzero-denominator-computed-zero-is-a-value-not.md)

## Redundancy

*The class whose absence produced #2424, #2425 and #2426.*

284. **A value renders once per surface: the task drawer's summary strip is the READ surface, the sections below it are the EDIT surface, and a value belongs to exactly one of them (#2424).** → [rule](../../docs/design/invariants/284-a-value-renders-once-per-surface-the-task-drawer-s-summary.md)
363. **A surface that REPORTS current state is a readout and is exempt; everything else is a teaching surface, and at most ONE teaching surface renders per column (#3134).** → [rule](../../docs/design/invariants/363-a-surface-that-reports-current-state-is-a-readout-and-is.md)

## Surface states

*Loading, empty, and failed are three different things and must look like it.*

248. **A data surface's loading state is a skeleton ghost that mirrors the shape of the real content, never a bare `Loading…` text line.** → [rule](../../docs/design/invariants/248-a-data-surface-s-loading-state-is-a-skeleton-ghost-that.md)
177. **A primary surface's zero-data state is a warm `EmptyState`, not a bare "No data" line; its single entrance animation is `motion-safe:` only.** → [rule](../../docs/design/invariants/177-a-primary-surface-s-zero-data-state-is-a-warm-emptystate.md)
246. **A TanStack Query fetch failure on a primary surface renders the shared `QueryErrorState` (`components/QueryErrorState.tsx`), never an empty or perpetual-skeleton state — a dead request must be visually distinct from "nothing here yet".** → [rule](../../docs/design/invariants/246-a-tanstack-query-fetch-failure-on-a-primary-surface-renders.md)
224. **A route-level error surface (`errorElement`) that offers recovery actions must move focus to its heading on mount — the erroring subtree unmounted, dropping focus to `document.body`, so keyboard/AT users otherwise cannot reach the recovery CTAs.** → [rule](../../docs/design/invariants/224-a-route-level-error-surface-errorelement-that-offers.md)
298. **A route boundary is inherited, never opted into: every child of the `AppShell` route gets its `errorElement` from `shellRoutes()` in `router.tsx`, and a recovery action that leaves the document asks the write queue itself before discarding it.** → [rule](../../docs/design/invariants/298-a-route-boundary-is-inherited-never-opted-into-every-child.md)
337. **Every rung of one ordered notice ladder shares one live-region contract — decide it at the ladder, from the most announcement-worthy branch, never per rung.** → [rule](../../docs/design/invariants/337-every-rung-of-one-ordered-notice-ladder-shares-one-live.md)
372. **A write refusal's presentation is decided by whether a replay could succeed, and its inline error is a SIBLING `role="alert"` — never a child of the surface's preview `role="status"`.** → [rule](../../docs/design/invariants/372-a-write-refusal-s-presentation-is-decided-by-whether-a.md)
375. **A shared helper does not stop nine surfaces reinventing a refusal — the PROP TYPE does. When a class recurs across call sites of one primitive, change what the primitive ACCEPTS, and let `tsc` refuse the hardcoded string.** → [rule](../../docs/design/invariants/375-a-shared-helper-does-not-stop-nine-surfaces-reinventing-a.md)
376. **Making a refusal SPECIFIC makes its staleness a defect — a surface showing the server's own sentence must RETIRE it when the thing it describes changes, and the mutation hook will not do that for you.** → [rule](../../docs/design/invariants/376-making-a-refusal-specific-makes-its-staleness-a-defect-a.md)
377. **A control whose field has NO reader is a third inert state — render no control at all, for every role, with a plain sentence inside the row saying nothing reads it. It is neither rule 122's disabled stub nor rule 361's version-badged inert arm.** → [rule](../../docs/design/invariants/377-a-control-whose-field-has-no-reader-is-a-third-inert-state.md)
379. **An unresolved server verdict has TWO safe defaults, and which one is safe depends on whether the output is an AFFORDANCE or a WITHDRAWAL — never carry a `can_*` field's polarity across the two.** → [rule](../../docs/design/invariants/379-an-unresolved-server-verdict-has-two-safe-defaults-and.md)
380. **On a surface that commits from a keyboard shortcut, a description bound to the commit BUTTON is unreachable — bind it to the dialog.** → [rule](../../docs/design/invariants/380-on-a-surface-that-commits-from-a-keyboard-shortcut-a.md)
373. **When the floor to REVERSE an act sits ABOVE the floor to perform it, the receipt must carry the server's verdict on the reversal — never infer it from the act having succeeded.** → [rule](../../docs/design/invariants/373-when-the-floor-to-reverse-an-act-sits-above-the-floor-to.md)
374. **A skeleton gated on a remote job's STATUS needs a bounded exit — "the job never reported" and "the job is still running" are the same two seconds and different hours.** → [rule](../../docs/design/invariants/374-a-skeleton-gated-on-a-remote-job-s-status-needs-a-bounded.md)
391. **A flag fixed at navigation time cannot carry a status the server writes LATER — route the job's id, not a boolean about it, or the destination can never learn how the job ended.** → [rule](../../docs/design/invariants/391-a-flag-fixed-at-navigation-time-cannot-carry-a-status-the.md)
386. **A hand-enumerated "nothing to read" predicate that decides FOCUS SEATING rots the moment a new conditional paragraph lands beside it — re-derive it, or put the content inside the live region.** → [rule](../../docs/design/invariants/386-a-hand-enumerated-nothing-to-read-predicate-that-decides.md)
381. **When a terminal status has no surface, widening the PREDICATE is usually the wrong repair — ask which component should have been READING the status, and check the failure state does not evict the recovery path that is already on screen.** → [rule](../../docs/design/invariants/381-when-a-terminal-status-has-no-surface-widening-the.md)
384. **A setting that is NOT-NULL at every scope does NOT inherit — it SEEDS — and the copy saying so has to be swept across every scope in the same commit, because the false sentence is written once per surface and each one reads as authoritative alone.** → [rule](../../docs/design/invariants/384-a-setting-that-is-not-null-at-every-scope-does-not-inherit.md)
385. **A receipt must count in a unit the user chose — never one the server's tally loop happens to hold, and never a write the receipt is structurally unable to show.** → [rule](../../docs/design/invariants/385-a-receipt-must-count-in-a-unit-the-user-chose-never-one-the.md)
338. **Demoting a creation surface means deleting its FORM, not its affordance — and an affordance that carries context a route cannot express must keep its own control.** → [rule](../../docs/design/invariants/338-demoting-a-creation-surface-means-deleting-its-form-not-its.md)
339. **A control that performs two acts must SAY which one the next press does — and the label and the accessible name must be one derived string, spelled for the platform reading it.** → [rule](../../docs/design/invariants/339-a-control-that-performs-two-acts-must-say-which-one-the.md)
340. **A word the product must not say is not enforced by asking people not to say it — put the word in ONE module, brand its type, and let `tsc` refuse the literal.** → [rule](../../docs/design/invariants/340-a-word-the-product-must-not-say-is-not-enforced-by-asking.md)
352. **An entry point whose precondition is "a row is selected" is DEAD on a surface where selecting a row opens a covering drawer — put it on the row.** → [rule](../../docs/design/invariants/352-an-entry-point-whose-precondition-is-a-row-is-selected-is.md)
353. **A surface fronting two independent server permissions has a PARTIAL-rights band, and one "View only" badge is wrong for it in both directions — re-derive the standing badge from the union, and sweep every piece of standing copy that names the withheld affordance.** → [rule](../../docs/design/invariants/353-a-surface-fronting-two-independent-server-permissions-has-a.md)
354. **A DOCKED region that can grow needs a height cap and its own scroller — and the ancestor that would otherwise clip it cannot scroll, which is why nobody notices.** → [rule](../../docs/design/invariants/354-a-docked-region-that-can-grow-needs-a-height-cap-and-its.md)
355. **A responsive surface that renders ONE state through TWO breakpoint-selected components must give that state ONE live-region contract — decide it at the state, not once per rendition.** → [rule](../../docs/design/invariants/355-a-responsive-surface-that-renders-one-state-through-two.md)
358. **A modal's PINNED chrome is a budget charged against its scroller, and a scripted mount-focus SCROLLS that scroller — so autofocusing a control below the fold silently pushes the surface's lead content off the top, at every viewport height the reviewer did not open.** → [rule](../../docs/design/invariants/358-a-modal-s-pinned-chrome-is-a-budget-charged-against-its.md)
359. **A control gated on "there is something to do" must be gated on a fact the server owns or the client can always re-derive — never on a counter that only counts this session's own mutations.** → [rule](../../docs/design/invariants/359-a-control-gated-on-there-is-something-to-do-must-be-gated.md)
364. **`?? []` says "the query has not answered" and "the answer is empty" with the same word — so nothing that REMOVES may read it.** → [rule](../../docs/design/invariants/364-says-the-query-has-not-answered-and-the-answer-is-empty.md)
415. **A capability claim that decays with TIME must be REPLACED when it stops being true — not left standing beside a warning that contradicts it — and the freshness fact it branches on is a SERVER field, never a client subtraction.** → [rule](../../docs/design/invariants/415-a-capability-claim-that-decays-with-time-must-be-replaced.md)

## Motion

*Motion is never content.*

70. **`prefers-reduced-motion` is evaluated at engine init and on media query change.** → [rule](../../docs/design/invariants/70-prefers-reduced-motion-is-evaluated-at-engine-init-and-on.md)
181. **All transform/overlay motion uses the shared `ease-brand` + a named `duration-*` token, and the four entrance keyframes live in `globals.css` and are applied under `motion-safe:` — never hand-rolled per call site, never ungated.** → [rule](../../docs/design/invariants/181-all-transform-overlay-motion-uses-the-shared-ease-brand-a.md)

## Controls and composition

*Reach for the shared primitive before writing a new one.*

179. **A segmented control (`role="radiogroup"` of `role="radio"` buttons) must fill the active segment with a token that contrasts against its container surface — never the same surface token the control sits on — and selection is conveyed by fill, not text color alone.** → [rule](../../docs/design/invariants/179-a-segmented-control-role-radiogroup-of-role-radio-buttons.md)
183. **App-wide confirmations use the global `toast()` API + the single `ToastHost`; board-local transient notices stay in `BoardDropNotice` (rule 170).** → [rule](../../docs/design/invariants/183-app-wide-confirmations-use-the-global-toast-api-the-single.md)
356. **A capped set of transient surfaces must NOT evict by age when dwell is set by importance — give each class its own slot instead.** → [rule](../../docs/design/invariants/356-a-capped-set-of-transient-surfaces-must-not-evict-by-age.md)
378. **A surface that removes itself on a timer and holds a focusable control must take its dwell from `usePausableAutoDismiss` — a bare `setTimeout` is the defect, and it is invisible in review because the surface it deletes is correct.** → [rule](../../docs/design/invariants/378-a-surface-that-removes-itself-on-a-timer-and-holds-a.md)
250. **Menu/panel group headers (eyebrows) use one canonical recipe: `text-xs font-semibold uppercase tracking-[.06em] text-neutral-text-secondary`; inside a `role="menu"` or dialog, wrap the grouped rows in a `role="group"` labeled "like the header" (`aria-label` or `aria-labelledby`), with the visible header div `aria-hidden`.** → [rule](../../docs/design/invariants/250-menu-panel-group-headers-eyebrows-use-one-canonical-recipe.md)
253. **A neutral read-state chip may become a tap-to-explain disclosure, but the disclosure must stay neutral, grant no capability, and portal out of any clipping scroll container.** → [rule](../../docs/design/invariants/253-a-neutral-read-state-chip-may-become-a-tap-to-explain.md)
260. **A floating popover / menu / listbox that must escape a clipping ancestor (an `overflow-hidden` card, an `overflow-y-auto` scroll panel) or stay on a narrow viewport uses the shared `useAnchoredPopover` hook (`hooks/useAnchoredPopover.ts`) as its positioning + dismissal engine — do not hand-roll the `getBoundingClientRect` → `position:fixed` → flip-above → clamp → scroll(capture)/resize → outside-`pointerdown` math inline.** → [rule](../../docs/design/invariants/260-a-floating-popover-menu-listbox-that-must-escape-a-clipping.md)
351. **A floating `role="menu"` / `role="listbox"` panel must carry BOTH a height guard and `overflow-y-auto` — a panel that can grow taller than the viewport and has neither spills off the bottom of the screen with nothing to bring the rest into view.** → [rule](../../docs/design/invariants/351-a-floating-role-menu-role-listbox-panel-must-carry-both-a.md)
287. **Any abbreviation, code, percentile, or icon-only control ships with a plain-English explanation reachable by hover AND keyboard focus AND touch — via the shared `Tooltip` (`components/Tooltip.tsx`), never a bare `title` and never a `group-hover` class (#2389).** → [rule](../../docs/design/invariants/287-any-abbreviation-code-percentile-or-icon-only-control-ships.md)
273. **`AppShell` renders the single `<main id="main-content">` landmark — a feature page, panel, or state-branch (loading/error/empty) rendered inside the shell must NOT emit its own `<main>`; use a labeled `<section aria-label>` (or a `<div>` when it already owns a `role`).** → [rule](../../docs/design/invariants/273-appshell-renders-the-single-main-id-main-content-landmark-a.md)
304. **A form that edits a *set* the server owns must round-trip every member — including ones this build has no widget for. Never narrow a fetched collection to the client's own catalog and then write the narrowed value back.** → [rule](../../docs/design/invariants/304-a-form-that-edits-a-set-the-server-owns-must-round-trip.md)
314. **A settings section is five coupled edits across four files and two packages — and four of them fail somewhere other than the file you are writing.** → [rule](../../docs/design/invariants/314-a-settings-section-is-five-coupled-edits-across-four-files.md)
317. **Merging settings sections is rule 314's five edits run backwards — plus the addresses the merged sections used to answer on, which fail SILENTLY and are not one mechanism but three.** → [rule](../../docs/design/invariants/317-merging-settings-sections-is-rule-314-s-five-edits-run.md)
390. **A teaching surface's glyph is a claim about a control, and a removal justified by a replacement lands WITH the replacement — never on the promise of it (#3257).** → [rule](../../docs/design/invariants/390-a-teaching-surface-s-glyph-is-a-claim-about-a-control-and-a.md)
393. **A row that hides its own label at phone width is a `shrink-0` budget problem, not a `min-w-0` problem — and the two have different fixes. Measure before you add either.** → [rule](../../docs/design/invariants/393-a-row-that-hides-its-own-label-at-phone-width-is-a-shrink-0.md)
412. **`input[type="date"]` exposes NO `textbox` role — locate it with `getByLabel`, never `getByRole('textbox')`, and pass `{ exact: true }` in Playwright.** → [rule](../../docs/design/invariants/412-input-type-date-exposes-no-textbox-role-locate-it-with.md)

## Dialogs, focus and keyboard

*Where focus goes, and what commits.*

303. **Never bind a manual refresh/retry control's `disabled` (or spinner) state to a query's raw `isFetching` when that query also polls (`refetchInterval` set) — track a local "this fetch was user-initiated" flag instead.** → [rule](../../docs/design/invariants/303-never-bind-a-manual-refresh-retry-control-s-disabled-or.md)
217. **Every dialog/drawer/modal/panel that edits existing information or collects new information presents an explicit, consistent commit/discard affordance — Save (primary) + Cancel (secondary), Save disabled until dirty, a Cancel that reverts to the original values, and an unsaved-changes guard on any dirty dismiss — composed from the shared `@/components/dialog` primitives, never re-decided per surface.** → [rule](../../docs/design/invariants/217-every-dialog-drawer-modal-panel-that-edits-existing.md)
206. **A dialog that declares `role="dialog"`/`role="alertdialog"` + `aria-modal="true"` MUST trap focus itself (`useFocusTrap`) — you cannot clone a confirm dialog that relied on a parent modal for focus containment into a standalone/bare mount and keep `aria-modal` honest.** → [rule](../../docs/design/invariants/206-a-dialog-that-declares-role-dialog-role-alertdialog-aria.md)
245. **A dialog that stays open while its content swaps state passes that state as `useFocusTrap`'s `focusKey`; a confirm dialog nested inside a modal whose parent trap yields must run its own `useFocusTrap` — never ship a modal surface where Tab can reach the background page (WCAG 2.4.3 / 2.1.2).** → [rule](../../docs/design/invariants/245-a-dialog-that-stays-open-while-its-content-swaps-state.md)
335. **A phase swap that replaces a surface with its OUTCOME must announce the outcome, not just seat focus on a button beside it — a live region inserted together with its own content is not a reliable announcement, and moving focus states the control's name and nothing else.** → [rule](../../docs/design/invariants/335-a-phase-swap-that-replaces-a-surface-with-its-outcome-must.md)
360. **A scroll container with no focusable descendant needs `tabIndex={0}` and a `focus:` ring — otherwise it is unreachable by keyboard, and the two attributes you added for accessibility are what hide the fact.** → [rule](../../docs/design/invariants/360-a-scroll-container-with-no-focusable-descendant-needs.md)
361. **A control that is inert *by design for a named release* is not rule 122's incidental placeholder — it takes an at-rest sentence, a version badge, `aria-disabled`, and an explicit `aria-label`; never a `title`, and never `disabled`.** → [rule](../../docs/design/invariants/361-a-control-that-is-inert-by-design-for-a-named-release-is.md)
362. **A focus trap assumes its focusable set and its restore target are both stable — a one-way action invalidates both, and neither rule 206 nor rule 245 catches it as written.** → [rule](../../docs/design/invariants/362-a-focus-trap-assumes-its-focusable-set-and-its-restore.md)
419. **A dialog whose trap container is the full-viewport scrim breaks the instant any phase disables every control — put `ref`/`role`/`aria-modal`/`tabIndex={-1}` and the `focus:` ring on the PANEL, and let the scrim be a plain pointer-dismiss sibling.** → [rule](../../docs/design/invariants/419-a-dialog-whose-trap-container-is-the-full-viewport-scrim.md)
365. **A ground change that carries meaning must be measured against the ground it actually sits on — and a `-raised`/`-sunken` step only steps within its own token family.** → [rule](../../docs/design/invariants/365-a-ground-change-that-carries-meaning-must-be-measured.md)
167. **A roving-`tabindex` group (`role="radiogroup"`/`"tablist"`) MUST move DOM focus on arrow keys, and arrow navigation MUST NOT commit a side-effect — only activation (click / Enter / Space) commits.** → [rule](../../docs/design/invariants/167-a-roving-tabindex-group-role-radiogroup-tablist-must-move.md)
280. **A roving-tabindex list must move DOM focus only when a *keyboard path* asked for it — never as a side effect of the list changing.** → [rule](../../docs/design/invariants/280-a-roving-tabindex-list-must-move-dom-focus-only-when-a.md)
211. **When a persistent left rail collapses into a mobile header that re-hosts the *same* interactive controls (scope switcher, context switcher, copy-link — anything queried by role/label), render exactly ONE copy via a `useBreakpoint()` conditional, NEVER two copies gated by `hidden md:flex` / `md:hidden`.** → [rule](../../docs/design/invariants/211-when-a-persistent-left-rail-collapses-into-a-mobile-header.md)
225. **An `aria-invalid` field must gate its form's primary action — the submit/primary button's enabled state derives from that validity AND the submit handler re-guards it; never leave the primary action live while showing an error, and never let it commit a stale/previous value the user did not type.** → [rule](../../docs/design/invariants/225-an-aria-invalid-field-must-gate-its-form-s-primary-action.md)
294. **A new Alt/Option+letter keyboard shortcut matches on `e.code`, never `e.key`.** → [rule](../../docs/design/invariants/294-a-new-alt-option-letter-keyboard-shortcut-matches-on-e-code.md)
323. **When a count is narrowed to a subset, re-check every predicate that reads it.** → [rule](../../docs/design/invariants/323-when-a-count-is-narrowed-to-a-subset-re-check-every.md)
296. **A truncation notice ships with a way past the cap, on the same surface.** → [rule](../../docs/design/invariants/296-a-truncation-notice-ships-with-a-way-past-the-cap-on-the.md)
297. **A client-triggered file download needs a polite live-region confirmation.** → [rule](../../docs/design/invariants/297-a-client-triggered-file-download-needs-a-polite-live-region.md)
307. **A global keyboard shortcut that DESTROYS something needs a single arbiter, and the claim registry in `hooks/useGlobalShortcut.ts` is that arbiter — do not build a second mechanism.** → [rule](../../docs/design/invariants/307-a-global-keyboard-shortcut-that-destroys-something-needs-a.md)
308. **A false capability claim is a property of the SURFACE, not of the sentence you were sent to fix — enumerate every claim on the screen, and pin it with an assertion on the capability rather than on the retired wording.** → [rule](../../docs/design/invariants/308-a-false-capability-claim-is-a-property-of-the-surface-not.md)
311. **A direct-manipulation gesture must state its CONSEQUENCE before release, and the same pointer position must never be able to mean two things.** → [rule](../../docs/design/invariants/311-a-direct-manipulation-gesture-must-state-its-consequence.md)
315. **A layout constant that varies at runtime needs ONE owner and a read path that does not require React — a second declaration is not a duplicate, it is a silent mis-hit.** → [rule](../../docs/design/invariants/315-a-layout-constant-that-varies-at-runtime-needs-one-owner.md)
316. **A control that STATES where its effect will land must derive the sentence and the mutation from one function — and the sentence must describe what the mutation actually composes, not what the design sketch promised.** → [rule](../../docs/design/invariants/316-a-control-that-states-where-its-effect-will-land-must.md)
329. **A key that is BOTH text and a command needs a state that says which — and the state must be set by an explicit gesture, never inferred from the pointer.** → [rule](../../docs/design/invariants/329-a-key-that-is-both-text-and-a-command-needs-a-state-that.md)
328. **A control's EXISTENCE must never be a side effect of a neighbour's visibility — and a fact stated only in a `title` or an `aria-label` is not stated.** → [rule](../../docs/design/invariants/328-a-control-s-existence-must-never-be-a-side-effect-of-a.md)
319. **A record becoming a control re-opens every question the record never had to answer — and the first is whether the thing can be reached at all.** → [rule](../../docs/design/invariants/319-a-record-becoming-a-control-re-opens-every-question-the.md)
320. **A hint that names a pointer gesture is not an affordance — every gesture-only path needs a NAMED action beside it, and the hint must name the action first.** → [rule](../../docs/design/invariants/320-a-hint-that-names-a-pointer-gesture-is-not-an-affordance.md)
321. **Two "views" of one collection are two SURFACES over one row model, and a surface may choose columns — never rows.** → [rule](../../docs/design/invariants/321-two-views-of-one-collection-are-two-surfaces-over-one-row.md)
322. **When two controls write ONE persisted layout value, they share one clamp and one announced range — and a bound must never reach backwards past the value the user already holds.** → [rule](../../docs/design/invariants/322-when-two-controls-write-one-persisted-layout-value-they.md)
324. **A gesture that acts on a SELECTION cannot be reached if a child of the row swallows the click — and the swallow is invisible to every test that drives the keyboard.** → [rule](../../docs/design/invariants/324-a-gesture-that-acts-on-a-selection-cannot-be-reached-if-a.md)
326. **A persisted preference and a taught keystroke are both CLAIMS — each must resolve against the thing that implements it, and the gate that proves it must DERIVE the resolution rather than restate it.** → [rule](../../docs/design/invariants/326-a-persisted-preference-and-a-taught-keystroke-are-both.md)
331. **A server-computed rollup is not maintained by any optimistic update, so it must be invalidated on the ORIGINATING client too — and it must be added to an EXISTING `useProjectWebSocket` handler, never a new `on()` registration.** → [rule](../../docs/design/invariants/331-a-server-computed-rollup-is-not-maintained-by-any.md)
327. **A row's own state must render AT REST, and the cell that states it is where the cell edits it — adding that control changes what a geometric row click hits.** → [rule](../../docs/design/invariants/327-a-row-s-own-state-must-render-at-rest-and-the-cell-that.md)
310. **Two URL-param writes in the SAME commit lose the first — `setSearchParam`'s functional updater does not save you, and the failure is silent.** → [rule](../../docs/design/invariants/310-two-url-param-writes-in-the-same-commit-lose-the-first.md)
309. **The Schedule row's far-left edge is spoken for twice — a third row-level meaning goes at the indent origin, not there.** → [rule](../../docs/design/invariants/309-the-schedule-row-s-far-left-edge-is-spoken-for-twice-a.md)
279. **An effect that needs a DOM node takes the node from `useElementRef` and lists it as a dependency — never `someRef.current` read inside an effect that cannot re-run when the node mounts (#2365).** → [rule](../../docs/design/invariants/279-an-effect-that-needs-a-dom-node-takes-the-node-from.md)
411. **`disabled` on a form control removes it from the tab order and takes its `aria-describedby` explanation with it — so the state that most needs explaining becomes the one a keyboard or screen-reader user cannot reach. Use `readOnly` + an `onChange` guard for "inert right now", and reserve `disabled` for controls with no explanation to offer.** → [rule](../../docs/design/invariants/411-disabled-on-a-form-control-removes-it-from-the-tab-order.md)

## Canvas

*The canvas is outside the DOM, so it inherits none of the guarantees above.*

235. **On the interactive canvas Gantt, the task bar FILL carries task STATE and the critical path is a red BORDER frame — never colour the fill by criticality.** → [rule](../../docs/design/invariants/235-on-the-interactive-canvas-gantt-the-task-bar-fill-carries.md)
244. **A `<canvas>` is not touched by the forced-colors (Windows High Contrast) user-agent transform, so canvas-drawn UI must detect `(forced-colors: active)` and repaint with CSS *system-color* keywords — otherwise it renders its fixed colors into a high-contrast theme and becomes invisible/unreadable.** → [rule](../../docs/design/invariants/244-a-canvas-is-not-touched-by-the-forced-colors-windows-high.md)
295. **A forced-colors palette entry that collapses an alpha tint to a solid system colour (`Canvas`/`CanvasText`) is only safe if that fill paints BEFORE everything it would occlude — check the draw ORDER, not just the palette.** → [rule](../../docs/design/invariants/295-a-forced-colors-palette-entry-that-collapses-an-alpha-tint.md)

## Iconography

*A glyph carries information or it does not exist.*

242. **A glyph that stands in for a *UI icon* — a status/affordance mark like a warning, lock, target, chart, pin, or disabled sign — must be a house SVG from `components/Icons.tsx`, never a Unicode emoji.** → [rule](../../docs/design/invariants/242-a-glyph-that-stands-in-for-a-ui-icon-a-status-affordance.md)
283. **An icon column carries information or it does not exist: no glyph repeats inside a single settings nav group, `ExternalLinkIcon` means "this leaves the app", and `WarningIcon` means "exception" (#2425).** → [rule](../../docs/design/invariants/283-an-icon-column-carries-information-or-it-does-not-exist-no.md)
292. **A 2px brand-primary left rule (`border-l-2 border-brand-primary`) is this app's SELECTION/ACTIVE idiom — a static informational block uses `border-l-4`.** → [rule](../../docs/design/invariants/292-a-2px-brand-primary-left-rule-border-l-2-border-brand.md)
293. **A `text-[12px]` paragraph of running prose in `features/settings/` carries a measure cap of `max-w-[440px]`–`max-w-[480px]`.** → [rule](../../docs/design/invariants/293-a-text-12px-paragraph-of-running-prose-in-features-settings.md)

## Placeholders and operator surfaces

*What an unavailable control is allowed to look like.*

122. **Disabled placeholder/stub controls in `features/settings/` use the `.settings-stub` recipe — never `disabled:opacity-50`.** → [rule](../../docs/design/invariants/122-disabled-placeholder-stub-controls-in-features-settings-use.md)
274. **A read-only surface for an operator / deploy-time (env or Helm) value presents an honest *status* — a state chip, the controlling env-var name, and an explicit "configured in the server environment, not editable here" — never a disabled in-app toggle or a "fix it here" link.** → [rule](../../docs/design/invariants/274-a-read-only-surface-for-an-operator-deploy-time-env-or-helm.md)
306. **A security-relevant escaper (CSV cell, HTML, filename, shell) has exactly ONE implementation in this tree, and the thing that keeps it that way is a source-scanning test — not a code review.** → [rule](../../docs/design/invariants/306-a-security-relevant-escaper-csv-cell-html-filename-shell.md)
336. **A tinted control inside an already-tinted container composites TWICE — an AA-safe token pair is not AA-safe at nesting depth 2, and the DS-v2 gate's own prescribed fix does not rescue it.** → [rule](../../docs/design/invariants/336-a-tinted-control-inside-an-already-tinted-container.md)
388. **A facet filter's option counts, the column it filters, and any tally rendered beside it must all be computed from the same field over the same denominator — a filter that describes a set the surface is not showing is worse than no filter.** → [rule](../../docs/design/invariants/388-a-facet-filter-s-option-counts-the-column-it-filters-and.md)
392. **A consent, warning, or write-lock predicate computed from a secondary TanStack Query list must not read that list's loading/failed default as a verdict — `[]`/`0`/`undefined` while unresolved is "unknown", never "nothing to guard against".** → [rule](../../docs/design/invariants/392-a-consent-warning-or-write-lock-predicate-computed-from-a.md)
398. **The sentence explaining a withheld control is a disclosure in its own right, and it carries the false claim that the withhold does not — three states, not two, and a third footprint that is neither `QueryErrorState` variant.** → [rule](../../docs/design/invariants/398-the-sentence-explaining-a-withheld-control-is-a-disclosure.md)
387. **A soft-disabled (`aria-disabled`) option is kept reachable in order to be *read* — so style it readable.** → [rule](../../docs/design/invariants/387-a-soft-disabled-aria-disabled-option-is-kept-reachable-in.md)

## Product boundary

*What OSS shows, and where Enterprise may be surfaced.*

231. **The OSS UI shows what one team can do; an Enterprise affordance appears ONLY at a surface where the user reaches for something inherently cross-program or org-governing — never as an ambient padlock, disabled control, or upsell teaser in the OSS daily path.** → [rule](../../docs/design/invariants/231-the-oss-ui-shows-what-one-team-can-do-an-enterprise.md)
121. **Enterprise-only capability rows carry an inline `EE` badge that is itself the link.** → [rule](../../docs/design/invariants/121-enterprise-only-capability-rows-carry-an-inline-ee-badge.md)
404. **A "this surface does not apply to you" disclosure must be gated on the CONDITION, never on emptiness — an explanation that lives only inside the empty state is blind to the populated case, which is the worse one.** → [rule](../../docs/design/invariants/404-a-this-surface-does-not-apply-to-you-disclosure-must-be.md)
409. **A shared notice's remediation sentence ("narrow the window", "use the filter", "try searching") is a claim about the CALLER's affordances, not the component's — parameterize it per mount, never hardcode one sentence for all of them.** → [rule](../../docs/design/invariants/409-a-shared-notice-s-remediation-sentence-narrow-the-window.md)

---

## Reading and adding a rule

This file is an **index**. Each numbered line is one invariant's headline; the
rule's full text — its lettered obligations, its reasoning, its references —
lives in the linked file under
[`docs/design/invariants/`](../../docs/design/invariants/). Hold the headlines.
Open the body before you touch the surface a rule governs, and before you cite
one of its lettered clauses. Rule numbers are unchanged, so every existing
`rule N` citation still resolves (#3744, ADR-0653 amendment).

The index is one line per rule so that two branches adding rules append
distinct lines instead of editing the same paragraph, and `.gitattributes`
merges it with `merge=union`. `scripts/check-web-rule-numbers.sh` (CI
`web:rule-numbers`, `make pre-push`) fails on a duplicate number — which is also
what a union merge leaves if two branches edited the same line — on an index
line whose body is missing, and on a body no line indexes.

To add an invariant:

1. `scripts/wt reserve rule` for the number.
2. Write `docs/design/invariants/<N>-<slug>.md`, copying the header of any sibling.
3. Append **one** line to the end of the section it belongs to:
   `N. **Headline.** → [rule](../../docs/design/invariants/<N>-<slug>.md)`.
   Never below this section — rules 411 and 412 landed down here before the
   split, which is the append-at-the-end collision this layout removes.

**Where does a new rule go?** Ask whether it would be correct for a surface that
does not exist yet. If yes it is an invariant: a body file plus an index line
here. If it only makes sense for the surface that produced it, write a decision
record instead. See ADR-0653.

## The other 228 rules

Every rule this file used to carry still exists. The ones bound to a single
surface and a single issue live as individually-linkable **decision records**
under [`docs/design/decisions/`](../../docs/design/decisions/) — see
[the index](../../docs/design/decisions/README.md). They are still binding for
the surfaces they govern; they are simply not part of the set indexed above.
