# ADR-1324: Cost model — project budget, one resource rate, actual cost from time entries

## Status

Accepted (2026-11-06)

## Context

P3M layer: **Programs and Projects** (budget, earned value) and **Operations** (time
entries priced at a rate). OSS, ratified on #754 (2026-09-17): a PM needs cost tracking
to run a program. Date-effective rate cards, rate history and retroactive reapplication
are enterprise#45 and are out of scope here.

Before this ADR nothing in the model carried money. `RollupKpi.COST_VARIANCE` and
`BUDGET_UTILIZATION` resolved to `"no_cost_data"` unconditionally
(`program_rollup.DEFERRED_KPI_REASONS`), and `AggregationPolicy.WEIGHTED_BY_BUDGET`
always fell back to `average` with `policy_available: false` (ADR-0088). Those are three
shipped settings controls that could never compute (#3426, the #3297/#3299 dead-control
class). The user ruled on 2026-11-05 to make them compute rather than hide them.

Downstream consumers this ADR designs for but does not build:

- **#4809** prices Monte Carlo runs from these rates and adds `p50_cost` / `p80_cost`. It
  reuses the server facts named here (`budget`, `actual`, `cost_computable`,
  `missing_rate_count`, each with `as_of` and a definition), so it adds only percentiles.
- **#4810** is the cost UI: People › Rates, Project Settings › Budget, and a rate-edit
  preview. It requires the RBAC rule and the preview endpoint defined here.

Facts that were verified in the tree before deciding (2026-11-06):

- `TimeEntry` (`apps/timetracking/models.py`) always FKs a `Task`, stores integer
  `minutes`, and soft-deletes. There is **no PTO or non-project time code** anywhere in
  the model.
- `Resource.user` is a plain FK, **not unique**, so one user can back several resources.
- The project's existing percent complete is the list annotation
  `Avg("tasks__percent_complete", filter=tasks__is_deleted=False)` (ADR-0171,
  `ProjectViewSet.get_queryset`, serialized by `ProjectSerializer.get_percent_complete`).
