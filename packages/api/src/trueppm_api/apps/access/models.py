"""RBAC models — ProjectMembership and Role."""

from __future__ import annotations

from django.conf import settings
from django.db import models

from trueppm_api.apps.projects.models import VersionedModel


class Role(models.IntegerChoices):
    """Project-scoped roles, ordered by privilege level.

    The ordinal value is used directly for threshold comparisons in permission
    classes: role >= MEMBER means the user holds at least the Member role.
    """

    VIEWER = 0, "Viewer"
    MEMBER = 1, "Member"
    SCHEDULER = 2, "Scheduler"
    ADMIN = 3, "Admin"
    OWNER = 4, "Owner"


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
