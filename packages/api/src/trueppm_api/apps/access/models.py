"""RBAC models — ProjectMembership, ProgramMembership, and Role."""

from __future__ import annotations

from django.conf import settings
from django.db import models

from trueppm_api.apps.projects.models import VersionedModel


class Role(models.IntegerChoices):
    """Project-scoped roles, ordered by privilege level.

    The ordinal value is used directly for threshold comparisons in permission
    classes: role >= MEMBER means the user holds at least the Team Member role.

    Code name  │ Ordinal │ Issue #11 label  │ Notes
    ───────────┼─────────┼──────────────────┼─────────────────────────────────
    VIEWER     │    0    │ Viewer           │
    MEMBER     │    1    │ Team Member      │ edit own assigned tasks
    SCHEDULER  │    2    │ Resource Manager │ assign resources; no task edit
    ADMIN      │    3    │ Project Manager  │ full task/dep edit; create baseline
    OWNER      │    4    │ Project Admin    │ delete project; manage membership
    ───────────┴─────────┴──────────────────┴─────────────────────────────────
    OWNER is kept as the code name (not renamed to PROJECT_ADMIN) because it
    carries the last-Owner guard invariant throughout the codebase. The human-
    readable label is "Project Admin" for API consumers.
    """

    VIEWER = 0, "Viewer"
    MEMBER = 1, "Team Member"
    SCHEDULER = 2, "Resource Manager"
    ADMIN = 3, "Project Manager"
    OWNER = 4, "Project Admin"


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

    class Meta:
        db_table = "access_project_membership"
        unique_together = [("project", "user")]

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

    class Meta:
        db_table = "access_program_membership"
        unique_together = [("program", "user")]

    def __str__(self) -> str:
        return f"{self.user} — {self.program} ({Role(self.role).label})"
