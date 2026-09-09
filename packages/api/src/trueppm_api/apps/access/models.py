"""RBAC models — ProjectMembership, ProgramMembership, and Role."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone

from trueppm_api.apps.projects.models import VersionedModel

# The three program-scoped models below (ProgramMembership,
# ProgramUserDefinedMentionGroup, ExternalStakeholder) all point their `program`
# ForeignKey at the same target. Naming it once keeps the app-label reference in
# a single place. Django serializes the FK target to this resolved string, so
# using the constant produces no migration change.
_PROGRAM_MODEL = "projects.Program"


class Role(models.IntegerChoices):
    """Project-scoped roles, ordered by privilege level (ADR-0072).

    Ordinals are spaced in 100-unit bands so Enterprise can register custom roles
    at intermediate values (e.g., a "Senior Scheduler" at 250) without forcing an
    OSS renumber. The band-boundary contract:

      - role >= Role.X (inequality / threshold) — "at least the X-band";
        Enterprise custom roles at intermediate ordinals DO inherit this band's
        capabilities.
      - role == Role.X (singular-tier equality) — "specifically the OSS X tier";
        custom roles do NOT silently absorb these matches. If Enterprise wants
        override semantics, it goes through the slot-registration pattern
        (ADR-0029), not OSS code changes.

    Code name  │ Ordinal │ Issue #11 label  │ Reserved band for Enterprise
    ───────────┼─────────┼──────────────────┼─────────────────────────────────
    VIEWER     │    1    │ Viewer           │ the floor; 0 is deliberately unused
               │  2–99   │                  │ read-augmented roles (e.g. Auditor)
    MEMBER     │   100   │ Team Member      │ edit own assigned tasks
               │ 101–199 │                  │ contributor extensions
    SCHEDULER  │   200   │ Resource Manager │ assign resources; no task edit
               │ 201–299 │                  │ resource-management extensions
    ADMIN      │   300   │ Project Manager  │ full task/dep edit; create baseline
               │ 301–399 │                  │ project-lead extensions
    OWNER      │   400   │ Project Admin    │ delete project; manage membership
               │  401+   │ (RESERVED)       │ no role above Owner; OSS contract
    ───────────┴─────────┴──────────────────┴─────────────────────────────────

    VIEWER is 1, not 0 (#2489). The ordinal is client-visible — it ships in
    membership payloads, invites, and MCP reads — and JavaScript treats 0 as
    falsy, so a single ``role || DEFAULT`` on any consumer silently promotes a
    Viewer to whatever the default is. Every role ordinal is now truthy, which
    removes the failure mode rather than relying on every consumer to remember
    ``??``. It costs one slot from the read-augmented band (2–99, still 98).

    "No membership" is expressed as ``None`` (a distinct type), never as an
    ordinal, so no sentinel value below VIEWER is needed or reserved.

    OWNER is kept as the code name (not renamed to PROJECT_ADMIN) because it
    carries the last-Owner guard invariant throughout the codebase. The human-
    readable label is "Project Admin" for API consumers.

    The labels above are **project-scoped**. A program names the same two top
    ordinals differently — see :data:`PROGRAM_ROLE_LABELS` below, which is the
    single source of that vocabulary; any new member added here must be added
    there too or the mapping test fails.

    NEVER compare against a raw integer literal (e.g. ``if role < 1``) — always
    use the symbolic name (``if role < Role.MEMBER``) so the comparison stays
    correct if ordinals change.
    """

    VIEWER = 1, "Viewer"
    MEMBER = 100, "Team Member"
    SCHEDULER = 200, "Resource Manager"
    ADMIN = 300, "Project Manager"
    OWNER = 400, "Project Admin"


# Program-context labels for the shared ``Role`` enum (#1794, #3503). The enum
# labels are project-scoped ("Project Admin", "Project Manager"); a program
# surface must read the role as it applies to the *program*, not to some
# project. Every role the enum defines is mapped so a future enum value can't
# silently fall back to a project label without a matching test failing. The
# project-side ``Role.label`` values are intentionally left unchanged.
#
# This lives beside ``Role`` rather than in a serializer module because two
# apps read it — ``access`` (membership rows) and ``projects`` (the program
# card) — and one rule rendered twice must have one definition (ADR-0133).
PROGRAM_ROLE_LABELS: dict[Role, str] = {
    Role.VIEWER: "Viewer",
    Role.MEMBER: "Team Member",
    Role.SCHEDULER: "Resource Manager",
    Role.ADMIN: "Program Manager",
    Role.OWNER: "Program Admin",
}


def program_role_label(role: int | None) -> str | None:
    """Program-context display label for a role ordinal.

    Returns ``None`` for ``None`` (no membership) and for any ordinal the
    ``Role`` enum does not define. That second branch is not defensive padding:
    ADR-0072 reserves the 2-99, 101-199, 201-299 and 301-399 bands for
    Enterprise custom roles, ``ProgramMembership.role`` is a plain
    ``IntegerField`` whose ``choices`` PostgreSQL does not enforce, and a bare
    ``Role(350)`` raises ``ValueError`` — which DRF does not convert, so it
    500s the WHOLE response rather than just this field (the failure mode
    #3419 fixed on the project side). ``None`` is honest: the OSS edition
    genuinely has no name for that ordinal, and every caller decides for itself
    how to render the gap.
    """
    if role is None or role not in Role.values:
        return None
    # ``.get``, not ``[]``: the map is exhaustive over ``Role`` and
    # ``test_every_role_has_a_program_label`` is what keeps it that way, but a
    # ``KeyError`` raised here would 500 the whole response — reintroducing, for a
    # new-enum-member input, exactly the failure shape the guard above removes.
    return PROGRAM_ROLE_LABELS.get(Role(role))


class ProjectMembership(VersionedModel):
    """Through table linking a user to a project with a specific role.

    Deliberately kept as a standalone model (not a ManyToManyField through=)
    so that it participates in the offline sync protocol via VersionedModel
    and can be queried directly in permission checks without a join through Project.
    """

    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.PROTECT,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    role = models.IntegerField(choices=Role.choices)
    # Per-project access evidence (#590): the OSS surface needs a minimum-viable
    # "who has access and since when" answer for compliance questionnaires.
    # VersionedModel deliberately omits created_at/updated_at (sync uses
    # server_version), so these are explicit columns rather than inherited.
    # Scope of the evidence (#3410): joined_at is the *first* join. Re-adding a
    # revoked member revives their original row and keeps this date, so the span
    # it describes may contain revoked intervals — use reinstated_at below as the
    # discriminator between "joined once, never left" and "was away and came
    # back". Do not present joined_at alone as proof of uninterrupted access.
    # joined_at uses default=timezone.now (not auto_now_add) so the AddField
    # migration backfills existing rows non-interactively at migration time.
    joined_at = models.DateTimeField(default=timezone.now, editable=False)
    # NULL means the role has never changed since the member joined; it is
    # stamped with timezone.now() only on an actual role change (the viewset
    # partial_update and the ownership-transfer service). The UI shows the
    # "role changed" line only when this is set.
    role_changed_at = models.DateTimeField(null=True, blank=True, editable=False)
    # Per-project reinstatement evidence (#3436). NULL means this membership has
    # never been revoked and re-added — a fresh add leaves it null. Stamped with
    # timezone.now() only in _revive_revoked_membership, each time a revoked row
    # is revived (a second revive advances it, it does not accumulate history).
    # This is the durable server-side fact #3410 shipped without: neither model
    # carries HistoricalRecords, deleted_version is cleared on revive, and the
    # access app writes no AuditEvent, so before this field there was no trace of
    # a revocation surviving past TRUEPPM_BOARD_EVENT_RETENTION_HOURS (24h
    # default). A machine caller reading joined_at alone cannot tell a
    # never-lapsed membership from a revived one; reinstated_at is the
    # discriminator.
    reinstated_at = models.DateTimeField(null=True, blank=True, editable=False)
    # Set when this membership was materialized by a workspace Group→project
    # cascade (ADR-0087 §5) rather than a direct invite. A direct grant
    # (source_group IS NULL) always wins: group reconciliation never alters or
    # revokes a direct membership, and only removes rows it created itself.
    source_group = models.ForeignKey(
        "workspace.Group",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="granted_memberships",
    )

    class Meta:
        db_table = "access_project_membership"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"], name="uniq_project_membership_project_user"
            ),
        ]
        indexes = [
            # Sync delta pull: WHERE project_id = X AND server_version > since (#810).
            models.Index(fields=["project", "server_version"], name="pm_proj_serverver_idx"),
            models.Index(fields=["project", "sync_seq"], name="pm_proj_syncseq_idx"),
        ]

    @classmethod
    def live(cls) -> models.QuerySet[ProjectMembership]:
        """Membership rows that have not been revoked — the soft-delete floor, in one place.

        It floors the *membership* only. A row on a soft-deleted **project** passes this
        and confers nothing, so a caller that does not already scope to a live project
        needs ``project__is_deleted=False`` as well (as
        ``notifications.digests.build_resource_overallocation_digest`` does). All current
        callers supply their own project scope.

        The uniqueness constraint above is **unconditional**: revoking access soft-deletes
        the row rather than removing it, and re-adding the member revives that same row
        (#3410). So a ``(project, user)`` lookup that omits ``is_deleted`` resolves a
        *revoked* member to their old role and reads as if they were still present — the
        defect class fixed on the write gates in #3386 and on the read paths in #3411.

        **Scope, stated narrowly on purpose.** This is a convenience for a *direct*
        ``ProjectMembership`` lookup; it is not, and does not claim to be, the only place
        the predicate lives. Being a classmethod it cannot compose through a related
        manager or a join, so the ~30 ``memberships__is_deleted=False`` join filters and
        the ``obj.memberships.filter(is_deleted=False)`` reads elsewhere necessarily
        restate it and are correct as they stand. Nothing enforces that a new direct read
        starts here — no test, no CI gate — so treat this as a shared definition to
        prefer, not an invariant to rely on. Making it a queryset method on a custom
        manager would let ``project.memberships.live()`` and ``Prefetch`` compose too;
        that is the natural next step and is deliberately not taken in this fix.

        Some direct reads must see revoked rows and stay on ``objects`` by design: the
        ``pre_save`` receiver in :mod:`~trueppm_api.apps.access.signals`, which reads the
        prior row precisely to detect the revocation transition; the add-member path in
        :mod:`~trueppm_api.apps.access.views`, which has to find a revoked row to revive
        it against the unconditional constraint, and to narrow its ``IntegrityError``
        against that same constraint; the sync delta, which ships tombstones by protocol
        so a client can learn the membership went away; and the workspace group-cascade
        reconciliation. Writes (``create``, ``get_or_create``, seeds, data migrations)
        are not reads and are equally out of scope.
        """
        return cls.objects.filter(is_deleted=False)

    def __str__(self) -> str:
        return f"{self.user} — {self.project} ({Role(self.role).label})"


class ProgramMembership(VersionedModel):
    """Through table linking a user to a program with a specific role (ADR-0070).

    Mirrors :class:`ProjectMembership` exactly — standalone model (not M2M
    ``through=``) so it participates in the offline sync protocol and supports
    direct permission checks without joining through ``Program``.

    Program membership controls access to program-level views (backlog, projects
    list, members). It does **not** automatically grant or modify project-level
    access — a user must be invited to each project separately. This is the
    deliberate "explicit grants only" boundary called out in ADR-0070 §RBAC.

    Uses the same :class:`Role` enum as :class:`ProjectMembership`; the role
    ordinals share semantics: VIEWER reads, MEMBER edits, SCHEDULER assigns,
    ADMIN manages member/projects, OWNER deletes program.
    """

    program = models.ForeignKey(
        _PROGRAM_MODEL,
        on_delete=models.PROTECT,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="program_memberships",
    )
    role = models.IntegerField(choices=Role.choices)
    # Per-program access evidence (#878): mirrors ProjectMembership exactly so
    # ADR-0070's "mirrors ProjectMembership" claim holds and the program members
    # view can answer "who has access and since when". VersionedModel omits
    # created_at/updated_at (sync uses server_version), so these are explicit.
    # The same scope caveat applies as on the project side (#3410): joined_at is
    # the first join and survives a revoke-then-re-add, so it is not proof of
    # uninterrupted access — reinstated_at below is the discriminator.
    # joined_at uses default=timezone.now (not auto_now_add) so the AddField
    # migration backfills existing rows non-interactively at migration time.
    joined_at = models.DateTimeField(default=timezone.now, editable=False)
    # NULL means the role has never changed since the member joined; it is
    # stamped with timezone.now() only on an actual role change (the viewset
    # partial_update and transfer_program_sponsorship).
    role_changed_at = models.DateTimeField(null=True, blank=True, editable=False)
    # Per-program reinstatement evidence (#3436) — mirrors ProjectMembership's
    # field exactly. NULL means never revoked and re-added; stamped with
    # timezone.now() each time _revive_revoked_membership revives this row.
    reinstated_at = models.DateTimeField(null=True, blank=True, editable=False)
    # Freeform functional-role label (#565), e.g. "Product Owner" / "Tech Lead" /
    # "Scrum Master" — distinct from, and orthogonal to, the access ``role`` enum
    # above. It is purely descriptive: not enforced anywhere, it anchors the
    # PO-vs-PM sovereignty signals #501 will surface (a PM-labeled member dragging
    # a story into an active sprint). Empty string is the single "unset" state
    # (no nullable string, per project DJ001 convention); the serializer strips a
    # whitespace-only submission back to "".
    role_title = models.CharField(max_length=50, blank=True, default="")

    class Meta:
        db_table = "access_program_membership"
        constraints = [
            models.UniqueConstraint(
                fields=["program", "user"], name="uniq_program_membership_program_user"
            ),
        ]
        indexes = [
            # Sync delta pull: WHERE program_id = X AND server_version > since
            # (ADR-0070 §Sync). Mirrors ProjectMembership's pm_proj_serverver_idx
            # so the standard offline-sync query pattern is index-backed on the
            # program side too — introduced with the #561 user-scoped program
            # sync endpoint.
            models.Index(fields=["program", "server_version"], name="progm_serverver_idx"),
            models.Index(fields=["program", "sync_seq"], name="progm_syncseq_idx"),
        ]

    def __str__(self) -> str:
        # Program vocabulary, not ``Role.label`` — this row is a membership of a
        # *program*, and the admin/log line that renders it should not call the
        # holder a "Project Admin" (#3503). Falls back to the raw ordinal for an
        # Enterprise custom-band role the OSS enum cannot name (ADR-0072).
        label = program_role_label(self.role) or f"Role {self.role}"
        return f"{self.user} — {self.program} ({label})"


class UserDefinedMentionGroup(VersionedModel):
    """Admin-curated, project-scoped ``@mention`` group (ADR-0212, #515).

    Complements the RBAC-derived auto-groups (``@admins``, ``@scrum-team``, …)
    resolved in ``access/groups.py`` with workflow-shaped groupings a PM defines
    by hand — e.g. ``@subcontractors``, ``@inspectors``, ``@team-private`` — that
    do not map onto a role band.

    ``name`` is the mention key *without* the leading ``@`` and is bounded to 32
    chars so it fits ``notifications.Mention.mentioned_group_key``. It is
    case-insensitively unique per project and may not collide with an auto-group
    key (validated in the serializer against ``ALL_AUTO_GROUP_KEYS`` — project-
    and program-scoped keys alike).

    Mention resolution snapshots the member list at write time — the same
    semantics as the auto-group resolver — so members added after a mention are
    not retroactively notified and departed members are not re-pinged.
    """

    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.PROTECT,
        related_name="mention_groups",
    )
    # The mention key without the leading @ (e.g. "subcontractors").
    name = models.CharField(max_length=32)
    # Optional one-line purpose shown in the manager UI. DJ001: "" not NULL.
    description = models.CharField(max_length=140, blank=True, default="")
    # Per-group email default (ADR-0212 §5). Default OFF preserves the un-opted-
    # email hard-NO (ADR-0075 V2); the group manager flips it on.
    email_default_on = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_mention_groups",
    )
    # Curated members. Plain M2M (no sync stream): resolution is server-side at
    # comment-write time, so offline clients never resolve groups.
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="mention_groups",
        blank=True,
    )
    # Per-user override / per-group mute (ADR-0212 §5). A member who mutes a group
    # receives neither in-app nor email for that group's mentions; a direct
    # @user mention still reaches them (mute is group-scoped).
    muted_by = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="muted_mention_groups",
        blank=True,
    )

    class Meta:
        db_table = "access_user_defined_mention_group"
        constraints = [
            # Case-insensitive project-unique name, enforced only across LIVE rows
            # (condition mirrors the serializer's is_deleted=False uniqueness check).
            # A soft-deleted group therefore frees its name for reuse rather than
            # reserving it — without the condition, re-creating a name after delete
            # would pass serializer validation but hit the DB constraint as a 500.
            models.UniqueConstraint(
                "project",
                Lower("name"),
                condition=models.Q(is_deleted=False),
                name="uniq_mention_group_project_name_ci",
            ),
        ]
        indexes = [
            # Sync delta pull: WHERE project_id = X AND server_version > since.
            models.Index(fields=["project", "server_version"], name="udmg_proj_serverver_idx"),
            models.Index(fields=["project", "sync_seq"], name="udmg_proj_syncseq_idx"),
        ]

    def __str__(self) -> str:
        return f"@{self.name} ({self.project_id})"


class ProgramUserDefinedMentionGroup(VersionedModel):
    """Owner-curated, program-scoped ``@mention`` group (ADR-0248, #516).

    The program-scoped parallel of :class:`UserDefinedMentionGroup`: a program
    manager hand-curates a collection of members drawn from across the program's
    projects — e.g. ``@program-tech-leads``, ``@program-vendor-x`` — that does not
    map onto a role band (the role-banded cases are the ADR-0240 auto-groups).

    Mentioned as a plain ``@name`` (no ``program-`` prefix — that prefix is
    reserved for the ADR-0240 auto-groups) from a comment on any task in a project
    of the program. Resolution precedence is member → project group → program
    group, so a program group is the widest, least-specific match (ADR-0248 §4).

    ``members`` are selectable across *all* projects in the program (the union of
    ``ProjectMembership``, matching ADR-0240's program-membership semantics), and
    resolution snapshots the member list at write time — members added after a
    mention are not retroactively notified, departed members are not re-pinged.
    """

    program = models.ForeignKey(
        _PROGRAM_MODEL,
        on_delete=models.PROTECT,
        related_name="mention_groups",
    )
    # The mention key without the leading @ (e.g. "tech-leads").
    name = models.CharField(max_length=32)
    # Optional one-line purpose shown in the manager UI. DJ001: "" not NULL.
    description = models.CharField(max_length=140, blank=True, default="")
    # Per-group email default (ADR-0248 §1, mirrors ADR-0212 §5). Default OFF
    # preserves the un-opted-email hard-NO (ADR-0075 V2); the manager flips it on.
    email_default_on = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_program_mention_groups",
    )
    # Curated members. Plain M2M (no sync stream): resolution is server-side at
    # comment-write time, so offline clients never resolve groups.
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="program_mention_groups",
        blank=True,
    )
    # Per-user override / per-group mute (ADR-0248 §1). A member who mutes a group
    # receives neither in-app nor email for that group's mentions; a direct
    # @user mention still reaches them (mute is group-scoped).
    muted_by = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="muted_program_mention_groups",
        blank=True,
    )

    class Meta:
        db_table = "access_program_user_defined_mention_group"
        constraints = [
            # Case-insensitive program-unique name across LIVE rows only — mirrors
            # the ADR-0212 project constraint so a soft-deleted group frees its name.
            models.UniqueConstraint(
                "program",
                Lower("name"),
                condition=models.Q(is_deleted=False),
                name="uniq_program_mention_group_program_name_ci",
            ),
        ]
        indexes = [
            # Sync delta pull: WHERE program_id = X AND server_version > since.
            models.Index(fields=["program", "server_version"], name="pudmg_prog_serverver_idx"),
            models.Index(fields=["program", "sync_seq"], name="pudmg_prog_syncseq_idx"),
        ]

    def __str__(self) -> str:
        return f"@{self.name} ({self.program_id})"


class ExternalStakeholder(models.Model):
    """A non-account external stakeholder registered against a program (#1658, ADR-0264).

    A snapshot-resolved registry of people who are *not* TruePPM users — client
    sponsors, vendor contacts, external reviewers — whom a program manager wants
    reachable through the ``@program-stakeholders`` mention fan-out alongside the
    program's Viewer-role members. The resolver
    (:func:`trueppm_api.apps.access.groups.resolve_external_stakeholders`) reads
    this table at comment-write time; later membership edits are not retroactive,
    matching the auto-group snapshot semantics.

    Registry/config, **not** sync state: like ``ShareLink`` and ``ApiToken`` this is
    a plain :class:`django.db.models.Model` (no ``server_version``) and is never part
    of the mobile offline delta — external stakeholders are a server-side program
    setting, not a board object a client edits offline.

    Email delivery to these addresses is **deferred to #1675**: #1658 ships the
    registry model + resolver so the recipient count can be surfaced, but no
    outbound mail is sent to an external stakeholder yet.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    program = models.ForeignKey(
        _PROGRAM_MODEL,
        on_delete=models.CASCADE,
        related_name="external_stakeholders",
    )
    name = models.CharField(max_length=200)
    email = models.EmailField()
    note = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # Soft-delete so a removed stakeholder's email frees up for re-add and the
    # case-insensitive unique constraint only binds live rows (see Meta).
    is_deleted = models.BooleanField(default=False)

    class Meta:
        db_table = "access_external_stakeholder"
        constraints = [
            # Case-insensitive (program, email) uniqueness across LIVE rows only —
            # mirrors the mention-group constraint pattern so a soft-deleted row
            # frees its email for re-add rather than reserving it (a re-add would
            # otherwise pass the serializer check but hit the DB as a 500).
            models.UniqueConstraint(
                "program",
                Lower("email"),
                condition=models.Q(is_deleted=False),
                name="uniq_external_stakeholder_program_email_ci",
            ),
        ]
        indexes = [
            # List query: WHERE program_id = X AND is_deleted = False.
            models.Index(fields=["program", "is_deleted"], name="extstake_prog_deleted_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.name} <{self.email}> ({self.program_id})"
