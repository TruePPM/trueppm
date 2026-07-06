"""End-to-end tests for ``/api/v1/me/connections/{source}/`` (ADR-0097 §3).

Covers the connection-management contract:
1. GET returns a summary; the encrypted secret is **never** returned.
2. PUT connects/updates, storing the PAT Fernet-encrypted, only after verify.
3. A non-Jira-Cloud ``base_url`` is rejected (SSRF allow-list) before the token
   is ever put on the wire.
4. A failed verify returns 422 and never persists the plaintext.
5. DELETE hard-removes the credential + cached items and is idempotent.
6. Every action is strictly personal — another user's connection is invisible.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http
from trueppm_api.apps.integrations.encryption import decrypt_secret
from trueppm_api.apps.integrations.models import ExternalWorkItem, IntegrationCredential

User = get_user_model()

pytestmark = pytest.mark.django_db

_JIRA_BASE = "https://acme.atlassian.net"


@pytest.fixture(autouse=True)
def _stub_verify(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make Jira ``/myself`` verification pass without the network by default.

    Tests that need a *failing* verify override ``http.get`` themselves."""
    monkeypatch.setattr(
        http, "get", lambda *a, **k: http.EgressResponse(200, b'{"displayName": "P"}', {})
    )


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="conn_user", password="pw")


@pytest.fixture
def other_user() -> AbstractBaseUser:
    return User.objects.create_user(username="conn_other", password="pw")


@pytest.fixture
def client(user: AbstractBaseUser) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _connect_body(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "secret": "jira-api-token",
        "base_url": _JIRA_BASE,
        "account_email": "priya@acme.io",
        "jql": "assignee = currentUser()",
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


def test_get_not_connected(client: APIClient) -> None:
    response = client.get("/api/v1/me/connections/jira/")
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is False
    assert body["status"] == "not_connected"
    assert "secret" not in body


def test_get_unknown_source_is_400(client: APIClient) -> None:
    assert client.get("/api/v1/me/connections/nope/").status_code == 400


def test_requires_authentication() -> None:
    assert APIClient().get("/api/v1/me/connections/jira/").status_code in (401, 403)


# ---------------------------------------------------------------------------
# PUT (connect / update)
# ---------------------------------------------------------------------------


def test_connect_stores_encrypted_secret(client: APIClient, user: AbstractBaseUser) -> None:
    response = client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is True
    assert body["status"] == "connected"
    assert body["account_email"] == "priya@acme.io"
    # Secret is never echoed.
    assert "secret" not in body
    assert "secret_ciphertext" not in body
    # Stored ciphertext round-trips to the plaintext — and is not the plaintext.
    row = IntegrationCredential.objects.get(user=user, provider="jira")
    assert bytes(row.secret_ciphertext) != b"jira-api-token"
    assert decrypt_secret(row.secret_ciphertext) == "jira-api-token"
    assert row.config["jql"] == "assignee = currentUser()"


def test_connect_is_idempotent_upsert(client: APIClient, user: AbstractBaseUser) -> None:
    """Connecting twice rotates the one row, never appends (unique per user,provider)."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    client.put("/api/v1/me/connections/jira/", _connect_body(secret="rotated-token"), format="json")
    rows = IntegrationCredential.objects.filter(user=user, provider="jira")
    assert rows.count() == 1
    assert decrypt_secret(rows.first().secret_ciphertext) == "rotated-token"


def test_connect_rejects_non_jira_cloud_host(client: APIClient, user: AbstractBaseUser) -> None:
    """SSRF allow-list: only *.atlassian.net; a stored token to an attacker host
    is never minted (the row is not written)."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(base_url="https://attacker.example.com"),
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["code"] == "base_url_not_allowed"
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


def test_connect_rejects_non_https_base_url(client: APIClient, user: AbstractBaseUser) -> None:
    """https-only (ADR-0097 §Resolution #1): a personal token must not ride http."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(base_url="http://acme.atlassian.net"),
        format="json",
    )
    assert response.status_code == 400
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


def test_jira_connection_does_not_hijack_task_link_resolution(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """Cross-registry guard (#1418): a stored jira external-source connection must
    not make an atlassian.net task-link URL resolve to the ``jira`` TASK_LINK
    provider (which is Enterprise-reserved) — it stays ``generic`` as before, so
    ``TaskLink.clean()`` accepts the link instead of 400ing."""
    from trueppm_api.apps.integrations.providers import resolve_provider_key

    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    resolved = resolve_provider_key("https://acme.atlassian.net/browse/RIV-1", user=user)
    assert resolved == "generic"


def test_connect_verify_failure_is_422_and_persists_nothing(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(401, b"{}", {}))
    response = client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    assert response.status_code == 422
    assert response.json()["reason"] == "invalid_token"
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


# ---------------------------------------------------------------------------
# DELETE (disconnect)
# ---------------------------------------------------------------------------


def test_delete_removes_credential_and_cached_items(
    client: APIClient, user: AbstractBaseUser
) -> None:
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="RIV-1", display_bucket="todo"
    )
    response = client.delete("/api/v1/me/connections/jira/")
    assert response.status_code == 204
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()
    assert not ExternalWorkItem.objects.filter(user=user, source="jira").exists()


def test_delete_is_idempotent(client: APIClient) -> None:
    assert client.delete("/api/v1/me/connections/jira/").status_code == 204


# ---------------------------------------------------------------------------
# Personal isolation (ADR-0097 §3)
# ---------------------------------------------------------------------------


def test_connection_is_strictly_personal(
    client: APIClient, user: AbstractBaseUser, other_user: AbstractBaseUser
) -> None:
    """Another user's connection is invisible; a caller only sees their own."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")

    other = APIClient()
    other.force_authenticate(user=other_user)
    # other_user has no connection of their own.
    assert other.get("/api/v1/me/connections/jira/").json()["exists"] is False
    # other_user's delete does not touch the first user's row.
    other.delete("/api/v1/me/connections/jira/")
    assert IntegrationCredential.objects.filter(user=user, provider="jira").exists()


def test_external_jira_row_absent_from_git_credentials_list(client: APIClient) -> None:
    """A jira EXTERNAL_TASK_SOURCES row must not leak into /me/credentials/
    (git-link PAT surface) — the two namespaces stay separate (ADR-0097 §1)."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    listed = {row["provider"] for row in client.get("/api/v1/me/credentials/").json()}
    assert "jira" not in listed