- Project roles are self-grantable: `POST /projects/` makes the caller Owner.
  `WorkspaceRole` (a stored `WorkspaceMembership`) is not self-grantable
  (`is_workspace_admin`, #3569).
- No currency exists anywhere in the model.

## Decision

### 1. Data model (three nullable columns, one audit verb)

| Field | Type | Meaning |
|---|---|---|
| `Workspace.currency` | `CharField(3)`, default `"USD"`, ISO-4217 shape `^[A-Z]{3}$` | The one currency every amount is in. |
| `Resource.cost_rate` | `DecimalField(12, 2)`, null, `>= 0` | **Hourly** cost in workspace currency. `null` means unrated. `0` is a real rate (a volunteer or a donated resource) and counts as rated. |
| `Project.budget` | `DecimalField(16, 2)`, null, `>= 0` | BAC (budget at completion) in workspace currency. `null` or `0` means no budget. |
| `AuditEventType.RESOURCE_RATE_CHANGED` | new choice | Rate changes are written to the workspace audit log, which is Admin-only. |

The model has **one current rate per resource, with no history**. Changing a rate
**re-costs every past entry** for that resource. This is intended, and the preview
(§5) exists so it is never a surprise. Rate history belongs to enterprise#45.

There is **one currency and no FX**. The workspace setting is a label for amounts; it
does not convert them. Changing it re-labels existing amounts and converts nothing. The
docs and the settings help text say so.

The rate lives on `Resource`, not `User`, so a non-human resource can carry one (#754
2026-09-26). In 0.5 a non-human resource's rate produces no cost, because only people
log time and non-labor cost is #2557. The rate is stored now so #4809 can price a
non-human assignment's sampled duration.

There is no per-role default rate. `job_role` is free text with no entity to hang a rate
on. This is a recorded VoC concern (David), and the missing-rate count in §3 is the
mitigation.

### 2. Actual cost (AC)

```
AC(project) = Σ over (user u) of  hours(u, project) × rate(resolve(u, project))
hours(u, p) = Σ TimeEntry.minutes / 60  where task.project = p, entry.is_deleted = False
```

- **Entries on soft-deleted tasks count.** The money was spent. EV (§3) already drops
  the task's value, so abandoned work shows correctly as negative CV.
- **PTO and non-project time are excluded by construction.** Only entries on the
  project's own tasks count. Time off is a calendar exception, not a time entry, so it
  is never costed. If a non-project time code is ever added, it must be excluded here.
  `test_cost.py` pins both shapes.
- **A running timer is not cost.** `ActiveTimer` is not a time entry.
- **Resolving a user to a resource** (`Resource.user` is not unique): among the user's
  resources, prefer one on the project's active roster, then a live one over a
  deactivated one, then by `name`, then by `id`. A deactivated resource still prices its
  history, because off-boarding a person must not erase what their past hours cost.
- A user with **no linked resource** is matched to a resource that has **no user link**
  and the same email (case-insensitive), the legacy fallback `ResourceSerializer.get_is_me`
  already applies. `Resource.user` has no API write path, so this is the only remedy a
  workspace admin has: create a resource with that person's email, then rate it. A
  resource already bound to someone else is never borrowed.
- A user with **no resource at all** (no link, no email match) has their hours counted as
  `unpriced_hours`, and they count once toward `missing_rate_count`. Their
  `missing_rate_resources` entry carries a `user_id` and a null `resource_id`.

The time aggregation is done in SQL: one grouped `Sum(minutes)` per `(project, user)`.
Resolution then runs in Python over the small result. A fixed number of queries serves
any number of projects, with no per-project loop (§8).

### 3. Earned value and the two KPIs

The EV basis was settled by the user on 2026-11-05 and is not reopened here:

```
percent_complete = existing project % complete (Avg of non-deleted tasks' percent_complete, 0–100)
EV   = BAC × percent_complete / 100
CV   = EV − AC                          (negative = over budget)
budget_utilization = AC / BAC           (a fraction; 1.0 = budget consumed)
```

The percent-complete definition is reused verbatim. `cost.project_percent_complete` is
the same aggregate the project list annotates, and a test pins that the two agree.
Known limitation: it is an unweighted mean that includes phase rows. The VoC "could not
see" item asks whether PMs accept that. A duration- or cost-weighted basis would be a new
ADR, not a silent change.

**Availability and reasons.** A value is only as good as its weakest input, so each KPI
says why it cannot compute:

| Condition (first match wins) | `available` | `reason` |
|---|---|---|
| Caller below the cost-visibility floor (§4) | false | `cost_restricted` |
| No budget, or budget = 0 | false | `no_budget` |
| Any person in scope lacks a rate | false | `missing_rates`, plus `missing_rate_count` |
| Otherwise | true | — |

A person is "in scope" if they logged time on the project, or if their resource
(linked to a user) is assigned (`TaskResource`) to one of the project's live tasks. An
unrated **non-human** resource does not block computation in 0.5, because it can carry
no cost. `cost_computable = (missing_rate_count == 0)` is the #4809 fact. It does not
depend on a budget being set, because AC is computable without one.

**Program rollup (ADR-0088):** `cost_variance` = Σ CV and `budget_utilization` = ΣAC /
ΣBAC across the program's contributing projects. Both are money or ratios of money, so
they are **policy-independent totals**, like the counts (ADR-0088). A per-project mean of
utilization would overweight a tiny project. The rollup is unavailable if **any**
contributing project is unavailable. In that case it reports the first reason in table
order, plus `projects_without_budget` and the program-wide distinct `missing_rate_count`.
A partial sum would be a confident wrong number. A program with zero contributing
projects returns `{available: true, value: null}`, the existing "no data" convention.

**`weighted_by_budget`** weights each project's band or variance by `Project.budget`. If
any contributing project lacks a budget, the policy falls back to
`average`. The response then carries `policy_available: false` and the new
`policy_unavailable_reason: "no_budget"`. The rollup is never blanked (ADR-0088).

`DEFERRED_KPI_REASONS` loses both cost entries, so `unavailable_kpis` on the
rollup-config endpoint stops listing them and the settings toggles light up (#2404's
intended path). `p80_completion` stays deferred to #753.

### 4. RBAC matrix for cost fields

The rule from #4810: **a Member or Viewer never receives a rate or a cost field.**

| Surface | Who receives cost data | Everyone else |
|---|---|---|
| `Resource.cost_rate` on `ResourceSerializer` (catalog, detail, nested `ProjectResource.resource_detail`) | workspace Admin+ (**stored** `WorkspaceRole`) | field **omitted** (not nulled) |
| Rate write: `POST /resources/{id}/rate/` | workspace Admin+, **human session only** (`IsNotTokenAuthenticated`: an API/agent token may not re-cost history; ai-review check 3) | 403 |
| `cost_rate` sent on `PATCH /resources/{id}/` | — | 400, pointing to the rate endpoint (no silent drop) |
| `Project.budget` on `ProjectSerializer` | project Admin+ (Project Manager) | field omitted |
| `Project.budget` write | project Admin+ | 400 for a Scheduler **even when the value is unchanged** |
| `GET /projects/{id}/cost/` (summary + per-person lines incl. rate) | project Admin+ | 403 |
| Program rollup cost KPIs | program Admin+ **and** project Admin+ on **every** contributing project | `{available:false, reason:"cost_restricted"}` |
| Workspace currency (`/workspace/`) | readable by all members (a label, not a secret); writable by workspace Admin+ | — |

Why a project PM sees per-person rates on their own cost summary, but not in the
catalog: a PM needs to explain their AC, which is the Sarah 🔴 "no derivation" concern.
The summary lists a rate only for people who **logged time on that project**. Time can
only be logged by someone who is a Member+ there (`can_user_log_time`). A self-created
throwaway project therefore exposes nobody's rate unless that person chose to work in
it. Catalog-wide rates are gated on the **stored** workspace role, because project
Admin is self-grantable (#3569). Gating the catalog on it would make every rate
readable in two requests.

Why the Scheduler write refusal is unconditional: the general sub-Admin gate in
`ProjectSerializer.validate` refuses only fields whose value *changes*. For a field the
Scheduler cannot read, that is an **equality oracle**: PATCHing `budget=X` returns 200
when X is right and 400 when it is wrong, so the budget can be found by binary search.

### 5. Rate re-cost preview: one endpoint for preview and save

`POST /api/v1/resources/{id}/rate/` with body `{"cost_rate": "<decimal>|null", "dry_run": bool}`.

- With `dry_run: true`, nothing is written. The response is computed with the proposed
  rate applied as an **override** to the same `project_cost_facts` function every other
  surface uses.
- With `dry_run: false`, "before" is computed, the rate is saved, the audit row is
  written, and "after" is recomputed from the database **without** an override.

The response shape is identical either way: `resource_id`, `currency`, `cost_rate_before`,
`cost_rate_after`, `dry_run`, `as_of`, and `projects[]` with `project_id`, `name`, `hours`,
`actual_before`, `actual_after`, `delta`, `cost_computable_before` and
`cost_computable_after`. It also returns `total_hours` and `total_delta`. A test pins
that the dry-run response equals the save response field for field. That is #4810's
"the preview equals the server's re-cost result" as a tested invariant, not an
intention.

`cost_rate` is therefore **read-only on `ResourceSerializer`**. There is one write path
with one gate, and nothing a client could PATCH around.

### 6. Project cost summary

`GET /api/v1/projects/{id}/cost/` (project Admin+, MCP-readable `PATH` scope). It
returns:

- `currency`, `as_of`, `budget`, `actual`, `earned_value`, `percent_complete`
- `cost_variance` and `budget_utilization`, each `{available, value, reason}`
- `cost_computable`, `missing_rate_count`
- `missing_rate_resources[]` (`{resource_id|null, user_id|null, name}`; names only, no
  rates)
- `logged_hours`, `priced_hours`, `unpriced_hours`
- `lines[]` (`{resource_id, name, hours, rate, cost}` per person who logged time)
- `definitions`: a map of field → one-sentence formula, so an agent can say *why* (ai-review)

Money is serialized as **decimal strings** and ratios as numbers, the DRF
`DecimalField` default (Nadia).

### 7. Leak paths: every path that serializes Resource or Project

| # | Path | Disposition | Test |
|---|---|---|---|
| L1 | `ResourceSerializer` (list/detail) | `cost_rate` stripped below workspace Admin | `test_cost_rbac::test_resource_rate_hidden_from_non_admin` |
| L2 | `ProjectResourceSerializer.resource_detail` (nested) | inherits L1 | `test_cost_rbac::test_roster_nested_resource_hides_rate` |
| L3 | `ProjectSerializer` list/detail | `budget` stripped below project Admin | `test_cost_rbac::test_project_budget_hidden_from_member_and_scheduler` |
| L4 | Budget write oracle (Scheduler PATCH) | unconditional 400 | `test_cost_rbac::test_scheduler_cannot_probe_budget_by_patch` |
| L5 | Sync pull (`SyncProjectSerializer`; Resource is not synced) | explicit field list, no cost field | `test_cost_rbac::test_sync_pull_project_has_no_budget` |
| L6 | WebSocket broadcasts (`project_updated`, `roster_changed`) | id-only payloads; a rate write broadcasts nothing | `test_cost_rbac::test_broadcasts_carry_no_cost` |
| L6b | OpenAPI schema (generated clients) | `Resource.cost_rate` is dropped from `required` (`core.openapi.ROLE_OMITTED_RESPONSE_FIELDS`), so a client does not assume the key is always present | schema regenerated |
| L7 | History diff, the project changelog and per-object history (`HistoricalProject` tracks `budget`) | `budget` added to `HISTORY_DIFF_PRIVACY_GATED` | `test_cost_rbac::test_changelog_never_shows_budget` |
| L8 | Program export bundle `history/project.json` (requester may be a project Viewer) | budget column dropped below project Admin | `test_cost_rbac::test_program_bundle_history_drops_budget_for_viewer` |
| L9 | Project export bundle | project Admin+ only (existing gate). Budget visible, which is intended | covered by the L8 helper test (`admin keeps budget`) |
| L12b | Rate write by an agent token | `IsNotTokenAuthenticated` on `rate` | `test_cost_rbac::test_agent_token_cannot_change_a_rate` |
| L10 | Workspace export | workspace Owner only (existing gate). Rates and budgets included, which is intended | `test_cost_rbac::test_workspace_export_is_owner_only` |
| L11 | Seed / MS Project XML exporters | explicit field lists, no cost field emitted | `test_cost_rbac::test_seed_export_has_no_cost_fields` |
| L12 | MCP (token reads of `projects/{id}/`, `programs/{id}/rollup/`, `projects/{id}/cost/`) | token user's role applies, same gates | `test_cost_rbac::test_mcp_member_token_sees_no_cost` |
| L13 | Share links (`share_services`) | explicit payloads, no project or resource cost fields | `test_cost_rbac::test_share_payload_has_no_cost` |
| L14 | Program rollup payload | `cost_restricted` below program Admin | `test_cost_rbac::test_rollup_cost_kpis_restricted_for_program_viewer` |
| L14b | Program rollup payload, program Admin who is not project Admin on every child | `cost_restricted`. Program roles do not cascade to projects (`_membership_role` reads only `ProjectMembership`). For a one-project program, BAC = CV / (pc − util), so the totals would hand a project Viewer the budget the Viewer role is denied | `test_cost.py::test_program_admin_needs_project_admin_on_every_project` (negative control: fails with the project check removed) |
| L15 | `ProgramProjectRowSerializer`, `TaskProjectRefSerializer`, bulk-settings | explicit narrow field lists | covered by L3's serializer-level strip, and these lists name no cost field |
| L16 | Settings template `copy_settings_from` | `SETTINGS_TEMPLATE_FIELDS` is an allowlist and `budget` is not a setting, so a new project never inherits another's budget | — (allowlist; nothing to change) |
| L17 | Workspace audit log (rate metadata) | workspace Admin-only (existing gate) | — (existing gate) |

Accepted inference risk: a viewer of a `weighted_by_budget` program sees health bands
weighted by budgets and `projects_without_budget`. Neither reveals an amount. A project
PM whose project has exactly one time-logger can divide AC by hours to get that rate,
and the PM is entitled to it anyway (§4).

### 8. Performance

`project_cost_facts(project_ids)` issues a fixed **6 queries for any N**: budgets,
percent complete, a grouped time sum, candidate resources, roster rows, and assigned
resources. Up to two more run only when someone logged time with no linked resource:
one reads their name and email, one matches an unlinked resource by email. The program rollup calls it once. The rate preview calls it twice, once for
"before" and once for "after". `test_cost.py` pins the count with
`django_assert_max_num_queries`.

## Threat model (STRIDE, architecture stage)

**Assets:** `Resource.cost_rate` is **confidential**, because it is a salary proxy.
`Project.budget` is **confidential**. Derived AC, EV, CV and utilization are
**confidential**. `Workspace.currency` is **internal**.

**Boundaries crossed:** B1 (REST), B2 (DB) and B4 (Redis pub/sub broadcasts). B3 does
not apply (no Celery dispatch). B5 does not apply (no extension point). B6 is limited to
MCP token reads, which are B1 with a token principal.

| Asset × threat | Mitigation |
|---|---|
| Rate: **S**poofing | Gate on a stored `WorkspaceRole`, not a self-grantable project role. Token principals inherit their user's role. |
| Rate: **T**ampering | Single write endpoint, `IsWorkspaceAdminStrict`. `PATCH` refuses the field. |
| Rate: **R**epudiation | `RESOURCE_RATE_CHANGED` audit row (actor, before, after) written in the same transaction. |
| Rate: **I**nfo disclosure | L1–L17 above. Omitted rather than nulled, so presence does not leak. Catalog `ordering`/`search` fields name no rate, so there is no sort oracle. |
| Rate: **D**oS | Preview is bounded by the fixed query count, and the resource catalog throttle (`ResourceCatalogThrottle`) applies. |
| Rate: **E**oP | A self-created project grants no rate visibility, because lines list only people who logged time there. |
| Budget: **T**ampering / **I** | Admin+ write. Unconditional Scheduler refusal (L4 oracle). Read strip (L3). |
| Budget: **R** | `HistoricalProject` tracks `budget`. The history diff hides it from readers (L7), but the row is retained for audit and readable to the project Admin via the export bundle. |
| Derived cost: **I** | Cost endpoint is Admin+. Rollup is `cost_restricted` below program Admin, and for a program Admin who is not project Admin on every contributing project (L14/L14b). |
| Broadcast fan-out (B4) | Payloads are id-only. No new broadcast carries cost (L6). |

**Top 3 risks:** (1) A future serializer that dumps all Project fields (`.values()`, `__all__`)
leaks `budget`. Mitigation: L7/L8 precedent, and the leak tests fail on any new path
that reuses the existing ones. (2) The budget equality oracle (L4). Fixed. (3) Inferring
a rate from a single-person AC. Accepted, because the only party who can do it is the
project PM, who is entitled.

**SOC 2 mapping:** CC6.1 (logical access: role-gated fields, stored principal), CC6.3
(least privilege: field omission), CC7.2 (monitoring: rate-change audit event), CC8.1
(change management: budget history retained).

## VoC inputs (simulated panel, scoped to rate/budget/RBAC)

The panel was simulated, not user research. Evidence tier E1: category discourse on
time-tracking and PPM tools treats rate visibility as a role-gated permission. Blockers
carried forward:

- 🔴 *Sarah*: a cost figure with no derivation. *Refuted by:* a PM tracing every AC
  dollar to hours × rate unaided in a demo. Addressed by §6 `lines` + `definitions`.
- 🟡 *Priya*: the rate is a salary proxy. *Refuted by:* no contributor objection in beta
  to PMs seeing per-person cost lines. Addressed by §4.
- 🟡 *David*: no per-role default rate. *Refuted by:* admins with more than 20 resources
  reaching `cost_computable` within a week. Mitigated by `missing_rate_resources`.
- 🟡 *Sarah*: re-costing changes past numbers. Addressed by §5.

Open questions only a real user can answer: whether PMs accept EV computed from an
unweighted task mean, and whether per-role default rates are needed in 0.5.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| Rate on `User` | One rate per person | Non-human resources cannot carry one (#754 scope addition) |
| `RateCard` model with effective dates | Correct historical cost | enterprise#45's scope (ruled 2026-09-17) |
| Rate visible to any project Admin+ in the catalog | Simpler | Self-grantable via `POST /projects/` (#3569) |
| `cost_rate` writable via `PATCH` + separate preview | REST-conventional | Two code paths that can drift. #4810 requires one endpoint |
| Rollup computes over the budgeted subset of projects | Always shows a number | A confident wrong total. Reasons are actionable instead |
| Per-project mean for `budget_utilization` | Honors the policy | Overweights small projects. A ratio of sums is the EVM-standard roll-up |
| Exclude `budget` from `HistoricalProject` entirely | No history leak class | Loses the budget audit trail (CC8.1) |

## Consequences

- The three #3426 controls compute. Each failure names an action: set a budget, or rate
  N people.
- #4809 adds only percentiles on top of `project_cost_facts`.
- Changing a rate re-costs history. This is documented, previewed and audited.
- New fields that serialize Project generically must consider `budget`. The leak-path
  tests are the tripwire.

## Implementation notes

- Affected packages: api, web (the rollup types and reason copy live in
  `features/programs/ProgramOverviewPage.tsx` and
  `features/settings/program/useProgramRollupConfig.ts`; `src/api/types.ts` needed no
  change), and website docs.
- Migration required: yes. Three additive `AddField`s in `workspace`, `resources` and
  `projects` (with `historicalproject`), plus an `AlterField` on `AuditEvent.event_type`
  choices. No constraint and no data repair. Rolling-update safety (migration rule 8),
  per column: `budget` and `cost_rate` are nullable, so an old pod's INSERT that omits
  them writes NULL. `Workspace.currency` is NOT NULL, so it carries `db_default="USD"`
  as well as `default`. With a Python default alone, `AddField` adds a column default
  and then drops it, and an old pod saving the Workspace would insert a
  `HistoricalWorkspace` row without the column and fail NOT NULL during the rollout.
  `sqlmigrate workspace 0030` now shows `ADD COLUMN currency ... DEFAULT 'USD' NOT NULL`
  with no `DROP DEFAULT`.
- API changes: `ResourceSerializer.cost_rate`, `ProjectSerializer.budget`,
  `WorkspaceSettingsSerializer.currency`, `POST /resources/{id}/rate/`,
  `GET /projects/{id}/cost/`, and rollup `policy_unavailable_reason`, new reasons and
  detail counts.
- OSS (trueppm-suite). No enterprise import.

### Durable Execution

1. Broker-down behaviour: N/A. No async side effect; all reads and the rate write are synchronous.
2. Drain task: N/A. Nothing is dispatched.
3. Orphan window: N/A.
4. Service layer: `apps/projects/cost.py::project_cost_facts` (read) and
   `apps/resources/services.py::set_resource_rate` (write).
5. API response on best-effort dispatch: N/A. Synchronous 200.
6. Outbox cleanup: N/A.
7. Idempotency: setting the same rate twice is a no-op write (no audit row when the rate
   is unchanged). `dry_run` is pure.
8. Dead-letter / failure handling: N/A. A failed write rolls back with the request transaction.

### On Acceptance

- [x] Open issues naming this ADR re-read: 0. The ADR is new; #754, #3426, #4809 and #4810
      already carry the post-decision scope (#754's 2026-09-17 and 2026-09-26 comments).
