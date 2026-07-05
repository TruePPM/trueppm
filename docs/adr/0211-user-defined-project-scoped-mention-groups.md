# ADR-0211: User-defined project-scoped @mention groups

## Status
Accepted

## Context
ADR-0075 shipped **auto-groups** for `@mention` fan-out — group keys derived
from project RBAC (`@admins`, `@schedulers`, `@scrum-team`, `@all`, …) resolved
at write time by `access/groups.py`. Those cover the role-shaped cases but not
workflow-shaped ones. Issue #515 (VoC from #476 V2):

- Sarah (PM, construction): "I need `@subcontractors` and `@inspectors` — a
  *subset* of my Viewer-role members, not all of them."
- Morgan (Coach): "A `@team-private` channel that doesn't include the PM."

These are **user-defined**, project-scoped, admin-curated collections of project
members. `access/groups.py` explicitly deferred them: "User-defined groups
(#515/#516) are NOT resolved here — those land later with their own management
UI and a separate resolver path."

**P3M layer:** single-project collaboration. A PM curating groups within one of
their projects needs no cross-program coordination, no org policy, no compliance
evidence. Unambiguously **OSS** (the classification test: "would a PM need this
to run their program?" → yes). Program-scoped groups and cross-project sharing
are explicitly out of scope (separate issues).

## Decision

### 1. Model — `access.UserDefinedMentionGroup` (VersionedModel)
A new synced model in the `access` app (alongside `ProjectMembership`), UUID PK,
`server_version`, soft-delete. Fields:

- `project` FK → `projects.Project` (PROTECT) — project-scoped.
- `name` `CharField(max_length=32)` — the mention key *without* the leading `@`
  (so `@subcontractors` stores `subcontractors`). Bounded at 32 to fit
  `Mention.mentioned_group_key` (also 32).
- `description` `CharField(max_length=140, blank=True, default="")` — optional
  one-line purpose, shown in the manager UI. DJ001: empty string, never NULL.
- `email_default_on` `BooleanField(default=False)` — the **per-group email
  default** (AC bullet). Default OFF preserves Priya's un-opted-email hard-NO
  (ADR-0075 V2). The group manager flips it.
- `created_by` FK → User (SET_NULL).
- `members` `ManyToManyField(User, related_name="mention_groups", blank=True)`
  — the curated member set. A plain M2M (auto through table): membership does
  **not** need its own sync stream because mention resolution is server-side at
  comment-write time; offline clients never resolve groups.
- `muted_by` `ManyToManyField(User, related_name="muted_mention_groups")` — the
  **per-user override / per-group mute** (AC bullet). A member who mutes a group
  receives neither in-app nor email for that group's mentions. One mechanism
  serves both "per-user override" and "per-group mute": muting a group whose
  default is ON *is* the per-user override.

Constraints: `UniqueConstraint(project, Lower(name))` — **case-insensitive**
project-unique name. Index `(project, server_version)` for the sync delta pull.

### 2. Name validation (serializer)
- Strip a leading `@` if the client sends one; trim; store as entered otherwise.
- Must match the mention key grammar `^[A-Za-z0-9_.-]+$` (the `_MENTION_RE`
  name class) so the group is actually mentionable.
- **Reject reserved auto-group names** (`KNOWN_GROUP_KEYS`: owners, admins,
  schedulers, members, viewers, all, scrum-team), case-insensitively — an
  auto-group name must never be shadowed by a user-defined one.
- Case-insensitive project-unique (DB constraint + a friendly serializer check).

### 3. RBAC (the split the issue asks for)
- **Group lifecycle** (create / rename / edit / delete): Project **Admin+**
  (`role >= Role.ADMIN`). Curating the *set of groups* is a PM act.
- **Membership + mute** (add / remove members, mute / unmute): Project
  **Scheduler+** (`role >= Role.SCHEDULER`) for add/remove; **any member** may
  mute/unmute *their own* subscription. Enforced in the viewset via
  `_membership_role`, mirroring `ProjectMembershipViewSet`.

### 4. Resolver path — reinterpret in `resolve_parsed_mentions`, not the parser
`parse_mentions` is a **pure** function with no project context, so it cannot
know that `@subcontractors` is a group. It therefore classifies any non-
`KNOWN_GROUP_KEYS` `@name` as `kind="user"` — unchanged. The project-aware step,
`notifications.services.resolve_parsed_mentions`, already has `project_id`, so it
becomes the single reinterpretation point:

1. Resolve `@user` names against project membership (as today).
2. For names that did **not** resolve to a member, look them up
   (case-insensitively) as `UserDefinedMentionGroup.name` in this project. A
   match is promoted to a group target (snapshot-resolved to its current members)
   and dropped from `skipped_users`.
3. Truly-unknown names remain skipped (structured 400, unchanged).

Username namespace wins over group namespace on an exact collision (a real member
is resolved before we ever consider groups) — acceptable and documented; group
names like `subcontractors` do not collide with usernames in practice.

`access/groups.py` gains `resolve_user_defined_group_members(project_id, name)`
— the "separate resolver path" the module's docstring promised — with the same
**snapshot-at-write** semantics as the auto-group resolver (new members joining
after a mention are not retroactively notified; departed members are not
re-pinged). Non-members in the M2M are filtered out at resolution.

### 5. Notification routing (inherits #476 semantics)
User-defined group mentions fan out through the existing `create_mention_notifications`
path and are recorded as `MentionScope.PROJECT_VISIBLE` `Mention` rows with
`mentioned_group_key = <name>`, exactly like auto-groups. The per-group email
default and per-group mute are applied inside the fan-out:

- **In-app**: created iff the project matrix `comment_mention/in_app` cell is ON
  **and** the recipient has not muted the group. (Direct `@user` mentions are
  never suppressed by a group mute — mute is group-scoped.)
- **Email**: `email_pending` iff the project matrix `comment_mention/email` cell
  is ON, outside quiet hours, the recipient has not muted the group, **and** the
  group's `email_default_on` is True. This replaces the global `MENTION_GROUP`
  toggle *for user-defined groups only* — the group manager's per-group default
  plus the member's mute is the complete, self-contained control surface the
  issue asks for. Auto-groups keep their existing global-toggle behavior.

### 6. Real-time + sync
Group create/rename/delete/membership writes broadcast a `mention_group_changed`
board event via `broadcast_board_event()` deferred with
`transaction.on_commit()` (ADR-0083), so open Members tabs refresh. The group
subclasses `VersionedModel` (UUID PK, `server_version`, soft-delete) for
consistency with the rest of the `access` app and to carry a monotonic version
for the broadcast + any future mobile-delta registration; membership edits bump
`server_version` on the parent row. Wiring it into the offline sync delta
(`sync/serializers.py`, `sync/views.py`) is **not** in scope for #515 — mention
resolution is server-side at comment-write time, so offline clients never need
to resolve groups.

## Consequences
- One new model + one migration (`access/0013`). No change to the pure parser,
  so no risk to the 0.2 mention grammar. Auto-group behavior is byte-identical.
- The reinterpretation adds **one** query (group name lookup) only when a comment
  contains an unresolved `@name` — the common case (all names resolve to members)
  is unaffected.
- Per-user-per-group state is deliberately minimal: a single `muted_by` M2M, not
  a full per-(user, group, channel) matrix. That is enough to satisfy the AC
  (per-user override + per-group mute) without a new preference table.
