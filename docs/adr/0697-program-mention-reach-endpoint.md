# ADR-0697: Program mention-reach endpoint and the two-arm reach copy contract

## Status
Accepted — status corrected 2026-08-02 after ADR audit (#2685, verified: `mention_reach` in `apps/projects/program_views.py`, web `useProgramMentionReach.ts`). 

> Numbering note: 0697 was reserved for this worktree while the highest ADR on
> `main` was 0689. Sibling worktree `2530-external-stakeholder-rows-have-no-edit-f`
> works the same subsystem; renumber at merge if it claims a colliding number.

## Context

`@program-stakeholders` has two arms that ADR-0264 deliberately keeps apart:

1. **Internal** — the exact-`Role.VIEWER` members across the program's live
   projects, resolved by `_resolve_program_group_members` from the **union of
   `ProjectMembership`**, deduplicated by user. These are real `User` accounts and
   they do receive a durable in-app `Notification` today.
2. **External** — `access.ExternalStakeholder` rows, resolved by
   `resolve_external_stakeholders` onto a distinct `external_targets` field.
   They have no `User`, so they receive **nothing**: no `Notification` row, no
   in-app badge, no email. ADR-0264 §4 defers outbound delivery to #1675.

Program Settings → External stakeholders (`ProgramStakeholdersPage.tsx`) today
shows only a bare row count on its section title. A PM curating that list cannot
see who the alias actually reaches, and the page's own subtitle is the only place
that hints the external arm is not delivered yet.

**The data-sourcing problem.** Nothing on the API surface answers "how many
Viewer-role members does this program's stakeholder alias reach?":

- `GET /programs/{id}/members/` returns `ProgramMembership`. ADR-0070 §RBAC is
  explicit that program membership is "explicit grants only" — it does **not**
  propagate to project-level access, and the resolver does not read it.
- `ProgramSerializer.member_count` counts `ProgramMembership` with no role filter.
- No mention-preview or reach endpoint exists. `resolve_group_members` has exactly
  one production caller: `TaskCommentViewSet.perform_create`.

Counting `role === VIEWER` client-side off `/programs/{id}/members/` would render a
number drawn from the wrong table under a semantic ADR-0070 forbids. On the one
page whose job is to tell the truth about reach, a confidently wrong figure is
worse than the bare count it replaces.

The client also cannot assemble the right number itself. Doing so means listing the
program's projects and reading each one's membership — an N+1 fan-out from the
browser, a second copy of the resolver's filter in TypeScript, and a permission
dead end: a program Admin is not necessarily a member of any project in the
program, so `/projects/{id}/members/` may 403 for exactly the user viewing the page.

**P3M layer:** Programs and Projects — one PM's program, no cross-program
aggregation. OSS. Nothing imports from `trueppm_enterprise`.

**Correction carried into this ADR.** `TRUEPPM_EXTERNAL_STAKEHOLDER_EMAIL_ENABLED`
does **not** exist. A repo-wide grep returns exactly one hit: ADR-0264 line 109,
which records that the flag was *considered and omitted* precisely because a
setting that gates nothing shipped is a dead branch. #1675 introduces it alongside
the code it guards. Nothing in this ADR may read, define, or reference it as live.

## Decision

### 1. Copy contract — two arms, two verbs, never a sum

The summary states the two arms separately and gives them **different verbs**,
because they have materially different fates today:

- Internal Viewer members: **"reaches"** — they get a durable in-app notification
  now.
- External stakeholders: **"listed here"** / **"not notified yet"** — they get
  nothing today.

Three rules follow, and they are the substance of this decision:

**(a) No total, ever.** The strip must never render a single combined number
("reaches 9 people"). The #1658 handoff phrased this as union math; #1675
superseded it. A sum on this page is the same type lie ADR-0264 §2 removed from
the resolver, re-introduced in the UI. The API response deliberately carries no
`total` field so the client has nothing to sum.

**(b) The external arm is never described as "reached", "notified", or "emailed"
today.** Future tense only, and **no version number** — "will be added in a future
release", matching the wording already shipped in the page subtitle. Naming 0.5
in UI copy would create a version claim that must be kept in sync with the roadmap
(CLAUDE.md version-status tense rule); "a future release" sidesteps it entirely.

**(c) The strip describes the *audience*, not a delivery prediction for any one
comment.** The actual fan-out excludes the comment's author
(`_resolve_mention_recipients` pops the mentioner) and email to internal members is
opt-in and OFF by default (ADR-0075 / ADR-0085). So the copy says who is in the
audience — it must not say "N people will be emailed" or "N notifications will be
sent".

**(d) The external arm leads.** The `ux-design` gate overrode this ADR's first
draft, which put the Viewer clause first: this page is *about* externals, so
leading with the internal count buries the lede, and the number a PM came here to
check is the one on the rows below. The Viewer clause is subordinate by weight,
not by size. This paragraph records the amendment so the ADR and the shipped
component agree.

Canonical copy (singular/plural handled — note the verb agrees too, `gets`/`get`):

> **3 external contacts — listed only.** No email or notification is sent to them
> yet; email delivery is a future, operator-enabled capability.
> 6 Viewer-role members get an in-app notification when you mention
> `@program-stakeholders`.

"operator-enabled" is five words that prevent a foreseeable support ticket: on a
self-hosted instance outbound email is an operator decision, so "it ships later"
without that qualifier reads as "it starts working when you upgrade".

Zero Viewer members is a real and important state and is stated plainly, with no
alarm styling — it is a fact about configuration, not a fault:

> No Viewer-role members in this program — `@program-stakeholders` notifies no one
> in-app today.

Empty state (zero external rows), which must also state the real Viewer count:

- Viewers > 0 — "No external stakeholders yet — `@program-stakeholders` reaches
  6 Viewer-role members in this program."
- Viewers = 0 — "No external stakeholders yet, and no Viewer-role members —
  `@program-stakeholders` reaches no one today."
- Reach unknown (query loading or errored) — fall back to the existing bare
  string. **Never substitute a fallback number.** Absence beats a wrong figure;
  that is the whole premise of the change.

The strip renders **nothing** when there are zero external rows: the empty state
already carries the reach sentence, and showing both would say the same thing
twice, 40px apart, in two voices.

**(e) The page subtitle gives up the deferral sentence.** It previously ended
"Email notifications to them will be added in a future release." — which the strip
now says better, with a live count, 40px below. Two future-tense email-deferral
sentences in one viewport is the redundancy this change exists to remove. The
subtitle keeps only what the registry *is*, and is corrected in the same pass from
"included in `@program-stakeholders` mentions" (the superseded union framing) to
"kept as a separate recipient list for `@program-stakeholders` mentions".

### 2. `GET /api/v1/programs/{id}/mention-reach/`

A read-only `@action(detail=True, methods=["get"], url_path="mention-reach")` on
`ProgramViewSet` (`packages/api/src/trueppm_api/apps/projects/program_views.py`).

```
GET /api/v1/programs/{id}/mention-reach/
200 {
  "group_key": "program-stakeholders",
  "viewer_member_count": 6,
  "external_stakeholder_count": 3
}
```

- **No `total`.** Its absence is part of the contract (§1a).
- `group_key` is echoed so the single-alias scope is explicit and a later version
  can accept `?group=` for `@program-pms` / `@program-schedulers` / `@program-all`
  without a breaking shape change. Those three are **not** built now — `@program-all`
  additionally carries an ADMIN actor gate and `ALL_GROUP_HARD_CAP`, which is its
  own design.
- Declared with `@extend_schema` so `docs/api/openapi.json` carries the real shape
  rather than an inferred one.

**Why `ProgramViewSet` and not `ExternalStakeholderViewSet`.** The fact spans both
arms — it reports internal `ProjectMembership` as well as the registry — so it is a
program fact, not a stakeholder-registry fact. `ProgramViewSet` is router-registered
(an `@action` auto-routes; the `access` app hand-writes every `path()`), already has
per-action RBAC dispatch in `_rbac_permissions()`, and already carries
`McpReadableViewMixin`, which makes the answer reachable to an agent asking "who
does this alias reach before I post?" — the API-first position in CLAUDE.md §1.

**Permission floor: `[IsAuthenticated, IsProgramAdmin]`** — a new branch in
`_rbac_permissions()`, matching the registry's own Admin+ floor (ADR-0264 §3).
Rationale: the strip only ever renders beside a list the caller can already read,
so a lower floor buys nothing; and the internal count is a partial disclosure of
membership across projects the caller may hold no grant on (ADR-0070's explicit-
grants boundary). Admin+ keeps that disclosure inside the role that administers the
alias. `IsProgramNotClosed` is not added — it is a read, and that class passes GET
regardless.

Two corrections the `rbac-check` and `security-review` gates forced into this
paragraph, because the first draft overstated the case:

1. **Both counts are already observable below Admin.** `resolve_parsed_mentions`
   gates only `@all` / `@program-all` on ADMIN, so any project member who can
   comment may *fire* `@program-stakeholders` and learn its reach — and the
   `task_comment_created` broadcast already carries `external_recipient_count`.
   Admin+ here is therefore a deliberate **tightening** for consistency with the
   registry page the strip renders beside, not a match to the numbers' existing
   floor. A follow-up may reasonably argue the preview should be available to
   whoever can fire the mention; that is a separate decision.
2. **ADR-0070 does not forbid this.** Three shipped endpoints already disclose
   child-project *people* data to a program-level caller with no project grant, at
   equal or weaker floors: `resource-contention` (names and emails, Scheduler+),
   `mention-groups` (full user rows from the `ProjectMembership` union, Viewer+),
   and `export` (usernames, emails, per-member effort, the same Admin+). A count at
   Admin+ discloses strictly less than `export` does at the identical floor.

**No view-level MCP audit flag.** An earlier draft had `mention_reach` set
`request._mcp_scope_filtered` itself after probing whether the exclusion narrowed
this program. It does not: `get_object()` has already run the mixin's
`filter_queryset`, whose `Program` branch sets the flag centrally for any token
caller. The probe was a redundant query and the only view-level set in the tree.
The action intersects and lets the mixin own the flag, matching `rollup`,
`schedule`, `projects`, `task_search`, and `resource_contention`.

**MCP opt-out.** `ProgramViewSet` declares `mcp_scope = McpScope.AGGREGATE`, whose
contract is that the view must intersect its own hand-built cross-project reads with
the consent helper — the mixin's row filter only sees the `Program` row
(`_mcp_filter_queryset` does `qs.exclude(mcp_enabled=False)` for model `Program`).
`mention_reach` therefore calls `mcp_excluded_project_ids(request)` and excludes
those projects from the `ProjectMembership` union, exactly as `rollup`, `schedule`,
`projects`, `resource_contention`, and `task_search` already do. This means an
agent token under an active opt-out sees a *smaller* number than the mention's true
reach — correct under ADR-0678 (the agent is not entitled to the withheld rows);
set `request._mcp_scope_filtered = True` when the exclusion narrows, per the
existing convention, so the audit row is not an unqualified "allowed". The external
arm is program-owned with no project FK and is not filtered.

### 3. One source of truth — the count helper lives beside the resolver

Both counts are computed in `packages/api/src/trueppm_api/apps/access/groups.py`,
next to the resolvers, keyed by **`program_id`** (the resolvers take `project_id`
and derive the program; the settings page already has the program).

The shared filter is extracted so the two paths cannot drift:

- `_program_membership_base_qs(program_id)` — every live `ProjectMembership` across
  the program's live projects. **Every** `@program-*` key narrows this, and so does
  the counter. A recipient-narrowing filter (deactivated users, a privacy
  suppression gate) belongs here and nowhere else.
- `_program_stakeholder_membership_qs(program_id)` — the base narrowed to
  `role=Role.VIEWER`. Used by the counter.
- `_program_external_stakeholder_qs(program_id)` — used by
  `resolve_external_stakeholders` **and** by the counter.

The stakeholders branch of `_resolve_program_group_members` narrows the base
in-place (`memberships.filter(role=Role.VIEWER)`) rather than rebinding to the
helper. That is deliberate and was the `security-review` gate's finding: a branch
that *replaces* the shared base instead of narrowing it silently opts out of any
filter later added to that base — on a notification fan-out path, a dropped
recipient filter is a disclosure vector that no test would catch, because the
counter and the resolver would still agree with each other.

**Counting trap (must not be missed).** The resolver returns *distinct users* — a
person who is a Viewer on two projects in the program is one recipient. The count
must therefore be `.values("user_id").distinct().count()`, **not** `.count()` on the
membership rows, or a multi-project Viewer is double-counted and the strip is wrong
in exactly the way this change exists to prevent.

A **contract test** binds the two: for a fixture program, assert
`viewer_member_count == len(resolve_group_members(project_id, "program-stakeholders"))`
and `external_stakeholder_count == len(resolve_external_stakeholders(project_id))`.
The extraction makes filter drift impossible; the contract test catches everything
else.

### 4. Web — a separate component file, a three-line page diff

`StakeholderReachSummary` is a **new file** in
`packages/web/src/features/settings/program/`, not a block inside
`ProgramStakeholdersPage.tsx`. #2530 is concurrently editing that file's row/table
region; keeping the component out of it reduces the page diff to one import, one
JSX line as the first child of the `px-6` wrapper above the sunken header row, and
the empty-state string. `GRID`, `StakeholderRow`, the add form, and the
`SettingsPageTitle` count on line 130 are untouched — the title count is the number
of rows *in this table*, which stays correct once the strip explains reach.

A new hook `useProgramMentionReach(programId)` reads the endpoint
(`queryKey: ['program-mention-reach', programId]`).

**Deliberate asymmetry:** the strip takes its external number from
`stakeholders.length` (passed in as a prop) and only its Viewer number from the
endpoint. The list the page already holds *is* the authoritative external set, and
using its length keeps the strip consistent with the rows rendered directly below it
after an add or remove without touching the mutation hook (also being edited by
#2530). The endpoint still returns `external_stakeholder_count` so a non-web caller
gets both arms in one request. Do not "fix" this asymmetry.

**No `role="status"` / `role="alert"` on the strip.** The page's error state owns the
only `role="alert"` and the empty state owns `role="status"`; both are asserted bare
in `ProgramStakeholdersPage.test.tsx`. The strip is static derived content, not a
live region — a plain `<p>` is correct and avoids breaking those assertions.

**Client guard:** render the internal clause only when `viewer_member_count` is a
`number`. The e2e catch-all route returns `{count:0,next,previous,results:[]}` for
any unmocked endpoint, which is truthy but has no `viewer_member_count` — without
the guard the strip renders "reaches undefined Viewer-role members". The e2e
`setup()` must also mock `**/api/v1/programs/${PROGRAM_ID}/mention-reach/` with the
real shape; the guard is the belt to that mock's braces.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Client counts `role === VIEWER` off `/programs/{id}/members/`** | No API work; hook already exists and is already used by `ProgramAccessPage` | Wrong table. `ProgramMembership` does not propagate to project access (ADR-0070); the resolver reads the `ProjectMembership` union. Ships a confidently wrong number on the page whose purpose is truthful reach. **Rejected** |
| **B. Client lists the program's projects and unions their memberships** | Uses only existing endpoints | N+1 from the browser; a second copy of the resolver filter in TypeScript that will drift; and a program Admin may hold no grant on those projects, so the reads 403. **Rejected** |
| **C. Extra field(s) on the existing `external-stakeholders/` list response** | Zero new requests; page already reads it | The list is a bare array (`pagination_class = None`) — there is no envelope to hang a summary on. Per-row repetition is absurd; adding an envelope is a breaking change to a shipped endpoint. **Rejected** |
| **D. `@action` on `ExternalStakeholderViewSet`** | Class-level `IsProgramAdmin` is already the floor we want; no MCP intersection work | The `access` app hand-writes every `path()`, so `@action` does not auto-route; scope-creeps a registry viewset into reporting internal membership; and the viewset has no MCP mixin, so the fact stays invisible to agents. **Rejected** |
| **E. `@action` on `ProgramViewSet` (chosen)** | Correct home for a two-arm program fact; router auto-routes; per-action RBAC already exists; agent-reachable | Requires the `mcp_excluded_project_ids` intersection and a direct test, because `AGGREGATE` scope is not enforced by the mixin's row filter |
| **F. Ship copy-only, no endpoint** | No API surface added | Drops the issue's core AC — the Viewer count is unobtainable client-side. The strip degenerates to restating the row count. **Rejected**, but see 🔴-1 |

## Consequences

- The page states, truthfully and separately, what the alias reaches now and what
  is deferred — the first surface where a PM can see that a program with zero
  Viewer-role members has a stakeholder alias that reaches nobody.
- `mention-reach` becomes a public API contract; #1675 extends it (a delivery flag,
  a per-arm `deliverable` signal) rather than reshaping it.
- The extracted querysets give the alias one definition. A future change to the
  Viewer filter or the soft-delete rules moves the resolver and the counter together.
- Harder: one more program endpoint to keep MCP-consent-correct, and `AGGREGATE`
  scope is verifiable only by direct test, not by the conformance suite.
- Risk: the strip is a *snapshot at page load*; the true fan-out is a snapshot at
  comment-write time. They can differ if membership changes in between. Acceptable —
  every mention resolver in the system is already snapshot-at-write, and the copy
  describes an audience rather than promising a delivery.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api, web
- Migration required: no
- API changes: yes — one new read-only endpoint,
  `GET /api/v1/programs/{id}/mention-reach/`. Regenerate `docs/api/openapi.json`
  (merge `origin/main` first) and update `docs/api/`.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Program-scoped, no cross-program
  aggregation, no `trueppm_enterprise` import.

### Durable Execution
1. Broker-down behaviour: **N/A** — a pure read endpoint with no async side effects.
   Nothing is dispatched, so there is nothing to lose when the broker is down.
2. Drain task: **N/A** — no async work is enqueued.
3. Orphan window: **N/A** — no outbox rows are written.
4. Service layer: the count helpers live in
   `apps/access/groups.py` (`_program_stakeholder_membership_qs`,
   `_program_external_stakeholder_qs` plus the counter), shared with the resolvers.
   No `services.py` dispatch function is needed — nothing is dispatched.
5. API response on best-effort dispatch: **N/A** — the response is synchronous and
   fully computed; there is no queued work to report.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: trivially satisfied — a GET with no side effects. Repeating it
   returns the same counts for the same program state.
8. Dead-letter / failure handling: **N/A** for async. On the synchronous path, a
   failed read surfaces as a normal DRF error; the web client renders no number at
   all rather than a fallback (§1c), so a failure degrades to the pre-change state
   instead of to a wrong figure.

## References
- Issue #2529 (this ADR). Concurrent, same file: #2530 (inline row edit).
- ADR-0264 (external stakeholder registry — the separate-arm decision, §2; the
  no-email / omitted-flag decision, §4; the Admin+ floor, §3).
- ADR-0240 (`@program-stakeholders` = exact Viewer across the program's projects),
  ADR-0070 (`ProgramMembership` does not propagate to project access),
  ADR-0072 (`Role.VIEWER == 1`), ADR-0075 / ADR-0085 (mention email opt-in, OFF by
  default), ADR-0678 (team MCP opt-out, `AGGREGATE` scope), ADR-0146 (settings shell).
- Follow-up #1675 owns outbound delivery to external stakeholders and introduces
  `TRUEPPM_EXTERNAL_STAKEHOLDER_EMAIL_ENABLED` with the code it guards.
