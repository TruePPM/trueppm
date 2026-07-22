"""Tests for the ``seed_sso_keycloak`` management command (#2274).

The command provisions the nightly ``sso:integration`` smoke's Keycloak provider
and its test-connection admin. These assert the outcome (provider config + admin
role), not the command internals, and that a re-run is idempotent.
"""

from __future__ import annotations

import pytest
from allauth.socialaccount.models import SocialApp
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command

from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.models import WorkspaceRole
from trueppm_api.apps.workspace.permissions import workspace_role_for_user

pytestmark = pytest.mark.django_db

User = get_user_model()


def _seed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSO_KEYCLOAK_ISSUER", "http://keycloak:8080/realms/trueppm-ci")
    monkeypatch.setenv("SSO_KEYCLOAK_CLIENT_ID", "trueppm-web")
    monkeypatch.setenv("SSO_KEYCLOAK_CLIENT_SECRET", "trueppm-ci-secret")
    monkeypatch.setenv("SSO_KEYCLOAK_ALLOWED_DOMAIN", "trueppm-ci.test")
    monkeypatch.setenv("SSO_ADMIN_EMAIL", "sso-admin@trueppm-ci.test")
    monkeypatch.setenv("INTEGRATION_USER_PASSWORD", "ci-integration-pw")
    call_command("seed_sso_keycloak")


def test_seeds_enabled_keycloak_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch)

    policy = SsoProviderPolicy.objects.select_related("social_app").get(slug="keycloak")
    assert policy.enabled is True
    assert policy.auto_create_members is True
    assert policy.allowed_email_domains == ["trueppm-ci.test"]
    assert policy.secret_set is True
    # The decrypted secret is what the token exchange will send to Keycloak.
    assert policy.get_client_secret() == "trueppm-ci-secret"

    app = policy.social_app
    assert app.provider == services.ALLAUTH_OPENID_CONNECT
    assert app.provider_id == "keycloak"
    assert app.client_id == "trueppm-web"
    # The real secret never lands in the plaintext allauth column.
    assert app.secret == ""
    assert app.settings["server_url"] == "http://keycloak:8080/realms/trueppm-ci"

    # The provider resolves through the normal fail-closed path (enabled + fully
    # configured), so the flow endpoints would actually use it.
    ctx = services.get_provider_for_slug("keycloak")
    assert ctx is not None
    assert ctx.issuer == "http://keycloak:8080/realms/trueppm-ci"


def test_seeds_workspace_admin_for_test_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch)

    admin = User.objects.get(email="sso-admin@trueppm-ci.test")
    # username == email so the password login used by the spec succeeds.
    assert admin.username == "sso-admin@trueppm-ci.test"
    assert admin.check_password("ci-integration-pw")
    # Least privilege: an explicit workspace-ADMIN membership (not a Django
    # superuser) is what clears IsWorkspaceAdminStrict on the test-connection route.
    assert admin.is_superuser is False
    assert workspace_role_for_user(admin) >= WorkspaceRole.ADMIN


def test_refuses_on_non_debug_without_password(
    monkeypatch: pytest.MonkeyPatch, settings: object
) -> None:
    """Prod guard (#1375): no known-credential admin / stray provider on a real box.

    On a non-DEBUG instance with no ``INTEGRATION_USER_PASSWORD``, the only
    resolvable password is a random throwaway, so the command must refuse rather
    than create an enabled SSO provider + loginable admin.
    """
    settings.DEBUG = False  # type: ignore[attr-defined]
    monkeypatch.delenv("INTEGRATION_USER_PASSWORD", raising=False)

    with pytest.raises(CommandError):
        call_command("seed_sso_keycloak")

    # Nothing was created — the guard runs before any write.
    assert not SsoProviderPolicy.objects.filter(slug="keycloak").exists()
    assert not User.objects.filter(email="sso-admin@trueppm-ci.test").exists()


def test_seed_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed(monkeypatch)
    _seed(monkeypatch)

    assert SocialApp.objects.filter(provider_id="keycloak").count() == 1
    assert SsoProviderPolicy.objects.filter(slug="keycloak").count() == 1
    assert User.objects.filter(email="sso-admin@trueppm-ci.test").count() == 1
