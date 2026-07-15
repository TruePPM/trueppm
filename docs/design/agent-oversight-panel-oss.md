# Design — OSS Per-Program Agent-Oversight Panel (#1849)

**Status:** Design phase (pre-implementation). OSS / Apache-2.0.
**Owner issue:** #1849 — follow-up #1 from ADR-0362 ("the fleet-oversight dashboard
design note").
**Related ADRs:** **ADR-0362** (parent — governance and oversight are one surface; §3
design rule, §6 open-core split "Oversight" row, §7 guardrails) · **ADR-0112** (the
hash-chained `AgentAction` substrate this panel projects; RC1/RC2, landed #1805) ·
**ADR-0218** (`get_schedule_derivation` — the refusal-explanation / "why this date"
surface) · **ADR-0104** (team-signal privacy/consent — the de-surveillance guardrail) ·
ADR-0095 (program tab shell) · ADR-0175/#987 (persisted Monte Carlo run).
**Scope of this doc:** the **Community half** of the oversight surface — a team's read
on **its own** agents, per program. The Enterprise counterpart (cross-program fleet fan
chart, trust/verification panel, cross-program drill-down) is explicitly **out of
scope** and sketched only where it constrains the OSS extension-point shape (§8).

This is a `/ux-design` + dataviz-pass design note. It is **not a build.** It is the
design that unblocks the later-phase implementation (the write surface lands in 0.6;
see the honest-tense box below).

---

## 0. Honest-tense callout — what is real today vs. forward-looking

> **Read this first. It governs every tense in this document.** Per the ADR-0362 §7
> honest-tense guardrail and the repo version-status tense rule, this panel describes a
> surface whose data is **partially forward-looking**. The design is drawn in full now
> so the substrate can be built against it; the copy separates what ships today from
> what ships later.

| Element | Status on `main` today (2026-07) | Tense |
|---|---|---|
| Hash-chained `AgentAction` audit record + `audit_verify` chain integrity | **Real** (ADR-0112 RC1/RC2, #1805) | present/past |
| `GET /api/v1/agent-actions/` team-readable, membership-scoped log | **Real** (`AgentActionViewSet`, #1805) | present |
| Read-only MCP surface (`mcp:read`) — the only actor recorded today (`actor_kind = mcp_token`) | **Real** (ADR-0186) | present |
| `get_schedule_derivation` (the "why this constraint fired") | **Real** (ADR-0218, `ScheduleDerivationView`) | present |
| Monte Carlo P50/P80/P95 fan (`MonteCarloHistogram`, `MonteCarloTimeline`) | **Real** (persisted run, ADR-0175) | present |
| **View 1 — agent-action table**, projecting the chain over read verdicts | Buildable now on real data; **populated only by reads** until 0.6 | present, with a forward note on write verdicts |
| **View 2 — refusal log**: `identity` / `policy` refusals on **reads** | **Real** vocabulary, recorded from day one (ADR-0112 RC1). Each refusal now carries a durable `refusal_detail` (`constraint` + `projected_impact`) on the API row itself (ADR-0421, #1850) — `token_identity` / `capability_scope` today, and the scheduling-guard codes reserved for 0.6 — so the panel reads the constraint straight off the row and can filter `?constraint=` | present |
| **View 2 — commitment refusals** (a write rejected as schedule-infeasible, with the constraint + projected impact) | **Forward-looking — the 0.6 gated-write surface** (#505/#604). `refusal_detail.projected_impact` is the durable slot it will populate (ADR-0421); until then it is an honest `{}` | **future** ("will show", "lands in 0.6") |
| **View 3 — agent-actuals-vs-forecast** fan | The **fan chart itself is shipped**; **agent actuals accrue only once agents do measured work** (0.6+) | mixed: chart present, actuals **future** |

The wedge ADR-0362 §4 names — *"write rejected: schedule-infeasible, here is the
constraint and the projected impact"* — is **View 2's forward-looking row**. It is
designed here so that the moment the 0.6 write surface lands, the refusal renders with
no further design work. Today the same view honestly shows identity/policy refusals on
the read surface.

---

## 1. Decision summary (read first)

**The OSS oversight surface is a new program-scoped tab, `Agents`, at
`/programs/:programId/agents`, composed almost entirely of components that already
exist.** It is a *projection of two substrates* — the hash-chained `AgentAction` record
(ADR-0112) and the CPM + Monte Carlo engine (ADR-0175/0218) — never a new data store.
Per the ADR-0362 §3 design rule, **every view below names the exact chain/engine query
it projects**; a view that could not name its query would be a boundary bug and is not
in this design.

The tab hosts three sub-views behind a segmented control:

| Sub-view | What it answers | Chain/engine query it projects (ADR-0362 §3) |
|---|---|---|
| **1 · Activity** (agent-action view) | "What have our agents done in this program?" | `GET /api/v1/agent-actions/?program=<id>` — a filtered projection of the `AgentAction` chain; drill-down terminates in one record whose `record_hash` `manage.py audit_verify` validates |
| **2 · Refusals** (refusal log) | "What did the engine refuse, and why?" | Same endpoint, `&verdict=refused`; each row reads `refusal_reason`; commitment refusals (0.6) attach `get_schedule_derivation` (ADR-0218) for the binding constraint + projected impact |
| **3 · Forecast impact** (agent-actuals-vs-forecast) | "Given what agents have actually done, when does this program finish?" | The persisted Monte Carlo run (ADR-0175) rendered by the existing `MonteCarloHistogram` / `MonteCarloTimeline` — the *same* engine the 0.6 refusal gate consults for projected impact in plan mode (`dry_run`) |

**Per-program scope.** A program (OSS entity) groups related projects. `AgentAction`
carries a `project` FK (nullable), and `AgentActionViewSet` already scopes rows to the
caller's `ProjectMembership`. The program view is the **union of the chain across the
program's readable member projects.** This requires one small, additive API extension —
a `?program=<id>` filter on the existing viewset (§7). No new model, no migration.

**Why a first-class tab and not a Settings sub-page.** Oversight is ADR-0362's durable
asset #1 — "where humans live once agents execute." It is a *read* surface for the whole
team (Viewer+), parallel to Overview/Schedule, not an admin configuration page. Writes
(token issuance, agent suspend) stay in Settings; *watching* agents is a daily-driver
tab.

---

## 2. Object → Lens Map (OOUX — ADR-0266)

State the objects before the pixels. Every lens below is a projection of a first-class
server object (API-first); none is a client-only invention.

| Object | Scope | Edition | Relationships | Lens (persona → view) |
|--------|-------|---------|---------------|-----------------------|
| **`AgentAction`** | per-instance chain, `project` FK, program via project | OSS | `sequence`/`prev_hash`/`record_hash` link to predecessor row; `principal` (human owner) → User; `actor_token` → `ApiToken` (prefix only); `project` → Project → Program | **Sarah (PM):** "what did the agents touch on my program?" · **Morgan (Coach):** "is this governing *agents*, not watching *people*?" · **Nadia (integration dev):** "did my token's call get recorded and verified?" |
| **Refusal** (an `AgentAction` where `verdict = refused`) | same | OSS | `refusal_reason` ∈ {identity, policy}; **0.6:** a commitment refusal links to a `get_schedule_derivation` result (binding constraint + projected impact) | **Sarah:** "the engine stopped an agent from breaking my plan — show me why" · **Alex (SM):** "did an agent try to move a sprint boundary?" |
| **`MonteCarloRun`** (forecast) | per project, rolled to program | OSS | conditioned on committed tasks incl. agent-completed work; P50/P80/P95 buckets | **Janet (Exec):** "when does this land, given the agents' real pace?" · **Sarah:** "is the agent-assisted forecast better or worse than plan?" |
| **`AgentActionCheckpoint`** | per-instance | OSS | re-anchors `audit_verify` across a prune (ADR-0361) | (system; surfaced only as a "chain re-anchored on {date}" note in the verify affordance) |

**Boundary lens (rule 231).** OSS shows what one team can do with **its own** agents in
**one program**. The cross-program fleet lens is an Enterprise seam (§8) — it appears as
an **empty extension-point slot** absent the edition, never an ambient padlock in the
OSS daily path.

---

## 3. Where it lives — placement & navigation

`ProgramTabs` (`packages/web/src/features/shell/ProgramTabs.tsx`) today renders eight
program tabs: Overview · Backlog · Projects · Schedule · Resources · Members · Assets ·
Settings. **Add `Agents` between Resources and Members** (governance-of-execution sits
next to capacity-of-execution):

```
Overview  Backlog  Projects  Schedule  Resources  [Agents]  Members  Assets  Settings
```

- Icon: a shield/robot glyph (`ShieldIcon` if present, else a new `AgentIcon` following
  the existing `ComponentType<{ className, 'aria-hidden' }>` contract).
- Route: `/programs/:programId/agents`, default sub-view `activity`
  (`/programs/:programId/agents/activity`); `.../refusals`, `.../forecast` for the other
  two. The sub-view is a segmented control, **not** a top-bar tab (matches how Schedule
  hosts Gantt/Grid without multiplying top-bar tabs).
- The tab is **always present** for any program the user can read (no methodology gate —
  agents are not agile-specific). When no agents have ever acted in the program, the tab
  is present and the panel shows the empty state (§6.1); we do not hide the tab, so the
  team can find "where do I watch our agents" before they connect one.
- `hidden md:flex` mirrors the existing `ProgramTabs` responsive rule; on `< md` the tab
  is reached from the program overflow menu, and the panel renders its mobile layout
  (§5.4).

---

## 4. Layout — desktop (1280px+)

Shared chrome for all three sub-views: a program-scoped header, the segmented sub-view
switcher, and a shared filter row. The header **names the substrate in plain language**
(the design rule made visible to the user, not just the spec):

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Agents · Website Replatform program                          ⟳ Recorded 2m ago │
│  A read-only projection of the tamper-evident agent-action log.  ⛓ Chain verified│  ← verify affordance
│                                                                                 │
│  ┌ Activity ─┬ Refusals ─┬ Forecast impact ┐        [ Project ▾ ] [ Range ▾ ]   │  ← segmented + filters
│  └───────────┴───────────┴─────────────────┘                                    │
├───────────────────────────────────────────────────────────────────────────────┤
│  (sub-view body)                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **`⛓ Chain verified` affordance** (top-right). This is the OSS integrity signal made
  human. It surfaces the state of `manage.py audit_verify` for the instance chain (§4.1).
  Clicking it opens a popover explaining what verification means and how to run it
  locally. This is the single most important trust element on the surface — the panel is
  credible *because* the rows underneath it are chain-verifiable, not because we say so.
- **Filters** (shared, drive all three views): **Project** (all readable member projects,
  default "All in program") and **Range** (`Last 24h · 7d · 30d · All`, default 7d,
  reads `occurred_at`). Refusals view adds a **Reason** chip filter (§4.2).

### 4.1 The `⛓ Chain verified` affordance — how chain integrity is surfaced

The row-level substrate is the hash chain; the team-level substrate is `audit_verify`.
We surface both:

- **Header badge** — one of three states:
  - `⛓ Chain verified` (`semantic-on-track` / green + shield-check icon + text) — the
    displayed rows' `sequence`/`record_hash` form an unbroken run and the latest
    `AgentActionCheckpoint` (if any prune has run, ADR-0361) re-anchors cleanly.
  - `⛓ Verify locally` (`neutral` / muted) — the default when the client cannot assert
    integrity server-side (see below): a neutral, honest "run the CLI to confirm" state,
    **never a false green**.
  - `⚠ Chain gap detected` (`semantic-critical` / red + label) — a `sequence` gap or
    `record_hash`/`prev_hash` mismatch is visible in the returned page. This is a tamper
    signal and reads as one.
- **Popover** (on click): plain-language explanation — "Every agent action is one link
  in a tamper-evident chain. Each row's fingerprint (`record_hash`) is computed from the
  one before it, so a removed or altered row breaks the chain. To verify the full chain
  on your own instance, run `manage.py audit_verify`." Includes a copy-to-clipboard of
  the command. **No server call claims cryptographic proof the browser cannot make** —
  the authoritative check is the CLI (ADR-0112: the team detects tampering *on its own
  instance*); the UI honestly points at it. (Honest-tense: an in-browser
  `POST .../agent-actions/verify/` that re-walks the page and returns
  `{ ok, first_gap_sequence }` is a candidate follow-up — noted, not designed here, so
  the badge does not overstate what ships.)
- **Row → chain link:** each Activity/Refusals row carries its `sequence` (`#1274`) as a
  monospace chip; the drill-down (§4.1) shows `record_hash`, `prev_hash`, and
  `payload_hash` verbatim so the row is individually locatable in a CLI verify run. This
  is the "drill-down terminates in a record `audit_verify` can validate" requirement of
  ADR-0362 §3, made concrete.

### 4.2 View 1 — Activity (agent-action table)

**Purpose:** the team's chronological read of what its agents did across the program.
**Projects:** `GET /api/v1/agent-actions/?program=<id>` (membership-scoped;
`order_by("-occurred_at", "-sequence")` as the viewset already does).

Columns map **1:1 to real `AgentAction` / serializer fields** (no invented data):

```
┌──────────────┬──────┬──────────────────┬──────────────┬───────────┬────────────┬──────────┐
│ When         │ Seq  │ Action           │ Actor        │ On behalf │ Capability │ Verdict  │
│ occurred_at  │ seq  │ action · method  │ token_prefix │ principal │ capability │ verdict  │
├──────────────┼──────┼──────────────────┼──────────────┼───────────┼────────────┼──────────┤
│ 2m ago       │ #1274│ get_schedule GET │ 3f9a··       │ Nadia K.  │ mcp:read   │ ● Allowed│
│ 14m ago      │ #1268│ list_tasks   GET │ 3f9a··       │ Nadia K.  │ mcp:read   │ ● Allowed│
│ 1h ago       │ #1251│ get_forecast GET │ a10c··       │ Sarah P.  │ mcp:read   │ ⛔ Refused│  → row opens drawer
└──────────────┴──────┴──────────────────┴──────────────┴───────────┴────────────┴──────────┘
                                                       [ Load older ]  ← cursor pagination
```

- **Verdict** cell uses the dataviz status mapping (§9.1): `Allowed` =
  `semantic-on-track` dot, `Refused` = `semantic-critical` `⛔`, `Requires approval`
  (0.7) = `semantic-at-risk` `◐`. Never color alone — each carries an icon + text label
  (WCAG 1.4.1).
- **Actor** shows `actor_token_prefix` (the 8-char prefix, never token material) + the
  `actor_kind` badge (`MCP token` today; more kinds arrive with #1063). **On behalf**
  shows the `principal` (the human token-owner) — this is *attribution of an agent to
  its accountable human*, **not** a productivity signal (§6 de-surveillance).
- **Row click → detail drawer** (slide-over, right, 420px — the established detail
  pattern, not full-page nav):

```
┌ Action #1274 ──────────────────────────────── ✕ ┐
│ get_schedule_derivation · GET · 200               │
│ ● Allowed · mcp:read                              │
│                                                   │
│ Actor      MCP token 3f9a··  (on behalf of Nadia) │
│ Project    Checkout Service                       │
│ Object     project · 8c2f-…                       │
│ Engine     trueppm-scheduler 0.4.1                │  ← engine_version
│ When       2026-07-12 14:03:11Z                   │
│                                                   │
│ ── Chain link ──────────────────────────────────  │
│ sequence      1274                                │
│ record_hash   9f2c…a71b   [copy]                  │  ← the audit_verify anchor
│ prev_hash     4b81…0d3e                           │
│ payload_hash  c7e2…5510                            │
│ ⛓ This record is verifiable via  audit_verify [copy]│
└───────────────────────────────────────────────────┘
```

  The drawer is the terminus ADR-0362 §3 requires: a single chain record, its hashes
  shown verbatim, individually locatable in a `manage.py audit_verify` run.
- **Pagination:** cursor/`Load older` on `-occurred_at, -sequence`. The chain is
  append-only and can be long; never load unbounded. (The viewset returns DRF's default
  page; the design assumes the standard cursor pattern the rest of the app uses.)

**Honest-tense note.** Until the 0.6 write surface, every row's `method` is `GET` and
every `verdict` is `Allowed` or a read-refusal. A one-line info strip states this
plainly: *"Today agents can only read. Write actions — and the refusals that guard your
plan — arrive with the 0.6 write surface."* The strip is removed automatically once any
non-`GET` action appears in the chain (a data-driven condition, not a version check).

### 4.3 View 2 — Refusals (refusal log)

**Purpose:** the concentrated view of what the engine *stopped* — ADR-0362's "refusal is
the demo." **Projects:** `GET /api/v1/agent-actions/?program=<id>&verdict=refused`; each
row reads `refusal_reason`.

```
┌─ Refusals ────────────────────────────────────  [ Reason: All ▾ ]  [ Range ▾ ] ─┐
│  Identity 2  ·  Policy 5  ·  Commitment 0        ← reason distribution (§9.2)     │
│  ▂▂▂▂▂▂▂ (compact stacked bar, labelled)                                          │
├───────────────────────────────────────────────────────────────────────────────┤
│ When    Seq   Action              Actor    Reason        Why                     │
├───────────────────────────────────────────────────────────────────────────────┤
│ 1h ago  #1251 get_forecast GET    a10c··   ⛔ Identity    Token expired           │  ← identity/policy: real today
│ 3h ago  #1240 list_risks   GET    a10c··   ⛔ Policy      Missing mcp:read scope  │
│ ─── (0.6, forward-looking) ─────────────────────────────────────────────────────│
│ —       —     move_task    POST   —        ⛔ Commitment  Would breach baseline;  │  ← commitment refusal (future)
│                                            P80 slips +6d  [ Why this? → ]         │     designed now, empty today
└───────────────────────────────────────────────────────────────────────────────┘
```

Two row shapes, one table — **designed for both, forward part labelled:**

- **Identity / policy refusals (real today).** `refusal_reason = identity` → "no/invalid
  actor" (a revoked or expired token was presented); `refusal_reason = policy` → "actor
  known, capability denied" (e.g. missing `mcp:read`). The **Why** cell is a short,
  literal string derived from the recorded reason + `capability_used`. These are
  present-tense: they exist on the read surface now.
- **Commitment refusals (forward-looking, 0.6).** When the 0.6 gated-write surface lands,
  a refused write carries the *plan* reason: the binding constraint that fired and the
  projected schedule impact. The **Why** cell shows a one-line summary
  (*"Would breach baseline; P80 slips +6d"*) and a **`Why this? →`** link that opens the
  derivation drawer (§4.3.1). This row is **rendered from `get_schedule_derivation`
  (ADR-0218)** — the exact same derivation surface that powers the schedule "why this
  date?" popover and the 0.8 auto-narrative (ADR-0362 §3: "one derivation surface").
- The commitment section is **visually separated and future-labelled** ("arrives with
  0.6 writes") and shows an inline empty note today, so the view is honest: the row shape
  is real, the data is not yet.

#### 4.3.1 Refusal drill-down — the derivation drawer (0.6)

A commitment refusal's `Why this? →` opens the same right slide-over, in "derivation"
mode:

```
┌ Refusal · move_task #—  (0.6) ─────────────── ✕ ┐
│ ⛔ Refused · Commitment · plan-mode dry_run       │
│                                                   │
│ The agent tried to move "API cutover" to Aug 14.  │
│ The engine refused: this would breach baseline v3.│
│                                                   │
│ ── Binding constraint (get_schedule_derivation) ──│  ← ADR-0218 Derivation.binding
│ kind          predecessor_link                    │
│ driving task  Data migration (FS +2d)             │
│ imposed date  Aug 12                              │
│ ── Projected impact (same MC engine) ─────────────│  ← the fan the gate consulted (dry_run)
│ P80 finish    Nov 2  →  Nov 8   (+6d)             │
│ [ Open in Schedule → ]  [ ⛓ chain record ]        │
└───────────────────────────────────────────────────┘
```

This closes the ADR-0362 §3 loop concretely: the refusal *explanation* is
`get_schedule_derivation` (which constraint fired), and the *projected impact* is the
same Monte Carlo engine the gate consulted in plan mode — the identical numbers View 3
plots. `[ ⛓ chain record ]` jumps to the Activity drawer for the same `AgentAction`
row, so every refusal is still chain-verifiable.

### 4.4 View 3 — Forecast impact (agent-actuals-vs-forecast)

**Purpose:** the durable-asset-#2 question — *"given what the agents have actually done,
when does this program finish?"* **Projects:** the persisted `MonteCarloRun` (ADR-0175)
for the program's schedule, **rendered by the existing components** — no new chart type.

```
┌─ Forecast impact · Website Replatform ───────────  [ Project: All ▾ ] ──────────┐
│                                                                                 │
│   P50: Oct 18    P80: Nov 2 (+11d)    P95: Nov 29          ← MonteCarloTimeline  │
│                                                                                 │
│   ▁▂▃▅▇▇▆▄▂▁    │ P50    ┊ P80    ┆ P95                    ← MonteCarloHistogram │
│   └─ week buckets ─────────────────────────┘                                    │
│                                                                                 │
│   ── Agent contribution ──────────────────────────────────────────────────────  │
│   Of 42 tasks, agents completed 6 (14%).  These actuals are folded into the      │
│   committed schedule the forecast runs on.        [ View in Activity → ]         │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Reuse, do not reinvent (dataviz §9.3).** `MonteCarloTimeline`
  (`packages/web/src/features/schedule/MonteCarloTimeline.tsx`) renders the three
  permanently-visible P50/P80/P95 chips; `MonteCarloHistogram`
  (`.../MonteCarloHistogram.tsx`) renders the week-bucket SVG distribution with the three
  percentile rules (P50 `semantic-on-track` solid · P80 `semantic-at-risk` dashed · P95
  `semantic-critical` dotted). This design **cites those components by name and changes
  nothing about them** — it embeds them in the Agents tab. It reuses the same P80-vs-CPM
  `p80DeltaDays` delta the schedule view already computes.
- **The "agent actuals" honesty.** We do **not** invent a second forecast or a new mark.
  Agent-completed work is already reflected in the committed task set the Monte Carlo run
  consumes (a task an agent finished is a task marked complete — the engine does not care
  *who* completed it). So the fan **is** the agent-actuals-conditioned forecast by
  construction. The only agent-specific addition is a **plain-language contribution
  strip** — *"agents completed N of M tasks; these actuals are in the schedule this
  forecast runs on"* — with a link into View 1. This is dataviz-honest: the number is a
  count of chain records, not a fabricated attribution, and the chart is the shipped one.
- **Honest-tense note.** Until agents do measured write-work (0.6+), N = 0 and the strip
  reads *"No agent-completed work yet — this forecast reflects the human-run plan. Agent
  actuals will fold in here as agents complete tasks."* The fan still renders (it is the
  ordinary program forecast); only the contribution strip is forward-looking. This view
  therefore ships useful on day one (it is the program's Monte Carlo forecast) and gains
  the agent overlay as actuals accrue — **no redesign at 0.6.**

---

## 5. Responsive & mobile

### 5.4 Mobile layout (320–428px)

Oversight is a *read* surface, so mobile is fully supported (unlike the desk-only PDF
export). The three sub-views become a **stacked, swipeable segmented control**; tables
become **cards**.

```
┌──────────────────────────┐
│ Agents · Replatform      │
│ ⛓ Verify locally    ⟳ 2m │
│ [Activity][Refuse][Fcast]│  ← segmented, horizontally scrollable
├──────────────────────────┤
│ ┌──────────────────────┐ │
│ │ #1274 · 2m ago       │ │  ← Activity as cards
│ │ get_schedule · GET   │ │
│ │ 3f9a·· → Nadia       │ │
│ │ ● Allowed · mcp:read │ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ #1251 · 1h · ⛔ Refuse│ │
│ └──────────────────────┘ │
│        [ Load older ]    │
└──────────────────────────┘
```

- Card tap → the same detail drawer, rendered as a **bottom sheet** on mobile.
- Forecast impact: `MonteCarloHistogram` already ships a mobile variant path
  (`MobileMonteCarloCard` / `MonteCarloSheet`) — **reuse it**; the contribution strip
  stacks beneath.
- Touch targets ≥ 44px; the segmented control and `Load older` meet this.
- The `Range`/`Project`/`Reason` filters collapse into a single **Filter** bottom-sheet
  trigger.

### 5.3 Tablet (768–1024px)

Table retains When/Action/Actor/Verdict; **Capability** and **On behalf** collapse into
the row's second line. Drawer is a right slide-over (not full sheet). Segmented control
stays inline.

---

## 6. States (every sub-view)

### 6.1 Empty — "no agents connected yet"

The load-bearing empty state (most self-hosters will land here first). Per sub-view:

- **Activity:** an illustration + *"No agent activity yet. When an MCP client or agent
  acts in this program, every action it takes is recorded here — tamper-evident and
  verifiable."* Primary action: **`Connect an agent →`** (deep-links to
  Settings → API tokens / MCP setup). Secondary: **`What gets recorded? →`** (docs).
- **Refusals:** *"No refusals recorded. When the engine refuses an agent action — an
  expired token, a missing capability, or (with 0.6 writes) a change that would break
  your plan — it shows here with the reason."*
- **Forecast impact:** **not** empty in the usual sense — it renders the program's
  ordinary Monte Carlo forecast with the "No agent-completed work yet" contribution strip
  (§4.4). If the program has *no* forecast at all (no committed tasks / no run), it shows
  the standard "Run a forecast" empty state the schedule view already uses (do not
  fabricate a fan).

### 6.2 Loading

Skeleton rows (table shape), **not** a spinner (design principle 3 / house rule). The
`⛓` badge shows a neutral pulsing placeholder, never a premature green. Forecast impact
shows the histogram skeleton the schedule view already uses.

### 6.3 Error

Actionable, inline (not a toast-and-vanish): *"Couldn't load agent activity."* + a
machine hint if present + **`Try again`**. A `403` on the program (non-member) is a
route-guard concern handled upstream, not this panel's error state. Critically, a
**`⚠ Chain gap detected`** is **not** an error state — it is a first-class *finding*
(§4.1) rendered in red with an explanation, because a broken chain is exactly what this
surface exists to reveal.

### 6.4 Offline

The `AgentAction` log is server-side and append-only (never synced to mobile — see the
model docstring). Offline therefore shows the standard **"Working offline — agent
activity updates when you reconnect"** banner over the last-loaded rows; no writes exist
on this surface to queue. The forecast fan shows its last-cached run with the app's
standard stale-data affordance.

---

## 7. API dependencies

**One additive, backward-compatible extension; no new model, no migration.**

- `GET /api/v1/agent-actions/` — **exists** (`AgentActionViewSet`, #1805). Already
  supports `?verdict=` and `?project=` and membership scoping.
  - **Extension needed:** add a **`?program=<uuid>`** filter that resolves the program's
    readable member projects and filters `project_id__in` that set (intersected with the
    caller's `ProjectMembership`, preserving today's scoping — a non-member gains nothing).
    This is the only backend change the panel requires. It is small, read-only, and
    RBAC-preserving (rbac-check applies when it is implemented). Rationale for a
    server-side filter over N client calls: one indexed query on the existing
    `agent_action_proj_idx` `(project, -occurred_at)` index vs. a fan-out of per-project
    requests the client would have to merge and re-sort.
  - **Range filter:** `?since=<iso>` (or reuse the standard time-window param the app
    uses) on `occurred_at`.
  - **Reason filter (Refusals):** client-side on the returned `refusal_reason`, or
    `?refusal_reason=` if the viewset gains it (optional; low volume).
- `GET /api/v1/projects/<pk>/monte-carlo/latest/` — **exists** (ADR-0175). View 3 reads
  the persisted run; program rollup uses the existing program forecast rollup the Program
  Overview already consumes (do **not** invent a new aggregate — reuse the program
  rollup endpoint the overview KPIs read).
- `GET /api/v1/projects/<pk>/schedule/derivation/?task_id=&quantity=` — **exists**
  (ADR-0218, `ScheduleDerivationView`). View 2's commitment-refusal drawer (0.6) reads it
  for the binding constraint + projected impact.
- **No new write endpoints.** This is a read-only oversight surface.

**Substrate gap flagged (per the issue's ask).** The one place the shipped substrate does
not yet support a view the issue implies is **program-scope aggregation**: the
`AgentActionViewSet` filters by a *single* `?project=` or by membership, not by
`?program=`. Handled by the additive `?program=` filter above — a redesign was **not**
required; the model's `project` FK + the existing membership scoping make program
aggregation a filter, not a schema change. (A program-scoped `mcp:read` spec already
exists — #1852 — confirming program scope is a live concern, not speculative.)

---

## 8. Enterprise boundary — what this OSS panel does NOT include

Per ADR-0362 §6 ("Oversight" row) and the CLAUDE.md Two-Repo Rule, this OSS panel is a
team's read on **its own** agents in **one program**. It deliberately excludes — and the
Enterprise `trueppm-enterprise` fleet dashboard registers against the same OSS
components to add:

| Excluded from OSS (→ Enterprise) | Why it is Enterprise |
|---|---|
| **Cross-program fleet fan chart** (agent actuals vs. *portfolio* forecast) | Cross-program aggregation is portfolio governance, not one team's read (ADR-0362 §6) |
| **Trust/verification panel** (fleet-wide agent trust scores, verification rates) | An org-level rollup across programs; needs the cross-instance/notarized chain (Enterprise audit row) |
| **Cross-program drill-down** (one agent's actions across many programs) | Crosses the program boundary; OSS drill-down terminates within the program's chain |
| **Notarized / signed chain, retention & legal hold, SIEM/CEF streaming** | The compliance-evidence value-add (ADR-0112 §3, #146); OSS ships raw JSON export + `audit_verify` only |

**Extension-point shape (OSS composes, never imports Enterprise).** The three OSS
sub-view components (`AgentActivityTable`, `RefusalLog`, `AgentForecastImpact`) and the
`?program=` projection are the seam. Enterprise composes them into a cross-program fleet
view by (a) calling the same read API without the single-program filter (org-scoped, an
Enterprise permission), and (b) registering a **fleet route + fleet-scope slot** via the
established edition-routing extension point (ADR-0029/0030) — the same pattern the
portfolio tabs use over the project shell (see `docs/ux/p3m-vs-oss-views.md` §6). The OSS
panel exposes a stable prop contract for these components; it does **not** reach into
enterprise. `grep -r "trueppm_enterprise" packages/` stays at zero.

---

## 9. Dataviz pass — marks, color, accessibility

### 9.1 Verdict status mapping (reserved status colors, never categorical)

Verdicts are a **status** encoding (ADR-0362's verdict vocabulary), mapped onto the
existing semantic tokens — consistent with the whole app and **never** color-alone
(WCAG 1.4.1). Each is icon + text + color:

| Verdict | Token (light/dark from the shared ramp) | Icon | Label |
|---|---|---|---|
| `allowed` | `semantic-on-track` (green) | ● (filled dot) | Allowed |
| `refused` | `semantic-critical` (red) | ⛔ | Refused |
| `requires_approval` (0.7) | `semantic-at-risk` (amber) | ◐ | Requires approval |

These are the **same tokens** `MonteCarloHistogram` uses for its P50/P80/P95 rules, so
the whole Agents tab reads as one system in both light and dark (the tokens carry their
own dark-mode steps — a *selected* dark palette, not a flipped one). Status colors are
reserved: a verdict color is never reused for a category series.

### 9.2 Refusal reason distribution (View 2 header)

A **compact single stacked bar** (not a pie), labelled with counts, showing
`identity` / `policy` / `commitment` refusal mix. Marks: 2px surface gap between segments
(dataviz mark spec); each segment direct-labelled with its count; a legend row beneath
since there are three categories. Reasons are **categorical within the refused status**,
so they use texture + label, not three saturated hues competing with the verdict red:
`identity` and `policy` use two steps of a single muted ramp + a 45°/135° texture
distinction for the CVD/print case; `commitment` (the plan refusal — the important one)
gets the `semantic-critical` step to draw the eye, matching its row treatment. This keeps
the "refusal is the demo" row visually dominant without a rainbow.

### 9.3 Agent-actuals-vs-forecast (View 3) — reuse, annotate, do not invent

Per the dataviz procedure (form first: this is a *distribution + thresholds* job, already
solved) and the explicit instruction to reuse: **no new chart type.**
`MonteCarloHistogram` (week-bucket bars in `neutral-text-disabled`; P50 solid green / P80
dashed amber / P95 dotted red rules — pattern-differentiated, so not color-alone) +
`MonteCarloTimeline` (the three labelled date chips) are embedded verbatim. The only
addition is the **text contribution strip** (§4.4) — a stat line, not a chart, which the
dataviz form heuristic explicitly endorses ("sometimes the answer is not a chart"). We do
**not** overlay a second "agent" series on the fan (that would be a dual-encoding lie —
the actuals are already *in* the single distribution), and we do **not** add a second
y-axis (dataviz non-negotiable: one axis).

### 9.4 Accessibility (WCAG 2.1 AA)

- **1.4.1 (color not alone):** every verdict and every percentile rule carries an icon +
  text/label + line pattern (covered above).
- **1.4.3 (contrast):** all text uses ink tokens (`neutral-text-*`), never the series
  color, on the surface — the app's WCAG contrast gate (#1689) applies.
- **Tables:** semantic `<table>` with `<th scope="col">`; each row is a link with an
  accessible name ("Action #1274, get_schedule_derivation, Allowed"); the drawer is
  `role="dialog"` `aria-modal`, focus-trapped, labelled by its heading (web-rule 206 /
  established dialog focus conventions).
- **Segmented control:** `role="tablist"` / `role="tab"` with `aria-selected`; arrow-key
  navigation between the three sub-views.
- **`⛓` badge:** a `<button>` with an accessible name reflecting state
  ("Chain verified — details" / "Chain gap detected — details"); the state is never
  conveyed by the chain glyph color alone.
- **Live region:** the `⟳ Recorded 2m ago` freshness label and any "new activity"
  update announce via a polite `aria-live` region, not a focus-stealing toast.
- **Histogram:** `MonteCarloHistogram` already ships `role="img"` with a text
  alternative and a prose fallback for the degenerate single-bucket case — inherited.

---

## 10. De-surveillance guardrail (ADR-0362 §7 / ADR-0104) — explicit

**This panel governs AGENTS. It never surveils PEOPLE.** This is a hard constraint, not a
preference, and it shapes what is deliberately absent:

**What this panel renders (agent actors + verdicts — legitimate governance):**
- `AgentAction` rows: the *agent/token* actor (`actor_token_prefix`, `actor_kind`), the
  *action*, the *verdict*, the *capability used*, the *chain position*.
- The `principal` (human token-owner) appears **only as attribution** — *which
  accountable human owns the agent that acted* — exactly as an audit log names who holds
  a credential. It answers "whose agent did this," never "how much did this person do."

**What this panel deliberately does NOT show, and why:**
- **No human throughput, velocity, review-pace, or productivity aggregation.** There is
  no "actions per principal" leaderboard, no per-person activity rate, no ranking of
  humans by their agents' volume. Aggregating `principal` into a productivity gauge is
  precisely the surveillance drift ADR-0362 §7 forbids and the third-pillar VoC blocker
  ADR-0104 was written to close. The Activity view sorts by time and filters by
  project/verdict — **never** groups-by-and-counts humans.
- **No human-signal mixing.** Velocity, throughput, retro pulse, and any team-health
  signal are governed by the ADR-0104 team-owned, opt-in-upward `SignalAudience` consent
  model (`ProjectSignalPrivacyPolicy`) and are **not** eligible for this panel. If a
  future oversight view ever wanted to correlate agent activity with a *team* signal (it
  should not, at OSS/program scope), that signal would have to pass
  `audience_can_read` at the requester's tier — this panel provides no path around that
  gate. There is no code seam here by which a `principal` count becomes a management
  metric.
- **Where the ADR-0104 gate sits relative to this panel:** the panel reads
  `agent-actions`, an **agent** audit surface with membership scoping — it never touches
  the velocity/pulse/throughput reads that `audience_can_read` protects. The two surfaces
  are kept structurally separate: agents are governed by the chain (this panel); people's
  signals are governed by consent (ADR-0104), and the second is never rendered here.

The design test, stated for future maintainers: *if a proposed addition to this panel
would let a manager infer a person's output rather than an agent's actions, it is a
surveillance regression and belongs nowhere in TruePPM — not gated to Enterprise, but
out.* (ADR-0104 §A.5 rejected even a PMO/exec bypass for exactly this reason.)

---

## 11. Persona read (five personas)

| Persona | Value | Verdict |
|---|---|---|
| **Sarah (PM)** — target | "I can see what our agents touched on my program, and when the engine stopped one from breaking my plan — with the *why*." The refusal-with-derivation drawer is her trust moment. Forecast-impact answers "given the agents' real pace, when do we land?" | **Strong win** — this is her oversight surface. |
| **Morgan (Agile Coach)** | Checks the guardrail first: renders *agents*, not *people*; no velocity, no per-person counts; ADR-0104 consent untouched. The de-surveillance framing (§10) is explicit. | **Approves** — autonomy-safe; would 🔴 any per-`principal` leaderboard, which the design forbids. |
| **Nadia (integration/API dev)** | Her `mcp:read` token's calls are recorded, attributed to her, and **chain-verifiable** — she can prove what her agent did and that the log wasn't altered (`audit_verify`). | **Win** — the transparency is a feature, not a threat, because it is her own accountable record. |
| **Alex (Scrum Master)** | Cares that an agent can't silently move a sprint boundary; the Refusals view (with 0.6 commitment refusals against sprint sovereignty, ADR-0362 §4) is where he'd confirm a refusal fired. | **Neutral-positive today** (read-only), **win at 0.6** when write-refusals populate. |
| **Janet (Exec sponsor)** | Reads only the Forecast-impact chips (P80 date) — the agent-actuals-conditioned finish. Rarely opens the other two views. | **Light but real** — the one number she wants, no new surface to learn (reuses the MC chips she already sees on Overview). |

**Boundary-confirming absence:** the PMO/portfolio persona (Marcus) gets **nothing** here
by design — cross-program fleet oversight is his surface and it is **Enterprise** (§8).
That absence validates the boundary rather than indicating a gap (the same pattern the
PDF-export note documents).

---

## 12. Test plan (for the implementation phase — not built in this note)

**vitest (web units, co-located):**
- `AgentActivityTable` — column mapping from real serializer fields; verdict → status
  token/icon; row → drawer; empty ("no agents connected yet") / loading skeleton / error.
- `RefusalLog` — filter to `verdict=refused`; identity/policy row rendering; the
  forward-looking commitment section renders its future-labelled empty state today; the
  reason distribution bar counts correctly.
- `AgentForecastImpact` — reuses `MonteCarloHistogram`/`MonteCarloTimeline` (assert
  composition, not re-test the charts); contribution strip N=0 wording; no-forecast empty
  state defers to the standard schedule empty state.
- `⛓ ChainVerifyBadge` — the three states (verified / verify-locally / gap-detected);
  popover copy + copy-to-clipboard.

**Playwright (`packages/web/e2e/`):**
- Golden: navigate to `/programs/:id/agents`, land on Activity, see rows, open a row
  drawer, read the chain hashes; switch to Refusals; switch to Forecast impact and see the
  fan. **Mock `agent-actions?program=`, the program forecast rollup, and (for the drawer)
  the derivation endpoint with their real shapes** — do not lean on the catch-all list
  route for the object-shaped forecast endpoint (repo #1190 lesson).
- Empty state: no agents → "Connect an agent" CTA present.
- A `⚠ Chain gap detected` fixture renders the red finding state (not an error toast).

**pytest (API):** covers the `?program=` filter when it is implemented — membership
scoping preserved (a non-member sees nothing), program → member-project resolution,
combined with `verdict=refused`. (rbac-check + perf-check + regression-check apply to
that backend slice per the fast-paths table; this design note itself is docs-only.)

**Out of scope (no gate triggered by this note):** migration/broadcast/security — the
panel adds no model, no write path, no new auth surface; the one API change is an
additive read filter handled in its own implementation MR.

---

## 13. Boundary confirmation

**OSS / Apache-2.0 clean.** Per-program (Programs/Projects layer) read of the team's own
agents; composed from shipped components (`MonteCarloHistogram`, `MonteCarloTimeline`,
the detail-drawer pattern) + the existing `AgentActionViewSet` and `ScheduleDerivationView`
read APIs; one additive `?program=` read filter. No enterprise import — the fleet
dashboard composes the OSS components from `trueppm-enterprise` via the edition-routing
extension point (§8). `grep -r "trueppm_enterprise" packages/` stays at zero. Cross-program
fleet oversight, trust/verification, and notarized/streamed audit are explicitly
Enterprise and out of scope.
