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
