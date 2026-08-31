# ADR-0963: The cross-project booking signal is a bounded disclosure, gated on assignment authority

## Status

Accepted (2026-08-30)

This ADR ships **no code**. #3155 implements it, after #3200 merges (that issue edits the
same picker rows). It exists because the feature makes a deliberate, permanent decision to
disclose one new fact to a non-org-admin audience, and because the filed design bundle
(`handoff-0.4-3155-booking-signal`, decisions `B1`–`B20`) reaches the right conclusion on
the central question via an argument that is **backwards**. A privacy rationale that is
wrong in an issue comment dies with the issue; wrong in an ADR it gets cited. Both are
worse than recording it correctly once.

It overturns `B7` (§5) and restates `B5`/`B6`'s conclusion on different grounds (§3), and
records `B20` as struck (§8).

## Context

**P3M layer: Programs and Projects.** The signal is consumed at the moment one PM assigns
one person to one task on one project's schedule. It does no cross-program aggregation, no
scoring, no leveling, and no enforcement. `enterprise-check` ran on the issue and returned
**OSS**; nothing here disturbs that. The Apache-2.0 boundary is untouched — no extension
point, no signal, no import.

That conclusion has to be argued rather than assumed, because **ADR-0034 explicitly holds a
line this feature stands near**: "cross-project resource heat maps and demand forecasting
remain Enterprise… the resource page is a catalog, not an analytics view." A workspace-wide
count is cross-project and it is about resources. Three existing decisions put it on the
OSS side of that line, and all three turn on the same distinction:

- **ADR-0499 §3** draws it in one sentence — "surfacing raw `units` and letting the human
  read overload is OSS; *scoring* and *leveling* it is Enterprise." A bare integer with no
  denominator is as far from a score as the surface gets.
- **ADR-0071** is the count-only-across-a-wall precedent: a cross-program consumer may read
  aggregate counts and never per-item text, and the wall is "structural at the OSS API
  layer."
- **ADR-0104 Principle 6** — "**suppress, don't 403**: aggregates stay visible; the gated
  detail is suppressed" — is this feature's shape exactly. The count is the aggregate that
  stays; the task and project names ADR-0499 protects are the detail that is suppressed.

The Enterprise counterpart remains what `enterprise-check` said it was: cross-program
leveling, the portfolio heat map, and pre-commit enforcement that refuses an overallocating
assignment. If this line ever grows a percentage, a denominator, a color, or a verdict, it
has crossed into Enterprise and this ADR no longer authorizes it.

### The problem

Every resource-picking surface on the Schedule tells the PM about *this* project and
nothing else. `ResourceSearchCombobox` runs two queries (`useResourceSearch`,
`useSkillFitSearch`), and `ResourceAssignmentSection` surfaces `resource_overallocated` and
`skill_mismatch` *after* a successful add. Skill fit is computed against this task's
requirements; the overallocation sum is scoped to this project
(`_check_overallocation(resource, project_id)`). So the picker knows who exists and whether
they fit, and cannot say that the person being added is already holding six rows on two
other schedules. The conflict is discovered after the commitment, not before it.

The fix is an **advisory count** — one quiet line under each result — and nothing more. Not
a block, not a health score, not a heat map. It is the same posture as the existing
in-project overallocation banner (ADR-0028: soft warning, assignment stands), widened by
one axis.

### Two claims in the issue and the bundle that do not hold against this tree

Both are load-bearing, and correcting them is most of why this ADR exists.

