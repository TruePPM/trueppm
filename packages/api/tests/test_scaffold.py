"""Smoke tests for the Django scaffold — verifies apps are importable and settings load."""

from __future__ import annotations

from django.apps import apps
from django.conf import settings


def test_settings_load() -> None:
    """DJANGO_SETTINGS_MODULE loads without error."""
    assert settings.configured


def test_installed_apps_present() -> None:
    """All TruePPM apps are registered."""
    app_labels = {app.label for app in apps.get_app_configs()}
    assert "projects" in app_labels
    assert "resources" in app_labels
    assert "scheduling" in app_labels
    assert "sync" in app_labels


def test_drf_installed() -> None:
    """Django REST Framework is in INSTALLED_APPS."""
    assert "rest_framework" in settings.INSTALLED_APPS


def test_channels_installed() -> None:
    """Django Channels is in INSTALLED_APPS."""
    assert "channels" in settings.INSTALLED_APPS


def test_spectacular_installed() -> None:
    """drf-spectacular is in INSTALLED_APPS."""
    assert "drf_spectacular" in settings.INSTALLED_APPS


def test_celery_broker_configured() -> None:
    """Celery broker URL is set."""
    assert settings.CELERY_BROKER_URL.startswith("redis://")


def test_channel_layers_configured() -> None:
    """Channel layers backend is channels_redis."""
    backend = settings.CHANNEL_LAYERS["default"]["BACKEND"]
    assert "redis" in backend.lower()
