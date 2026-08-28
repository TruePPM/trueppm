# `design_handoff_trueppm_v4` beta-1 review — five items that must NOT be implemented as written

> **Design decision record (#3139, extended by #3133 and #3127).** This file reconciles the beta-1 review of the
> `design_handoff_trueppm_v4` bundle against the Schedule as it actually shipped.
> **Where this file and the review disagree, this file wins.** Each item below was
> decided against deliberately, and until now the reasoning lived only in a source
> comment — which is not where the next person reading the handoff will look.
>
> Nothing here is a general invariant, so nothing here is a `packages/web/CLAUDE.md`
> rule and nothing here takes a rule number. It is a standing correction to an
> upstream document the repo does not own.

The v4 bundle is an external Claude Design deliverable; it is not mirrored into this
repo. It is cited by name from `packages/web/CLAUDE.md` rules 302 / 309 / 327 / 328 / 329,
from ADR-0776, ADR-0843, and ADR-0844, and from several source files. Items 1–4
below come from its beta-1 UX review pass, not from the bundle's own spec pages;
item 5 is from the bundle's own build order.

**Two of the first four would regress accessibility if applied literally. One teaches a
keystroke that does something else. The fourth would delete a value sighted users have
no other way to read. The fifth would strand every project a user creates outside the
aggregates, because it builds the way *into* a state before the way out of it exists.**
All five would pass every gate in the pipeline, because each is a change the code has no
way to recognize as wrong.

---

## 1. `F8` — the review names the wrong key

**Review, UX-REVIEW §1:** *"`F8` is unchanged."*

**It is not.** `F8` / `Shift+F8` is **"next / previous unresolved `@owner` token"**,
shipped by #2727 and specified in [ADR-0776 §3](../../../adr/0776-schedule-authoring-key-contract-completion.md)
("F8 'unresolved' = an unresolved `@owner` token"). #2724 later extended the predicate
to also catch rows a paste-many could not resolve a duration for. The unscheduled walk
— "next / previous row that still needs a committed date" — is **`F7` / `Shift+F7`**,
shipped by #2733.

The handoff predates #2727 and never learned the key was taken.

Where this is stated in source:

| What | Where |
|---|---|
| The `F8` binding and its predicate | `packages/web/src/features/schedule/ScheduleView.tsx:3623-3642` |
| The `F7` binding, and the comment recording the divergence | `packages/web/src/features/schedule/ScheduleView.tsx:3658-3673` |
| The `F8` predicate asserted end to end | `packages/web/e2e/schedule-paste-many.spec.ts:211-226` |

`ScheduleView.tsx:3663-3665`:

> *F7 rather than the F8 the design handoff names: F8 is already "next unresolved
> @owner" (#2727, ADR-0776 §3), shipped and in the cheatsheet. The handoff predates it.*

**Do not** rebind `F8` to the unscheduled walk, and **do not** copy "F8 is unchanged"
into a beta doc, a release note, or the in-app cheatsheet. Two shipped keys would
collide, and the one users would lose is the one ADR-0776 wrote a whole section for.

---

## 2. Deleting the 3px mode gutter would regress WCAG 1.4.1

**Review, UX-REVIEW §2 item 7:** remove the `GATED` chip **and** the mode gutter.

**The chip half is already done, and for the reason the review gives.** `gated` is the
baseline row mode and draws neither mark:
`packages/web/src/features/schedule/deliveryModePresentation.ts:196-198` (`isModeVisible`
returns false for `gated`), with the module docstring at `:12-18` stating why — *"A
gated plan of 400 rows would otherwise carry 400 identical chips, which is noise, not
signal — the shape of a hybrid is legible precisely because the non-default branches
are the ones that draw."* No further work is needed on that half; treat item 7's chip
paragraph as satisfied, not outstanding.

**The gutter half must stay.** Two independent reasons:

**(a) It is the non-color half of a WCAG 1.4.1 pair.**
`packages/web/src/features/schedule/RowModeIndicators.tsx:8-15`:

> *Two marks carrying one fact, so it survives a color-vision deficiency and a
> monochrome print (WCAG 1.4.1): a 3px gutter at the row's left edge, and a text chip
> beside the task name. The timeline's bar texture (`drawDeliveryModeMark`, #2727) is
> the third. None of them is load-bearing alone.*

Delete the gutter *and* the chip and the delivery mode survives only as the timeline's
bar texture — off-screen for any row scrolled out of the timeline viewport, and absent
entirely from the outline the review is talking about.

**(b) It is load-bearing geometry, not decoration.** `packages/web/CLAUDE.md` **rule 309**
("The Schedule row's far-left edge is spoken for twice — a third row-level meaning goes
at the indent origin, not there") builds the entire Schedule left-edge stacking contract
on the gutter existing:

- the row's `border-l-2 border-brand-primary` encodes **selection**;
- `ModeGutter`'s absolutely-positioned 3px stripe at `left-0` encodes **delivery mode**,
  deliberately stacked just inside the selection border rather than replacing it
  (`RowModeIndicators.tsx:17-28`);
- because those two are taken, containment was routed to the **indent origin**
  (`(level - 1) * WBS_INDENT + 8`) instead — which is what makes a phase's band edge and
  its children's deepest depth guide land on the same x.

That last identity is machine-pinned by
`packages/web/src/features/schedule/RowContainmentChrome.test.tsx` (*"the edge and the
guide are one line"*). Removing the gutter does not free the edge; it invites the next
change to move containment back to `left-0`, which silently invalidates the identity
rule 309 exists to protect.

**Do not** delete `ModeGutter`. If the outline genuinely needs to be quieter, the lever
is `isModeVisible`'s baseline (which modes draw at all), not the mark itself.

---

## 3. Removing the `⇥` lesson re-breaks #3020

**Review, UX-REVIEW §2 item 8:** the `⇥` lesson is taught twice; remove one.

**It is taught zero times as a keystroke.** The coach bar's indent line teaches
`formatChord('alt+ArrowRight')` — `packages/web/src/features/schedule/buildMode/ScheduleCoachBar.tsx:34`
— and the doc comment above it at `:19-32` records why:

> *`⌥→`, not `⇥` (#3020). Tab is bound to nothing and deliberately so: binding it
> reproduces the WCAG 2.1.2 keyboard trap fixed in #2192/#2727 (ADR-0776 §6, and
> `TaskListRow`'s `tryBuildModeIndent` doc comment). A chip naming a dead key is worse
> here than on any other surface — this bar's entire justification is that discovery was
> hover-dependent, so a user who tries the key it teaches and gets nothing concludes the
> feature is broken rather than the hint.*

The footer add-row (`packages/web/src/features/schedule/ScheduleAppendTaskFooter.tsx:64-89`)
teaches no keystroke at all — it renders a `+` glyph and its `label` token, nothing more.
So there is no second lesson to remove.

**The one surviving `⇥` is not a keystroke.** The coach bar's third line reads
`+ ⇤ ⇥ ◆` (`ScheduleCoachBar.tsx:36`) — those are the row's **button glyphs** on hover,
which is the design's own chosen notation. `ScheduleCoachBar.tsx:27-31` calls this out
explicitly, and the distinction is machine-enforced by
`packages/web/src/features/schedule/scheduleTeachingChords.test.tsx` under
`packages/web/CLAUDE.md` **rule 326(d)**: a `<kbd>` chip is a keystroke claim and must
resolve against the registered bindings; prose is a claim only when it carries a modifier
glyph. The test has a case named *"leaves the row-control glyph run alone — those are
buttons, not keys"* precisely so a future guard does not demand a wrong "fix" to a right
string.

**Do not** bind `Tab` on a focused Schedule row, and **do not** delete the `⌥→` lesson as
a duplicate. Applying item 8 literally re-introduces the WCAG 2.1.2 keyboard trap that
#2192 / #2727 fixed and #3020 caught a second time.

---

## 4. A progress bar and its own numeral are one readout, not a duplication

**Review, UX-REVIEW §8.4:** *"Board lane header reads `4 items · rolls up 62%` and then
draws the same bar. Same double-statement pattern as §2."*

**Rejected (#3133, closed wontfix).** §2's duplications are one value rendered on two
*surfaces* — a rail and a view bar, a context bar and a forecast strip — which can drift
apart, disagree, and leave the reader to reconcile them. A bar and its own data label are
one value on two *channels* of a single readout: both derive from the same `pct` in the
same 188px row, so they cannot diverge. `packages/web/CLAUDE.md` **rule 284** governs the
first case and not the second, and it is not being widened to cover it.

The change was implemented and measured before being rejected, which is what settled it:

- The bar is `flex-1` beside a variable-width task count, so **a 55% lane can draw a
  longer fill than a 60% lane**. Harmless while the numeral disambiguated; with the bar as
  sole carrier, lane-to-lane comparison becomes meaningless.
- A `title` tooltip cannot restore the figure. With `aria-label` already supplying the
  accessible name, `title` falls through to the accessible *description* — Chromium
  reports `{name: "Phase progress 55 percent", description: "55%"}`, announcing the number
  twice. That is the very duplicate the change existed to remove, reintroduced in the
  accessibility tree, and it has no touch affordance on a touch-primary surface.
- Net effect: assistive-tech users keep the value via `aria-valuenow`, and **sighted users
  lose it entirely**. That inverts the usual equity direction for no gain.

Four of the nine `role="progressbar"` components in the tree render this pattern
(`LaneMeta`, `EpicHeader`, `SchedulePulse`, `SubtasksSection`). If a future change does
decide a bar owns its percentage alone, it is a **class** change under **rule 300** — settle
the rule, add a check that counts the population, watch it fail against `origin/main`, give
the bar a fixed width so lanes are comparable, and convert all four. It is not four point
fixes; rule 284 is itself the artifact of point-fixing this class once already, in #2424.

**Do not** delete a progressbar's numeral on its own.

---

---

## 5. "Written as a `draft` on the first keystroke" — right idea, wrong mechanism, and blocked on the way out

**Handoff, case 01/02:** *"The project is written as a `draft` on the first keystroke,
so leaving is free and returning is exact."*

**The user value is real and should ship. The mechanism must not, and the server half
cannot ship before the commit affordance (#3129).** Two separate findings; the second
is the blocking one.

### (a) The draft state is a door with no way out until #3129 lands

`commit_project()` (`apps/projects/commit_moment.py`) is the **only** legal
`draft → active` transition, and after #3127 it is the only *possible* one. It has no
caller in the web app — that is #3129's entire scope, and it is still open. So a
create-as-draft path landing first would put every newly created project into a state
nothing in the product can leave.

That is not a cosmetic wait. A draft is excluded — deliberately, by #2962/#3128 — from
program rollup, portfolio health, the Programs directory count, omni-search, the
cross-project dependency picker, My Work, the notification fan-out, the digest
audience, the nightly forecast-floor capture, and the program schedule pass. A beta
user's first project would be authored normally and then be invisible in search, absent
from their program's rollup, and silently unable to notify the people assigned to it,
with no control anywhere that explains or reverses it.

**Sequencing rule: #3129 ships before, or in the same MR as, any create-as-draft path.**
The dependency runs in the opposite direction from the one #3127 records ("depends on
the exclusion-list gap landing first" — #3128, which did land). Nothing in the tracker
noticed the second dependency, because the way *in* and the way *out* were filed as
separate issues and only the way in names the lifecycle.

### (b) "On the first keystroke" mints junk that reaches outside the product

Even with #3129 shipped, the *first-keystroke* half should not be implemented as
written. `perform_create` on `ProjectViewSet` is not a cheap row insert: it creates an
Owner `ProjectMembership`, writes a `project_created` audit event, allocates a
`HistoricalProject` row and a sync sequence, broadcasts `project_created` over the
board WebSocket, and dispatches a **`project.created` webhook to every subscriber**.
Firing that on keystroke one means an abandoned Start sheet delivers a real webhook,
naming a one-character project, to a customer's integration endpoint.

It also accumulates. Drafts are excluded from aggregates but are explicitly *not*
hidden from a direct read or from the project list a member browses
(`apps/projects/lifecycle.py`), so every abandoned sheet leaves a visible row. The
model docstring names a 7-day resume window, but nothing sweeps and nothing should:
a job that deletes projects a user can see is a far worse thing to add to a beta than
the problem it solves.

**What to build instead:** the sentence's actual promise is that the *sheet's* state
survives leaving, which does not require a `Project` row at all. Persist the Start
sheet's in-progress fields client-side, restore them on reopen, and expire them on the
same 7-day window the model already names — no server row, no webhook, no sweeper, and
the resume window becomes a property of something that can honestly expire. That is a
different interaction from the one the handoff describes, so it owes a `ux-design`
pass and the rule-217 unsaved-changes contract in `packages/web/CLAUDE.md` before it is
written; it is **not** covered by this file and is not implemented yet.

**Do not** add a create-as-draft write path while #3129 is open, and **do not** call
`POST /projects/` from a keystroke handler.

## If you are writing a spec from the v4 handoff

Cite this file. The five corrections above are invisible to the bundle, invisible to
CI, and — for items 1 and 3 — invisible to any test of the control being changed, which
is exactly why they are written down here rather than left in a comment.

Related records: ADR-0776 (§3 `F8`, §6 `Tab`/`Alt+→`), ADR-0801 (delivery-mode encoding),
`packages/web/CLAUDE.md` rules 309, 326, 328.
