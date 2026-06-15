"""App config for the profiles app (ADR-0129).

Holds per-user *app* preferences (not collaborative domain data). Currently a
single field — ``default_landing`` — that drives the role-based app front door.
"""

from __future__ import annotations

from django.apps import AppConfig


class ProfilesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.profiles"
    verbose_name = "User profiles"
