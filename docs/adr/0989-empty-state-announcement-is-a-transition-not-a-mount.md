# ADR-0989: An empty state announces a transition, not a mount — and speaks through one persistent region

## Status

Accepted (2026-09-01). Amends the announcement half of web-rule 177 and the
`role="status"` premise that web-rules 224 and 246 reason from. Implements #3198;
the requirement originates in the `handoff-0.4-1413-3135` design bundle, item **E4**.

## Context

`components/EmptyState.tsx` has carried `role="status"` on its own container since
#1171. Two independent defects follow from that single attribute, and they are not
the same defect stated twice.

**1. The region enters the accessibility tree together with its text.** A live
region is specified to announce *mutations* of a region already in the tree. A
node mounted with its content in the same commit is announced inconsistently
across assistive technologies — this project already wrote that down as web-rule
335, after #2914 hit it on a reconciliation surface, and `RouteAnnouncer`
(`components/RouteTitle.tsx`, #2200/#2203) already solved it with a permanently
mounted region. `EmptyState` was never brought in line.

**2. It fires on mount, and mount is not the event anyone wants announced.** The
interesting event is the transition *into* empty. Mount is a strictly larger set:
clearing a filter, switching projects, and a plain route change all remount the
component with no user-facing news. A screen-reader user moving between two empty
surfaces hears the same sentence twice; a user editing a filter that leaves the
surface empty hears the state restated when nothing changed.

The second defect is the one that cannot be fixed inside the component at all. A
component can observe only its own mount, and its own mount is the *same event*
whether the surface just became empty or was already empty before a remount. The
two are distinguishable only by what else is on screen across a settle boundary,
which no single instance can see.

### The multi-instance case is the strongest one, and it is not an onboarding concern

A Board with four empty columns mounts four `EmptyState`s in one commit and fires
four announcements. This has nothing to do with the first-run brief the
requirement arrived in, which matters because #1413 declined to take E4 on the
grounds that a shared a11y contract should not be changed on the strength of a
first-run brief. That reasoning was right and is why #3198 exists separately; it
was never an argument that the defect is small.

### Three documented rules derive from the attribute being moved

This is why the change is not component-internal. Verified in
`packages/web/CLAUDE.md`:

- **Rule 177** specifies the anatomy as *"a `role="status"` block"* and justifies
  the decorative icon on the grounds that *"the `role="status"` + title carry the
  announcement"*. Move the role and that justification no longer closes.
- **Rule 246** builds the surface-state trio on it — widget fetch error → polite
  in-place `QueryErrorState`; empty data → calm `EmptyState`; route throw →
  assertive self-focusing `errorElement`. Its `inline` variant is deliberately
  `role="status"` *"so a total outage does not fire N assertive announcements"* —
  the same N-announcement problem, solved there by **politeness** rather than by
  **relocation**. That tension has to be answered, not inherited.
- **Rule 224** uses the contrast as its justification for focus behavior: an
  `errorElement` self-focuses because it is `role="alert"`, *"whereas `EmptyState`
  is `role="status"` (polite) and does not"*.

## Decision

**(a) `EmptyState` carries no role and no live region.** Its `<h2>` stays a real
heading, reachable by heading navigation; its icon stays decorative. It gains a
`data-testid="empty-state"` so specs that scoped on the removed role have a stable
handle (rule 242's re-anchor recipe).

**(b) One persistent polite region for the whole app**, `EmptyStateAnnouncer`,
mounted once and permanently in `AppShell` and rendered empty. Messages are
injected into a node already in the tree, satisfying rule 335.

**(c) A module-level registry owns the transition.** Every mounted empty surface
registers its heading (`useEmptyStateAnnouncement`). After a settle window the
registry compares the live title set against the set at the previous settle and
speaks **the first title present now that was absent then** — or nothing.

That one predicate is the whole contract, and each arm falls out of it rather than
being special-cased:

| Situation | Live set change | Spoken |
|---|---|---|
| First render of an empty surface | `{} → {A}` | `A` |
| Remount at unchanged emptiness (route change, project switch) | `{A} → {A}` | — |
| Empty → populated | `{A} → {}` | — |
| Populated → empty | `{} → {A}` | `A` |
| Filter edit leaving the surface equally empty | `{A} → {A}` | — |
| N blocks empty at once | `{} → {A,B,C,D}` | `A` only |
| Navigating from one empty surface to a *different* one | `{A} → {B}` | `B` |

**(d) The settle window is 500ms**, and it is load-bearing twice: it coalesces N
simultaneous registrations into one announcement, and it spans the dip to empty
that a route change produces when the old instance unmounts before the new one
mounts. Without it, every route change between two equally-empty surfaces would
read as populated→empty and re-announce — the defect, reintroduced.

**(e) Politeness stays `polite` and the spoken text stays the heading only.**
Reading the orientation copy aloud on every empty transition is too much, and an
assertive empty state would interrupt.

**(f) The bespoke empty states web-rule 177 licenses route through the same
registry** — `GridFilteredEmptyState` and all three `MyWorkEmptyState` flavors
carried the identical `role="status"`. Leaving them would make the amended rule
177 contradict the code, which is precisely the drift `packages/web/CLAUDE.md`
exists to prevent.

**(g) The region clears itself on mount.** The store is module-level and outlives
the shell: `AppShell` unmounts on logout and whenever a throw reaches the
`RequireAuth` net. Without a session reset the remounted region would enter the
accessibility tree already holding the previous session's sentence — this ADR's
own defect, wearing stale text. The reset drops the message *and* the settled
set, so the new session is not deafened either: an equally-empty surface must
announce again for the user who just logged in, because for them it is news.
Found by the `ux-review` gate on this branch, not by the suite.

**(h) Zero call-site changes.** The ~30 surfaces that render `EmptyState` keep
their JSX exactly as written, and nothing about the visual anatomy, tokens,
spacing, entrance animation, or reduced-motion handling moves.

## Consequences

**Rule 246's tension is answered, not inherited.** `QueryErrorState`'s `inline`
variant keeps `role="status"` and keeps solving its N-announcement problem with
politeness. The two are no longer the same shape and the trio's third member is
now described by what it *is*: a calm zero-data view that announces once, through
the shell, on becoming empty. Rule 224's contrast survives with its terms
restated — `errorElement` is assertive and self-focuses; an empty state is polite,
does not take focus, and now also does not repeat itself.

**A single region is a deliberate narrowing of "per surface".** E4 asked for a
persistent region per surface. One app-level region satisfies every acceptance
criterion, and is strictly better for the multi-instance case: there is no second
region to race the first. The cost is that two genuinely unrelated surfaces cannot
announce simultaneously — which is the coalescing behavior E4 asked for anyway.

**Announcement is now testable as announcement.** The registry emits, so specs
count emissions rather than reading the region's text. That distinction is not
academic: the first version of this suite asserted text, passed nine of nine, and
**also passed with the freshness check mutated to announce unconditionally** —
i.e. it was green against the exact defect being fixed. Text is identical whether
or not a redundant announcement fired. Three mutations are recorded in the spec
file's header for whoever changes this next.

**What this does not do.** It does not give a surface a way to announce anything
but its heading, does not touch loading or error states, and does not make
`EmptyState` a landmark. A surface needing richer announcement should own its own
region rather than widening this one.

## Alternatives considered

**Keep `role="status"`, suppress with a mount-time guard inside the component.**
Cannot work: the component cannot distinguish "just became empty" from "was
already empty" — that information exists only across instances.

**Key suppression on a caller-supplied surface id.** Requires touching ~30 call
sites, and gets the two-empty-surfaces-same-sentence case wrong, since identity
would live in the prop rather than in what is actually spoken.

**Move the role to each host surface.** Thirty regions, thirty chances to mount a
region with its own text, and the Board's four columns still announce four times.
This is the option rule 335 already rejects in general form.
