"""AppConfig for the idempotency app — HTTP Idempotency-Key request dedup."""

from __future__ import annotations

from django.apps import AppConfig


class IdempotencyConfig(AppConfig):
    name = "trueppm_api.apps.idempotency"
    verbose_name = "Idempotency"
    default_auto_field = "django.db.models.BigAutoField"
