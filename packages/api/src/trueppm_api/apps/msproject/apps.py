"""Django app config for MS Project import/export."""

from django.apps import AppConfig


class MsProjectConfig(AppConfig):
    """MS Project import/export app."""

    name = "trueppm_api.apps.msproject"
    verbose_name = "MS Project Import/Export"
    default_auto_field = "django.db.models.BigAutoField"
