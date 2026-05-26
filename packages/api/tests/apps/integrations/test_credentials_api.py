"""End-to-end tests for the ``/api/v1/me/credentials/`` viewset.

Covers the four contracts that are load-bearing for ADR-0049 and #587:

1. ``list`` returns one row per registered provider — connected or not.
2. ``create`` upserts, never duplicates — connect and rotate share a code path.
3. ``destroy`` is idempotent and only deletes the caller's own rows.
4. The encrypted secret is **never** returned by any response.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http
from trueppm_api.apps.integrations.encryption import decrypt_secret
from trueppm_api.apps.integrations.models import IntegrationCredential

User = get_user_model()

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_token_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make PAT verification pass without touching the network.

    #677 wired a live ``/user`` ping into ``create()`` — these viewset tests
    assert connect/rotate/RBAC behavior, not the network, so we stub the egress
    layer to a 200. The real ``verify_token`` mapping (invalid/timeout/5xx/SSRF)
    is covered in ``test_credential_verification.py``.
    """

    def _fake_get(
        url: str, *, headers: dict[str, str] | None = None, timeout: float = http.DEFAULT_TIMEOUT
    ) -> http.EgressResponse:
        return http.EgressResponse(
            status=200, body=b'{"username": "stub", "login": "stub"}', headers={}
        )

    monkeypatch.setattr(http, "get", _fake_get)


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="cred_user", password="pw")


@pytest.fixture
def other_user() -> AbstractBaseUser:
    return User.objects.create_user(username="cred_other", password="pw")


@pytest.fixture
def client(user: AbstractBaseUser) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------


def test_list_includes_one_row_per_registered_provider(client: APIClient) -> None:
    """Even with zero stored rows the response covers all registered providers
    — the page renders the "Not connected" state without a second request."""
    response = client.get("/api/v1/me/credentials/")
    assert response.status_code == 200
    providers = {row["provider"]: row for row in response.json()}
    assert {"gitlab", "github", "generic"} <= providers.keys()
    for row in providers.values():
        assert row["exists"] is False
        assert row["created_at"] is None
        assert "secret" not in row
        assert "secret_ciphertext" not in row


def test_list_marks_connected_provider(client: APIClient, user: AbstractBaseUser) -> None:
    IntegrationCredential.upsert(user=user, provider="github", secret="ghp-fake-token", base_url="")
    response = client.get("/api/v1/me/credentials/")
    assert response.status_code == 200
    row = next(r for r in response.json() if r["provider"] == "github")
    assert row["exists"] is True
    assert row["created_at"] is not None
    assert "secret" not in row
    assert "secret_ciphertext" not in row


def test_list_anonymous_is_rejected() -> None:
    response = APIClient().get("/api/v1/me/credentials/")
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# create / upsert
# ---------------------------------------------------------------------------


def test_create_stores_encrypted_secret(client: APIClient, user: AbstractBaseUser) -> None:
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-very-secret", "base_url": "https://gitlab.example.com"},
        format="json",
    )
    assert response.status_code == 200
    row = IntegrationCredential.objects.get(user=user, provider="gitlab")
    # Stored ciphertext bytes are not the plaintext.
    assert b"glpat-very-secret" not in bytes(row.secret_ciphertext)
    # Server can still decrypt for the future #637 refresh endpoint.
    assert decrypt_secret(row.secret_ciphertext) == "glpat-very-secret"
    assert row.base_url == "https://gitlab.example.com"


def test_create_secret_never_in_response(client: APIClient) -> None:
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-very-secret"},
        format="json",
    )
    assert response.status_code == 200
    body = response.content.decode()
    assert "glpat-very-secret" not in body
    assert "secret" not in response.json()[0]
    assert "secret_ciphertext" not in response.json()[0]


def test_create_rotates_rather_than_duplicates(client: APIClient, user: AbstractBaseUser) -> None:
    """Connect followed by Rotate must produce one row, not two."""
    client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp-old"},
        format="json",
    )
    client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp-new"},
        format="json",
    )
    rows = IntegrationCredential.objects.filter(user=user, provider="github")
    assert rows.count() == 1
    row = rows.get()
    assert decrypt_secret(row.secret_ciphertext) == "ghp-new"


