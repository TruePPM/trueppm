"""Tests for live PAT verification on ``POST /api/v1/me/credentials/`` (#677).

ADR-0049 §3 says a credential is verified against its provider before it is
stored, so a wrong / expired / wrong-scope / wrong-host token is rejected with
422 at connect time rather than silently accepted and discovered later by
#637's status fetch. These tests drive the viewset and assert each
``VerifyResult.reason`` maps to the right response and that **no row is written**
(and therefore the secret is never encrypted) on a failed verify.

The egress layer (``integrations.http.get``) is stubbed per-test so no real
network call is made; the SSRF case uses a literal internal IP so the real
guard runs without DNS.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http
from trueppm_api.apps.integrations.models import IntegrationCredential

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="verify_user", password="pw")


@pytest.fixture
def client(user: AbstractBaseUser) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _stub_get(monkeypatch: pytest.MonkeyPatch, **kwargs: object) -> None:
    """Replace ``http.get`` with a callable described by ``kwargs``.

    ``status``/``body`` return an :class:`EgressResponse`; ``raises`` raises the
    given exception instance instead.
    """

    def _fake_get(
        url: str, *, headers: dict[str, str] | None = None, timeout: float = http.DEFAULT_TIMEOUT
    ) -> http.EgressResponse:
        if "raises" in kwargs:
            raise kwargs["raises"]  # type: ignore[misc]
        return http.EgressResponse(
            status=int(kwargs.get("status", 200)),
            body=bytes(kwargs.get("body", b"{}")),  # type: ignore[arg-type]
            headers=dict(kwargs.get("headers", {})),  # type: ignore[arg-type]
        )

    monkeypatch.setattr(http, "get", _fake_get)


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------


def test_valid_pat_is_verified_and_stored(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_get(monkeypatch, status=200, body=b'{"username": "octocat"}')
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-good"},
        format="json",
    )
    assert response.status_code == 200
    assert IntegrationCredential.objects.filter(user=user, provider="gitlab").exists()


def test_generic_provider_is_accepted_unverified(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The generic provider inherits the base no-op verifier — no network call,
    credential stored. Guard against any accidental egress by making ``get``
    explode if it is reached."""

    def _boom(*args: object, **kwargs: object) -> object:
        raise AssertionError("generic provider must not call the network to verify")

    monkeypatch.setattr(http, "get", _boom)
    response = client.post(
        "/api/v1/me/credentials/generic/",
        {"secret": "some-token"},
        format="json",
    )
    assert response.status_code == 200
    assert IntegrationCredential.objects.filter(user=user, provider="generic").exists()


# ---------------------------------------------------------------------------
# failure paths — 422, no row written
# ---------------------------------------------------------------------------


def test_invalid_pat_is_rejected_without_storing(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """401 from /user → 422 invalid_token, and the row is never written, so the
    secret is never encrypted (upsert is not reached)."""
    _stub_get(monkeypatch, status=401, body=b'{"message": "401 Unauthorized"}')
    response = client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp-bad"},
        format="json",
    )
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "provider_verification_failed"
    assert body["reason"] == "invalid_token"
    assert not IntegrationCredential.objects.filter(user=user).exists()


