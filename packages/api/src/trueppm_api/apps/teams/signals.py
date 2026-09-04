"""Auto-membership invariant for the teams app (ADR-0078 §F).

A ``ProjectMembership`` write mirrors onto the project's default ``Team`` so that a
new member appears on the facet matrix without a separate "join the team" step. The
mirror runs on commit so a rolled-back membership change mirrors nothing.

**The mirror is create-only, and that is the single most misread fact in this app.**
It moves rows in one direction. Nothing here removes a ``TeamMembership`` when the
``ProjectMembership`` that produced it is revoked, so after an offboarding the team
row survives with its facet flags set and the two tables disagree — permanently, and
silently. Every cohort or gate built on ``TeamMembership`` must therefore apply its
own live-``ProjectMembership`` floor; the team-row filters cannot see the difference.
Three notification cohorts were fixed for exactly this, one at a time (#2897, #3291,
#3334), each time because a reader assumed what this file used to claim.
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

    Skips soft-deleted rows: a revoked project membership must not (re)create a team
    membership.

    Skipping is *all* it does — it does not remove the row that already exists. There
    is no ``post_delete`` receiver here and no FK from ``TeamMembership`` to
    ``ProjectMembership`` for a cascade to travel over, so revocation leaves the
    mirrored row live with its facets. This docstring previously claimed the opposite
    ("handled by the FK cascade… a stale team row is invisible"); that claim was the
    stated reason three separate recipient cohorts were built without a project-row
    filter (#2897, #3291, #3334). If a delete-side mirror is ever added, it belongs
    here — and every downstream floor can then be revisited together.
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