**(a) The existing picker search is not project-scoped.** The issue and the bundle both
describe the count as riding on "the existing project-scoped resource search". There is no
such thing. `useResourceSearch` issues `GET /resources/?search=` and `useSkillFitSearch`
issues `GET /resources/?search=&task=` — the **org-wide** catalog, gated `IsAuthenticated`
(ADR-0034), with `email` stripped for non-admins (#891) and a 60/min throttle. Neither
passes a project id, and `ResourceSearchCombobox`'s props are `{onSelect, onDismiss,
taskId}` — the component is not given `projectId` and therefore *cannot* name the project
to exclude. The picker is project-scoped in its **knowledge**, not in its result set. This
is a design constraint, not a quibble: it is why the count cannot simply be a new field on
the existing list response (§4).

**(b) Every project member can already read one resource's assignments across all of their
own projects — in a single request.** `TaskResourceViewSet` reads are gated
`IsProjectMember` (Viewer+), because the `CanAssignResource` in its `permission_classes`
returns `True` unconditionally on safe methods. Its `get_queryset` scopes to
`task__project_id__in=member_project_ids` — **every project the caller belongs to**, not
just the project in the URL — and it honors `?resource=<uuid>`. So

```
GET /api/v1/projects/{any-project-I-am-in}/task-resources/?resource=R
```

already returns, to any Viewer, every `TaskResource` row for `R` across the caller's entire
membership, with task ids, project ids and units. That single fact decides §3.

## Decision

### 1. A new project-nested read endpoint, not a field on an existing response

```
GET /api/v1/projects/{project_pk}/resource-booking-signal/?resource=<uuid>&resource=<uuid>…
```

Read-only, on a `ProjectScopedViewSet`. Response:

```json
{"basis": {
   "scope": "workspace_excluding_current_project",
   "excludes": ["draft_projects", "archived_projects",
                "backlog_tasks", "complete_tasks", "deleted_tasks"],
   "includes_untracked_assignments": true
 },
 "results": [
   {"resource": "…", "state": "ok",      "count": 6},
   {"resource": "…", "state": "none"},
   {"resource": "…", "state": "unknown", "cause": "no_linked_account"}
 ]}
