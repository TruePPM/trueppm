# ADR-0909: Timeline Enter-to-create parity — the two bindings already had homes

## Status

Accepted — 2026-08-25, implemented by #2784 in the same MR (verified: the `Enter`
branch in `packages/web/src/features/schedule/ScheduleAriaOverlay.tsx`, the
`authoringActive` gate in `packages/web/src/hooks/useKeyboardReschedule.ts`, and the
`authoring` / `canEditRow` props threaded through `CanvasScheduleTimeline`; covered by
the `#2784` block in `ScheduleAriaOverlay.keyboard.test.tsx` and two browser-level specs
in `e2e/schedule-build-mode.spec.ts`).

For 0.4, child of epic #2741 (Project Designer). Closes the question ADR-0776 §7 deferred
and ADR-0810 split out.

## Context

ADR-0776 §7 shipped the `Enter` / `Shift+Enter` / `⌘+Enter` row-creation trio on the
**Grid outline only**, and deferred Timeline parity with an explicit reason:

> Timeline parity for Enter-creates-a-row … is a genuinely separate design question
> (where do "open drawer" and "reschedule" go on the Timeline once Enter is reassigned?)
> that deserves its own resolution rather than an ADR-in-passing.

That framing was right at the time and is why nothing was decided in passing. It also
contains the assumption this ADR overturns: that **two** bindings needed new homes.

The Timeline's canvas bars (`ScheduleAriaOverlay`, `role="listbox"` / `option` per
ADR-0776 §8) bind `Enter` → open the task drawer (#2205, WCAG 2.1.1 consistency with the
outline rows and the canvas double-click) and `Shift+Enter` → start a keyboard reschedule.
Both are tested and load-bearing.

**What changed since ADR-0776 was written is that both answers arrived on their own.**

1. **#2979 established `Alt+Enter` as "open the details of this thing"** on
   `TaskListRow` — the outline sitting a few inches to the left of this canvas, on the
   same screen — for *exactly* this reason, and its source comment reasons it out in full:
   plain `Enter` inserts a row in build mode, `Shift`/`⌘`+`Enter` insert above/child, `F2`
   renames, a bare letter types into the Name cell, so no unmodified key is free.
   `BacklogListRow` carries the same binding. It is the platform's own convention.
2. **`r` / `R` has been the reschedule key since #2205**, as a single-key alias for
   `Shift+Enter`. Reschedule never needed relocating — it already had a home that is not
   Enter-based.

So the deferred question had one binding to rehome, not two, and the product had already
answered it on the sibling surface.

## Decision

### 1. The Enter family on a focused bar follows *authoring*, exactly as it does on an outline row

