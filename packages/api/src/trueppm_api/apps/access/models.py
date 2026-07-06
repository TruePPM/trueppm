"""RBAC models — ProjectMembership, ProgramMembership, and Role."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone

from trueppm_api.apps.projects.models import VersionedModel


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
    VIEWER     │    0    │ Viewer           │
               │  1–99   │                  │ read-augmented roles (e.g. Auditor)
    MEMBER     │   100   │ Team Member      │ edit own assigned tasks
               │ 101–199 │                  │ contributor extensions
    SCHEDULER  │   200   │ Resource Manager │ assign resources; no task edit
               │ 201–299 │                  │ resource-management extensions
    ADMIN      │   300   │ Project Manager  │ full task/dep edit; create baseline
               │ 301–399 │                  │ project-lead extensions
    OWNER      │   400   │ Project Admin    │ delete project; manage membership
               │  401+   │ (RESERVED)       │ no role above Owner; OSS contract
    ───────────┴─────────┴──────────────────┴─────────────────────────────────

    OWNER is kept as the code name (not renamed to PROJECT_ADMIN) because it
    carries the last-Owner guard invariant throughout the codebase. The human-
    readable label is "Project Admin" for API consumers.

    NEVER compare against a raw integer literal (e.g. ``if role < 1``) — always
    use the symbolic name (``if role < Role.MEMBER``) so the comparison stays
    correct if ordinals change.
    """

    VIEWER = 0, "Viewer"
    MEMBER = 100, "Team Member"
    SCHEDULER = 200, "Resource Manager"
    ADMIN = 300, "Project Manager"
    OWNER = 400, "Project Admin"


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
    # joined_at uses default=timezone.now (not auto_now_add) so the AddField
    # migration backfills existing rows non-interactively at migration time.
    joined_at = models.DateTimeField(default=timezone.now, editable=False)
    # NULL means the role has never changed since the member joined; it is
    # stamped with timezone.now() only on an actual role change (the viewset
    # partial_update and the ownership-transfer service). The UI shows the
    # "role changed" line only when this is set.
    role_changed_at = models.DateTimeField(null=True, blank=True, editable=False)
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
        ]

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
        "projects.Program",
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
    # joined_at uses default=timezone.now (not auto_now_add) so the AddField
    # migration backfills existing rows non-interactively at migration time.
    joined_at = models.DateTimeField(default=timezone.now, editable=False)
    # NULL means the role has never changed since the member joined; it is
    # stamped with timezone.now() only on an actual role change (the viewset
    # partial_update and transfer_program_sponsorship).
    role_changed_at = models.DateTimeField(null=True, blank=True, editable=False)
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
        ]

    def __str__(self) -> str:
        return f"{self.user} — {self.program} ({Role(self.role).label})"


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
        ]

    def __str__(self) -> str:
        return f"@{self.name} ({self.project_id})"
