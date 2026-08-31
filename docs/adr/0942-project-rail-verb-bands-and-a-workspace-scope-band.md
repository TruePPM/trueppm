# ADR-0942: The project rail is three verb bands and one scope band

## Status

Accepted (2026-08-30)

> **Supersedes [ADR-0128](0128-v2-grouped-view-bar-health-cluster.md) §A's `PEOPLE`
> group and its standalone leading/trailing views.** Amends
> [ADR-0195](0195-methodology-adaptive-sprint-group.md) §A′ (band membership; the
> methodology conditional itself is **retained unchanged**),
> [ADR-0203](0203-rename-view-group-sprint-to-deliver.md) (the Schedule-in-Deliver
> placement opt-in it set up is retired), [ADR-0139](0139-customize-views-per-user-nav-visibility.md)
> (hideability stops being derived from band membership), and
> [ADR-0180](0180-unified-today-split-view.md) (`today` now leads the tracking
> sequence rather than the band). Reaffirms
> [ADR-0127](0127-v2-context-bar-shell-slice-2.md) Decision D against a design brief
> that contradicts it. Route segments are untouched (rule 108 / [ADR-0030](0030-p3m-navigation-shell-split.md)).

This ADR ships **no code**. #3136 implements the taxonomy; #3137 retires the
Schedule-in-Deliver preference. It exists because the change contradicts three
Accepted ADRs, and a contradiction that is resolved in an implementation MR is
resolved where nobody will find it again.

It also closes **#3138** (§9).

## Context

**P3M layer: Programs and Projects.** Single-project chrome, no cross-project
surface — **OSS**, unambiguously. `enterprise-check` is not close: this is the
navigation of one team's own working surface. The Apache-2.0 boundary is untouched
(`packages/web/src` contains no import of `trueppm_enterprise`).

The 0.4 design review replaces the project rail's grouping with a taxonomy the
brief states in one line: *three verb bands in lifecycle order, every item a noun,
plus a ruled-off `WORKSPACE` band that is a different kind of thing rather than a
lower-ranked fourth band.* The taxonomy is good. The problem is that three Accepted
ADRs say otherwise, one of them in the exact grammatical terms the brief uses
against it, and a fourth is contradicted by the accompanying design frames.

### What ships today

`packages/web/src/features/shell/methodologyTabs.ts` composes the rail:

```
overview                            STANDALONE_LEADING  — no band label, unhideable
PLAN      schedule · grid · calendar
DELIVER   product-backlog · sprints · board       (AGILE/HYBRID only — ADR-0195)
TRACK     today · risk · reports · activity · assets     (+ board on WATERFALL)
PEOPLE    resources
settings                            STANDALONE_TRAILING — no band label, unhideable
```

