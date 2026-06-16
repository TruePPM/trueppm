"""App config for sync."""

from django.apps import AppConfig


class SyncConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.sync"

    def ready(self) -> None:
        # Wire the Project.last_sync_version watermark receivers (ADR-0142, #822).
        from trueppm_api.apps.sync.receivers import register_watermark_receivers

        register_watermark_receivers()
