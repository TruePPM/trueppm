"""Signal receivers for the projects app.

Burndown UPSERT on task status change is the primary connection here. When a
task in an ACTIVE sprint changes status, today's ``SprintBurnSnapshot`` row
is recomputed and written via the unique ``(sprint, snapshot_date)`` index —
naturally idempotent under concurrent writes.
"""

from __future__ import annotations

import logging
from typing import Any

from django.db.models.signals import post_save
from django.dispatch import receiver

from trueppm_api.apps.projects.signals import task_status_changed

logger = logging.getLogger(__name__)


@receiver(task_status_changed)
def _on_task_status_changed(
    sender: Any,
    task: Any,
    old_status: str | None,
    new_status: str,
    **kwargs: Any,
) -> None:
    """Update today's burn snapshot when a sprint-tracked task moves columns.

    No-op when the task is not in any sprint, or when its sprint is not in
    ACTIVE state. A FAILED upsert is logged but never raised — burndown is a
    secondary observation and must not block the primary status write.
    """
    from trueppm_api.apps.projects.models import SprintState
    from trueppm_api.apps.projects.seed.replay_ctx import is_seed_replay_active
    from trueppm_api.apps.projects.services import upsert_burndown_for_sprint

    # During seed event-replay (ADR-0114) the timeline drives backdated burndown
    # per simulated day; the live receiver would instead stamp *today's* row and
    # collapse the curve to a single point, so skip it.
    if is_seed_replay_active():
        return

    sprint = getattr(task, "sprint", None)
    if sprint is None or sprint.state != SprintState.ACTIVE:
        return
    try:
        upsert_burndown_for_sprint(sprint)
    except Exception:
        logger.exception(
            "task_status_changed: burndown upsert failed for sprint=%s task=%s",
            sprint.pk,
            task.pk,
        )


def _register_task_soft_delete_receiver() -> None:
    """Register the Task post_save receiver that frees RetroActionItem links.

    Wrapped in a function so the import of Task (which would create an import
    cycle if done at module top) happens after the models app is fully loaded.
    Called from ``ProjectsConfig.ready()``.
    """
    from trueppm_api.apps.projects.models import Task

    @receiver(post_save, sender=Task)
    def _on_task_save_reset_promoted(
        sender: Any,
        instance: Any,
        created: bool,
        **kwargs: Any,
    ) -> None:
        """Reset RetroActionItem.promoted_task_id when its Task is soft-deleted.

        ADR-0071 §2 rollback: when the promoted Task is soft-deleted, the
        originating action item must become re-promotable. VersionedModel
        soft_delete sets is_deleted=True and saves; this receiver detects
        that transition.

        No-op for INSERT and for any save where is_deleted=False — the common
        case of a normal Task update.
        """
        if created or not getattr(instance, "is_deleted", False):
            return
        from trueppm_api.apps.projects.retro_services import (
            reset_promoted_task_on_delete,
        )

        try:
            reset_promoted_task_on_delete(str(instance.pk))
        except Exception:
            logger.exception(
                "task soft-delete: failed to reset promoted_task_id for task=%s",
                instance.pk,
            )


def _register_program_rollup_seed_receiver() -> None:
    """Register the Program post_save receiver that seeds rollup config on create.

    ADR-0169 / #527: a newly-created Program gets methodology-aware default
    rollup config (which KPIs roll up, which aggregation policy to use). The
    backfill of existing rows happens in migration 0041; this receiver covers
    every Program created after the migration.

    Idempotent: only fires when ``created=True`` AND the config is still empty
    (the migration-default ``[]``). Re-saves of an existing Program never
    rewrite user-customized values.
    """
    from trueppm_api.apps.projects.models import Program

    @receiver(post_save, sender=Program)
    def _on_program_create_seed_rollup(
        sender: Any,
        instance: Any,
        created: bool,
        **kwargs: Any,
    ) -> None:
        if not created:
            return
        if instance.rollup_enabled_kpis:
            # Already seeded — service-layer create may pre-populate before
            # save() in a future change; respect any value already present.
            return
        from trueppm_api.apps.projects.services import rollup_config_defaults

        enabled, policy = rollup_config_defaults(instance.methodology)
        # update() skips this signal (no save() recursion) and avoids bumping
        # server_version a second time on the same logical create.
        Program.objects.filter(pk=instance.pk).update(
            rollup_enabled_kpis=enabled,
            rollup_aggregation_policy=policy,
        )
        instance.rollup_enabled_kpis = enabled
        instance.rollup_aggregation_policy = policy


