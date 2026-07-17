"""API tests for the admin SSO provider config endpoint (ADR-0187 §2, #1405).

Endpoint: ``/api/v1/workspace/sso/`` (``IsWorkspaceAdminStrict`` — ADMIN on every
method, reads included) and ``/api/v1/workspace/sso/test-connection/``. The
decisive security properties exercised here: the client secret is **never**
serialized back (only ``secret_set: bool``), enabling requires a complete config,
``default_role`` cannot be OWNER, and *both reads and writes* are Admin-gated —
the read shape exposes the org's IdP config (issuer, client_id, allowed email
domains), so a plain member must not be able to GET it.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import OIDCProvider
from trueppm_api.apps.workspace.models import WorkspaceRole

from .conftest import ISSUER, api_client

User = get_user_model()

URL = "/api/v1/workspace/sso/"
TEST_CONN_URL = "/api/v1/workspace/sso/test-connection/"


def _full_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "issuer_url": ISSUER,
        "client_id": "trueppm-web",
        "client_secret": "rotate-me",
        "allowed_email_domains": ["example.com"],
    }


@pytest.mark.django_db
def test_get_lazily_materializes_disabled_provider(admin: Any) -> None:
    resp = api_client(admin).get(URL)
    assert resp.status_code == 200
    assert resp.data["enabled"] is False
    assert resp.data["secret_set"] is False
    # The redirect_uri the operator must allow-list is derived and surfaced.
    assert resp.data["redirect_uri"].endswith("/api/v1/auth/oidc/callback/")
    # The secret is never present in any form on the read shape.
    assert "client_secret" not in resp.data


@pytest.mark.django_db
def test_put_configures_and_stores_encrypted_secret(admin: Any) -> None:
    resp = api_client(admin).put(URL, _full_config(), format="json")
    assert resp.status_code == 200
    assert resp.data["enabled"] is True
    assert resp.data["secret_set"] is True
    assert "client_secret" not in resp.data
    # Stored encrypted; decrypts back to the plaintext we sent.
    provider = OIDCProvider.load()
    assert provider.get_client_secret() == "rotate-me"


@pytest.mark.django_db
def test_put_omitting_secret_preserves_it(admin: Any) -> None:
    client = api_client(admin)
    client.put(URL, _full_config(), format="json")
    # A later PUT without client_secret must not wipe the stored secret.
    resp = client.put(URL, {"display_name": "Renamed IdP"}, format="json")
    assert resp.status_code == 200
    assert resp.data["secret_set"] is True
    assert OIDCProvider.load().get_client_secret() == "rotate-me"


@pytest.mark.django_db
def test_put_with_new_secret_rotates(admin: Any) -> None:
    client = api_client(admin)
    client.put(URL, _full_config(), format="json")
    resp = client.put(URL, {"client_secret": "new-secret"}, format="json")
    assert resp.status_code == 200
    assert OIDCProvider.load().get_client_secret() == "new-secret"


@pytest.mark.django_db
def test_cannot_enable_without_complete_config(admin: Any) -> None:
    resp = api_client(admin).put(URL, {"enabled": True}, format="json")
    assert resp.status_code == 400
    assert "enabled" in resp.data


@pytest.mark.django_db
def test_default_role_owner_rejected(admin: Any) -> None:
    resp = api_client(admin).put(URL, {"default_role": int(WorkspaceRole.OWNER)}, format="json")
    assert resp.status_code == 400
    assert "default_role" in resp.data


@pytest.mark.django_db
def test_allow_password_signin_rejected_in_oss(admin: Any) -> None:
    """OSS never enforces password-login policy, so accepting the field would be a
    set-but-ignored no-op. The write serializer rejects it outright (#2025) rather
    than silently persisting it — an honest 400 instead of a lie."""
    resp = api_client(admin).put(URL, {"allow_password_signin": False}, format="json")
    assert resp.status_code == 400
    assert "allow_password_signin" in resp.data
    # The stored value is untouched (default True) — nothing was persisted.
    assert OIDCProvider.load().allow_password_signin is True


@pytest.mark.django_db
def test_write_without_allow_password_signin_is_unaffected(admin: Any) -> None:
    """The rejection is field-scoped: a normal config write that omits the field
    must still succeed (the validator only fires when the client sends it)."""
    resp = api_client(admin).put(URL, _full_config(), format="json")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
def test_issuer_wellknown_url_rejected(admin: Any) -> None:
    resp = api_client(admin).put(
        URL,
        {"issuer_url": f"{ISSUER}/.well-known/openid-configuration"},
        format="json",
    )
    assert resp.status_code == 400
    assert "issuer_url" in resp.data


@pytest.mark.django_db
def test_issuer_http_rejected_outside_debug(admin: Any, settings: Any) -> None:
    # An http issuer would carry the client secret + ID token over cleartext.
    # Rejected outside DEBUG (local dev may still use http).
    settings.DEBUG = False
    resp = api_client(admin).put(
        URL, {**_full_config(), "issuer_url": "http://idp.example.com"}, format="json"
    )
    assert resp.status_code == 400
    assert "issuer_url" in resp.data


@pytest.mark.django_db
def test_delete_removes_config(admin: Any) -> None:
    client = api_client(admin)
    client.put(URL, _full_config(), format="json")
    resp = client.delete(URL)
    assert resp.status_code == 204
    assert OIDCProvider.objects.count() == 0
    # A subsequent GET re-materializes a blank, disabled provider.
    again = client.get(URL)
    assert again.status_code == 200
    assert again.data["enabled"] is False


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_read_or_write(member: Any) -> None:
    client = api_client(member)
    # IsWorkspaceAdminStrict gates *every* method at ADMIN. The read shape leaks the
    # org's IdP config (issuer, client_id, allowed email domains), so a plain member
    # must be denied on GET too — not just on writes.
    get_resp = client.get(URL)
    put_resp = client.put(URL, _full_config(), format="json")
    delete_resp = client.delete(URL)
    assert get_resp.status_code == 403
    assert put_resp.status_code == 403
    assert delete_resp.status_code == 403


@pytest.mark.django_db
def test_admin_can_read(admin: Any) -> None:
    # The admin GET path must keep working after the tightening.
    resp = api_client(admin).get(URL)
    assert resp.status_code == 200
    assert resp.data["enabled"] is False
    assert "client_secret" not in resp.data


@pytest.mark.django_db
def test_anonymous_is_denied(db: object) -> None:
    resp = api_client().get(URL)
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_member_cannot_test_connection(member: Any) -> None:
    resp = api_client(member).post(TEST_CONN_URL, {}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_test_connection_returns_probe_result(admin: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_probe(issuer_url: str) -> dict[str, Any]:
        return {
            "ok": True,
            "issuer": issuer_url,
            "endpoints": {
                "authorization_endpoint": f"{issuer_url}/authorize",
                "token_endpoint": f"{issuer_url}/token",
                "jwks_uri": f"{issuer_url}/jwks",
            },
        }

    monkeypatch.setattr(services, "check_provider_reachability", _fake_probe)
    resp = api_client(admin).post(TEST_CONN_URL, {"issuer_url": ISSUER}, format="json")
    assert resp.status_code == 200
    assert resp.data["ok"] is True
    assert resp.data["endpoints"]["token_endpoint"] == f"{ISSUER}/token"


@pytest.mark.django_db
def test_test_connection_no_issuer_configured(admin: Any) -> None:
    # No stored issuer and none supplied → a clear "no_issuer" result, not a 500.
    resp = api_client(admin).post(TEST_CONN_URL, {}, format="json")
    assert resp.status_code == 200
    assert resp.data["ok"] is False
