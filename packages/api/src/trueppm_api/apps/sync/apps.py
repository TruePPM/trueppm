"""App config for sync."""

from django.apps import AppConfig


class SyncConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.sync"

    def ready(self) -> None:
        # Wire the per-project sync sequence that allocates `sync_seq`
        # (ADR-0686, #2491).
        from trueppm_api.apps.sync.sequence import register_sequence_receivers

        register_sequence_receivers()
