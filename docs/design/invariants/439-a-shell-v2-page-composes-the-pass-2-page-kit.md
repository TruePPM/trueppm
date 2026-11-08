# Rule 439 — A shell v2 page composes the Pass 2 page kit; it never restates a gutter, a title size, a row height or a state

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Controls and composition*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**A page rendered inside shell v2 (`features/shell2/`, the `shell_v2` flag) takes its frame, its title, its tables, its avatars and its loading / empty / error / not-computable states from the Pass 2 kit in `src/components/page2/` and the `page` / `table` variants of the shared state components. It never re-types the numbers those primitives own.** The numbers are the Pass 2 conventions (#4795, design handoff "TruePPM Redesign Pass 2", frames `c-l` / `c-d`):

| Convention | Owner | The rule it encodes |
|---|---|---|
| Gutters 16 / 20 / 24 / 32 at < 768 / 768 / 1024 / 1440; content 1120 max (Overview, Settings) or full bleed (Schedule, Board) | `PageFrame` (`width="contained" \| "bleed"`) | One frame per page, never a hand-written `max-w-*` and `px-*` |
| Chrome above the page is three rows at most; the page starts at <= 191px | `PageFrame`'s `toolbar` / `toolbarOverride` | A banner, "filters applied" row or bulk bar REPLACES the toolbar row; the frame renders one or the other, so stacking cannot be written |
| Title scale: lead 44/52, greeting 32/40, page title 20/28, tile 20/28 tabular, section 15/22, body 13/20, meta 12/16, mono 12 | `TYPE` in `typeScale.ts`, `PageTitle`, `SectionHeading` | A page asks for a step by role, never `text-[20px]` |
| One H1 per page; the context header is the visible title when present | `PageTitle` (`visuallyHidden` under a context header) | Two visible titles repeat each other |
| Eyebrow rule: the breadcrumb owns ancestry; a title never repeats it. Phone: the back label above the title is the breadcrumb, and a button | `PageTitle`'s `back` | Rendered once from `useBreakpoint()` (rule 211) |
| Table: 36px rows (32 dense, 64 narrative), 44 on a coarse pointer or phone; 32px sticky header; no zebra; sticky identity column with an edge once scrolled; right-aligned mono tabular numbers | `DataTable` | The identity column's edge is a strong hairline, not a shadow — rule 1 overrides the design's "edge shadow" |
| Avatar 22 / 28 / 36; stack of at most 3 plus "+N" read as "N more people"; dashed-ring unassigned with a user-plus icon; over-allocation as the amber glyph plus the number | `Avatar`, `AvatarStack`, `UnassignedAvatar` | The number is printed, never left to a color ring |
| Not computable: one dashed-top line naming the missing input and the single fix | `NotComputable` | **Narrows rule 119** for shell v2: the muted card becomes a line, because a tile with a dash in it reads as a value of zero. Never hidden — rule 119 still holds |
| Empty: left-aligned, no illustration, at most two actions | `EmptyState variant="page"` | The `actions` tuple type refuses a third |
| Error: neutral, not red; says what still works; short support code | `QueryErrorState variant="page"` + `lib/supportCode` | Red is reserved for critical and blocked (rule 440); rule 246 still requires `QueryErrorState` |
| Skeleton: real chrome and counts first; pulse under `motion-safe:` only | `LoadingSkeleton variant="table"` | Real column names and a known count paint as text; only cell values ghost |
| Definition tip: dotted-underline term, hover / focus / tap, Escape dismisses, "as of" time nearby | `DefinitionTip` | Built on the shared `Tooltip` (rule 287) |
| 44px targets under `@media (pointer: coarse)`, 2px focus ring with offset | `HIT_44` and `FOCUS_RING` in `classes.ts`; real-box controls add `[@media(pointer:coarse)]:h-11 max-md:h-11` | Rules 4 and 5, written once |

**Why.** Every page in the Pass 2 audit invented its own width, title size, table density and empty / error / loading state, and the drift came back each time a page was fixed in isolation. A convention that lives in a design file and a review checklist is re-decided by every page; a convention that lives in one component is decided once. The screen issues (#4796–#4800) consume these primitives, so they are where a retune lands.

**How to apply.**

1. Before writing a frame, a heading, a table or a state on a shell v2 page, reach for the kit. If the kit lacks a shape you need, extend the kit, not the page.
2. The kit's fixture page (`/shell2/kit?ff=shell_v2`, `features/shell2/KitPage.tsx`) mounts every primitive with static data and is the reference the screen issues build against; `e2e/shell-v2-page-kit.spec.ts` pins the geometry jsdom cannot measure (gutters, the 191px start, row heights, the sticky edge) and runs axe in both themes.
3. A `StatusChip` in a cell is how a table states a status — a word plus a glyph (rule 440), never a colored word alone.

**Scope.** Shell v2 pages. The v1 shell's pages keep the `warm` `EmptyState`, the `fill` / `inline` `QueryErrorState` and their existing layouts until they move under shell v2; this rule is not a reason to restyle a v1 page.
