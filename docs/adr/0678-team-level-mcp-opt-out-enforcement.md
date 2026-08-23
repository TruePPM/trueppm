# ADR-0678: Team-level MCP opt-out — restrictive-only consent cascade and a fail-closed enforcement point

## Status
Accepted — status corrected 2026-07-29 after ADR audit (#2539, verified: `McpScope` enum,
`filter_queryset` hook in `access/permissions.py`, `mcp_enabled` migrations on
`Program`/`Workspace`).

## Context

The read-only MCP surface (ADR-0186 §E) is reachable by any personal API token
carrying `mcp:read`. ADR-0497 gave the *operator* a single instance-wide kill
switch (`TRUEPPM_MCP_ENABLED` → the `McpInstanceEnabled` guard). #2415 surfaced
the complementary gap from the Agile-Coach persona:

> *"Consent that only an admin can grant or revoke on the team's behalf is
> consent in name only."* — Morgan

#2415 split into a frontend half (#2481 / ADR-0677 — the Agents sub-view, an
*after-the-fact log*) and this half: the control that actually **blocks**. A team
must be able to say "no agent reads our data," and that decision must hold
regardless of the requester's token scope and regardless of what a scope above
the team would prefer.

### What is already right

`McpReadableViewMixin.mcp_token_guards()` (`apps/access/permissions.py:1311`)
returns four ANDed guards: `McpInstanceEnabled` → `TokenReadOnlyMethods` →
`TokenHasScope('mcp:read')` → `TokenIsOwnerScoped`. Every one of them returns
`True` unconditionally for human JWT/Session auth, so nothing here can affect
normal user access on the shared viewsets. A fifth guard drops in beside them,
and because the guards are ANDed, *"neither switch overrides the other in the
permissive direction"* holds **by construction** — no precedence logic to write
or test. The refusal audit is free: `finalize_response()` already records a
`POLICY` / `CAPABILITY_SCOPE` refusal for any denied read
(`permissions.py:1342–1437`).

### The blocker

A DRF permission class cannot see which project is in scope. `_mcp_audit_target`
(`permissions.py:1439`) resolves `project_id` **only** from
`view.kwargs['project_pk'|'project_id']` or the pk of a `Project` retrieve, and
its docstring documents it as best-effort and total-by-construction. That is
correct for an audit row and **disqualifying for a security gate**: it is `None`
for every collection endpoint. A guard-only opt-out is therefore bypassed by any
list endpoint that carries the project as a query param (`/tasks/?project=X`) —
the same confused-deputy shape #1712 closed with `TokenIsOwnerScoped`.

### The surface, enumerated exhaustively (19 subclasses, AST-derived)

| Shape | Views | Can a guard see the project? |
|---|---|---|
| Project in URL path | `ProjectOverviewView`, `BoardColumnConfigView`, `ProjectSprintHealthView`, `ProjectForecastView`, `ProjectSprintForecastView`, `MonteCarloLatestView`, `MonteCarloWhatIfView`, `ScheduleDerivationView` | **Yes** |
| ViewSet *detail* actions | `Project`/`Task`/`Risk`/`Label`/`Sprint`/`Program`/`BacklogItem` ViewSets | Yes (via pk → project FK) |
| ViewSet *list* actions | the same seven ViewSets | **No** |
| Cross-project aggregators | `MeSearchView`, `MeWorkView`, `WorkspaceAssetsView` | **No** — by design, they span projects |
| No project data at all | `MeView` (`auth/me/` — identity echo) | N/A |

This is why the working recommendation on #2482 (option C, "one central
`mcp_scope_queryset` hook in the mixin") **cannot be uniform as stated**: 8 of the
19 views are plain `APIView` with no `queryset` attribute, and 3 of those are
aggregators that assemble their response by hand. The mechanism has to be
two-part, and the third part is what stops a *future* view from silently failing
open.

P3M layer: **Programs and Projects** — a single team's consent over reads of its
own data. `grep -r 'trueppm_enterprise' packages/` returns zero on all touched
code.

## Decision

### 1. A restrictive-only (monotone) consent cascade — *not* an ADR-0135 override

`mcp_enabled` is added with the same field name at three scopes, following the
ADR-0135/0144/0151/0153/0510 family's tri-state shape:

* `Workspace.mcp_enabled` — `BooleanField(default=True)`, non-null root
* `Program.mcp_enabled` — `BooleanField(null=True)`, NULL = *no opinion*
* `Project.mcp_enabled` — `BooleanField(null=True)`, NULL = *no opinion*