def _register_milestone_rollup_receiver() -> None:
    """Register the Task post_save receiver that fires the milestone rollup.

    ADR-0074: when a task assigned to a sprint changes (status, story points,
    sprint membership), and that sprint targets a milestone, recompute the
    milestone rollup live. This is the "instant Gantt update" path — the
    authoritative recompute on sprint close still runs inside the drain.

    Bails out early for the common case (no sprint, no target milestone) so
    the receiver adds negligible overhead to non-sprint task writes. Errors
    are logged and swallowed; the rollup is a cosmetic side effect and must
    never block a primary task write.

    Wrapped in a function for the same import-timing reason as the soft-delete
    receiver above. Called from ``ProjectsConfig.ready()``.
    """
    from trueppm_api.apps.projects.models import Task

    @receiver(post_save, sender=Task, dispatch_uid="milestone_rollup_on_task_save")
    def _on_task_save_recompute_rollup(
        sender: Any,
        instance: Any,
        created: bool,
        **kwargs: Any,
    ) -> None:
        sprint_id = getattr(instance, "sprint_id", None)
        if sprint_id is None or getattr(instance, "is_deleted", False):
            return
        from trueppm_api.apps.projects.seed.replay_ctx import is_seed_replay_active

        # During seed event-replay (ADR-0114) the rollup is computed-on-read and
        # the post-import CPM pass refreshes it; firing here per backdated beat
        # would queue redundant milestone_rollup_updated broadcasts on commit.
        if is_seed_replay_active():
            return
        from trueppm_api.apps.projects.models import Sprint

        # One small query — index hit on PK. The cheap filter is paying for
        # itself by short-circuiting the common "task not linked to a
        # sprint-with-milestone" case before any rollup work.
        milestone_id = (
            Sprint.objects.filter(pk=sprint_id, is_deleted=False)
            .values_list("target_milestone_id", flat=True)
            .first()
        )
        if milestone_id is None:
            return
        from trueppm_api.apps.projects.services import recompute_milestone_rollup

        try:
            recompute_milestone_rollup(milestone_id)
        except Exception:
            logger.exception(
                "milestone rollup: recompute failed for task=%s milestone=%s",
                instance.pk,
                milestone_id,
            )


def _register_backlog_pull_rollback_receiver() -> None:
    """Register the Task post_save receiver that rolls back a pulled BacklogItem.

    ADR-0069 rollback: when the Task created by a backlog pull is soft-deleted,
    the originating BacklogItem must become re-pullable. TruePPM Tasks are
    soft-deleted (VersionedModel sets is_deleted=True and saves), so this hooks
    post_save and reacts to the is_deleted transition — mirroring the existing
    RetroActionItem soft-delete receiver above. ``pulled_task`` is SET_NULL, so
    deletion never cascades to the item; this restores its PROPOSED status.

    No-op for INSERT and for any save where is_deleted is False (the common
    Task-update case). Wrapped in a function for the import-timing reason noted
    on the other receivers. Called from ``ProjectsConfig.ready()``.
    """
    from trueppm_api.apps.projects.models import Task

    @receiver(post_save, sender=Task, dispatch_uid="backlog_pull_rollback_on_task_save")
    def _on_task_soft_delete_reset_backlog_item(
        sender: Any,
        instance: Any,
        created: bool,
        **kwargs: Any,
    ) -> None:
        if created or not getattr(instance, "is_deleted", False):
            return
        from trueppm_api.apps.projects.backlog_services import (
            reset_pulled_item_on_task_delete,
        )

        try:
            reset_pulled_item_on_task_delete(str(instance.pk))
        except Exception:
            logger.exception(
                "backlog rollback: failed to reset BacklogItem for deleted task=%s",
                instance.pk,
            )