def test_create_rejects_blank_secret(client: APIClient) -> None:
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "   "},
        format="json",
    )
    assert response.status_code == 400


@pytest.mark.parametrize(
    "bad_url",
    [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "gopher://example.com/",
        "ftp://example.com/",
        "example.com",  # no scheme
        "https://gitlab.example.com/?token=x",  # query string corrupts /api/v4/user
        "https://gitlab.example.com/#frag",  # fragment corrupts /api/v4/user
    ],
)
def test_create_rejects_dangerous_base_url_schemes(client: APIClient, bad_url: str) -> None:
    """``base_url`` is operator-supplied and ends up driving the provider's
    ``/user`` verify call (and #637's status fetches). Reject anything that
    isn't a clean ``http``/``https`` host URL at write time — wrong scheme, no
    scheme, or a query/fragment that would corrupt the constructed verify URL —
    so the resolver-level SSRF guard isn't the only line of defense."""
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-x", "base_url": bad_url},
        format="json",
    )
    assert response.status_code == 400


def test_create_rejects_unknown_provider(client: APIClient) -> None:
    response = client.post(
        "/api/v1/me/credentials/not-a-real-provider/",
        {"secret": "x"},
        format="json",
    )
    assert response.status_code == 400


def test_create_anonymous_is_rejected() -> None:
    response = APIClient().post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "x"},
        format="json",
    )
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# destroy
# ---------------------------------------------------------------------------


def test_destroy_revokes_credential(client: APIClient, user: AbstractBaseUser) -> None:
    IntegrationCredential.upsert(user=user, provider="gitlab", secret="glpat-x")
    response = client.delete("/api/v1/me/credentials/gitlab/")
    assert response.status_code == 204
    assert not IntegrationCredential.objects.filter(user=user, provider="gitlab").exists()


def test_destroy_is_idempotent(client: APIClient) -> None:
    response = client.delete("/api/v1/me/credentials/gitlab/")
    assert response.status_code == 204


def test_destroy_rejects_unknown_provider(client: APIClient) -> None:
    response = client.delete("/api/v1/me/credentials/not-a-real-provider/")
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# RBAC — own-only enforcement
# ---------------------------------------------------------------------------


def test_one_user_cannot_see_another_users_credentials(
    client: APIClient, other_user: AbstractBaseUser
) -> None:
    """Another user has a github credential, but the authenticated client
    sees ``exists=False`` for github — queryset auto-scopes to request.user."""
    IntegrationCredential.upsert(user=other_user, provider="github", secret="ghp-other")
    response = client.get("/api/v1/me/credentials/")
    assert response.status_code == 200
    row = next(r for r in response.json() if r["provider"] == "github")
    assert row["exists"] is False


def test_one_user_cannot_revoke_another_users_credentials(
    client: APIClient, other_user: AbstractBaseUser
) -> None:
    """DELETE only touches rows belonging to the authenticated user. The
    other user's GitHub row survives. This is the IDOR test — without
    the queryset filter, an attacker could delete arbitrary rows."""
    IntegrationCredential.upsert(user=other_user, provider="github", secret="ghp-other")
    response = client.delete("/api/v1/me/credentials/github/")
    assert response.status_code == 204
    # Other user's row is untouched.
    assert IntegrationCredential.objects.filter(user=other_user, provider="github").exists()


def test_one_user_cannot_rotate_another_users_credentials(
    client: APIClient, user: AbstractBaseUser, other_user: AbstractBaseUser
) -> None:
    """POST creates / rotates a credential for the authenticated user only.
    A POST does not leak into another user's row even though the URL path
    contains only the provider key, never a user id."""
    IntegrationCredential.upsert(user=other_user, provider="github", secret="ghp-other")
    response = client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp-mine"},
        format="json",
    )
    assert response.status_code == 200
    # Two distinct rows now — one per user, scoped correctly.
    assert IntegrationCredential.objects.filter(provider="github").count() == 2
    mine = IntegrationCredential.objects.get(user=user, provider="github")
    theirs = IntegrationCredential.objects.get(user=other_user, provider="github")
    assert decrypt_secret(mine.secret_ciphertext) == "ghp-mine"
    assert decrypt_secret(theirs.secret_ciphertext) == "ghp-other"
