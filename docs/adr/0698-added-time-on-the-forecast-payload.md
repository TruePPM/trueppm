# ADR-0698: Added time rides the forecast payload, and is derived at read time — never cached

## Status

Accepted — status corrected 2026-08-02 after ADR audit (#2685, verified: `apps/scheduling/views.py`, `risk_premium.py`, web `types/index.ts`). 

## Context

#2483 promoted the schedule risk premium ("added time") to a first-class project fact. The
server half is complete and correct: `scheduling/risk_premium.py` owns the six-state machine
(`not_run` · `unmeasurable` · `stale` · `zero` · `premium` · `negative`), evaluated in an order
whose whole purpose is that a *structural* zero — a project with no three-point estimates, which
simulates flat and therefore yields exactly 0 days — can never fall through into the good-news
presentation. `ProjectOverviewView` calls `build_risk_premium(latest_run, today=…)` and emits
eight `risk_premium_*` keys; `features/project/addedTime.ts` maps them to one
`AddedTimePresentation` discriminated union; `AddedTimeCard` renders it.

**It renders there and nowhere else.** A user on Schedule, Board or Table has no pointer to
added time at all, and `MobileMonteCarloCard` has no premium reference. The root cause is not a
missing component:

- `AddedTimeCard` reads the **project overview** payload (`GET /projects/{id}/overview/`).
- The shell (`HealthCluster`) and every schedule surface read the **Monte Carlo** payload
  (`GET /projects/{id}/monte-carlo/latest/`), which carries `cpm_finish` and
  `delta_vs_cpm {p50,p80,p95}` — a raw signed day count and **no state discriminant**.

So a context-bar segment built today would have to re-derive state client-side from a day count.
That is precisely the false-all-clear the state machine exists to prevent: an unestimated project
yields `0`, and `+0d` would tell the least-known project in the portfolio that it carries no
schedule risk — not a weaker claim than the truth, the *inverse* of it.

### What the #2483 design handoff actually said, and where it is now stale

The handoff (`handoff-2483`, §1.1 · §4 · §5.1 · §6 · §7 · §8) is the design source. Two of its
sections describe a surface that no longer exists, and the difference is load-bearing:

**§5.1 measures the pre-#1644 segmented cluster.** Its width table — "5 segments ≈ 470px",
"+ `+11d` segment ≈ 575px", "+ qualified pair ≈ 700px", against "640px available at 1280" —
budgets an `inline-flex` strip of five nowrap segments sharing a 56px bar. #1644 (ADR-0128 §B,
rule 109) replaced that strip with **a single status chip**: a dot, the worst-state word, an
`md:`-gated `P80 {date}` fragment, and a caret, opening a portaled `role="dialog"` popover whose
rows are the `healthClusterModel` segments. Rule 109 explicitly forbids reintroducing the
segmented cluster. §5.1's *numbers* therefore cannot be transplanted; its *method* (a
measurement-free budget at 12.5px mono) and its *verdict* (drop rather than un-qualify) can, and
this ADR carries both forward.

**§8's `healthClusterSegments()` / `hc()` does not exist** — grep returns zero hits. It was the
handoff's helper for the deleted strip. Its build contract still has to be honored, but against
the chip-plus-popover reality.

§5.1 also carries an `[ENG]` note recommending `min-width: 0; overflow-x: auto` with a
non-shrinking crumb, "filed separately". That is **#2533**, owned by a concurrent agent. Nothing
in this ADR may require changing the cluster container's min-width, overflow-x, or the breadcrumb
flex behavior.

### The state machine has a time-dependent term, and the forecast payload has a 24h cache

`GET /monte-carlo/latest/` has three branches: a cache hit (a `result_dict` the live-run path
wrote with a **24h TTL**), a from-history read off the most recent persisted `MonteCarloRun`, and
a 404. `risk_premium_state` includes `stale` (age > `STALE_AFTER_DAYS` = 7), and
`risk_premium_ratio` is `days ÷ (cpm_finish − today)`. Both terms depend on *when the response is
built*, not on when the run happened. Whether a premium can be safely frozen into a 24h cache
entry is the sharpest correctness question in this issue, and it is answered in the Decision.

**P3M layer:** Programs and Projects — one project's forecast. No cross-project or portfolio
aggregation. Squarely **OSS**.

## Decision

**Option A.** The eight `risk_premium_*` keys ride the Monte Carlo result payload, on both
`POST /api/v1/projects/{id}/monte-carlo/` and all three branches of
`GET /api/v1/projects/{id}/monte-carlo/latest/`, produced by the same
`scheduling/risk_premium.py` code the overview calls — and **derived at response-build time,
never written into the cache**.

Option B (have the shell fetch the overview payload) is rejected in Alternatives.

### 1. `risk_premium.py` gains a values-level entry point; `build_risk_premium` delegates

`build_risk_premium(run, *, today)` takes a `MonteCarloRun` model instance. The live MC run path
has no persisted run in hand at response-build time — it builds a `result_dict` and *separately*
calls `_persist_mc_run_if_authorized`, which writes a row only for Scheduler+. So the module is
refactored into three layers, with **no change to the state machine itself**:

