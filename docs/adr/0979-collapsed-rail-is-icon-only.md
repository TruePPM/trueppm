# ADR-0979: The collapsed rail is icon-only (64px), superseding the 0px hide

## Status

Accepted (2026-08-31) — founder decision. **Reverses** [ADR-0127](0127-v2-context-bar-shell-slice-2.md)
Decision D (RATIFIED 2026-06-14, "0px hide") and [ADR-0942](0942-project-rail-verb-bands-and-a-workspace-scope-band.md)
§10 ("The rail collapses to 0px. The brief's collapsed frames are dead spec", Accepted 2026-08-30).

> This ADR carries the burden of argument, not the status quo. ADR-0127 did not *forget*
> to consider an icon rail — it considered one, rejected it explicitly (ADR-0127:115,
> "Collapse = 60px icon rail kept"), and directed that MR !607 (#1176) be closed as
> superseded rather than merged. ADR-0942 §10 then re-affirmed the 0px reading fourteen
> days before this reversal, having seen the design bundle's icon-only frames and declined
> them "now or later". Reversing two settled records requires answering their reasoning,
> which §Decision does below, rather than restating a preference.

## Context

ADR-0127 Decision D made collapse a two-state model: **expanded (248px) / hidden (0px)**,
with a persistent re-open `≡` in the shell bar and ⌘K as the power-nav jump. Its stated
rationale is three sentences long and specific:

> ⌘K already covers fast jump-to, so the icon rail is redundant; **0px maximizes canvas
> (Sarah/Alex VoC)** and gives a clean two-state model.

ADR-0942 §10 inherited that and hardened it: the design bundle's 64px icon-only frames
were named **dead spec**, and implementation checklist item 6 read *"Do not implement the
design bundle's collapsed icon frames."*

The contradiction between those records and the shipped design bundles was surfaced as
**Q1** by the ADR-verification pass over `handoff-0.4-1413-3135/ADR Verification.html`,
which flagged it rather than absorbing it. The founder answered on 2026-08-31: **icon-only.**

### What is actually true in the tree today (verified on `main` @ 2026-08-31)

- `stores/shellStore.ts:136-137` — `selectSidebarWidth(state: ShellState): 0 | 248`. The
  return type is **literally `0 | 248`**, so this is a typed contract change, not a
  constant swap.
- `stores/shellStore.test.ts:53-63` — pins both arms of that union.
- `features/shell/Sidebar.tsx:446-447` — `aria-hidden={hidden || undefined}` and
  `inert={hidden || undefined}`. Both come off under icon-only, and every row inside
  becomes reachable.
- `features/shell/Sidebar.tsx:255` (docblock) and `:318` (the `inert` rationale comment)
  both assert the 0px contract **in prose**, so both are wrong the moment code changes.
- Auto-collapse below `lg` currently *hides*. Under icon-only it *shrinks*. ADR-0127
  changed this in the other direction; this ADR reverses it again.

## Decision

**The collapsed rail is icon-only at 64px.** It is a live, focusable navigation landmark,
not an absent one. `selectSidebarWidth` becomes `64 | 248`.

### 1. Rebutting ADR-0127's "0px maximizes canvas (Sarah/Alex VoC)"

This is the strongest of the three and it is **not** rebutted on the evidence — it is
**accepted as a cost**. The VoC finding has not changed and is not being reinterpreted:
maximizing canvas was, and remains, a persona-grounded win for Sarah and Alex. No new
panel was run for this ADR, and none should be cited as if it had been.

What changed is the weighting. Icon-only takes **64px of canvas back on every surface,
permanently** — on a 1440px design width that is 4.4%, and the rail was already yielding
184px of the 248. The decision is that permanent ambient orientation is worth 64px, and
that the surfaces with a genuine full-bleed need are few enough to be served by a
dedicated mechanism (§3) rather than by the global collapse state. That is a judgement
about trade weight, and it is recorded here as one so a future reader can reverse it
knowingly.

### 2. Rebutting "⌘K already covers fast jump-to, so the icon rail is redundant"

This conflates two jobs. ⌘K is **navigation**: it answers "take me to X" for a user who
already knows X exists and can name it. The icon rail is **ambient orientation**: it
answers "where am I, what else is there, and is anything waiting for me" for a user who
is not currently asking a question. A zero-width rail cannot answer any of the three,
and ⌘K cannot answer them either, because a palette that must be summoned is by
construction unavailable to someone who does not yet know what to summon.

The redundancy claim would hold if the rail's only function were jump-to. It is not:
the rail also carries **band structure** (ADR-0942's verb/scope taxonomy) and **state**
(active item, and any count or status mark a band item renders). Those survive at 64px
and vanish at 0px. So the two are complements, not duplicates, and ⌘K remains the fast
path exactly as ADR-0127 and ADR-0942 §10 both state.

### 3. Rebutting the clean two-state model — and what replaces full-bleed

The two-state model was genuinely simpler, and this ADR gives that up. **Collapse no
longer reclaims the full width**, so any surface that relied on collapse-to-0px for a
truly full-bleed canvas can no longer get one that way.

The candidate is **the Schedule at export width**. If that need is real it wants its own
mechanism — a focus/present mode that suppresses all chrome, not a global nav state
doing double duty. That mechanism is **explicitly out of scope here** and is not a
blocker for this ADR; it is called out so the next person to want it does not
re-litigate collapse. Filed as follow-up (§Implementation Notes).

### 4. #1176's premise returns; #1176 itself does not

ADR-0127 Decision D closed **#1176** ("keep Resources catalog icon in the collapsed
rail") as superseded, and directed !607 closed rather than merged. Amending to icon-only
**reinstates its premise** — there are icons in the collapsed rail again — so the ADR
must say whether that specific icon comes back. It does not, as a special case.

Under ADR-0942 the rail's contents are an **authored taxonomy** of verb and scope bands
(§§1–2, §6), and hideability is authored vocabulary rather than derivation. The collapsed
rail therefore renders **the taxonomy's own items at icon size** — whatever ADR-0942 says
belongs in the rail is what appears, in taxonomy order. Resources appears if and only if
the taxonomy places it there. #1176's outcome is achieved as a consequence of the
taxonomy rather than as a hand-picked exception, which is the form that will not drift
the next time the taxonomy changes.

### 5. The accessibility contract changes — and it is a different contract, not a better one

Today the collapsed rail is an `inert`, `aria-hidden` subtree: it is genuinely **not
there** for every user, and that symmetry is the current contract's one virtue.

At 64px it becomes a **live navigation landmark**:

- items keep their `aria-label` and their tab stop;
- band headings stay in the DOM, visually hidden, so a screen-reader user's traversal is
  **identical collapsed and expanded**;
- `inert` and `aria-hidden` come off (`Sidebar.tsx:446-447`).

This is arguably better than what it replaces — a screen-reader user currently loses the
entire rail on collapse. But it must be recorded as a **change of contract**: "collapsed"
stops meaning "not there", the tab order grows by the rail's item count in a state where
it previously grew by zero, and every focus-order test that assumed the collapsed rail
was skippable now asserts the wrong thing.

### 6. The `≡` toggle stays

ADR-0127 made the persistent re-open `≡` **non-negotiable** precisely because nav could
otherwise be "lost" at 0px. At 64px nav is never lost, so the rescue rationale expires —
but the control stays, **re-characterised as a toggle rather than a rescue**. Removing it
would leave expand-from-icon-only with no explicit affordance, and the cost of keeping it
is one button in a bar that already renders it.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Keep 0px (status quo, ADR-0127 D + ADR-0942 §10)** | Maximum canvas; clean two-state model; symmetric a11y (absent for everyone); already shipped and tested | No ambient orientation; rail structure and state invisible; screen-reader users lose the rail entirely on collapse; contradicts the shipped design bundles |
| **Icon-only 64px (chosen)** | Ambient orientation preserved; band structure and state survive collapse; a11y traversal identical in both states; matches the design bundles | Costs 64px of canvas permanently; ends full-bleed-by-collapse; typed contract, `inert`/`aria-hidden` and focus-order tests all change; reverses two Accepted records |
| **Icon-only, but `aria-hidden` retained** | Keeps today's a11y symmetry and a smaller diff | Incoherent: a visible, pointer-clickable 64px nav that is invisible to assistive tech is a WCAG 4.1.2 defect, not a compromise. Rejected outright |
| **Three states (0 / 64 / 248)** | Serves full-bleed *and* ambient orientation | Re-introduces the complexity ADR-0127 removed, and a tri-state toggle has no obvious control affordance. The full-bleed need is better served by an explicit focus mode (§3) |

## Consequences

**Easier.** Orientation without a round trip through ⌘K. Screen-reader parity between
collapsed and expanded. The shipped design bundles and the ADR corpus stop contradicting
each other, which is the condition #3269 exists to end.

**Harder.** 64px less canvas everywhere, forever. Full-bleed needs a separate mechanism.
The collapsed rail is now a live surface that must be designed, tested, and kept
accessible in a state that previously needed none of that.

**Risks.** (1) The focus-order change is the easiest thing to get wrong and the least
likely to be caught by a passing test suite — the existing tests assert the *old*
contract and will keep passing against a wrong implementation until they are updated
deliberately. (2) At 64px an icon without a visible label leans entirely on `aria-label`
and tooltip; ADR-0942's taxonomy was authored with labels present, so icon legibility for
each band item is an open implementation question, not a settled one.

## Implementation Notes

- P3M layer: Programs and Projects / Operations (shell chrome, all layers)
- Affected packages: `web`
- Migration required: no
- API changes: no
- OSS or Enterprise: **OSS**

**Scope guard.** This ADR is the record only. **No code moves in the MR that lands it.**
[#3136](https://gitlab.com/trueppm/trueppm/-/issues/3136) **is not** the implementation
issue — it implements ADR-0942 and must not implement anything collapsed-specific;
shipping icon-only frames against an Accepted ADR that forbade them is precisely the
state #3269 exists to avoid. The implementation issue is
[#3279](https://gitlab.com/trueppm/trueppm/-/issues/3279).

Two items deliberately **not** decided here, to be resolved by that issue:
1. Per-item icon selection and legibility for every ADR-0942 band item at 64px.
2. The full-bleed / export-width focus mode (§3) — a distinct mechanism, distinct issue.

### Durable Execution

Not a feature ADR — no async work, no persistence, no dispatch. Answered N/A with cause:

1. Broker-down behaviour: **N/A** — client-side layout state only; nothing is enqueued.
2. Drain task: **N/A** — no task.
3. Orphan window: **N/A** — no task.
4. Service layer: **N/A** — no server call. State lives in `stores/shellStore.ts`.
5. API response on best-effort dispatch: **N/A** — no endpoint.
6. Outbox cleanup: **N/A** — no outbox row.
7. Idempotency: **N/A** — `toggleSidebar` is a pure state flip; repeat application is
   the user toggling, which is intended.
8. Dead-letter / failure handling: **N/A** — no failure path; the rail renders from
   local state and cannot fail partially.