**It diverges from that family in one load-bearing way: the cascade is AND, not
override.** The effective value is

```
effective(project) = TRUEPPM_MCP_ENABLED
                 AND workspace.mcp_enabled
                 AND (program.mcp_enabled  is not False)
                 AND (project.mcp_enabled  is not False)
```

Any scope may deny for itself and everything beneath it. **No scope may grant
over a denial from any other scope.** A NULL means "no opinion", never "yes".

This is deliberate and it is the whole point of the ADR. For sharing and
attachments, a workspace `ENFORCE` lock is a *security ceiling* and pointing it
downward is coherent. For a **consent** switch it is not: an org-level lock that
could force MCP back **on** for a team is precisely "consent in name only" —
the objection this issue exists to answer. Making the cascade monotone means the
consent property is structural rather than promised, and it makes the
team switch compose with the ADR-0497 instance switch under exactly the rule
#2415 demanded, on the inheritance axis as well as the kill-switch axis.

**Consequence, stated plainly:** there is deliberately **no**
`mcp_override_policy` / `ENFORCE` field and **no** Enterprise enforcement
provider seam for this setting, breaking symmetry with `attachment_policy.py`.
Enterprise governance retains the only lever that is coherent here — turning MCP
off at the workspace scope, org-wide, which the cascade already honors. That is
a governance capability; forcing it *on* is not one.

Resolution is computed-on-read (ADR-0108) in a new
`apps/projects/mcp_settings.py`, mirroring `attachment_policy.py`'s
`resolve_* / resolve_inherited_* / _parent_* / _program_of` shape. Serializers
expose `effective_mcp_enabled` / `inherited_mcp_enabled` so no client
re-implements precedence. The columns are **not** in `_HISTORY_EXCLUDED_BASE`, so
every flip is captured by `HistoricalRecords` — a consent control whose changes
are not audited is not a consent control.

### 2. Scope is the **project**, not the sprint

#2482 says "team/sprint settings". The enforcement scope is the **project**. A
sprint is a child of a project with no independent membership boundary; MCP reads
reach sprint rows *through* project-scoped views, so a sprint-level switch would
create a scope the enforcement point cannot see uniformly, and would fragment one
consent decision into N per-sprint decisions that a token could route around by
reading the parent. The project is the team. The sprint settings surface links to
the project-level control rather than duplicating it.

### 3. Enforcement: declare-or-deny, with two mechanisms behind one chokepoint

Every `McpReadableViewMixin` subclass **must** declare how it is MCP-scoped:

```python
class McpScope(StrEnum):
    PATH      = "path"       # project resolvable from URL kwargs -> guard enforces
    QUERYSET  = "queryset"   # mixin filters rows by project FK
    AGGREGATE = "aggregate"  # view calls mcp_visible_project_ids() itself
    NO_PROJECT_DATA = "none" # response carries no project-scoped data at all
```

`McpReadableViewMixin.mcp_scope: ClassVar[McpScope | None] = None`, and the new
`McpProjectEnabled` guard **denies any token read on a view that has not declared
one**. A future MCP-readable view that forgets therefore fails **closed** at
runtime, not open — the property option B could not offer. The mechanisms:

* **`McpProjectEnabled` guard** (appended to `mcp_token_guards()`, after
  `McpInstanceEnabled`). For `PATH`, resolves the project from
  `view.kwargs['project_pk'|'project_id']` — or, on a `Project` detail route, the
  pk — and denies **403** when the resolved project is opted out. Human
  JWT/Session callers pass unconditionally, as with every other guard. For
  `QUERYSET` / `AGGREGATE` / `NO_PROJECT_DATA` the guard passes and the
  corresponding mechanism below carries the enforcement. Detail actions of a
  `QUERYSET` viewset are additionally covered because the filtered queryset is
  what resolves the object — a 404, not a leak.
