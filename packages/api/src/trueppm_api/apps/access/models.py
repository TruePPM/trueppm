"""RBAC models — ProjectMembership, ProgramMembership, and Role."""

from __future__ import annotations

from django.conf import settings
from django.db import models
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

    class Meta:
        db_table = "access_program_membership"
        constraints = [
            models.UniqueConstraint(
                fields=["program", "user"], name="uniq_program_membership_program_user"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} — {self.program} ({Role(self.role).label})"
