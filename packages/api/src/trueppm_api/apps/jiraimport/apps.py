"""Django app config for offline Jira import."""

from django.apps import AppConfig


class JiraImportConfig(AppConfig):
    """Offline Jira XML import app."""

    name = "trueppm_api.apps.jiraimport"
    verbose_name = "Jira Import"
    default_auto_field = "django.db.models.BigAutoField"
