"""Auto-membership invariant for the teams app (ADR-0078 §F).

A ``ProjectMembership`` write mirrors onto the project's default ``Team`` so that
the facet matrix always reflects the project's members and a new member never sees
a separate "join the team" step. The mirror runs on commit so a rolled-back
membership change mirrors nothing.
"""

from __future__ import annotations

from functools import partial
from typing import Any

from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.teams.services import ensure_team_membership


@receiver(
    post_save,
    sender=ProjectMembership,
    dispatch_uid="teams_mirror_membership_to_default_team",
)
def _mirror_membership_to_default_team(
    sender: type, instance: ProjectMembership, **kwargs: Any
) -> None:
    """Keep the default team's membership in step with the project's membership.

    Skips soft-deleted rows: a revoked project membership should not (re)create a
    team membership. Team-membership removal on project-member removal is handled
    by the FK cascade plus the project-membership soft-delete; the facet matrix is
    sourced from active project members, so a stale team row is invisible.
    """
    if instance.is_deleted:
        return
    transaction.on_commit(
        partial(
            ensure_team_membership,
            project_id=instance.project_id,
            user_id=instance.user_id,
            project_role=instance.role,
        )
    )
