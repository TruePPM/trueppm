"""API tests for the admin SSO provider collection (ADR-0517 §3.4).

Endpoints under ``/api/v1/workspace/sso/providers/`` (collection + item +
test-connection), all gated by ``IsWorkspaceAdminStrict`` (ADMIN on every method,
reads included — a GET discloses IdP topology). The decisive security properties:
the client secret is **never** serialized back (only ``secret_set: bool``) and
``SocialApp.secret`` stays empty; enabling requires a complete config;
``default_role`` cannot be OWNER; ``allow_password_signin`` is rejected in OSS; and
both reads and writes are Admin-gated.
"""

from __future__ import annotations

from typing import Any

import pytest
from allauth.socialaccount.models import SocialApp
from django.contrib.auth import get_user_model

from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.models import WorkspaceRole

from .conftest import ISSUER, api_client

User = get_user_model()

COLLECTION = "/api/v1/workspace/sso/providers/"
DETAIL = COLLECTION + "generic/"
TEST_CONN = DETAIL + "test-connection/"


def _full_config() -> dict[str, Any]:
    return {
        "slug": "generic",
        "display_name": "Example IdP",
        "server_url": ISSUER,
        "client_id": "trueppm-web",
        "client_secret": "rotate-me",
        "allowed_email_domains": ["example.com"],
        "enabled": True,
    }


# ---------------------------------------------------------------------------
# Create / list / read
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_empty_by_default(admin: Any) -> None:
    resp = api_client(admin).get(COLLECTION)
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_post_creates_and_stores_encrypted_secret(admin: Any) -> None:
    resp = api_client(admin).post(COLLECTION, _full_config(), format="json")
    assert resp.status_code == 201, resp.data
    assert resp.data["enabled"] is True
    assert resp.data["secret_set"] is True
    assert resp.data["slug"] == "generic"
    assert resp.data["provider"] == services.ALLAUTH_OPENID_CONNECT
    assert "client_secret" not in resp.data
    # Redirect URI is the UNCHANGED callback path for every provider (ADR-0517 §3.5).
    assert resp.data["redirect_uri"].endswith("/api/v1/auth/oidc/callback/")
    # Stored encrypted on the policy; SocialApp.secret stays empty (control 2).
    policy = SsoProviderPolicy.objects.get(slug="generic")
    assert policy.get_client_secret() == "rotate-me"
    assert policy.social_app.secret == ""


@pytest.mark.django_db
def test_get_detail_secret_never_exposed(admin: Any) -> None:
    client = api_client(admin)
    client.post(COLLECTION, _full_config(), format="json")
    resp = client.get(DETAIL)
    assert resp.status_code == 200
    assert resp.data["secret_set"] is True
    assert "client_secret" not in resp.data
    assert resp.data["scopes"] == ["openid", "email", "profile"]


@pytest.mark.django_db
def test_put_omitting_secret_preserves_it(admin: Any) -> None:
    client = api_client(admin)
    client.post(COLLECTION, _full_config(), format="json")
    resp = client.put(DETAIL, {"display_name": "Renamed IdP"}, format="json")
    assert resp.status_code == 200
    assert resp.data["secret_set"] is True
    assert resp.data["display_name"] == "Renamed IdP"
    assert SsoProviderPolicy.objects.get(slug="generic").get_client_secret() == "rotate-me"


@pytest.mark.django_db
def test_put_with_new_secret_rotates(admin: Any) -> None:
    client = api_client(admin)
    client.post(COLLECTION, _full_config(), format="json")
    resp = client.put(DETAIL, {"client_secret": "new-secret"}, format="json")
    assert resp.status_code == 200
    assert SsoProviderPolicy.objects.get(slug="generic").get_client_secret() == "new-secret"


@pytest.mark.django_db
def test_cannot_enable_without_complete_config(admin: Any) -> None:
    resp = api_client(admin).post(COLLECTION, {"slug": "generic", "enabled": True}, format="json")
    assert resp.status_code == 400
    assert "enabled" in resp.data


@pytest.mark.django_db
def test_unknown_slug_rejected(admin: Any) -> None:
    resp = api_client(admin).post(COLLECTION, {"slug": "nope"}, format="json")
    assert resp.status_code == 400
    assert "slug" in resp.data


@pytest.mark.django_db
def test_default_role_owner_rejected(admin: Any) -> None:
    resp = api_client(admin).post(
        COLLECTION, {"slug": "generic", "default_role": int(WorkspaceRole.OWNER)}, format="json"
    )
    assert resp.status_code == 400
    assert "default_role" in resp.data


@pytest.mark.django_db
def test_allow_password_signin_rejected_in_oss(admin: Any) -> None:
    resp = api_client(admin).post(
        COLLECTION, {"slug": "generic", "allow_password_signin": False}, format="json"
    )
    assert resp.status_code == 400
    assert "allow_password_signin" in resp.data
    assert SsoProviderPolicy.objects.filter(slug="generic").exists() is False


