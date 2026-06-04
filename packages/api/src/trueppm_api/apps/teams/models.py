"""Team and TeamMembership models (ADR-0078, OSS).

Two axes of authority live here and are deliberately independent:

* **Access role** (``TeamMembership.role``) — Member or Admin — is coordination
  authority: who can manage the team's membership and facets.
* **Facets** (``is_scrum_master``, ``is_product_owner``) — facilitation and
  ownership — are orthogonal markers. A user can be an Admin who is also Scrum
  Master, or a Member who is also Product Owner.

Keeping the facets off ``ProjectMembership`` is a hard ADR-0078 constraint: hanging
the booleans on the project membership made project-admin implicitly team-admin and
routed around the per-team consent model (Morgan 🔴). The Team entity exists so the
facet axis has a real, per-team home.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils import timezone

from trueppm_api.apps.projects.models import VersionedModel


class TeamRole(models.TextChoices):
    """Team-scoped coordination role.

    Intentionally only two tiers — the team's own membership management axis is
    coarse (you either manage the team or you don't). This is distinct from the
    5-tier project ``Role`` ordinal (ADR-0072): a project Admin inherits team-admin
    authority for low-consent actions (ADR-0078 §D) without holding this role.
    """

    MEMBER = "member", "Member"
    ADMIN = "admin", "Admin"


class Team(VersionedModel):
    """A Scrum team that owns a sprint commitment, scoped to one project (ADR-0078 §A).

    Every project has exactly one ``is_default=True`` team, auto-created by the
    initial data migration and kept populated by the auto-membership signal. The
    0.3 slice never creates a second team — multi-team UX lands in #599 (0.6) —
    so ``is_default`` is always True in practice today; the field and the
    one-default-per-project constraint exist so that work can land without a
    schema change.
    """

    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="teams",
    )
    name = models.CharField(max_length=255)
    short_id = models.CharField(max_length=8)
    description = models.TextField(blank=True, default="")
    # Auto-created at migration; exactly one per project. db_index because the
    # default-team resolution path (resolve_default_team) filters on it per request.
    is_default = models.BooleanField(default=False, db_index=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_teams",
    )
    # VersionedModel omits created_at/updated_at (sync uses server_version), so
    # these are explicit. default=timezone.now (not auto_now_add) lets the data
    # migration create rows with an explicit timestamp non-interactively.
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_team"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "name"],
                condition=models.Q(is_deleted=False),
                name="team_name_per_project_unique",
            ),
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(is_default=True, is_deleted=False),
                name="team_one_default_per_project",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.project_id})"


class TeamMembership(VersionedModel):
    """A user's membership of a team: an access role plus two independent facets.

    The facets are soft-singletons — at most one Scrum Master and one Product
    Owner per team — enforced at the serializer/service layer rather than by a DB
    constraint, so a facet can move between members in a single write (reassign)
    without a transient double-holder rejection.
    """

    team = models.ForeignKey(
        Team,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="team_memberships",
    )
    role = models.CharField(
        max_length=16,
        choices=TeamRole.choices,
        default=TeamRole.MEMBER,
    )
    is_scrum_master = models.BooleanField(default=False)
    is_product_owner = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        db_table = "teams_team_membership"
        constraints = [
            models.UniqueConstraint(
                fields=["team", "user"],
                condition=models.Q(is_deleted=False),
                name="team_member_unique",
            ),
        ]
        indexes = [
            # Facet resolution for gates: WHERE team_id = X AND user_id = Y.
            models.Index(fields=["team", "user"], name="tm_team_user_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.user} — {self.team} ({self.role})"

    @property
    def project_id(self) -> object:
        """Expose the owning project's id without a join, mirroring the access models.

        Permission helpers resolve a facet from a (user, project) pair; exposing
        project_id here keeps those call sites off a ``team.project_id`` chain.
        """
        return self.team.project_id