| Keys | Authorable row | Not authorable |
|---|---|---|
| `Enter` | insert sibling **below** | open the drawer *(unchanged, #2205)* |
| `Shift+Enter` | insert sibling **above** | start keyboard reschedule *(unchanged)* |
| `⌘/Ctrl+Enter` | insert **child** | — |
| `Alt+Enter` | open the drawer | open the drawer |
| `r` / `R` | keyboard reschedule | keyboard reschedule |
| `Space` | select | select |

**Outside build mode nothing changes at all.** That is deliberate and is what keeps the
blast radius of this change to authors: a viewer, and an editor who is simply not in build
mode, get precisely the bindings #2205 shipped. The pattern "Enter's meaning follows build
mode" is not new either — `TaskListRow` has behaved that way since #2727.

One inconsistency is left standing rather than papered over: outside build mode, `Enter` on
an outline row toggles selection while `Enter` on a bar opens the drawer. That predates
this issue, and unifying it means changing a shipped, tested binding on a surface #2784 was
not asked to touch. It is named here so the next reader knows it was seen and not missed.

### 2. `Alt+Enter` opens the drawer — adopted, not invented

The one thing this ADR had to choose, and it chose the answer already in the codebase
twice. Before this change `Alt+Enter` opened the drawer in the outline and did nothing over
the bar, two panes of one screen apart. Parity here **removes** an inconsistency rather
than trading one for another.

It also applies in *both* modes, not only while authoring. A binding that appears and
disappears with build mode is one a user cannot build a habit on, and there is nothing
`Alt+Enter` would otherwise mean on a read-only bar.

### 3. Reschedule stays on `r`; `Shift+Enter` merely stops being its second trigger

No relocation, no new key, no announcement of a moved shortcut — because nothing moved. The
`Shift+Enter` alias drops out *while authoring* only.

### 4. The gate is a flag on `useKeyboardReschedule`, because `preventDefault` cannot express it

The row insert happens in the overlay's React handler **on the bar**;
`useKeyboardReschedule` listens **on `document`**, fires after it in bubble order, and keys
off the *selection* rather than the event target. Without a gate, one `Shift+Enter` would
insert a row and start a reschedule on the previously-selected task.

`defaultPrevented` is not available as the discriminator: the working `Shift+Enter` path
already calls `preventDefault()` today and this listener still initiates — that interplay is
pinned by `ScheduleAriaOverlay.keyboard.test.tsx` and is load-bearing. So the hook takes an
explicit `authoringActive` input and drops `Shift+Enter` from its initiation set when it is
set. `r` / `R` is unconditional.

`ScheduleView`'s `useKeyboardReschedule` call moved below the role resolution to compute
that flag — still unconditional, still stable in position across renders.

### 5. The gate is per row on `canEditRow`, NOT on `authoring != null`

`BuildModeProvider` is mounted for **every desktop user, viewers included**
(`buildModeActive = !isMobile`), so a non-null build-mode API is not an entitlement check.
This exact trap already shipped once: the Timeline's context menu offered a viewer Indent,
Duplicate and Delete over the bar track while the outline correctly offered them nothing
(web rule 302 — absence, not a control that refuses). The trio therefore resolves through
the same per-row `canEditRow` the outline's own row menu uses, threaded down rather than
re-derived, and the prop defaults to *deny* so a host that forgets to pass it gets the safe
answer.

### 6. The announcements move with the keys

Both the static grid help (`#schedule-grid-help`) and `rescheduleHint`'s polite live message
are mode-aware. `rescheduleHint`'s own docstring already warned that a divergence from
`tryInitiate` "either advertises a shortcut that does nothing or hides one that works" —
leaving it announcing "Shift+Enter to reschedule" while authoring would have been precisely
that, one mode over.

## Consequences

- The Grid and the Timeline now share one authoring key contract. A planner who learns the
  trio in the outline does not have to learn that the canvas is different.
- `Shift+Enter` is overloaded across modes on one surface. Mitigated by the announcements
  above and by `r` working identically in both, so the reschedule habit never breaks.
- `useKeyboardReschedule` gains an input it must be told about. A future caller that forgets
  it gets today's behavior (`authoringActive = false`), which is the safe default — but a
  second authorable canvas surface would need to pass it.
- Not addressed here: the outline's non-build-mode `Enter` (toggle selection) versus the
  bar's (open drawer). See §1.

## Alternatives considered

**Move reschedule to a new chord and keep `Enter` = open.** This is what ADR-0776 §7
anticipated, and it is strictly worse now: it relocates a tested WCAG 2.1.1 binding to solve
a problem `Alt+Enter` already solves, and it would leave the canvas and the outline
disagreeing about how to open a task.

**Enter creates on the bar unconditionally.** Rejected — it takes `Enter` = open away from
viewers, who cannot create anything, in exchange for nothing.

**Mirror `TaskListRow` exactly, including its non-build `Enter` = toggle selection.**
Rejected as a gratuitous regression of #2205 on the read-only path, which is out of scope
for this issue and would need its own WCAG argument.

**Gate on `authoring != null`.** Rejected: it is not an entitlement check, and shipping it
would re-create the viewer bug described in §5.
