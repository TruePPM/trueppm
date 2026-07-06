# ADR-0240: Program-scoped @mention auto-groups

## Status
Accepted

## Context
ADR-0075 shipped **project-scoped** auto-groups for `@mention` fan-out
(`@admins`, `@schedulers`, `@scrum-team`, `@all`, …), derived from project RBAC
and resolved at write time by `access/groups.py`. ADR-0212 added user-defined
project-scoped groups. Both stop at the project boundary.

Issue #514: once programs have real membership (ADR-0070 `Program`, the #501
dual-level backlog), a program manager needs to ping across the projects of a
**program** — "all the PMs on Program Alpha", "everyone in the program release" —
without hand-listing each project's team. This is the program-scoped parallel of
the shipped project-scoped auto-groups.

**P3M layer / boundary.** Cross-*project* coordination *within a single program*
is explicitly OSS (CLAUDE.md two-repo rule: a program is one PM/team's set of
related projects). Cross-*program* and portfolio-level mention groups remain
Enterprise. `@program-*` therefore lands in OSS.

## Decision

### 1. Four keys, resolved from the union of project memberships
Add `PROGRAM_GROUP_KEYS = {program-pms, program-schedulers, program-stakeholders,
program-all}` to `access/groups.py`. A `@program-*` mention resolves against the
program that contains the project the comment was written in
(`Project.program`), drawing from the **union of `ProjectMembership` across every
live project in that program**, deduplicated:

- `@program-pms` — `role >= ADMIN` (Owners + Admins) across the program.
- `@program-schedulers` — `role >= SCHEDULER` across the program.
- `@program-stakeholders` — **exact `VIEWER` role** across the program.
- `@program-all` — every member of every project in the program.

**Why union-of-project-membership, not `ProgramMembership`.** The AC targets "every
PM/scheduler/viewer *across all projects* in a program" — the people actually
working the program's projects. `ProgramMembership` is a separate, smaller set
(formal program enrolment); resolving against it would miss the project leads a
program ping is meant to reach. The program's own OWNER `ProgramMembership` does
not, by itself, make someone a `@program-*` recipient.

**Why exact `VIEWER` for stakeholders.** Project-scoped `@viewers` uses a
`role >= VIEWER` floor, which — since `VIEWER` is the lowest band — resolves to
*everyone*. Reusing that floor for `@program-stakeholders` would make it identical
to `@program-all`. "Stakeholder" means the view-only audience, so the key matches
the exact `VIEWER` role.

### 2. Gates inherited from ADR-0075
- **Admin gate.** `@program-all`, like `@all`, requires the actor to be `ADMIN+`
  in the originating project (enforced in `resolve_parsed_mentions`; mirrored as a
  disabled autocomplete row). The role-banded keys are not gated.
- **Cardinality cap.** `@program-all` honors the same `ALL_GROUP_HARD_CAP` (200)
  as `@all` — a program-wide fan-out is exactly the blast radius the cap guards.
  The role-banded keys are uncapped, matching `@admins`/`@schedulers`.
- **Snapshot semantics + notification rules** (email default OFF, per-user mute,
  quiet hours) are unchanged — program groups flow through the same
  `create_mention_notifications` path.

### 3. Standalone projects
A project with `program = NULL` has no program to resolve against. A hand-typed
`@program-*` there raises `InvalidGroupKeyError`, which the fan-out path already
catches into `skipped_groups` (no notification, no 500). The autocomplete never
offers `@program-*` for a standalone project (`useProject().program` is null).

### 4. Reserved names
`ALL_AUTO_GROUP_KEYS = KNOWN_GROUP_KEYS | PROGRAM_GROUP_KEYS` now backs both the
mention parser's group/user classification and the user-defined-group name
validator, so a *new* curated group can never shadow a program key.

### 5. Cross-project snippet is gated on source-project membership
This is the one new trust-boundary decision. A `@program-*` mention is the first
case where a Notification recipient may **not** be a member of the mention's
source project (they are a member of a *sibling* project in the program). The
inbox's `NotificationSerializer.get_snippet` returned `comment.body[:200]`
unconditionally — a documented `#476` TODO already warned it "MUST re-check
current project membership at read time" once non-member recipients became
possible.

Decision: **redact the body snippet for a recipient who is not a current member
of the source project.** The row is still delivered (they learn they were pinged
and can click through, subject to normal task permissions), but one project's
comment text never surfaces to another project's team. Project membership is the
read boundary in OSS; a *program* is a coordination unit, not a shared-content
unit. The recipient's member-project set is resolved once per response
(`NotificationViewSet.get_serializer_context`) and memoized on the serializer
context, so the inbox list stays O(1) queries.

This also, for free, satisfies the standing rule that a member who has since
*left* the source project no longer sees the body.

## Consequences
- No schema change: resolution reuses `ProjectMembership` + `Project.program`;
  `Mention.mentioned_group_key` is a free `CharField(max_length=32)` and the
  longest key (`program-stakeholders`, 20 chars) fits. No migration.
- Two bounded queries per `@program-*` resolution (fetch `program_id`, then the
  joined membership query) — no N+1. Both filter columns are indexed
  (`Project.program`, `ProjectMembership.project`).
- **Amplification / uncapped role bands (considered, deferred):** only
  `@program-all` carries the `ALL_GROUP_HARD_CAP` (200); the role-banded keys are
  uncapped, matching project-level `@admins`/`@schedulers`. A program-wide band
  is a wider blast radius than a single project's, but the fan-out is bounded by
  the existing `MENTION_DAILY_LIMIT` and email is queued (not sent inline via the
  request), so the synchronous cost is bounded row inserts. If a program grows
  large enough for this to bite, extend the cap to all `PROGRAM_GROUP_KEYS`.
- **Pre-existing name collision (low risk):** a `UserDefinedMentionGroup` created
  *before* this change and named exactly like a program key (e.g. `program-pms`)
  is now classified as an auto-group and resolves program-wide instead of to its
  curated list. The name validator only reserves keys for *new* groups. Likelihood
  is negligible (a PM would have had to hand-pick that exact name); if it ever
  surfaces, a one-off rename is the remedy. Not worth a data migration in alpha.
- **Deferred:** the AC's "external stakeholder list" (non-member stakeholders) has
  no backing model and is out of scope here; `@program-stakeholders` covers
  Viewer-role members only. **#1658** owns the external-stakeholder registry
  (needs `enterprise-check` + design). This ADR also unblocks #516 (user-defined
  *program*-scoped groups), which builds on this program mention surface.