@pytest.mark.django_db
def test_create_without_allow_password_signin_is_unaffected(admin: Any) -> None:
    resp = api_client(admin).post(COLLECTION, _full_config(), format="json")
    assert resp.status_code == 201, resp.data


@pytest.mark.django_db
def test_issuer_wellknown_url_rejected(admin: Any) -> None:
    resp = api_client(admin).post(
        COLLECTION,
        {"slug": "generic", "server_url": f"{ISSUER}/.well-known/openid-configuration"},
        format="json",
    )
    assert resp.status_code == 400
    assert "server_url" in resp.data


@pytest.mark.django_db
def test_issuer_http_rejected_outside_debug(admin: Any, settings: Any) -> None:
    settings.DEBUG = False
    resp = api_client(admin).post(
        COLLECTION, {**_full_config(), "server_url": "http://idp.example.com"}, format="json"
    )
    assert resp.status_code == 400
    assert "server_url" in resp.data


@pytest.mark.django_db
def test_scopes_are_not_widenable(admin: Any) -> None:
    # Sending a scopes field is silently ignored — the read shape stays server-fixed.
    body = {**_full_config(), "scopes": ["openid", "email", "profile", "groups"]}
    resp = api_client(admin).post(COLLECTION, body, format="json")
    assert resp.status_code == 201
    assert resp.data["scopes"] == ["openid", "email", "profile"]


@pytest.mark.django_db
def test_delete_removes_provider_and_socialapp(admin: Any) -> None:
    client = api_client(admin)
    client.post(COLLECTION, _full_config(), format="json")
    resp = client.delete(DETAIL)
    assert resp.status_code == 204
    assert SsoProviderPolicy.objects.count() == 0
    assert SocialApp.objects.count() == 0  # cascade
    assert client.get(DETAIL).status_code == 404


@pytest.mark.django_db
def test_delete_purges_orphaned_social_accounts(admin: Any) -> None:
    """SocialAccount has no FK to SocialApp — deleting a provider must purge its
    per-user bindings explicitly so a reused slug cannot silently re-activate them."""
    from allauth.socialaccount.models import SocialAccount
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user(username="bound", email="b@example.com")
    client = api_client(admin)
    client.post(COLLECTION, _full_config(), format="json")
    SocialAccount.objects.create(
        user=user, provider="generic", uid="sub-x", extra_data={"iss": ISSUER}
    )

    resp = client.delete(DETAIL)
    assert resp.status_code == 204
    assert SocialAccount.objects.filter(provider="generic").count() == 0


@pytest.mark.django_db
def test_github_provider_needs_no_issuer(admin: Any) -> None:
    resp = api_client(admin).post(
        COLLECTION,
        {
            "slug": "github",
            "display_name": "GitHub",
            "client_id": "gh",
            "client_secret": "ghs",
            "allowed_email_domains": ["example.com"],
            "enabled": True,
        },
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["provider"] == services.ALLAUTH_GITHUB


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_read_or_write_collection(member: Any) -> None:
    client = api_client(member)
    assert client.get(COLLECTION).status_code == 403
    assert client.post(COLLECTION, _full_config(), format="json").status_code == 403


@pytest.mark.django_db
def test_member_cannot_read_or_write_detail(member: Any, admin: Any) -> None:
    api_client(admin).post(COLLECTION, _full_config(), format="json")
    client = api_client(member)
    assert client.get(DETAIL).status_code == 403
    assert client.put(DETAIL, {"display_name": "x"}, format="json").status_code == 403
    assert client.delete(DETAIL).status_code == 403


@pytest.mark.django_db
def test_anonymous_is_denied(db: object) -> None:
    resp = api_client().get(COLLECTION)
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_member_cannot_test_connection(member: Any, admin: Any) -> None:
    api_client(admin).post(COLLECTION, _full_config(), format="json")
    resp = api_client(member).post(TEST_CONN, {}, format="json")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# test-connection
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_test_connection_returns_probe_result(admin: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client = api_client(admin)
    client.post(COLLECTION, _full_config(), format="json")

    def _fake_probe(ctx: services.ProviderContext) -> dict[str, Any]:
        return {
            "ok": True,
            "issuer": ctx.issuer,
            "endpoints": {
                "authorization_endpoint": f"{ctx.issuer}/authorize",
                "token_endpoint": f"{ctx.issuer}/token",
                "jwks_uri": f"{ctx.issuer}/jwks",
            },
        }

    monkeypatch.setattr(services, "check_provider_reachability", _fake_probe)
    resp = client.post(TEST_CONN, {}, format="json")
    assert resp.status_code == 200
    assert resp.data["ok"] is True
    assert resp.data["endpoints"]["token_endpoint"] == f"{ISSUER}/token"


@pytest.mark.django_db
def test_test_connection_unknown_provider_is_404(admin: Any) -> None:
    # An unknown slug matches the detail views' not-found behavior (404), not a 200.
    resp = api_client(admin).post(TEST_CONN, {}, format="json")
    assert resp.status_code == 404