```python
def risk_premium_from_values(
    *,
    p80: datetime.date | None,
    cpm_finish: datetime.date | None,
    taken_at: datetime.datetime | None,
    diagnostic: dict[str, Any] | None,
    today: datetime.date,
) -> RiskPremium: ...
```

- carries today's `build_risk_premium` body verbatim, including the `None`-run all-null case;
- `build_risk_premium(run, *, today)` keeps its exact signature and delegates. The existing
  `test_risk_premium.py` duck-types `MonteCarloRun` with `SimpleNamespace`, so it stays green
  unchanged.

```python
def risk_premium_for_forecast_payload(
    payload: Mapping[str, Any], *, today: datetime.date
) -> RiskPremium: ...
```

- parses `payload["p80"]`, `payload["cpm_finish"]` (ISO dates), `payload["last_run_at"]`
  (ISO datetime) and `payload["forecast_diagnostic"]`, then delegates to
  `risk_premium_from_values`;
- **tolerates absence.** A key that is missing, `None`, or unparseable is passed through as
  `None`. A legacy cached payload written before `cpm_finish` existed therefore resolves to
  `not_run`, which is the correct read — not a guess.

This is the "reuse, never a second derivation" constraint discharged structurally: there is
exactly one `_premium_state` and exactly one ratio calculation in the codebase, and every caller
reaches them through this module.

### 2. The premium is never cached — it is derived on every response

**This is the answer to the 24h-cache question, and it is required, not merely tidy.**

Two independent reasons, of which the second is decisive:

**(a) The `stale` transition is only accidentally safe today.** `STALE_AFTER_DAYS` is 7 and the
cache TTL is 86 400 s, so a cache entry can never age past one day and `stale` is unreachable
inside the window. That safety is a coincidence of two constants living in two different apps,
bound by no test and no comment. Lower `STALE_AFTER_DAYS` to 1, or raise the TTL, and every
cached payload silently freezes a `premium` that should have flipped to `stale` — presenting an
old verdict as current, the exact failure `addedTimePresentation` already suppresses the band for.

**(b) Freezing `ratio` is wrong *today*, at the current constants.** `ratio = days ÷
(cpm_finish − today)`. `today` advances while the same cache entry is served, so a frozen ratio
drifts within hours; worse, once `cpm_finish` passes `today` the remaining duration is gone and
`build_risk_premium` correctly returns `ratio = None`, while a frozen entry would keep printing a
percentage of a remainder that no longer exists. No choice of `STALE_AFTER_DAYS` fixes this.
Read-time derivation removes the coupling instead of documenting it.

Concretely:

- **Live path (`run_monte_carlo`).** `result_dict` is built and `cache.set` as today, **without**
  premium keys. The response is a *new* dict, `{**result_dict, **premium}` — not an in-place
  mutation of the cached object. (`_persist_mc_run_if_authorized` already establishes
  "response ≠ cached dict" here by adding `run_id` after `cache.set`; this ADR makes the
  separation explicit rather than relying on the cache backend copying on write.)
  `premium = risk_premium_from_values(p80=mc_result.p80, cpm_finish=cpm_finish,
  taken_at=timezone.now(), diagnostic=result_dict["forecast_diagnostic"], today=timezone.localdate())`.
- **Cache-hit branch of `/latest/`.** `risk_premium_for_forecast_payload(cached,
  today=timezone.localdate())`, merged into the response.
- **From-history branch of `/latest/`.** `build_risk_premium(latest, today=timezone.localdate())` —
  literally the call `ProjectOverviewView` already makes, on the same row.
- **404 branch.** Unchanged. No premium keys on a 404 body.

Cost: a pure function over four already-loaded values. No query, no I/O.

### 3. Wire contract — the same eight flat keys as the overview

Deliberately **flat and byte-identical to `/overview/`**, not nested. Two payloads carrying the
same fact under two shapes is how they drift; one shape means `AddedTimeFacts` is literally the
same TypeScript interface on both, with zero mapping divergence.

| Key | Type | Null discipline |
|---|---|---|
| `risk_premium_state` | `"not_run" \| "unmeasurable" \| "stale" \| "zero" \| "premium" \| "negative"` | **Never null.** Always one of the six. This is the discriminant. |
| `risk_premium_days` | `int \| null` | `null` unless both `p80` and `cpm_finish` are known |
| `risk_premium_ratio` | `float \| null` | `null` when `days` is null **or** `cpm_finish <= today` (no remaining duration to normalize against) |
| `risk_premium_band` | `string \| null` | **Always `null`** until #2299 supplies calibrated thresholds. Out of scope here. |
| `risk_premium_as_of` | ISO-8601 datetime `\| null` | `null` when there is no run |
| `risk_premium_reason` | `ForecastReason \| null` | Carried even in measured states, so a consumer can caption a flat-but-real forecast without refetching |
| `risk_premium_cpm_finish` | ISO-8601 date `\| null` | `null` when unknown |
| `risk_premium_p80` | ISO-8601 date `\| null` | **Withheld (`null`) in the `unmeasurable` state** — see the note below |

Absent keys are legal (a legacy cached payload) and map to `notRun` client-side, which
`addedTimePresentation` already handles.