```

`basis` is the §9 predicate, stated. It is a **response-level constant** — identical for
every caller, every project and every resource — so it discloses nothing and costs nothing,
and it is the difference between a number that can be cited and a number that has to be
believed. See §10 for why a decision-grade integer without it is a defect rather than a
nicety.

**The response shape is the primary security control.** No task ids, no project ids, no
project *count*, no dates, no units, no names. Any one of those turns this into a
project-scoped `ResourceViewSet.assignments` (ADR-0499) behind a weaker gate than the
`IsOrgAdmin` that action carries precisely because it names things.

Four rules the shape has to hold:

- **Every requested id appears in `results`.** An omitted id renders as nothing, and
  nothing renders as free.
- **More than 20 ids is a 400**, never a silent truncation, for the same reason.
- **`pending` never appears on the wire.** It is the fourth arm of the client union (§7)
  and is a client-only state. A wire `pending` would be an invitation to poll.
- **The value is caller-independent.** It falls out of §3 and is worth stating because it
  is load-bearing for caching: the count is the same integer for every caller, so it caches
  per `(project_id, resource_id)` with no per-user key. Viewer-scoping would have made the
  cache per-user and the §6 side channel harder to bound.

### 2. The gate is `[IsAuthenticated, IsProjectMember, IsProjectScheduler]`

**Gate the advisory on the authority to act on it.** SCHEDULER (ordinal 200, "Resource
Manager", ADR-0072) is exactly the floor at which a caller may perform the write this
advisory precedes — `TaskResourceViewSet` gates assignment writes at SCHEDULER+. So the
count can never be reached by someone who cannot act on it, and can never 403 someone who
can. The four candidates, and why the other three fail:

| Gate | Verdict |
|---|---|
| `IsAuthenticated` (the ADR-0034 catalog read gate) | **Reject.** Hands every authenticated account in the install a workforce workload profiler. |
| `IsOrgAdmin` (the ADR-0499 gate) | **Reject.** A PM or Scheduler is not necessarily an org admin; this 403s the people the feature exists for. Widening it instead would undo a gate narrowed on purpose. |
| `IsProjectMember` alone (Viewer+ on this project) | **Reject.** A Viewer cannot assign anyone, so the advisory informs no decision they can make. Disclosure without purpose. |
| **`IsProjectMember` + `IsProjectScheduler`** | **Accept**, per the principle above. |

**Do not reach for `CanAssignResource` here, despite the name.** Its `has_permission` reads
`if project_pk is not None and request.method not in ("GET", "HEAD", "OPTIONS")` — on a GET
it returns `True` unconditionally. Composing `[IsAuthenticated, IsProjectMember,
CanAssignResource]` on a read yields an effective gate of **Viewer+**, and every test that
only asserts "SCHEDULER succeeds" passes on it. `IsProjectScheduler` enforces the floor on
all methods once `project_pk` resolves. The pytest must assert **MEMBER and VIEWER receive
403**, not merely that SCHEDULER and above succeed.

`IsProjectNotArchived` is deliberately **not** composed: this is a read, and refusing to
answer on an archived project would manufacture an `unknown` for no privacy reason.

#### This gate is one band weaker than ADR-0499's, and that is the point

Stated rather than left to be discovered: SCHEDULER is ordinal **200** and `IsOrgAdmin` is
`role__gte=ADMIN`, ordinal **300** (ADR-0072). So this endpoint is reachable by a band that
cannot reach `ResourceViewSet.assignments`. That is deliberate and it is a correction, not
an erosion. ADR-0499 itself records that it uses `IsOrgAdmin` as a *proxy* for the
resource-manager capability — and against ADR-0072 that proxy is off by one band, because
the persona whose entire job is allocation ("Resource Manager", the label ADR-0072 gives
ordinal 200) does not clear it. ADR-0774 calls `POST /task-resources/` "a Scheduler's whole
role."

The divergence is safe because the two endpoints carry different payloads, and ADR-0499's
own rationale is written against the payload rather than the audience: task and project
names are "project-scoped confidential data… it would tell any authenticated user which
projects a colleague is on and what those tasks are called." A bare integer names no task
and no project. What it does still carry is the second clause in weaker form — *that* a
colleague is on N things elsewhere — which is precisely the disclosure §3 decides
deliberately rather than inherits.

The rule to carry forward: **the gate follows the payload, not the sibling endpoint.** A
future action on this route that adds a name or an id inherits ADR-0499's gate, not this
one.

#### Throttle

A dedicated throttle scope at **30/min** (mirroring `ResourceCatalogThrottle`'s pattern,
not its rate). The arithmetic is a harvest ceiling, not an interaction limit: at 20 ids per
request, 60/min would be 1200 resource-counts per minute for one account. The interactive
path fires once per settled keystroke, after paint, cached 60 s — 30/min is roughly ten
times the headroom it needs.

This follows the three-part remedy ADR-0061's #815 amendment established after a
pre-release review found the *members* typeahead could be paginated to harvest the
workspace's email list from one low-privilege account: **strip the sensitive field, tighten
the gate, add a per-user throttle.** This design does all three (§1, §2, here). The
precedent is close enough to be binding — that was also a picker, and this is the same
attack with a different column.

### 3. "Elsewhere" is the whole workspace minus this project — on utility grounds, and the leak is stated

`Workspace` is a **singleton installation-wide configuration** (ADR-0087); OSS has no
tenancy boundary (multi-tenancy is Enterprise). So "workspace" means the whole install, and
"elsewhere" means every project in it except this one.

The bundle (`B5`/`B6`) reaches this conclusion by arguing that **viewer-scoping leaks
project membership by differencing** — Dana sees 6, Sam sees 4, so Sam learns a project
exists that he is not on. That argument is **inverted**, and Context (b) is why:

- **Viewer-scoping discloses nothing.** A viewer-scoped count is a `len()` of a response
  the caller can already fetch in one request. It is not a weaker disclosure than the
  workspace count; it is a **no-op** — a convenience aggregation of data the caller is
  already entitled to read.
- **Workspace-scoping is the more disclosive option, and it discloses to a solo actor.**
  Given `N_workspace`, any caller computes their own `N_visible` from that same existing
  request and derives `N_hidden = N_workspace − N_visible` alone. The bundle's differencing
  attack needs two colluding viewers to yield a *weaker* version of what one viewer gets
  unaided here.

So the honest statement is not that workspace-scoping is private. It is that **the
feature's entire information content is the leak**: the only new fact this endpoint can
possibly deliver is `N_hidden`, the count of a person's committed tasks in projects the
caller cannot see. There is no version of this feature that both works and discloses
nothing — viewer-scoping is a no-op and workspace-scoping is the leak.

We ship the leak, deliberately and bounded, because it is the whole point: the PM who books
someone already committed, with no signal, goes back to a spreadsheet. And what is
disclosed is a **magnitude about a person**, not the identity, location, timing, or
contents of any project.

#### This departs from the house pattern for cross-project aggregates — narrowly

Two Accepted ADRs establish that a cross-project aggregate is legal in OSS *because* it is
member-scoped: **ADR-0663** computes utilization over "each `Project` the user has a
`ProjectMembership` on with `role >= Role.SCHEDULER`", and **ADR-0221** is the same shape at
program level. **ADR-0499** names the same guard from the other side — `TaskResourceViewSet`
is "deliberately scoped to the requesting user's member projects as an IDOR guard, so it
under-reports a cross-project picture by construction," and says in as many words that
computing an *unscoped* count "is a deliberate departure from that guard and needs its own
decision." This ADR is that decision.

The departure is narrow, and the reason those precedents do not transfer is specific rather
than convenient. ADR-0663's and ADR-0221's aggregates are **derived values** — utilization
percentages, health rollups — that a member could not cheaply reconstruct from rows they can
already read, so member-scoping there still delivers most of the value while holding the
guard. This aggregate is a **count of rows the member can already fetch in one request**
(Context (b)), so member-scoping delivers exactly none of it. The house pattern is not
wrong; it is inapplicable, because here it degenerates to a no-op. That leaves two options,
ship the leak or do not ship the feature, and this ADR chooses the first with the leak
named.

Anyone tempted to widen this precedent should note the test it turns on: *does member-scoping
still deliver the value?* Where it does — which is nearly everywhere — ADR-0663 and ADR-0221
govern and this ADR does not apply.

Two consequences the bundle understates, recorded rather than papered over:

- **`B8`'s residual leak is general, not a small-workspace edge case.** The bundle frames
  location-inference as a two-project-workspace curiosity. The general form: **a viewer who
  is a member of P−1 of P projects attributes the entire hidden remainder to the single
  project they cannot see.** That is not an edge case — it is the ordinary position of a
  senior PM or resource manager, which is to say the primary user of this picker. Accepted.
  The viewer supplies the localization from their own membership knowledge, which is their
  own data; the endpoint still names nothing.
- **Small workspaces are still not special-cased**, and `B8` is right about why:
  suppressing the signal where collisions are likeliest would invent a fourth state of
  nothing, and a number that disappears under conditions the reader cannot see is worse
  than a number that is occasionally inferable.

### 4. Why a separate endpoint rather than a field on `/resources/`

Three independent reasons, any one sufficient:

1. `/resources/` is not project-nested, so neither the SCHEDULER floor nor "which project
   to exclude" is resolvable there. A `?project=` query param would carry the project
   without carrying any gate that can check it.
2. Its gate is `IsAuthenticated` org-wide. A field added there is a field at Viewer+.
3. `B14` requires the count to be **off the results path** — rows render on the two
   existing queries and the count arrives after paint. A separate endpoint *is* that
   separation, structurally, instead of by convention in a serializer that could later be
   made eager.

### 5. Drafts are excluded — `B7` is overturned, and `lifecycle.py` is untouched

`B7` includes DRAFT projects, reasoning that an uncommitted plan is still a commitment
someone has been told about, and the issue thread anticipated recording that deviation in
`projects/lifecycle.py` as a stated exemption. **We exclude drafts instead**, on three
grounds that agree:

- **This is the paradigm case for the exclusion list.** `lifecycle.py` says to apply it to
  "any queryset feeding a rollup, a health figure, a search result…". This is literally an
  aggregate over a project population, and the module's stated harm applies verbatim: a
  half-built plan inside it makes the number a guess.
- **Draft ≠ committed, and the noun is the whole feature.** The signal says "this person is
  committed elsewhere". A draft is by definition a plan nobody has agreed to. Counting it
  inflates the number with work that may never happen, and the reader cannot tell which
  part. The feature carries no dates and no capacity arithmetic precisely so that the one
  integer can be trusted; `B7` spends that trust.
- **Including drafts is the more disclosive choice.** A draft is the most sensitive project
  state — exploratory, often about moving people around. "R is penciled into something" is
  a larger disclosure than "R is booked", and it is also the noisiest series feeding §6.

The predicate fits `exclude_draft_projects(qs, path="task__project")` exactly — shape 2 of
the three, single-valued path, no new predicate written at the call site. **No fourth shape
is needed and `lifecycle.py` requires no amendment.** The rule that module states is "no
surface writes its own draft-exclusion predicate"; following it, rather than deviating from
it, is why there is nothing to record there.

### 6. The temporal side channel is accepted and named

Absent from the bundle. The count is a **series**, not a value. `R` moving from 3 to 9
between Monday and Tuesday discloses that work started somewhere the caller cannot see, and
roughly when; sampled across the catalog over days it builds an activity map of projects
the caller has no access to.

No mitigation short of not shipping the feature — the throttle bounds the sampling *rate*,
not the signal. Accepted, on the same ground as §3: the population sharing a workspace is
one organization, and the catalog is already open to it. Two things do reduce the amplitude
and are chosen partly for that reason: the draft exclusion (§5) removes the churniest
projects from the series, and the 60 s cache is a **server-side** ceiling, not only a
client one.

### 7. The client contract is a four-way union with no default branch

`B11`, adopted as written. `{ok, count} | {none} | {unknown, cause} | {pending}` — a
discriminated union, exhaustively switched, **no default branch in the renderer**. The
reason is specific: `count ?? 0` and `{count && …}` both silently render "unknown" as
"free", which is the single worst outcome this feature can produce. A confidently wrong
"free" is acted on; an honest "can't check" is not.

Both halves of that have precedent and neither is novel. **ADR-0172** makes `unknown` a
first-class status rendered on its own — "explicit, **never fabricated**" — rather than
collapsed into a zero or a null. **ADR-0104** states the inverse rule for aggregates: a
project that cannot be included is *excluded*, "**never zero-filled** — a zero-fill would
let a [reader] infer non-sharing or dilute an aggregate." `none` and `unknown` are therefore
different states on the wire because they are different states in the domain, and the union
is what stops the renderer from merging them. (The nullable-integer style does exist in the
corpus — ADR-0698 uses `date | null` — so this is a choice between two live conventions,
not a correction of one. It is chosen here because this value's failure mode is
*actionable*: someone books a person on it.)

`unknown` fires when `resource.user_id is None`, cause `no_linked_account`. This is
grounded, not hypothetical: a resource with no linked user account genuinely cannot be
correlated to `Task.assignee` at all (the same limit `_check_overallocation` documents).
It fires **even when `TaskResource` rows exist** for that resource — the count would then
be a floor missing an unbounded bare-assignee population, and a number that may be
arbitrarily low is not a number. The cost, accepted: unit-tracked assignments on unlinked
resources (equipment, teams, legacy rows) are not reported.

### 8. Copy, placement, and what is struck

- Row string: **`6 elsewhere`** (`B3`). Summary: **"Assigned to 6 other tasks in this
  workspace. Which tasks and which projects are not shown."** The second sentence is
  `B4` and is not optional — without it the number reads as a withheld link and the
  workaround is asking an admin.
- **Count tasks, never projects** (`B2`). A project count is low-cardinality, so a reader
  who knows her own memberships subtracts her way to a shortlist of names. A task count
  spans one project or six and reduces to no noun. It also makes §9's two-arm union
  trivially correct: deduping by task is what "count tasks" already means, where counting
  projects would need a separate dedupe. Banned: project counts, dates, percentages,
  "overbooked", "busy elsewhere".
- `unknown` row string: **"Can't check · no account linked"** (`B13`).
- Accessibility (`B17`): the count goes in the option's accessible name as **visible text**
  plus an `sr-only` completion **inside the same option**. No `title`, no `aria-label` on
  the option — an `aria-label` replaces the accessible name and would drop the skill chips.
  This is rule 328(b): a fact stated only in a `title` is not stated.
- Advisory ordering (`B9`): the cross-project line is **third**, after the two existing
  banners — `resource_overallocated`, then `skill_mismatch`, then this.
- **`B20` is struck.** It asserts the matched/missing skill distinction is carried by a
  dashed border alone. False in this tree: `ResourceSearchCombobox.tsx:226` already renders
  `` name={`Missing: ${ms.skillName}`} ``, and `SkillChip`'s `missing` variant selects
  `border-semantic-critical/40 text-semantic-critical bg-semantic-critical-bg`, not a
  dashed border. The real 328(b) defect on those rows is proficiency stated in a `title`
  plus `aria-hidden` dots, filed separately as **#3200**. Do not implement `B20`.
- `B7`'s "cancelled / template project" exclusions name states that do not exist on
  `Project` in this tree — there is no cancelled lifecycle (the `CANCELLED` members nearby
  belong to `SprintState`), and templates are a separate model (ADR-0789), not a flag on
  `Project`. Only `lifecycle` and `is_archived` are real. `B7`'s "exclude the task being
  assigned" is redundant: that task is in this project, which is already excluded.

### 9. The count, defined once

`count(R, P)` is the number of **distinct tasks** `T` where all hold:

- `T.is_deleted` is false, and `T.project != P`
- `T.project.lifecycle != DRAFT` — via `exclude_draft_projects(qs, "task__project")` (§5)
- `T.project.is_archived` is false
- `T` is in `Task.committed` (ADR-0057 — excludes BACKLOG) and `T.status != "COMPLETE"`
- and **either** a `TaskResource(T, R)` row exists, **or** `R.user_id is not None and
  T.assignee_id == R.user_id`

The two arms are deduped by task id, which counting tasks gives for free.

The committed/non-complete predicate is deliberately **the same population**
`_check_overallocation` uses for the in-project banner, differing only in the aggregate
(count of tasks vs. sum of units). If the two surfaces disagreed about what work is, the
banner and the line would contradict each other on one screen and the PM would stop
trusting both.

The bare-assignee arm is not optional. #3047 established that a read-side capacity figure
which counts only `TaskResource` rows understates reality, because the most common shape is
a task with an `assignee` and no assignment row. Counting only `TaskResource` here would
render "0 elsewhere" — a confident *free* — for a person bare-assigned to twelve tasks.

### 10. The AI surface: `basis` is required, and MCP readability waits on it

`ai-review` returned **two gaps**, both closed here rather than deferred.

**A decision-grade number with no derivation is a defect.** The count is determined by five
predicates and a two-arm union (§9), none of which is on the wire. Two failure modes follow
from the same root. A PM who counts eight in her head against a line that says six has no
way to reconcile the difference and stops trusting the number permanently — the issue
thread's own warning, that each wrong exclusion "produces a number a PM notices once and
then never trusts again." And an agent handed a bare integer with no population definition
will **invent one**: it will read "6" and emit "Ashley is overallocated, don't assign" —
which is *scoring*, the exact thing ADR-0499 §3 puts on the Enterprise side of the line.

The resolution is that **the predicate is not confidential; the rows are.** The endpoint can
say what it counted without saying what the things are, so `basis` (§1) ships as part of the
response contract rather than as documentation. It is the provenance surface, and it is free.

**MCP readability is deliberately deferred, and gated on the above.** This endpoint is
**not** declared `McpReadableViewMixin` in this iteration. Recorded as a decision, not an
omission, because "undeclared" would otherwise read as an oversight to some later session:

- The reason is not the gate. An MCP token resolves to a user with a project role, so
  `IsProjectScheduler` and the throttle apply to it exactly as to a browser.
- The reason is §6. A caller that can poll on a schedule turns the temporal side channel
  from something a human might notice into something a program samples continuously, and
  the count is the one value on this surface whose entire content is a bounded leak.
- Revisit once `basis` has shipped and the count has a citable population — an agent that
  can quote what it counted is materially less likely to fabricate a verdict over it. Until
  then, exposing the bare integer to a model is the failure mode above with an automation
  budget.

This is a narrower answer than `lifecycle.py`'s MCP exemption and does not contradict it.
That rule is about **rows vanishing from a list**, where an agent cannot tell absence from a
404. Nothing vanishes here: every requested id gets a row in `results` (§1), and the
excluded populations are named in `basis`. The agent is told what it is not being told.

**Three checks pass and are recorded so the next iteration does not re-derive them.**

- *Write safety* — n/a. Read-only, no mutation, no agent write, so no `verdict` audit
  obligation. **Forward constraint:** the advisory deliberately does not block (ADR-0028
  posture, §Context). If a later iteration ever refuses an assignment on this signal, that
  refusal becomes an agent-auditable event and needs a `refused` entry with an
  `identity`-vs-`policy` reason — and it is also the point at which the feature has crossed
  into the Enterprise enforcement half.
- *Decision memory* — a deliberate **non-goal**. "The PM booked Ashley knowing she had six
  elsewhere" is arguably a slip cause worth a retro, but capturing it would make this the
  first advisory in the product with a memory, inconsistent with the existing overallocation
  banner which records nothing, and would turn an advisory into a surveillance surface
  ("who overrode the warning") that nobody asked for.
- *AI boundary* — holds. Team-level count beside a picker row is OSS; cross-program
  leveling, the portfolio heat map, utilization *scoring* and pre-commit enforcement are the
  Enterprise counterpart and are already filed there. No new extension point, so no
  ADR-0029/0030 slot registration is required.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Chosen: new project-nested endpoint, workspace scope, SCHEDULER+, drafts excluded** | Gate matches the authority to act; response shape carries no names or ids; count is caller-independent and cacheable | Discloses `N_hidden` to SCHEDULER+; residual localization when the viewer sees P−1 of P projects; temporal side channel |
| Reuse `ResourceViewSet.assignments` | Exists today | 403s every non-org-admin — i.e. most of the intended audience — or forces widening an `IsOrgAdmin` gate that exists to protect task and project *names* |
| New field on `GET /resources/` | No new route | Not project-nested, so neither the gate nor the excluded project is resolvable; ships at Viewer+; puts the count on the results path, against `B14` |
| Viewer-scoped count (`B5`/`B6`'s rejected option) | Intuitively "more private" | A **no-op** — it aggregates data the caller can already fetch in one request — and it fails the exact case the feature exists for: the PM booking someone into a project she cannot see |
| Blur or suppress below a threshold | Bounds the leak | Invents a fourth state of nothing exactly where collisions are likeliest; a number that vanishes under invisible conditions is not trustworthy (`B8`) |
| Include drafts (`B7`) | Counts demand that is about to become real | Makes the integer a guess; "committed" is the noun the feature sells; discloses the most sensitive project state and feeds the §6 series hardest |

## Consequences

**Easier.** The gating principle — *gate an advisory on the authority to act on it* — is
now written down and reusable; it is a better default than either "reuse the strictest
existing gate" or "inherit the base read gate". The caller-independent count caches without
a per-user key. Following `lifecycle.py` rather than deviating from it means no amendment
there and one fewer place for the draft rule to fray.

**Harder.** `ResourceSearchCombobox` must be given `projectId` (it has only `taskId`
today); `ResourceAssignmentSection` already holds it, and the vitest mock at
`ResourceAssignmentSection.test.tsx:56` must move in the same commit. The flat
(non-skill-mode) render path renders `{r.name}` and nothing else, so it has no layout to
hang a second line off — the count has to land in **both** paths, and the bundle's mock
frame (modal header, footer, `Cancel`/`Assign`) does not ship: the real surface is an
inline `max-h-56` dropdown with no chrome but the input.

**Risks.** (1) The disclosure in §3 is permanent and cannot be walked back once integrators
depend on it. (2) Response-shape creep re-creates ADR-0499's payload behind a weaker gate —
mitigated by a pytest asserting the response body's **exact key set**, not merely the
absence of names; the issue's acceptance criterion as written ("asserts no name leaks")
passes on a payload leaking project ids. (3) `CanAssignResource`'s GET short-circuit is a
live trap for the implementer, addressed in §2. (4) `basis` (§1) is safe **only** while it
stays a response-level constant; the moment anything in it varies per resource or per
caller it becomes a channel, and the same exact-key-set test should pin its shape too.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** api, web
- **Migration required:** no — no model change. `migration-check` and
  `api:migration-constraint-safety` are `n/a` for the implementing MR.
- **API changes:** yes — one new project-nested read route (§1), carrying `basis` and a
  four-state per-resource union; `docs/api/openapi.json` regenerated. Not declared
  MCP-readable in this iteration (§10).
- **OSS or Enterprise:** OSS. `enterprise-check` ran on #3155 and returned OSS as a
  basic-vs-governance split; the Enterprise counterpart is cross-program leveling, the
  portfolio heat map, and pre-commit enforcement.
- **Broadcast:** none. No write path, no board-scoped mutation — `broadcast-check` is `n/a`.

### Durable Execution

1. **Broker-down behaviour:** N/A — pure read endpoint, zero async side effects.
2. **Drain task:** N/A — no async work dispatched.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A for dispatch. The count predicate (§9) still gets one named
   function in the resources app rather than an inline queryset, so the in-project banner
   and this line can be asserted against the same definition.
5. **API response on best-effort dispatch:** N/A — synchronous 200. `pending` is a
   client-side state and never appears on the wire (§1).
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** idempotent by construction (GET, no mutation). The 60 s server-side
   cache is keyed `(project_id, resource_id)` and is caller-independent (§1), so repeats
   are indistinguishable.
8. **Dead-letter / failure handling:** N/A for async. On the synchronous path, a query that
   exceeds the client's 1200 ms budget yields `pending` client-side, which the renderer
   promotes to `unknown` at the budget (`B14`) — never to `none`.
