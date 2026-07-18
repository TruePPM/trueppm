"""Regression guard for #2124 — the SSO migration/INSTALLED_APPS wiring.

``sso.0002`` (which creates ``SsoProviderPolicy`` / db_table ``sso_provider_policy``)
declares ``allauth.socialaccount`` and ``django.contrib.sites`` as migration
dependencies. If either app is ever dropped from ``INSTALLED_APPS``, those
dependency targets vanish from the migration graph and ``sso.0002`` is silently
stranded — ``migrate`` skips it, the table is never created, and every OIDC
endpoint 500s with ``relation "sso_provider_policy" does not exist``. The
``api:migration-check`` gate (``makemigrations --check``) does *not* catch this,
because the on-disk migrations still faithfully describe the models.

These tests close that gap with cheap, direct assertions:

* the two allauth-side dependency apps are wired into ``INSTALLED_APPS``;
* the ``sso_provider_policy`` table physically exists after a real migrate
  (pytest-django builds the test DB by applying every migration, so a stranded
  ``sso.0002`` would fail this);
* the unauthenticated ``discover`` entry point returns 200, not 500, on a fresh
  DB with no provider configured.
"""

from __future__ import annotations

import pytest
from django.apps import apps
from django.db import connection

from trueppm_api.apps.sso.models import SsoProviderPolicy

DISCOVER = "/api/v1/auth/oidc/discover/"


def test_allauth_dependency_apps_are_installed() -> None:
    """``sso.0002`` depends on these; dropping either strands the migration (#2124)."""
    assert apps.is_installed("django.contrib.sites"), (
        "django.contrib.sites must stay in INSTALLED_APPS — it is a migration "
        "dependency of sso.0002; removing it silently strands sso_provider_policy."
    )
    assert apps.is_installed("allauth.socialaccount"), (
        "allauth.socialaccount must stay in INSTALLED_APPS — it is a migration "
        "dependency of sso.0002; removing it silently strands sso_provider_policy."
    )


@pytest.mark.django_db
def test_sso_provider_policy_table_is_created_by_migrate() -> None:
    """The table sso.0002 creates must exist after a real migrate (#2124)."""
    assert SsoProviderPolicy._meta.db_table == "sso_provider_policy"
    assert "sso_provider_policy" in connection.introspection.table_names(), (
        "sso_provider_policy is absent — sso.0002 was not applied. Confirm its "
        "migration dependencies (socialaccount, sites) are installed apps."
    )


@pytest.mark.django_db
def test_oidc_discover_does_not_500_on_fresh_db(db: object) -> None:
    """The OIDC discover entry point must return 200, never 500, with no provider (#2124)."""
    from .conftest import api_client

    resp = api_client().get(DISCOVER, {"email": "alice@example.com"})
    assert resp.status_code == 200
    assert resp.data["provider_present"] is False