* **Central queryset scoping**, hooked at **`filter_queryset()`** — not
  `get_queryset()`. This distinction is load-bearing: **three of the eight
  queryset-backed MCP viewsets build their queryset from scratch instead of
  calling `super().get_queryset()`** (`ProgramViewSet`, `BacklogItemViewSet`,
  `MeWorkView`), so a `get_queryset` override on the mixin is never reached for
  them and would fail *open* on precisely the collections that matter. DRF calls
  `filter_queryset()` from both `ListModelMixin.list()` and
  `GenericAPIView.get_object()` however the queryset was built, and no MCP-readable
  view overrides it. The mixin *also* filters in `get_queryset()`, for the five
  viewsets that do chain and for actions reading `self.get_queryset()` directly
  without `filter_queryset` (`ProjectViewSet.health_summary`); the narrowing is
  idempotent, so double-filtering is harmless. Project resolution reuses the
  FK-path introspection `ProjectScopedViewSet.get_queryset` already performs
  (`project` FK → `predecessor__project` → `Project` itself → `program` FK).
* **`mcp_visible_project_ids(request)` helper** for the three aggregators, which
  build responses by hand and cannot be filtered generically.

A **conformance test enumerates every `McpReadableViewMixin` subclass** (the same
AST/`__subclasses__` walk used to build the table above) and asserts each declares
an `mcp_scope`; for `AGGREGATE` it asserts the view module calls the helper. The
runtime default already fails closed — the test exists so the failure surfaces in
CI rather than as a support ticket.

### 4. Aggregators filter silently; the audit row says so

`MeSearchView`, `MeWorkView` and `WorkspaceAssetsView` **exclude rows from
opted-out projects and return 200**, rather than refusing wholesale. Refusing
wholesale would let one team's consent decision break a *different* team's access
to its own data through a shared personal endpoint — one project opting out would
blank a contributor's entire cross-project work list. Silent filtering is the
correct behavior for an aggregator, and it is stated here because it is a real
information-hiding choice, not an implementation detail. `MeView` is
`NO_PROJECT_DATA`: it echoes the caller's identity and carries no project rows.