def test_wrong_host_pat_fails_auth(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A github.com PAT pasted into the gitlab slot fails the gitlab /user auth
    (401) — exercised as the invalid_token path against the gitlab endpoint."""
    _stub_get(monkeypatch, status=403)
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "ghp-wrong-host"},
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["reason"] == "invalid_token"
    assert not IntegrationCredential.objects.filter(user=user).exists()


def test_provider_5xx_is_unreachable(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_get(monkeypatch, status=503)
    response = client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp-x"},
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["reason"] == "provider_unreachable"
    assert not IntegrationCredential.objects.filter(user=user).exists()


def test_provider_timeout(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_get(monkeypatch, raises=http.EgressTimeout("timed out"))
    response = client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp-x"},
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["reason"] == "provider_timeout"
    assert not IntegrationCredential.objects.filter(user=user).exists()


def test_provider_connection_error_is_unreachable(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_get(monkeypatch, raises=http.EgressError("connection refused"))
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-x"},
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["reason"] == "provider_unreachable"
    assert not IntegrationCredential.objects.filter(user=user).exists()


@pytest.mark.parametrize(
    "base_url",
    [
        "https://127.0.0.1",  # loopback
        "https://169.254.169.254",  # cloud metadata (link-local)
        "https://10.0.0.1",  # RFC1918
        "https://192.168.1.1",  # RFC1918
    ],
)
def test_ssrf_base_url_is_blocked(
    client: APIClient,
    user: AbstractBaseUser,
    base_url: str,
    settings: pytest.FixtureRequest,
) -> None:
    """Even when a host is operator-allowlisted (#902), the resolver-level SSRF
    guard still rejects an internal address with 422 blocked_host — the two
    controls compose as defense in depth. The allowlist is set here so the SSRF
    guard, not the allowlist precheck, is what fires. The real ``http.get`` runs
    (literal IPs need no DNS), exercising the guard end to end."""
    host = base_url.split("://", 1)[1]
    settings.INTEGRATION_ALLOWED_HOSTS = [host]
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-x", "base_url": base_url},
        format="json",
    )
    assert response.status_code == 422
    assert response.json()["reason"] == "blocked_host"
    assert not IntegrationCredential.objects.filter(user=user).exists()


# ---------------------------------------------------------------------------
# base_url allowlist — PAT must never ship to a non-allowlisted host (#902)
# ---------------------------------------------------------------------------


def test_base_url_attacker_host_rejected_before_verify(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A github credential with an arbitrary public ``base_url`` is rejected with
    400 *before* verify runs — the PAT must never reach attacker.example.com.
    ``http.get`` is booby-trapped to prove no egress happens."""

    def _boom(*args: object, **kwargs: object) -> object:
        raise AssertionError("verify must not run for a disallowed base_url — PAT would leak")

    monkeypatch.setattr(http, "get", _boom)
    response = client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp_secret", "base_url": "https://attacker.example.com"},
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["code"] == "base_url_not_allowed"
    assert not IntegrationCredential.objects.filter(user=user).exists()


def test_base_url_github_saas_host_allowed(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The github SaaS host passes the allowlist and is stored after verify."""
    _stub_get(monkeypatch, status=200, body=b'{"login": "octocat"}')
    response = client.post(
        "/api/v1/me/credentials/github/",
        {"secret": "ghp_good", "base_url": "https://api.github.com"},
        format="json",
    )
    assert response.status_code == 200
    assert IntegrationCredential.objects.filter(user=user, provider="github").exists()


def test_base_url_self_hosted_allowed_via_operator_allowlist(
    client: APIClient,
    user: AbstractBaseUser,
    monkeypatch: pytest.MonkeyPatch,
    settings: pytest.FixtureRequest,
) -> None:
    """A self-hosted GitLab CE host is accepted only once an operator adds it to
    TRUEPPM_INTEGRATION_ALLOWED_HOSTS (#902)."""
    settings.INTEGRATION_ALLOWED_HOSTS = ["gitlab.mycorp.example"]
    _stub_get(monkeypatch, status=200, body=b'{"username": "dev"}')
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-good", "base_url": "https://gitlab.mycorp.example"},
        format="json",
    )
    assert response.status_code == 200
    assert IntegrationCredential.objects.filter(user=user, provider="gitlab").exists()


# ---------------------------------------------------------------------------
# Transport security — a PAT must never ride a plain-http base_url (#4086)
# ---------------------------------------------------------------------------


def test_http_base_url_rejected_before_any_egress(
    client: APIClient,
    user: AbstractBaseUser,
    monkeypatch: pytest.MonkeyPatch,
    settings: pytest.FixtureRequest,
) -> None:
    """``http://gitlab.com`` passes the host allow-list but would send the PAT in
    cleartext on the first request, so it is refused with 400 and nothing is sent."""
    settings.DEBUG = False

    def _boom(*args: object, **kwargs: object) -> object:
        raise AssertionError("verify must not run for an http base_url")

    monkeypatch.setattr(http, "get", _boom)
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-x", "base_url": "http://gitlab.com"},
        format="json",
    )
    assert response.status_code == 400
    assert "cleartext" in str(response.json())
    assert not IntegrationCredential.objects.filter(user=user).exists()


def test_https_base_url_accepted(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_get(monkeypatch, status=200, body=b'{"username": "u"}')
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-x", "base_url": "https://gitlab.com"},
        format="json",
    )
    assert response.status_code == 200


def test_http_base_url_accepted_in_debug(
    client: APIClient, monkeypatch: pytest.MonkeyPatch, settings: pytest.FixtureRequest
) -> None:
    """Local development may use http, mirroring the SSO issuer rule."""
    settings.DEBUG = True
    _stub_get(monkeypatch, status=200, body=b'{"username": "u"}')
    response = client.post(
        "/api/v1/me/credentials/gitlab/",
        {"secret": "glpat-x", "base_url": "http://gitlab.com"},
        format="json",
    )
    assert response.status_code == 200


def test_generic_provider_http_base_url_still_allowed(
    client: APIClient, settings: pytest.FixtureRequest
) -> None:
    """``generic`` never sends its token anywhere, so plain http is exempt."""
    settings.DEBUG = False
    response = client.post(
        "/api/v1/me/credentials/generic/",
        {"secret": "x", "base_url": "http://intranet.example"},
        format="json",
    )
    assert response.status_code == 200


def test_send_time_refuses_to_attach_a_pat_to_a_stored_http_base_url(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch, settings: pytest.FixtureRequest
) -> None:
    """A row stored before the serializer check existed must not leak its PAT."""
    from trueppm_api.apps.integrations.providers import (
        GitHubTaskLinkProvider,
        GitLabTaskLinkProvider,
    )

    settings.DEBUG = False

    def _boom(*args: object, **kwargs: object) -> object:
        raise AssertionError("no request may carry the PAT to an http base_url")

    monkeypatch.setattr(http, "get", _boom)
    cred = IntegrationCredential(user=user, provider="gitlab", base_url="http://gitlab.com")
    monkeypatch.setattr(
        "trueppm_api.apps.integrations.providers._credential_secret", lambda c: "secret"
    )
    assert (
        GitLabTaskLinkProvider().fetch_metadata("https://gitlab.com/g/p/-/issues/1", cred).status
        == "unknown"
    )
    assert (
        GitHubTaskLinkProvider().fetch_metadata("https://github.com/o/r/issues/1", cred).status
        == "unknown"
    )
    for cls in (GitLabTaskLinkProvider, GitHubTaskLinkProvider):
        result = cls.verify_token("secret", base_url="http://gitlab.com")
        assert not result.ok and result.reason == "blocked_host"
