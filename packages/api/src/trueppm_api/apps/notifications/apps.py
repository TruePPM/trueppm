"""App config for the notifications app (ADR-0075)."""

from django.apps import AppConfig


class NotificationsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.notifications"
    verbose_name = "Notifications"

    def ready(self) -> None:
        # Side-effect imports for signal receivers (Mention → Notification fan-out
        # wiring lives in receivers.py; imported here so it's registered exactly
        # once at app-ready time).
        from . import receivers  # noqa: F401
