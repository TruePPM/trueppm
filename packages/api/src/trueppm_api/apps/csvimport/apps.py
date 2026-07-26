"""Django app config for CSV / Excel import."""

from django.apps import AppConfig


class CsvImportConfig(AppConfig):
    """CSV / Excel spreadsheet import app."""

    name = "trueppm_api.apps.csvimport"
    verbose_name = "CSV Import"
    default_auto_field = "django.db.models.BigAutoField"