**On `risk_premium_p80` being withheld while raw `p80` sits beside it.** On the overview payload
the withholding reads like confidentiality; it never was. It is a *presentation* control: a flat
run's "P80" is the CPM date wearing a percentile's name, and offering it as a commitment hands
the reader a forecast the simulation never produced. On the MC payload the raw `p80` is
unavoidably adjacent. That is fine and must not be "fixed" by populating
`risk_premium_p80` — the guard is structural on the client (`AddedTimeUnmeasurable` has no
headline and no measured presentation to reach), not a function of key absence.

### 4. Permissions — no new disclosure

| Endpoint | Permission classes |
|---|---|
| `GET /projects/{id}/overview/` | `IsAuthenticated`, `IsProjectMember`, `IsProjectNotArchived` |
| `GET /projects/{id}/monte-carlo/latest/` | `IsAuthenticated`, `IsProjectMember`, `IsProjectNotArchived` |
| `POST /projects/{id}/monte-carlo/` | `IsAuthenticated`, `IsProjectMember`, `IsProjectNotArchived` |

Identical role floor. Further, the premium is derived *entirely* from `p80`, `cpm_finish` and
`forecast_diagnostic` — all three of which the same caller already receives on the same payload.
**Net new disclosure: zero.** This moves a server-owned classification onto a payload whose
inputs the caller already holds; it does not widen any audience.

### 5. The two payloads share a derivation; their *inputs* can differ, and that is bounded

