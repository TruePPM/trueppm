"""App config for history."""

from django.apps import AppConfig


class HistoryConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.history"

    def ready(self) -> None:
        # Register the post_save receiver that fires history_record_created.
        import trueppm_api.apps.history.signals  # noqa: F401