`Sidebar.tsx` is the sole presentation (`ViewTabs` was deleted with the top-bar
strip in #1643); `useGroupedProjectViews.ts` is the single composition path both
the rail and the ⌘K palette read.

### The four conflicts, each verified against this tree

**1. ADR-0128 §A justifies `PEOPLE` in the brief's own vocabulary, inverted.**
ADR-0128:89-92 records the group as deliberate: *a one-item group whose label is the
category the golden standard reserves for people/workload surfaces, kept now because
it is cheaper than re-teaching the IA when a second people-surface lands.* ADR-0195
reaffirms it in all three of its per-methodology tables (:100, :111, :121) and
ADR-0203:48 carries it forward. The brief's stated reason for retiring it — "PLAN
and TRACK are verbs; PEOPLE is a noun" — is the direct inverse of ADR-0128's
reasoning, and a grammatical argument is symmetric: either premise can be conserved
by changing the other term. Grammar cannot settle this, so §5 does not use it.

**2. ADR-0203 set up a shipped preference that "one home per item" retires.**
ADR-0203 answered *"should `schedule` also appear under Deliver?"* with **no, by
default**, and routed the opt-in to #1645. That opt-in shipped:
`groupedVisibleViewsForUser(methodology, hiddenViews, scheduleInDeliver)`
(`methodologyTabs.ts:170-200`) appends `schedule` into DELIVER **while leaving it in
PLAN**, backed by `UserProfile.schedule_in_deliver`
(`apps/profiles/models.py:117`, default `False`), exposed read-only on the
current-user payload (`apps/access/serializers.py:519,620`) and writable on the
profile endpoint (`apps/profiles/serializers.py:20,42,94-96`). "One home, and the
mode does the work" cannot be adopted while an item can be in two bands at once.

**3. ADR-0195's methodology conditional is load-bearing and the brief omits it.**
ADR-0195:47-70 argues that `board` cannot statically move: on AGILE/HYBRID it is the
execution state of the current iteration and belongs with the cadence circuit; on
WATERFALL, where `sprints` and `product-backlog` are hidden by ADR-0041, it is a
plain kanban and belongs in TRACK. Both static options were rejected there as
WATERFALL regressions. The brief's taxonomy carries no conditional at all.

**4. The design brief's collapsed frames contradict ADR-0127, and say so.**
ADR-0127:4 records the founder ratification of Decision D — collapse is
**hidden (0px)**, not an icon rail — :93 records that this *supersedes* the 60px
icon rail, and :115 lists the 60px alternative as rejected. `Sidebar.tsx:247`,
`:310-313` and `:438-439` implement it (`inert` + `aria-hidden` when hidden). The
brief draws icon-only collapsed frames and flags the conflict itself without
resolving it.

### The structural trap under all of it

```ts
export const HIDEABLE_VIEW_KEYS: ReadonlySet<string> =
  new Set(VIEW_GROUPS.flatMap((g) => g.views));   // methodologyTabs.ts:156
```

Hideability is **derived from band membership**. `overview` and `settings` are
unhideable today purely because they stand outside every band —
`methodologyTabs.ts:149-155` and `apps/profiles/constants.py:9-17` both state the
requirement, and the server rejects an unknown key in `hidden_views` with a 400. The
new taxonomy puts **both** inside bands. Under the current derivation that silently
makes both user-hideable, diverging the web vocabulary from the server's frozen one
and destroying the ADR-0030/0139 guarantee that a user's nav can never be emptied.
The brief does not solve this and does not claim to.

Mobile already got this right and is the precedent §6 generalizes:
ADR-0196 composes the BottomNav's reachable set as
`(filters ∩ …) ∪ {overview} ∪ {settings}` — an explicit union, not a derivation —
and deliberately does not inherit desktop band order at all.

### Corrections to the brief's stated current state

The design bundle's "current state" column is written from memory. Two claims are
wrong in this tree and were verified before being relied on:

- **"Table was the Schedule grid renamed and is already deleted" is false.**
  ADR-0053 consolidated the legacy **Table** and **WBS** views into `grid`, which is
  live: `router.tsx:563` serves `/projects/:id/grid`, and `:583-584` redirect the
  legacy `wbs` and `list` segments to it. Nothing here is deleted; there is one
  consolidated view with two legacy redirects.
- **The bands drawn in the brief are illustrative, not exhaustive.** `today`
  (ADR-0180), `reports`, `activity` (ADR-0201) and `assets` (ADR-0215) are all TRACK
  members; the last two postdate the mockup entirely.

## Decision

### 1. The taxonomy

```
PLAN       schedule · grid · calendar
DELIVER    product-backlog · sprints · board            (AGILE/HYBRID only)
TRACK      overview · today · risk · reports · activity · assets    (+ board on WATERFALL)
──────────────────────────────────────────────────────  full-bleed rule
WORKSPACE  resources · settings                          pinned, raised, outside the scroll
```

`STANDALONE_LEADING` and `STANDALONE_TRAILING` are retired as concepts. **Every
view is a band member.** Route segments are unchanged.

### 2. A band has a *kind*: `verb` or `scope`

This is the extensible definition, and it is deliberately about the container rather
than the contents:

> A **verb band** is a labelled group inside the rail's scrolling flow. A **scope
> band** is a container the rail's flow *ends at* — a full-bleed rule, a raised
> ground, and items outside the scroll region. Everything else about it — type,
> weight, color, height, icon, active state — is identical to a verb band, on
> purpose.

The corollary is the load-bearing half: **the distinction is never carried by
contrast, size, weight, or opacity.** Each of those means "less important" in DS
v1.0 and three of them mean "unavailable". WORKSPACE is not less important — a
self-hoster lives in Settings in week one. It is *elsewhere*, and the rail says
elsewhere by changing the floor, not by fading the furniture.

Consequences that follow from the definition rather than from a rule list:

- The scope band's position is `margin-top: auto`, never a function of how many
  bands sit above it. Drop DELIVER, rename everything, add a band — the footer does
  not move.
- The role-context lens (ADR-0162) re-orders **within verb bands only**. A scope
  band's order is fixed: it is not a workflow, so there is no workflow to re-point.
- A band whose members are all filtered out by methodology, personal hides, or role
  renders nothing — no label, and for a scope band no rule and no raised ground
  either. This is the existing empty-band rule (ADR-0128 §A) applied unchanged, and
  it is reachable: `resources` is gated to Scheduler+, so a Member's WORKSPACE band
  is Settings alone.

### 3. One home per item, per render — and `schedule_in_deliver` is removed

A nav item listed twice is two objects to the person using it. **Every view appears
in exactly one band in any given render.** #3137 removes the preference outright:
the model field and its column, both serializer fields, the profile-services prefs
tuple, the web hook and the ViewsMenu toggle, and the corresponding
`docs/api/openapi.json` entries.

Removed, not deprecated to a no-op. A boolean that still round-trips and is read by
nothing is precisely the dead-control class this codebase already carries scars
from: it is documented, it echoes back, and it lies to every API and MCP client
about what the product does. At pre-1.0 alpha, with a display-only field that no
rollup, report, export, schedule computation, or webhook reads, the honest option is
deletion and a `400` on a stale write.

**The changelog fragment must name the field.** `changelog.d` offers only
`added`/`changed`/`fixed`/`security`, so a deletion flattens into a generic
"changed" a consumer skims past. The fragment for #3137 names
`schedule_in_deliver` explicitly and states the new PATCH behavior. Adding a
`removed` fragment type is a real gap and is out of scope here.

**The cost is named, not waved off.** #1645 existed so a phase-gated, sprint-blended
program could show the plan where the delivery squad works. After this, PLAN sits
directly above DELIVER and that need is served by adjacency and one hop — weaker
than the opt-in. If that friction is reported by real users, the answer is **not** to
restore a duplicate: it is band order, or a pinned/recent affordance that is
explicitly a shortcut rather than a second home.

### 4. The taxonomy stays methodology-adaptive

ADR-0195 §A′ is **retained in full**. DELIVER exists only for AGILE and HYBRID;
`board` sits in DELIVER for those and in TRACK on WATERFALL.

The obvious objection — that a methodology-dependent band contradicts §3 — does not
hold. §3 forbids an item being in two bands **in one render**. `board` is in exactly
one band for any given project. Those are different claims and only the first is a
usability problem.

**`calendar` stays in PLAN**, against the brief's `DELIVER = Board · Sprints ·
Calendar`. The brief's placement is not a preference question, it is a defect:
`HIDDEN_FOR_METHODOLOGY` hides only `sprints` and `product-backlog` on WATERFALL, so
`calendar` is visible there — and WATERFALL has no DELIVER band. Moving `calendar`
into DELIVER deletes it from the WATERFALL rail outright.

### 5. `PEOPLE` is superseded — and the reason is not grammar

ADR-0128 §A's `PEOPLE` group is retired. Not because it is a noun; that argument is
symmetric and settles nothing. It is retired because **the bet it rested on is
falsifiable and has been falsified**: ADR-0128 kept a one-item group open for a
second people-surface, and fourteen months later `views: ['resources']` is still one
item, with no second people-surface in 0.4 or 0.5. A reserved category that never
filled is a label the reader has to account for, indefinitely.

`resources` moves to WORKSPACE because Team and Settings answer the same kind of
question — *who and how is this project set up* — rather than naming a lifecycle
step. The grammatical regularity the brief noticed is a **consequence** of that
taxonomy, not its justification.

**Where a future people-surface lands** — the rule, so this is not re-litigated per
surface. Classify by the question the surface answers, and prefer co-location over
category:

- It answers *"who is on what"* — capacity, workload, allocation, a project heat map
  → **WORKSPACE, beside Team.** An existing surface already answers that question;
  a second home for the same question means two "who's on what" numbers to
  reconcile by hand. Co-location beats category.
- It answers *"when does the work land"* — resource-loaded dates, leveling effects →
  that is a property of the schedule, and it renders **inside the Schedule surface**,
  not as a sibling rail item in PLAN.

Cross-program leveling and the cross-portfolio heat map are Enterprise and are not
in scope for either branch.

### 6. Hideability is an authored vocabulary, not a derivation

This is the structural concept the WORKSPACE band needs, and it is **not** a fourth
`ViewGroupId`. Band membership and hideability are decoupled:

- `HIDEABLE_VIEW_KEYS` becomes an **authored literal set**, no longer
  `VIEW_GROUPS.flatMap(…)`.
- `ALWAYS_ON_VIEW_KEYS = { overview, settings }` is its authored complement.
- Invariants, asserted by tests rather than by a comment:
  1. the two sets are disjoint;
  2. every band member is in exactly one of them — so a view added to a band can
     neither silently become hideable nor silently become un-customizable;
  3. `HIDEABLE_VIEW_KEYS` equals the server's `apps/profiles/constants.py` set.

Invariant 3 is the one with no gate today: `constants.py` asks in prose to "keep the
two lists in sync", and prose is what let this become derivable in the first place.
The mechanism is a single checked-in vocabulary file that **both** a pytest and a
vitest assert against, so drift fails a pipeline in whichever language introduces it.

No server change. `apps/profiles/constants.py` is untouched — which is the point, and
is exactly what ADR-0203 established when it noted the server vocabulary is keyed by
*view*, never by group.

Band structure stays **client-only**. The rail is presentation; the server's
band-agnostic view vocabulary is the contract, and promoting bands to a server fact
would freeze a layout decision into an API for no consumer that exists.

### 7. Labels: one rename adopted, one rejected

- **`overview` → "Dashboard". Adopted.** "Overview" named a *position* — the thing
  at the top you arrive at. Once it is the third band's first member that name is
  simply wrong, and an item called "Overview" sitting inside TRACK is worse than
  either the status quo or the rename. Key/label divergence is not a new class here:
  `sprints` already renders the workspace's configured iteration term (ADR-0111/0116)
  through the same `labelFor` seam, so the shell has shipped divergence by design
  since 0.2.
- **`grid` → "Scope". Rejected.** `grid` is not moving; it stays in PLAN exactly
  where it is, so nothing in the taxonomy makes "Grid" wrong, and the rule "every
  item is a noun" is already satisfied. Against that, "scope" is a live, overloaded
  term in this product's own vocabulary — sprint scope, scope creep, scope injection
  (ADR-0102) — and it would land on a leaf a contributor clicks rather than a band
  header they scan past. A rename with no structural forcing function and a known
  collision is not worth its churn. Revisit only if a real report names "Grid" as
  unclear.
- **`resources` keeps "Team". Rejected the brief's "People".** That label was the
  retired band name being carried down onto its one member. "Team" is already a
  noun, already correct, and already in the specs, docs, and ⌘K palette.

### 8. `overview` leads TRACK; `today` follows it

ADR-0180 placed `today` at the head of TRACK when the band's alternative head was
`board` or `risk`; it did not contemplate the landing surface joining the band. The
landing route leads its own band. `today` leads the tracking sequence proper,
immediately after it — which also makes the desktop head order match mobile's, where
ADR-0196 already fixes `overview` first and `today` second (the #1324 guarantee).

### 9. Timesheet is not in the project rail — this closes #3138

The brief's `TRACK = Dashboard · Risks · Timesheet` has no third member here.
`me/timesheet` is a **cross-project** weekly entry surface (ADR-0224); there is no
project-scoped timesheet route. TRACK is Dashboard · Today · Risks · Reports ·
Activity · Assets.

Of the three options #3138 sets out, this ships no new surface and tells no lie about
scope. A rail entry that navigates out of project scope would break the rail's whole
contract — an item is the thing you land on *within this project* — and is the class
`packages/web/CLAUDE.md` rule 283 reserves `ExternalLinkIcon` for. A project-scoped
timesheet route remains a possible follow-up on its own merits; it is not part of
this.

### 10. The rail collapses to 0px. The brief's collapsed frames are dead spec

ADR-0127 Decision D holds unchanged: collapsed means **the rail is not there** —
0px, `inert`, `aria-hidden` — and ⌘K remains the fast jump. The design bundle's
icon-only 64px frames are **not to be implemented**, now or later. Nothing else in
the bundle depends on them; the rule and the raised ground are simply never seen in
the collapsed state.

What survives from that section is its *reasoning*, which still applies to the phone
drawer: at 44px rows with labels present, the same container treatment carries the
distinction.

### 11. Accepted design input, with two corrections

Recorded as the visual contract for #3136:

| Part | Scope band |
|---|---|
| Separator | full-bleed 1px `chrome-border/25`, run past the rail's 8px inset — the rail's **only** rule, so it means exactly one thing |
| Ground | `chrome-surface-raised` — 1.10:1 light, 1.14:1 dark; lifts in both themes, no theme-specific override |
| Band label | identical to a verb band, every value |
| Item row | identical, minus the trailing health-dot slot |
| Active state | identical, spine included — "you are here" is one vocabulary |
| Scroll | outside the scroll region; the rule gains a 6px inset shadow once scrolled |
| Position | `margin-top: auto`, capped `max-height: 40%` with its own scroll |

Tokens: **the `chrome-*` ramp**, not the `neutral-*` one — `chrome-surface`,
`chrome-surface-raised`, `chrome-border`, `chrome-text-primary`,
`chrome-text-secondary`, `brand-primary`. **`neutral-text-disabled` is banned from the
band** — the rejected alternatives (dimming, shrunk label, bordered card) each encode
rank or unavailability, and dimming at `opacity:.5` is literally how this app draws a
disabled control.

> **Correction (2026-08-30, #3136).** This table originally named the `neutral-*`
> tokens. That was wrong, and wrong in a way that silently disarmed the whole
> mechanism: the rail is painted `chrome-surface`, and `--chrome-*` / `--neutral-*` are
> two independent ramps (`packages/web/CLAUDE.md` rule 8a), so `neutral-surface-raised`
> on `chrome-surface` measures **1.01:1 in light theme** — no lift whatsoever — while
> reading as a real lift in dark (1.27:1). §2's "the rail says elsewhere by changing the
> floor" would not have fired for any light-theme user, and no dark-mode screenshot
> would have shown it. The implemented band uses `chrome-surface-raised` (**1.10:1**
> light, **1.14:1** dark) with a `chrome-border/25` rule. The generalization is now
> `packages/web/CLAUDE.md` rule 365.

> **Amendment (2026-08-31, #3268).** The correction above was recorded but the table
> was left as written, so the contract a reader scans still named the wrong ramp while
> the prose underneath it disagreed — and the #1413 checklist panel, specified into the
> same rail from the same bundle, inherited `neutral-surface-raised` from the table
> rather than from the correction. The **Ground and Separator rows are now amended in
> place**; this note is kept so the original error stays on the record. Anything else
> rendered *inside* the rail takes the `chrome-*` ramp for the same reason — the
> container it lifts off is painted `chrome-surface`.

**Correction A — the a11y mechanism.** The finding is adopted: one `<nav>` landmark,
and a scope band is a labelled group rather than a second landmark. The bundle's
proposed `<h3>` + `aria-labelledby` is **not** adopted. `Sidebar.tsx:1440-1442` ships
`role="group"` + `aria-label={`${label} views`}` with the visible header
`aria-hidden`, which satisfies the same requirement without double-reading (rule
172/171) — and pointing `aria-labelledby` at a visible uppercase header would
reintroduce exactly the uppercase-read problem the next correction is about.

**Correction B — the uppercase invariant is real, its stated mechanism is not.** The
bundle credits this codebase with sentence-case-in-DOM plus uppercase-in-CSS.
`Sidebar.tsx:1442` renders `{group.id}` — the DOM text is literally `"PLAN"`. It is
safe because that header is `aria-hidden="true"` and the accessible name comes from
the band's sentence-case `label`. So the invariant to carry through the retaxonomy,
as a regression guard, is: **the visible band header is `aria-hidden`, and every
band's accessible name is its sentence-case label** — never an uppercase string, and
never the configurable iteration term (ADR-0203 §12 invariant #5).

### 12. What this ADR does not decide

Named unknowns, carried forward rather than closed:

- **Whether the rail is how anyone actually navigates**, versus ⌘K, bookmarks, and
  deep links. Every judgment above about relearning cost and label churn assumes the
  rail is read. If it is mostly not, the whole severity ordering inverts. Nothing
  available today answers this; the in-product feedback link (#2392) and the first
  real self-hoster sessions will.
- **Whether a naming collision is a first-week cost or a permanent one.** §7's
  rejection of "Scope" assumes it is not merely absorbed by muscle memory. Teams
  routinely absorb worse.
- **Whether any real integration writes `schedule_in_deliver`.** A display-only
  preference is a plausible target for a "set every profile field" onboarding
  script. `SELECT COUNT(*) … WHERE schedule_in_deliver = true` was not run: the only
  instance available is a dev database seeded with our own demo data, so the answer
  would measure our seeds, not adoption.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Adopt the taxonomy; WORKSPACE is a typed scope band and hideability becomes an authored vocabulary** (chosen) | Every view has one home and one band; `overview`/`settings` keep their guarantees by an explicit rule instead of by standing outside the structure; the server contract is untouched; matches how mobile (ADR-0196) already composes its set | Supersedes an Accepted ADR's group and retires a shipped preference; the always-on guarantee now rests on a test rather than on structural impossibility |
| Add `WORKSPACE` as a fourth `ViewGroupId` and leave the derivation alone | One-line change | Silently makes `settings` (and `overview`) user-hideable, diverges the web vocabulary from the server's, and the server 400s on the resulting write. This is the trap, not a shortcut past it |
| Keep `overview`/`settings` standalone and add WORKSPACE for `resources` only | Smallest diff; no hideability question at all | A one-item scope band, and a rail whose bottom is a band *plus* a loose row — the "different kind of thing" reads as an inconsistency instead of a category. Re-creates the one-item-group problem §5 just retired |
| Keep `PEOPLE` and add WORKSPACE beside it | No superseded ADR | Two bands for two items, one of which has been waiting fourteen months for a second member; the rail gains a band and loses nothing |
| Drop the methodology conditional, as the brief's taxonomy implies | Three verbs on every project; simplest thing to describe | Either a "Deliver" band containing only `board` on WATERFALL, or `board` leading PLAN on a Gantt-first project — both rejected with reasons at ADR-0195:47-70. This is the WATERFALL regression that ADR is about |
| Keep `schedule_in_deliver` as an ignored no-op field | No client breaks on a stale write | A documented, writable field that changes nothing — the exact dead-control class the tree already carries, and a lie to every API/MCP client |
| Adopt "Scope" for `grid` as the brief specifies | Matches the handoff verbatim | Collides with sprint scope / scope creep / scope injection in this product's own vocabulary, on a leaf item rather than a scanned header, with no structural forcing function behind it |

## Consequences

**Easier.** One rule answers "where does this view go" — lifecycle step or project
scope — instead of a group list plus two standalone exceptions. The scope band's
`margin-top:auto` makes the rail's footer independent of everything above it, so
later band changes cannot move it. Decoupling hideability from band membership means
a view can be added to any band without touching the customization vocabulary, and
drift from the server now fails a pipeline instead of a code review. The taxonomy
gains a stated extension rule (§5) that a future capacity surface can be checked
against rather than argued about.

**Harder.** The always-on guarantee for `overview` and `settings` is now a rule
enforced by tests rather than a structural impossibility; if invariant 6.2 is ever
deleted, the failure is silent until a user empties their own nav. #3136 carries real
churn — `Sidebar.tsx`, `methodologyTabs.ts`, `useGroupedProjectViews.ts`,
`ViewsMenu.tsx`, `viewMeta.ts`, `features/me/ViewVisibilitySection.tsx` — and every
band-name and label assertion under `packages/web/src/**/*.test.*` and
`packages/web/e2e/`. The `Overview` label alone appears across 38 e2e spec files.
**Sweep by quoted literal *and* by regex locator** (`{ name: /overview/i }`, usually
case-insensitive, which a case-sensitive literal grep misses twice), and update every
match in the same commit as the source change.

**Risks.** Retiring `schedule_in_deliver` is irreversible in practice and its uptake
is unknown and unknowable today (§12); the mitigation is that the need it served is
adjacent-band, one hop, and the recorded response to a real complaint is a shortcut,
not a restored duplicate. Moving the landing route's row from first in the rail to
third band down costs relearning, bounded by unchanged URLs and unchanged ⌘K. The
"Dashboard" rename widens an existing key/label divergence rather than opening a new
class, but it does widen it.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: **web** (taxonomy, #3136), **api** (the `schedule_in_deliver`
  removal only, #3137)
- Migration required: **yes**, one — dropping `UserProfile.schedule_in_deliver`
  (#3137). Trivial `RemoveField`; no data to preserve, no constraint added, so the
  constraint-safety gate does not apply.
- API changes: **yes**, one — `schedule_in_deliver` removed from the current-user
  payload and the profile PATCH endpoint. Regenerate `docs/api/openapi.json`. The
  changelog fragment names the field explicitly (§3). Band structure stays
  client-only; no endpoint is added.
- OSS or Enterprise: **OSS** (`trueppm-suite`).

Contract for #3136, so it does not have to be re-derived:

1. `ViewGroupDef` gains `kind: 'verb' | 'scope'`; `STANDALONE_LEADING` /
   `STANDALONE_TRAILING` are removed.
2. `HIDEABLE_VIEW_KEYS` becomes an authored literal with `ALWAYS_ON_VIEW_KEYS` as its
   complement, and the three invariants of §6 are tests.
3. The lens (ADR-0162) applies to `kind: 'verb'` bands only.
4. The band header stays `aria-hidden`; the accessible name stays the sentence-case
   `label` (§11 correction B).
5. Only `VIEW_TAB_META.overview.label` changes ("Overview" → "Dashboard"). `grid`
   and `resources` labels are unchanged. No route segment changes.
6. Do not implement the design bundle's collapsed icon frames (§10).

### Durable Execution

1. **Broker-down behaviour:** N/A — no async side effects. The taxonomy is client-side
   presentation; the only server change is a field removal on a synchronous PATCH.
2. **Drain task:** N/A — no new category of async work.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A — no dispatch path. Composition stays in
   `useGroupedProjectViews.ts`, the single client path both the rail and the ⌘K
   palette already read.
5. **API response on best-effort dispatch:** N/A — the profile PATCH remains
   synchronous and returns the updated profile.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** N/A for tasks (there are none). The migration is idempotent by
   Django's own applied-migrations ledger.
8. **Dead-letter / failure handling:** N/A — no task can fail. A client PATCHing the
   removed `schedule_in_deliver` receives a `400` naming the unknown field, which is
   the intended, visible failure (§3) rather than a silent no-op.