`run_monte_carlo` is `IsProjectMember`, but `_persist_mc_run_if_authorized` writes a
`MonteCarloRun` only for Scheduler+ (#1502). So a Member's run refreshes the `mc_latest` cache
without creating a history row, and `/latest/` can then serve a *newer* run than `/overview/`.

This divergence is **pre-existing** — it already applies to `delta_vs_cpm` vs
`risk_premium_days` — and is not introduced here. It is bounded and self-describing three ways:

1. Same function, same eight keys, so the *derivation* can never differ — only the run.
2. Both payloads carry `risk_premium_as_of`, so which run each reflects is always legible.
3. **The two are never on screen at the same time.** The chip suppresses added time on Overview
   (rule 284, §7 below), and Overview is the only surface that reads `/overview/`. The
   redundancy rule therefore does double duty: it is also what makes the cache-vs-history split
   unobservable.

### 6. Web — one derivation, one presentation, one short-form formatter

**`AddedTimeFacts` moves to `packages/web/src/types/index.ts`** and `addedTime.ts` re-exports it
(`export type { AddedTimeFacts } from '@/types';`), so every existing `from './addedTime'` import
keeps working. This fixes the layering direction: `MonteCarloResult` cannot import from
`features/`, and `addedTime.ts` already imports `ForecastReason` from `@/types`.

**`MonteCarloResult` gains `riskPremium?: AddedTimeFacts`.** The interior stays snake_case,
deliberately and with a docstring saying so: it is the shared wire slice, not a mapped view
model, and keeping it raw is what makes
`addedTimePresentation(result.riskPremium)` type-check against the *same* contract the Overview
uses. `useMonteCarloResult.mapResponse` passes the eight keys through verbatim, `undefined` when
absent.

**`addedTimePresentation` is not touched.** It remains the single derivation. A new *formatter
over its output* is added to `addedTime.ts` — not a second derivation:

```ts
export type AddedTimeShortForm =
  | { kind: 'number'; text: string }          // "+11d" / "−4d"
  | { kind: 'qualified'; text: string }       // "+11d vs Oct 24"
  | { kind: 'needsEstimates'; text: string }  // "needs estimates"
  | { kind: 'worded'; text: string }          // "No added time"
  | null;                                     // nothing to say

export function addedTimeShortForm(
  p: AddedTimePresentation,
  opts: { qualified: boolean },
): AddedTimeShortForm;
```

Rules encoded in it, so no renderer re-decides them:

- `unmeasurable` → `needsEstimates`. **Never `0d`, never `—`** (A4).
- `notRun` → `null`. The chip already says `P80 —`; a second "not run" read is noise.
- `zero` → the worded `presentation.headline` (`No added time`), never `+0d`.
- `stale` → **`null` in short form.** A3 forbids an as-of stamp on the chip, and a stale premium
  rendered without its provenance is exactly "an old verdict presented as current". The honest
  resolution of *no stamp allowed* + *must not read as current* is to not render it on the chip
  at all; it renders in full, with its stamp, in the popover row. **This is a decision the
  handoff did not make** (§4 state 06 says `Strip: +11d · Jul 14`, which A3 forbids); it is
  resolved here in A3's favor because A3 is the invariant and the state-06 caption is an example.
- `premium` / `negative` → `qualified ? "{headline} vs {cpm}" : headline`.

**Amended during implementation (ux-design gate).** The qualified form is
`+11d vs Oct 24`, **not** the `Oct 24 → Nov 4` pair this ADR first specified. The pair
was carried over from the handoff's deleted standalone strip, which had no P80
neighbour; on the chip, `P80 Nov 4` sits two spans to the left, so the pair would print
`Nov 4` twice inside one 34px control. The replacement also carries the *magnitude* —
the value the reader came for, which the pair silently drops — names its baseline
explicitly rather than trusting a route predicate, is ~22px narrower, and matches the
phrasing `useForecastPresentation.baselineClause` already uses for the same gap. The
union also gained a fourth `worded` kind, because `zero → 'No added time'` matched none
of the three originally listed.

### 7. How A1–A4 and S1 map onto the chip-plus-popover reality

This is the mapping the implementer must not have to guess.

| Handoff rule (written for the deleted strip) | Chip-plus-popover realization |
|---|---|
| **A1** number only where a baseline date is on screen; Schedule qualifies via the #2426 dashed CPM chip; Board/Table render the pair | Applies to the **inline chip fragment**. `baselineOnScreen` is a route predicate (§8) — but see the amendment below: it has **no true case**, and Schedule drops the fragment entirely. |
| **A2** if the qualified form does not fit the width budget, drop entirely — never degrade to an unqualified number | Applies to the **inline chip fragment only**. |
| **A3** no band word, no track, no as-of stamp in the strip | Applies to the chip fragment. The popover row may carry the as-of, and does so **only** in the `stale` state, where it is load-bearing. No band, no track, anywhere in the chip or popover. |
| **A4** unmeasurable renders `needs estimates`, never `0d`, never `—` | Applies to **both** the chip fragment and the popover row. |
| **S1** no hue — added time never takes a health colour | Neutral tokens only in both places. Reinforced by rule 172 ("the Forecast segment is NEUTRAL… colour is reserved for the actual at-risk/critical signals"). |

**A4's `.text-info` is rendered as neutral secondary ink, not a new colour.** The handoff
specifies `needs estimates` in `.text-info` (its prototype's `--tp-info`). **No such token exists
in this codebase.** `packages/web/tailwind.config.ts` has zero `info` keys in the `semantic`
palette; `--info` in `globals.css` is a raw chart variable never mapped into Tailwind; and
`--tp-info` appears nowhere at all. (`BurnChart.tsx:156` already uses `bg-semantic-info-bg`,
which therefore emits **no CSS** — the config's own comment warns that "Tailwind silently emits
no CSS for undefined tokens". That is a pre-existing dead class, worth its own follow-up, and not
a precedent to copy.) Adding a fourth semantic colour is a design-system change requiring a
`/brand` pass and AA verification in both modes, and it would put a new coloured signal on a
surface where **S1 and rule 172 both forbid one**. So A4 renders in
`text-neutral-text-secondary`. The discriminating signal is the *words* `needs estimates`, which
is what rule 6 requires anyway — colour was never carrying it. This is a deliberate, recorded
deviation from the handoff's literal token.

**Amended during implementation (ux-review gate): `baselineOnScreen` is empty, and
Schedule drops the fragment.** Schedule was the sole candidate for the bare number,
because #2426 put a dashed `CPM: Oct 24` chip in its forecast row. But the component
that renders that chip — `ScheduleForecastBar` — renders `P80: Nov 4 (+11d)` beside it,
from the same `delta_vs_cpm` the premium is derived from, and it is `hidden md:block
flex-shrink-0` (always visible wherever the `xl:`-gated fragment is). So the one surface
that made a bare number legible was the one surface already printing that number, and an
`Added +11d` fragment there would be the same value twice on one screen with nothing
marking either as authoritative — rule 284's defect, now generalized as **rule 291**.
`addedTimeChipContext` therefore returns a separate `fragment` flag: Schedule keeps the
popover row (behind a click, and the only carrier of `needs estimates` and the stamped
stale read) and loses the inline fragment. `addedTimeChipForm` keeps its
`baselineOnScreen` parameter and its invariant test — the rule is still the right one;
it simply has no true case in this product today.

**The popover row is never dropped.** A2's motive is that an unqualified number is worse than no
number; a dropped *chip fragment* whose qualified value is one click away in the popover does not
trigger that motive. This is also what fixes the issue's actual complaint — "no pointer to it at
all" — at every width, including phones, where the chip fragment never renders (matching the
existing P80 fragment's `md:` gate, #1788). Rule 109 sanctions a breakpoint-gated *fragment*
(it describes the P80 fragment as `hidden sm:inline-flex`); rule 211 forbids two *copies of a
control*, which this is not.

**Rule 284 suppression on Overview.** Both the chip fragment **and** the popover row are
suppressed on Overview. The rule's general form is *"before adding a cell to a summary surface,
grep the surface for the value"*, and `AddedTimeCard` is on that screen — a popover row would be
a second render of the same value on the same screen, which is the whole defect 284 names.
Suppression also covers project settings routes, where `HealthCluster` already returns `null`.

### 8. Route mechanism, named

A pure, unit-tested `pathname → behavior` resolver in the shell, modeled on the existing
`createTargets.ts` precedent (`resolveCreateTargets(pathname)`, whose docstring states the same
intent: *"Pure (pathname in, targets out) so it is trivially unit-tested"*).

`useLocationModel.ts` already owns the shell's view parser — the module-private
`viewSegment(pathname, id, fallback)`, which defaults a bare `/projects/:id` to `overview`. To
keep **one** parser rather than adding a third, `useLocationModel.ts` gains and exports a thin
wrapper:

```ts
/** The active project view for a pathname, or null off a project route. Bare
 *  `/projects/:id` resolves to `overview`, matching the location switcher. */
export function projectViewSegment(pathname: string): string | null;
```

and the new pure module `packages/web/src/features/shell/addedTimeChip.ts` consumes it:

```ts
/** Views that already carry the CPM baseline date on screen (#2426 dashed CPM chip). */
const BASELINE_ON_SCREEN_VIEWS = new Set(['schedule']);
/** Views that render AddedTimeCard themselves — rule 284, one value per surface. */
const ADDED_TIME_OWNED_VIEWS = new Set(['overview']);

export function addedTimeChipContext(pathname: string):
  | { suppressed: true }
  | { suppressed: false; baselineOnScreen: boolean };
```

`HealthCluster` reads `useLocation().pathname` and calls it. `useMatch` cannot be used: the
predicate is a set membership over the view segment, and hooks cannot be called in a loop.

### 9. The A2 width budget as a pure function

`packages/web/src/features/shell/addedTimeChipFit.ts`:

```ts
export function addedTimeChipForm(input: {
  viewportWidth: number;
  siblingCount: number;
  baselineOnScreen: boolean;
  hasP80Fragment: boolean;
}): 'number' | 'qualified' | null;
```

**Measurement-free by construction** — no `offsetWidth`, no `ResizeObserver`, no
`getBoundingClientRect`. This is deliberate: a measuring budget would read the very container
whose min-width / overflow-x rules **#2533** owns, and the two changes would fight. It also
mirrors the existing in-repo precedent for a measurement-free budget,
`truncateWbsPath(path, maxChars)`.

Contract, which is A1 and A2 fused:

1. `baselineOnScreen === false` → the only permitted non-null result is `'qualified'`. If the
   qualified form does not fit, return `null`. **`'number'` is unreachable.**
2. `baselineOnScreen === true` → prefer `'number'`; if even that does not fit, return `null`.
3. Below `md` the caller never consults it — the fragment is breakpoint-gated off and the
   popover row carries the value.

`siblingCount` exists so the function is testable across the range §8.1 names. **The production
call site passes the static worst case** (`RIGHT_CLUSTER_MAX_SIBLINGS`), because every
right-cluster sibling self-gates internally (`TimerChip` only while a timer runs,
`TaskRunIndicator` only when runs are active, `PresenceAvatarStack` only when others are online,
`MethodologyIndicator` only on a collapsed rail) and `HealthCluster` cannot observe which are
mounted without measuring. A fragment that fits sometimes and pushes the breadcrumb other times
is worse than one that renders predictably.

Constants, re-derived against the **current** TopBar (`ml-auto flex shrink-0 items-center
gap-1.5 md:gap-3`, "pinned, never compresses"), taking §5.1's per-control and per-form costs
where they still measure the same thing:

| Constant | px | Derivation |
|---|---|---|
| `BAR_FIXED_CHROME_PX` | 80 | header `px-3` (24) + rail-reopen `w-8` (32) + `gap-2` ×3 (24) |
| `LOCATION_SWITCHER_MIN_PX` | 320 | Program › Project › Leaf at a readable minimum; the only element that can absorb pressure |
| `SIBLING_PX` | 94 | §5.1's measured per-segment cost at 12.5px mono (≈470 ÷ 5), including gap |
| `CHIP_BASE_PX` | 104 | dot (8) + worst-state word + caret + `px-3` |
| `P80_FRAGMENT_PX` | 76 | `P80` label + mono date |
| `ADDED_TIME_NUMBER_PX` | 105 | §5.1: 575 − 470 |
| `ADDED_TIME_QUALIFIED_PX` | 230 | §5.1: 700 − 470 |

`available = viewportWidth − BAR_FIXED_CHROME_PX − LOCATION_SWITCHER_MIN_PX −
siblingCount × SIBLING_PX − CHIP_BASE_PX − (hasP80Fragment ? P80_FRAGMENT_PX : 0)`

At `siblingCount = 5`, `hasP80Fragment = true`:

| Width | `available` | Board / Table (no baseline) | Schedule (baseline) |
|---|---|---|---|
| 1024 | 50 | **drop** | **drop** |
| 1280 | 306 | `qualified` | `number` |
| 1440 | 466 | `qualified` | `number` |

**Why this differs from §5.1's 1280 verdict, and why that is correct.** §5.1 concluded the
qualified pair "does not fit at 1280 with five siblings". It reached that against a health
*strip* costing ≈470px. The chip that replaced it costs 104 + 76 = 180px — the surface got
≈290px cheaper — so more fits now. The constants above are derived, not tuned to reproduce a
predetermined answer; reverse-engineering them to force a drop at 1280 would be exactly the
"tuning constant nobody can defend" that this whole metric's lineage refuses. **The invariant is
what must hold; which width drops is an output.**

**How §8.1's DoD line is satisfied.** "Dropped rather than un-qualified … at 1024 / 1280 / 1440
with five siblings" is a property of the *choice*, not a claim that it always drops. The test
asserts both halves: the invariant (`baselineOnScreen: false` ⇒ result ∈ {`'qualified'`, `null`},
never `'number'`) swept across 320–1920, and the concrete drop at 1024.

### 10. Mobile (§6)

- **`MobileMonteCarloCard` consumes the same premium object** — the DoD item. It renders one
  extra chip after the forecast chips, in **neutral** tokens only
  (`border-neutral-border text-neutral-text-secondary`), never a semantic border like the
  P50/P80/P95 chips (S1). The chip text joins the card's `aria-label`.

  **Amended during implementation (ux-review gate): the chip renders for the
  `unmeasurable` state only.** For every measured state the P80 chip in the same row
  already reads `P80: Nov 4 (+11d)` — the same delta, off the same field — so a second
  copy put one number twice in one row, ~100px apart, and in two different minus glyphs
  (`useForecastPresentation` emits ASCII `-`, `addedTime` emits U+2212 `−`). Rule 291
  again. What the forecast chips structurally cannot say is that there was *nothing to
  measure*: a flat run renders `Forecast: Oct 24 · matches CPM`, which is exactly the
  reassuring misread the `unmeasurable` variant exists to refuse — and that gap is what
  DoD item 8 is actually about. The row already overflows at 320px, so the narrower
  outcome is also the kinder one.
- **`MonteCarloSheet` gains an added-time section, placed first** — above the histogram. §6 asks
  for the sheet "scrolled to the added-time section"; putting it first satisfies that *by
  construction* and removes the scroll plumbing (and its focus fight with the sheet's
  mount-focus on the close button) entirely.
- **The section reuses `AddedTimeCard` verbatim** — the actual Overview component, with `base`
  omitted so the redundant `Forecast →` link does not render. **Amended: `base` is passed
  for `unmeasurable` and `stale`.** `Add estimates →` lands on the grid and
  `Re-run forecast →` is the only path a phone user has to refresh a stale premium at
  all; withholding both left the sheet's two actionable states as dead ends. Every other
  state's action is `Forecast →`, i.e. the screen the sheet was opened from, and stays
  withheld. Reusing the component, not a copy,
  is the strongest available discharge of DoD item 8 ("the same premium object … so the two
  cannot disagree").
- **The `?` requirement is already met.** `AddedTimeCard` mounts `ForecastBasisHelp` →
  `FieldHelp`, a click-triggered **non-modal `role="dialog"`** carrying a real docs link —
  explicitly not a tooltip (`FieldHelp`'s own docblock cites web-rule 121 for why an
  `aria-describedby` tooltip cannot hold a link). No change needed.
- §7.1's "one sentence at the top defining the term" is **already shipped** in
  `ForecastBasisHelp` ("The days between the CPM finish and P80 are **added time** …"). No change.

### 11. `useForecastPresentation` is deliberately not extended

§8's build contract wanted `useForecastPresentation` to return a `premium` object. #2483 shipped
`addedTime.ts` off the overview payload instead. This ADR **keeps `addedTime.ts` as the single
derivation and leaves `useForecastPresentation` untouched.** The reason §8 wanted the premium
there was so forecast-payload surfaces had a source — which §2–§3 now provide directly. Moving
the derivation would churn the Overview, `AddedTimeCard` and their tests for no behavioral gain,
and would put two presentations (`ForecastPresentation` and `AddedTimePresentation`) in one hook.
`MobileMonteCarloCard` calls both functions side by side; each owns its own question.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Premium on the MC payload, derived at read time** (chosen) | `HealthCluster` already calls `useMonteCarloResult` — **zero extra requests** in the shell, and the same object serves `MobileMonteCarloCard`. One server-owned state for every surface, which is §8's stated discipline. Read-time derivation makes the cache question moot by construction | Two payloads now carry the same eight keys (mitigated: same function, identical shape, never co-rendered). `/latest/` grows a small object |
| B. Shell reads the project overview payload | No API change at all | Adds a `GET /overview/` to **every** project route (Schedule, Board, Table) for one chip fragment — an endpoint budgeted at ≤200 ms p95 that aggregates utilization, risks, milestones and task counts. The shell does not fetch it today. Leaves `MobileMonteCarloCard` — which reads the MC payload — still with no source, so §6/DoD 8 would need option A anyway. Fails "no surface decides its own state" for the mobile card |
| C. Premium frozen into the 24h cache entry | One derivation per run instead of per response | Wrong for `ratio` **today** (`today` advances under a live cache entry; a past `cpm_finish` must collapse the ratio to null and a frozen entry cannot). Safe for `stale` only by coincidence of `STALE_AFTER_DAYS = 7` vs an 86 400 s TTL, bound by no test |
| D. Client re-derives state from `delta_vs_cpm` | No API change | The false-all-clear this metric exists to prevent. An unestimated project yields 0 and would render `+0d`. Non-negotiable per the issue |
| E. Nested `risk_premium: {…}` object on the MC payload | Tidier grouping beside `delta_vs_cpm` | Two wire shapes for one fact is how the two payloads drift. Flat + identical means `AddedTimeFacts` is literally the same interface, with no mapping layer to diverge |
| F. Measuring width budget (`ResizeObserver` on the right cluster) | Exact | Reads the container whose min-width / overflow-x rules **#2533** owns — the two changes would fight. Also untestable as a pure function, which §8.1 requires |

## Consequences

**Easier**

- Added time is reachable from Schedule, Board and Table — the issue's headline defect — at every
  width, including phones, at zero additional request cost.
- Every surface reads one server-owned discriminant. No client can re-decide what `0` means.
- `risk_premium_ratio` becomes correct-over-time rather than correct-at-cache-write.
- The MCP forecast tool gains the premium on the payload agents already pull.

**Harder**

- Two endpoints now emit the eight keys. They cannot disagree about the *derivation* (one
  function) but can reflect *different runs* when a Member refreshed the cache without persisting
  a row. Bounded by `as_of` and by rule-284 suppression; documented in §5.
- The width budget is a table of estimated pixel constants with no runtime feedback. If the
  right cluster grows again (it already gained `TimerChip` and `QuickLogTime` since rule 174 was
  written), `SIBLING_PX` / `RIGHT_CLUSTER_MAX_SIBLINGS` must be revisited.
- `HealthCluster`'s `aria-label` changes, and the popover gains a row. Several E2E specs locate
  the chip and dialog.

**Risks**

- *A reader takes the chip's dropped fragment as "no added time".* Mitigated: the fragment is a
  pointer, never the value; the popover row is never dropped, and Overview always carries the
  full card.
- *`ADDED_TIME_QUALIFIED_PX` is an estimate; a long month/year-crossing pair (`Oct 24 → Jan 20 '27`)
  is wider than the constant assumes.* The overrun is absorbed by
  `LOCATION_SWITCHER_MIN_PX`'s headroom, and the container overflow rule lands in #2533.
- *Someone "fixes" the `unmeasurable` state by populating `risk_premium_p80` because raw `p80` is
  adjacent.* Called out in §3; the client guard is structural regardless.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: `api`, `web`
- Migration required: **no** — no model change
- API changes: **yes** — eight additive keys on `POST /projects/{id}/monte-carlo/` and on the
  cache-hit and from-history branches of `GET /projects/{id}/monte-carlo/latest/`. No existing
  key changes type or meaning. No change to `/overview/`
- Schema: **regenerate `docs/api/openapi.json`.** Both MC endpoints declare
  `OpenApiTypes.OBJECT` with prose `description`s that enumerate the payload keys; those strings
  must document the new group and are embedded in the schema. Merge `origin/main` **before**
  running `scripts/export-openapi.sh` (the `api:schema-drift` gate only checks self-consistency).
  The `openapi-schema` pre-commit hook regenerates automatically on any `packages/api/src/` touch
- `packages/web/src/api/types.ts`: **no change** — it carries no Monte Carlo types
- `packages/web/src/types/index.ts`: **yes** — `AddedTimeFacts` moves here; `MonteCarloResult`
  gains `riskPremium?: AddedTimeFacts`
- OSS or Enterprise: **OSS**

### File-by-file

**API**

- `packages/api/src/trueppm_api/apps/scheduling/risk_premium.py` — add
  `risk_premium_from_values` and `risk_premium_for_forecast_payload`; `build_risk_premium`
  delegates. State machine unchanged.
- `packages/api/src/trueppm_api/apps/scheduling/views.py` — `run_monte_carlo`: cache
  `result_dict` without premium keys, return a merged dict. `MonteCarloLatestView.get`: merge on
  the cache-hit branch via `risk_premium_for_forecast_payload` and on the from-history branch via
  `build_risk_premium`. Update both `@extend_schema` response descriptions.
- `packages/api/src/trueppm_api/apps/projects/views.py` — **unchanged**.

**Web**

- `packages/web/src/types/index.ts` — `AddedTimeFacts`; `MonteCarloResult.riskPremium`.
- `packages/web/src/features/project/addedTime.ts` — re-export `AddedTimeFacts`; add
  `addedTimeShortForm`.
- `packages/web/src/hooks/useMonteCarloResult.ts` — wire keys on
  `MonteCarloLatestResponse`; pass through in `mapResponse`.
- `packages/web/src/features/shell/useLocationModel.ts` — export `projectViewSegment`.
- `packages/web/src/features/shell/addedTimeChip.ts` — **new**, `addedTimeChipContext`.
- `packages/web/src/features/shell/addedTimeChipFit.ts` — **new**, `addedTimeChipForm` +
  constants.
- `packages/web/src/features/shell/healthClusterModel.ts` — new segment kind
  `{ kind: 'addedTime'; presentation: AddedTimePresentation }`, appended after the methodology
  segments; `HealthClusterInput` gains `addedTime: AddedTimePresentation | null` (null =
  suppressed). The model stays route-unaware — the caller resolves suppression. The three
  existing methodology shapes are unchanged, so the 15 existing model tests stay green.
- `packages/web/src/features/shell/HealthCluster.tsx` — `useLocation()`; derive presentation from
  `mcResult.riskPremium`; inline chip fragment (breakpoint-gated like the P80 fragment, neutral,
  no band/track/stamp); `AddedTimeRows` case in `SegmentRows` (static row, no drill — the
  Forecast row's `Details ›` one row above already lands on the same explanation, and a second
  nav target would be redundant); extend `chipAria` using `addedTimeSpokenHeadline`.
- `packages/web/src/features/schedule/MobileMonteCarloCard.tsx` — added-time chip + aria.
- `packages/web/src/features/schedule/MonteCarloSheet.tsx` — added-time section first, reusing
  `AddedTimeCard`.

**Docs**

- `packages/website/src/content/docs/features/monte-carlo.md` (or the added-time page) — state
  that the premium is now on the forecast payload and reachable from every project view.
- `changelog.d/2531.added.md`.

### Tests

**pytest**

- `tests/apps/scheduling/test_risk_premium.py` — `risk_premium_from_values` directly;
  `risk_premium_for_forecast_payload` over a live-shaped dict, a from-history dict, a legacy dict
  missing `cpm_finish`, and one with an unparseable `last_run_at`.
- MC view tests — all eight keys on the live POST and on all three `/latest/` branches; **the
  cached entry does not contain any `risk_premium_*` key** (the freeze guard, asserted directly
  against `cache.get`); **`ratio` recomputes as `today` advances over one cache entry** (freeze
  time at T, read; freeze at T + n days past `cpm_finish`, read the *same* cache entry, assert
  `ratio is None`) — this is the test that pins the sharp finding; permissions (Viewer 200,
  non-member denied, archived denied).
- `tests/apps/projects/test_overview.py` — assert `/overview/` and `/latest/` return **identical**
  premium key/value pairs for the same persisted run.

**vitest**

- `addedTimeChipFit.test.ts` — the invariant sweep (320–1920, `baselineOnScreen: false` ⇒ never
  `'number'`) plus the concrete drop at 1024 and `'number'` at 1024 with `baselineOnScreen: true`,
  all at `siblingCount: 5`.
- `addedTimeChip.test.ts` — suppressed on `/projects/x`, `/projects/x/overview`,
  `/projects/x/settings/general`, and off `/projects/…`; `baselineOnScreen` true only on
  `/projects/x/schedule`.
- `addedTime.test.tsx` — `addedTimeShortForm`: the digit `0` appears nowhere in the output for
  `zero`, `unmeasurable` or `notRun`; `stale` returns `null`.
- `HealthCluster.test.tsx` — popover carries the Added time row; both fragment and row suppressed
  on Overview; the `aria-label` clause.
- `MobileMonteCarloCard.test.tsx` — renders the same headline as `AddedTimeCard` for each of the
  six states, driven from one shared `AddedTimeFacts` fixture set.

**Playwright**

- Added time reachable from Schedule via the health chip; an unestimated project shows
  `needs estimates`, not a calm number. The spec must mock `/monte-carlo/latest/` with the **full**
  real shape including the new keys, plus `/status-summary/`, `/sprints/active/` and `/velocity/` —
  the catch-all `{count:0,…}` net returns a list shape for object endpoints and will crash the
  page (the #1190 failure mode).

### Pre-commit E2E grep (mandatory)

`HealthCluster`'s accessible name and popover contents change. Before committing, grep
`packages/web/e2e/` and update in the same commit:

- `getByTestId('health-cluster')` — `a11y.spec.ts`, `current-sprint-jump.spec.ts`,
  `my-work.spec.ts`, `schedule-monte-carlo.spec.ts`, `wave1-topbar.spec.ts`
- `getByRole('dialog', { name: 'Project health' })` — same set; the dialog name is unchanged but
  its row set is not
- `"Monte Carlo forecast"` — `schedule-monte-carlo.spec.ts` locates the forecast drill by this
  `aria-label` prefix; the new row must not collide under strict mode
- any assertion on the chip's `aria-label` / `Project health: …` string

Note `TopBar.test.tsx` **mocks** `HealthCluster`, so no TopBar-level test will catch a regression
here.

### Durable Execution

1. **Broker-down behaviour:** N/A. Every path touched is a synchronous read or the existing
   synchronous `run_monte_carlo` (inline by design, #1203). The premium derivation is a pure
   function with no async side effects and dispatches nothing.
2. **Drain task:** N/A — no new category of async work, so no new Beat drain. The existing
   schedule-request drain is untouched.
3. **Orphan window:** N/A — no outbox rows are written by this change.
4. **Service layer:** `scheduling/risk_premium.py` is the service boundary for this fact;
   `risk_premium_from_values` is the new single entry point and every caller (overview view, MC
   live path, MC latest view) reaches the state machine only through it. No `services.py`
   function is needed — nothing is dispatched.
5. **API response on best-effort dispatch:** N/A — both endpoints respond synchronously with the
   full result (`200`). No `{"queued": true}` path is involved.
6. **Outbox cleanup:** N/A — no outbox rows. The only stored artifact touched is the existing
   `mc_latest:{pk}` cache entry (24h TTL, self-expiring), which this ADR makes carry *fewer*
   keys, not more.
7. **Idempotency:** Both endpoints' premium derivation is a pure function of
   `(p80, cpm_finish, taken_at, diagnostic, today)` and is therefore trivially idempotent within
   a calendar day. `GET /latest/` is a safe read. `POST /monte-carlo/` was already re-runnable
   (it overwrites the same cache key and, for Scheduler+, appends a history row — unchanged
   semantics, rate-limited by `MonteCarloRunThrottle`).
8. **Dead-letter / failure handling:** N/A — no task. A malformed cached payload (missing or
   unparseable `cpm_finish` / `last_run_at`) is handled in-band by
   `risk_premium_for_forecast_payload` returning the `not_run` state rather than raising, so a
   legacy cache entry degrades to "no premium known" instead of 500-ing the forecast read.