The honest cost, and the mitigation: a filtered list is a **200 with an `ALLOWED`
audit row**, which under-reports the refusal relative to the 403 a path-scoped
read produces. When consent filtering is applied, the mixin marks the audit row's
summary *"consent-scoped (opted-out projects withheld)"*, so the Agents panel
(#2481) never shows an unqualified allow for a read that was narrowed. This is a
**flag, not a count** — reporting "withheld N" would need a second aggregate query
on every filtered read, which is not worth it for an annotation. Verdict stays
`ALLOWED` deliberately: `AgentActionVerdict` is consumed by the just-merged #2481
UI and by `AgentActionRefusalReason` typing on the web client, and adding a
`PARTIAL` member is a breaking enum change not worth taking inside 0.4. Follow-up
candidate, filed on merge rather than assumed.

### 5. RBAC — Admin+ flips it

Writing `mcp_enabled` requires project role **≥ ADMIN**, enforced field-level in
`ProjectSerializer.validate()` alongside the other general settings.
`ProjectViewSet.update` gates at `IsProjectScheduler`, so the field-level check is
what stops a Scheduler from flipping it — the same split ADR-0041 already uses.
Program and Workspace scopes gate on their existing admin permissions.
Owner-only was considered and rejected: the PM cohort is the team's decision-maker
here, and Owner-only would make the control unusable on projects whose owner has
left.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Guard + per-view queryset exclusion on all 19** | Actually closed; explicit at each site | 19 hand-written checks; a future view forgets and fails **open** — the defect the design must prevent |
| **B. Guard only, path-scoped views** | Smallest diff | **Fails open on every collection.** Not shippable as a consent control; ships the appearance of protection, which is worse than none |
| **C. Central `mcp_scope_queryset` hook only** (#2482's working rec.) | One chokepoint | Cannot be uniform: 8 of 19 views have no queryset, 3 are hand-built aggregators. Correct instinct, insufficient alone |
| **D (chosen). Declare-or-deny + guard + central queryset + aggregate helper** | One chokepoint per shape; unknown views fail **closed**; conformance test makes it loud in CI | Requires annotating all 19 views once; four mechanisms to understand instead of one |
| Override-style cascade per ADR-0135 (`ENFORCE` lock) | Symmetric with the settings family | An org lock that forces MCP **on** re-creates the exact "consent in name only" objection. Rejected on the merits |
| Sprint-level switch | Literal reading of #2482 | Enforcement point cannot see sprint scope uniformly; a token reads sprint data through project views and routes around it |

## Consequences

**Easier.** A team gets a real block, not a log. The switch composes with the
ADR-0497 instance switch with no precedence code. A new MCP-readable view cannot
silently join the surface — it must declare its scope or token reads are denied.
The audit story is free for path refusals and annotated for aggregate filtering.

**Harder.** Four mechanisms instead of one, and every future MCP-readable view
carries a one-line declaration. The `McpScope` taxonomy is a new concept
contributors must learn. The deliberate asymmetry with `attachment_policy.py` (no
`ENFORCE` seam) will read as an oversight to anyone who does not read this ADR —
the resolver module docstring must say why.

**Risks.** (1) `AGGREGATE` is enforced by a conformance test asserting the helper
is *called*, not that it is called *correctly* — weaker than the other three; the
three aggregators need direct per-endpoint tests. (2) The queryset filter adds a
subquery on opted-out project ids to token reads; it is a small `IN` over a set
that is empty on virtually every instance, and it is skipped entirely when no
project is opted out. (3) A partially-filtered 200 remains an `ALLOWED` row —
mitigated by the summary annotation, not eliminated.

## Threat model (STRIDE, condensed)

Run against this design before implementation. Findings that change the
implementation, ranked; the rest are recorded so a later reviewer does not
re-derive them.

**T1 — 🔴 Program-level aggregates bypass project scoping. Fixed in this MR.**
`ProgramViewSet` is MCP-readable, and five of its GET detail actions read **child
project** data: `schedule` (loads every member project's tasks *and every accepted
cross-project edge*), `rollup` (KPIs across projects), `projects` (per-project
counts), `task_search` (tasks across member projects), `resource_contention` (task
spans across every member project, tagged by source project). The `QUERYSET`
mechanism filters the `Program` row only — a `Program` has no `project` FK — so an
opted-out project's task data would flow out through its parent program. This is
the largest bypass in the design and precisely the "consent that does not hold"
failure. Each of the five intersects its project set with
`mcp_visible_project_ids(request)`. `ProjectViewSet.health_summary` is a *list*
action aggregating across the caller's projects and takes the same treatment.

**T2 — 🟠 Nested cross-project leakage: investigated, does not exist on the task
path.** The concern was that row-level filtering does not filter nested serializer
fields. Verified: `DependencyViewSet` is **not** MCP-readable (no mixin), and the
task read serializers expose only a `has_predecessors` *boolean* annotation — never
a nested predecessor/successor row. Cross-project edges (ADR-0120) are serialized
in exactly one MCP-reachable place, `ProgramViewSet.schedule`, already closed by
T1. Row-level filtering is therefore sufficient for Task/Risk/Label/Sprint.
Recorded as a negative finding.

**T3 — 🟠 `@action` routes that re-query instead of going through
`get_object()`/`get_queryset()`. Checked during implementation; the obligation
failed twice and is now a test (#3001).** 85 `@action` routes exist across the
seven MCP-readable viewsets. Detail actions resolving via `get_object()` inherit
the filtered queryset (opted-out → 404) and are covered. Any action reaching for
`Task.objects` / `Project.objects` directly bypasses it.

This was originally recorded as "a grep + review obligation, noted here so it stays
one". It did not stay one. Eleven `SprintViewSet` actions drifted past it (#2995),
then three more — `ProjectViewSet.retro_carryover`, `ProjectViewSet.trash` and
`MeWorkView`'s `retro_action_items` block (#3001). A control that has failed twice
is not a control, so the obligation is superseded by
`test_every_mcp_action_read_reaches_a_filtered_seam`
(`tests/apps/access/test_mcp_team_opt_out.py`).

The test asserts a **positive** property — every GET `@action` on a `QUERYSET`- or
`AGGREGATE`-scoped view reaches its rows through `self.get_object()`,
`self.get_queryset()`, `super().get_queryset()`, `self.filter_queryset()` or an
explicitly re-applied `self._mcp_filter_queryset()`, resolved transitively by one
level through `self._helper()` calls. The negative form ("no bare manager") was
tried first and cannot be written accurately: `working_calendars_preview`
legitimately re-fetches with `Project.objects…get(pk=obj.pk)` *after*
`self.get_object()` has gated it, and two other actions name `Project.objects` only
inside prose warning against it. Absence of a seam has no such false positives — it
is exactly the shape all fourteen drifted sites had. An action that reads no
project-scoped rows at all leaves the rule through a named allowlist that must carry
its reason.

`AGGREGATE` views remain outside what any static rule can prove — the scope assembles
its response by hand, so the test can see that a seam is reached but not that every
hand-built block reached it. Those still need direct per-block tests, which is how
the `MeWorkView` half of #3001 was found and is how it is now covered.

**T4 — 🟡 Filter backends re-widening after `get_queryset()`. Accepted.** DRF
applies filter/search/ordering backends *to* the queryset returned by
`get_queryset()`; they narrow, never widen. No action.

**T5 — 🟡 Opt-out enumeration oracle. Accepted.** A token can distinguish "opted
out" (403) from "not a member" (404), and can infer an opt-out from a row
disappearing. This discloses only that a project *the caller is already a member
of* has opted out — no project data, and no non-member project's existence. The
caller is the token's own minter, who sees the same switch in the UI. Not a
meaningful disclosure.

**T6 — 🟡 Self-re-enable by the restrained agent. Closed by construction; needs a
regression test.** `TokenReadOnlyMethods` confines a token to safe methods, so a
token cannot `PATCH` `mcp_enabled` — the agent cannot lift the control that
restrains it. That property is what makes this a consent control rather than a
suggestion, and it rests on a *pre-existing* guard, so it gets an explicit test
asserting a token write to `mcp_enabled` is refused. Without one, a future
reordering of the guard list breaks it silently.

**T7 — 🟡 EoP: a Scheduler flipping the switch. Fixed in this MR.**
`ProjectViewSet.update` gates at `IsProjectScheduler`; only field-level validation
stops a Scheduler (below Admin) from re-enabling MCP over the team's Admin
decision. Enforced in `ProjectSerializer.validate()` with a per-role test.

**T8 — 🟡 Repudiation: aggregate filtering records `ALLOWED`. Accepted, follow-up
filed.** Mitigated by marking the row *consent-scoped* so the Agents panel never
shows an unqualified allow for a narrowed read. A distinct `PARTIAL` verdict is the cleaner
model but is a breaking `AgentActionVerdict` change consumed by the just-merged
#2481 UI.

**T9 — 🟢 DoS from the opted-out subquery. Accepted.** Resolved once per request;
when no project is opted out (the case on virtually every instance) filtering is
skipped entirely.

SOC 2 mapping: T1/T3/T7 → CC6.1 (logical access); T6 → CC6.3 (access modification);
T8 → CC7.2 (monitoring). The `HistoricalRecords` capture of every flip → CC7.3.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: `api`, `web`
- Migration required: **yes** — three nullable/defaulted boolean columns
  (`Workspace.mcp_enabled` default `True`; `Program`/`Project` `null=True`). All
  additive, no backfill, no NOT NULL without default. One migration per the
  batch-then-generate rule.
- API changes: **yes** — `mcp_enabled` + `effective_mcp_enabled` /
  `inherited_mcp_enabled` on the Project, Program and Workspace settings
  serializers. `docs/api/openapi.json` regenerated after merging `origin/main`.
- OSS or Enterprise: **OSS**. Team-owned consent over reads of the team's own
  data is squarely the adoption side of the boundary.

### Durable Execution

1. **Broker-down behaviour** — N/A. This is a synchronous read-path permission
   check plus three additive columns. No task is dispatched on any path.
2. **Drain task** — N/A. No async work of any category is introduced.
3. **Orphan window** — N/A. No outbox rows.
4. **Service layer** — new pure-function module
   `apps/projects/mcp_settings.py` (`resolve_mcp_enabled`,
   `resolve_inherited_mcp_enabled`, `mcp_visible_project_ids`). No dispatch path,
   so no `services.py` entry point is required.
5. **API response on best-effort dispatch** — N/A. Reads are synchronous;
   enforcement is a 403 (path-scoped) or a filtered 200 (collections/aggregates).
6. **Outbox cleanup** — N/A. No outbox rows.
7. **Idempotency** — N/A for task execution. The setting write itself is an
   idempotent `PATCH` of a boolean column through the existing `IdempotencyMixin`
   on `ProjectViewSet`, so a replayed write converges on the same value.
8. **Dead-letter / failure handling** — N/A for tasks. The enforcement failure
   mode is fail-closed by construction: an undeclared `mcp_scope`, an
   unresolvable project, or a resolver exception denies the token read rather
   than admitting it. The existing refusal audit is best-effort on the refusal
   path (never turns a 403 into a 500) and fail-closed on the allow path,
   unchanged by this ADR.

## Amendment (2026-08-17, #2877) — "any token read" narrowed to "any agent-token read"

This ADR describes `McpProjectEnabled` as denying "any token read" and the mixin's row
filtering as applying to token callers. Both were written before #2547 made
`legacy:full` a general-purpose personal credential, and both therefore also caught a
member's own CI script.

The team opt-out's failure mode was the worse of the two, because row filtering is
**silent**: a filtered collection returns `200` with `count: 0`, which a nightly export
cannot distinguish from "no tasks this week". A team opting out of *agent* reads was
quietly emptying its own members' scripted reports.

As of #2877, `McpProjectEnabled`, `McpReadableViewMixin._mcp_filter_queryset`,
`mcp_visible_project_ids` and `mcp_excluded_project_ids` all consult
`trueppm_api.apps.projects.models.is_agent_token`. A `legacy:full` personal token is not
an agent and is not filtered; an `mcp:read` token is unaffected by this amendment and
every guarantee in the Decision holds for it.

The consent model itself is unchanged — restrictive-only AND, no `ENFORCE` override, no
Enterprise enforcement seam. What changed is only *who* the control is aimed at, which
is what the ADR intended all along and what the published documentation already claimed.

## Amendment (2026-08-23, #3014) — program bulk exports are serve-or-refuse, by operator policy

The Decision's enforcement section reasons entirely in terms of *narrowing*: a guard
denies a route, or a filter drops rows. Two routes fit neither shape, and this ADR did
not say what happens on them.

`ProgramViewSet.export` (the synchronous JSON seed) and
`ProgramViewSet.export_job_download` (the async `.tar.gz`) each emit **every member
project's rows in one artifact**. `ProgramViewSet` is `McpScope.AGGREGATE`, so
`McpProjectEnabled` passes unconditionally and the mixin's `Program` branch governs only
`program.mcp_enabled` — a child project's explicit "no" was therefore readable through
the parent. #3001 recorded this and deliberately declined to settle it.

**Neither artifact can be narrowed**, which is why the AND cascade has nothing to say
here. The bundle is built asynchronously and streamed from storage as opaque bytes, so
at download time there is nothing left to filter — and because `TokenReadOnlyMethods`
refuses an agent token on `POST`, the archive was always built *for a human*, so
filtering at build time cannot see the eventual agent reader either. The seed *could* be
trimmed at request time, but a seed is a re-import artifact: returning something shaped
like the program that quietly is not the program is worse than refusing.

So the lever is **serve-or-refuse**, and `TRUEPPM_MCP_PROGRAM_EXPORT_POLICY` chooses:
`withhold` (default) refuses an agent token when any member project has opted out;
`allow` treats the export as a program-level artifact governed by the program's own
setting alone. Enforced by `McpProgramExportConsent`, composed into
`ProgramViewSet._rbac_permissions()` for those two actions only — the job list and
status poll report bookkeeping that names no child project's contents, so withholding
them would cost an agent the ability to poll while protecting nothing.

**This is not the `mcp_override_policy` the Decision refuses, and the distinction is the
whole design.** That refusal is about *tenant scopes*: a workspace or program admin must
never be able to grant over a team's denial, because consent an admin can revoke on your
behalf is not consent (#2415). This setting lives in **deployment configuration** — the
operator is the person running the server, not a scope above the team inside it, and it
is the same kind of lever as the ADR-0497 instance switch the cascade already ANDs. A
future MR that promotes this to a `Workspace` or `Program` field would convert it into
exactly the override this ADR exists to prevent.

`allow` is offered rather than the question being decided once because the opposing
reading is genuinely defensible — a program-level export is a program-level artifact,
and a program admin already sees every child's data through the program surfaces. What
was not defensible was leaving it *implicit*.

Two defects were found while implementing this and are tracked separately, because both
are pre-existing and neither is specific to exports:

- **#3017** — the agent-action audit log records **zero** refusals. Under
  `ATOMIC_REQUESTS`, DRF's `exception_handler` calls `set_rollback()` for every
  `APIException`, discarding the row `finalize_response` writes on a refusal path. This
  ADR's §4 ("the audit row says so") and the T8 marker describe behavior that does not
  currently occur. The caller-facing ADR-0809 refusal envelope is unaffected and does
  work.
- **#3022** — a program that denies agent reads and has **zero** member projects is not
  withheld at all: `mcp_visible_project_ids` fast-paths on "has any *project* opted
  out?", and skips the `Program` branch when the answer is no. Narrow (an empty program
  holds no child data) but a direct contradiction of "any scope may deny for itself".
