"""App config for projects."""

from django.apps import AppConfig


class ProjectsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.projects"

    def ready(self) -> None:
        """Wire signal receivers when the app starts."""
        # Import for side-effects: registers receivers on task_status_changed.
        from trueppm_api.apps.projects import receivers

        # Register the post_save handler that resets RetroActionItem.promoted_task_id
        # when a Task is soft-deleted (ADR-0071 §2 rollback).
        receivers._register_task_soft_delete_receiver()

        # Register the post_save handler that recomputes the linked milestone
        # rollup live when a sprint-tracked task changes (ADR-0074).
        receivers._register_milestone_rollup_receiver()

        # Register the post_save handler that seeds methodology-aware rollup
        # config when a Program is created (ADR-0079, #527).
        receivers._register_program_rollup_seed_receiver()

        # Register the post_save handler that resets a pulled BacklogItem to
        # PROPOSED when its Task is soft-deleted (ADR-0069 rollback, #737).
        receivers._register_backlog_pull_rollback_receiver()
