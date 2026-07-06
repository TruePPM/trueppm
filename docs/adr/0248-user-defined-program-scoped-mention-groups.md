# ADR-0248: User-defined program-scoped @mention groups

## Status
Accepted

## Context
Three mention surfaces already exist:

- **ADR-0075** — project-scoped RBAC auto-groups (`@admins`, `@scrum-team`, `@all`, …).
- **ADR-0212** — user-defined, project-scoped, admin-curated groups
  (`access.UserDefinedMentionGroup`) for workflow-shaped collections a PM hand-picks
  (`@subcontractors`, `@inspectors`).
- **ADR-0240** — program-scoped **auto**-groups (`@program-pms`, `@program-all`, …),
  resolved from the union of `ProjectMembership` across a program's projects.

Issue #516 is the one remaining quadrant: **user-defined, program-scoped** groups — a
program manager's hand-curated `@program-vendor-x` / `@program-tech-leads` collection
that spans the projects of one program but isn't a role band. ADR-0240 explicitly named
#516 as the follow-up it unblocks.

**P3M layer / boundary.** Cross-*project* coordination *within a single program* is OSS
(CLAUDE.md two-repo rule: a program is one PM/team's set of related projects). This is the
program parallel of the already-OSS ADR-0212. Cross-*program* / org-level groups remain
Enterprise and are out of scope (the issue files those in `trueppm-enterprise`).

**Design provenance (why no fresh VoC/architect pass).** The design is fully determined by
the two accepted sibling ADRs: the model, serializer, viewset, resolver, and notification
routing all mirror ADR-0212 with `Program` substituted for `Project`, and the program
membership union / precedence semantics come from ADR-0240. This follows the precedent set
by ADR-0240 itself (a parallel of ADR-0075/0212, which likewise carried no new design pass).
The one genuinely new decision — flat-namespace resolution precedence — is recorded in §4.

## Decision

### 1. Model — `access.ProgramUserDefinedMentionGroup` (VersionedModel)
A program-scoped mirror of `UserDefinedMentionGroup`, same fields and semantics:

- `program` FK → `projects.Program` (PROTECT, `related_name="mention_groups"`).
- `name` `CharField(max_length=32)` — the mention key without the leading `@`.
- `description` `CharField(max_length=140, blank=True, default="")`.
- `email_default_on` `BooleanField(default=False)` — per-group email default (OFF preserves
  the ADR-0075 un-opted-email hard-NO).
- `created_by` FK → User (SET_NULL).
- `members` M2M → User (`related_name="program_mention_groups"`).
- `muted_by` M2M → User (`related_name="muted_program_mention_groups"`) — per-user mute.

Constraint: `UniqueConstraint(program, Lower(name), condition=is_deleted=False)` —
**case-insensitive program-unique** name across live rows (a soft-deleted group frees its
name, matching ADR-0212). Index `(program, server_version)` for the sync delta pull.

### 2. Members are program-wide (the AC's "selectable across all projects")
A group member is any user who holds a live `ProjectMembership` on **any** project of the
program. `add-member` validates against that union (not a single project, not
`ProgramMembership`) — mirroring ADR-0240's "union of project memberships is who works the
program." Resolution filters out members who no longer hold any program-project membership,
so a departed member's lingering M2M row never pings.

### 3. RBAC — lifecycle is Program **Owner** (the AC's explicit ask)
- **Group lifecycle** (create / rename / edit / delete): Program **Owner**
  (`role >= Role.OWNER`). The issue AC says "Program Owner can create, rename, and delete";
  curating a program's group set is a program-owner act, one band above ADR-0212's project
  Admin+ because a program spans multiple project teams.
- **Membership** (add / remove): Program **Admin+** (`role >= Role.ADMIN`).
- **Mute / unmute**: any program member (`role >= Role.VIEWER`), own subscription only.

Enforced in the viewset via `_program_membership_role`, mirroring `ProgramMembershipViewSet`.

### 4. Resolution — extend `resolve_parsed_mentions`, flat namespace, documented precedence
A program user-defined group is mentioned as a plain `@name` from a comment on a task in any
project of the program — no `program-` prefix (that prefix is reserved for the ADR-0240
auto-groups). The parser stays pure; the project-aware `resolve_parsed_mentions` gains one
fall-through step after the existing ADR-0212 project-group lookup:

**Precedence (new decision):** for an unresolved `@name`,
`project member → project user-defined group → program user-defined group → skipped`.
The **more specific scope wins**: a real member beats any group, and a project-scoped group
beats a program-scoped group of the same name. A comment's project must belong to a program
(`Project.program`) for the program step to run; standalone projects skip it. The program
lookup adds **one** batched query, and only for names still unresolved after the member +
project-group steps (the common all-resolve case is untouched).

`access/groups.py` gains `resolve_program_user_defined_group_members(program_id, name)` —
the program sibling of `resolve_user_defined_group_members`, same snapshot-at-write
semantics, filtering to users who still hold a membership somewhere in the program.

### 5. Notification routing (inherits ADR-0212 §5 + ADR-0240 §5)
Program group mentions fan out through the existing `create_mention_notifications` path as
`Mention` rows with `mentioned_group_key = <name>`. The per-group `email_default_on` and
`muted_by` are applied in the fan-out exactly like project groups — the fan-out's group
lookup queries `ProgramUserDefinedMentionGroup` in addition to `UserDefinedMentionGroup`,
with the project group taking precedence on the (documented, negligible) name collision, to
match the resolution precedence in §4. Cross-project snippet redaction (ADR-0240 §5:
recipients who aren't members of the source project get the body redacted) already covers
program-group recipients on sibling projects — no new code.

### 6. Real-time + sync
Create / rename / delete / membership writes broadcast a `mention_group_changed` board event
(reusing the ADR-0212 event name, with `scope: "program"` in the payload) via
`broadcast_board_event()` deferred with `transaction.on_commit()` (ADR-0083). Because a
program isn't board-scoped, the broadcast targets **each live project in the program** so any
open Members tab in the program refreshes. The model is a `VersionedModel` (UUID PK,
`server_version`, soft-delete); membership edits bump `server_version` on the parent row.
Offline sync-delta registration is out of scope (resolution is server-side at write time, so
offline clients never resolve groups — same as ADR-0212 §6).

## Consequences
- One new model + one migration (`access/0014`). No change to the pure parser or to
  auto-group behavior. The reinterpretation adds one query only for a comment carrying an
  `@name` that is neither a member nor a project group.
- **Name collision (low risk, documented):** a project group and a program group with the
  same name in the same project resolve to the *project* group (§4 precedence). A program
  group whose name later matches a program auto-group added upstream is shadowed by the auto-
  group — the validator reserves `ALL_AUTO_GROUP_KEYS` for *new* groups only (same residual
  risk ADR-0240 documented; a one-off rename is the remedy).
- Per-user-per-group state stays minimal (one `muted_by` M2M), matching ADR-0212.
- The management UI is a program-scoped mirror of the project `MentionGroupsSection`, mounted
  on the Program Settings Members section (rule 195 consolidated settings page).
