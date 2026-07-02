"""Scoped-throttle tests for the credential + webhook-secret endpoints (#1551).

The per-user credential store (``/api/v1/me/credentials/``), the Git-automation
config view, and the secret-rotation view each mint, return, or reveal the
presence of a plaintext credential/secret. Before #1551 none of them carried a
throttle, unlike ``login``/``refresh``/``invite_resend``/``oidc_*``/``ws_ticket``.
They now share the ``credential_rotate`` scope; these tests prove the limiter
actually fires with a 429 past the cap.

The rate is patched on the throttle class rather than via ``override_settings``:
DRF binds ``THROTTLE_RATES`` to a class attribute at import, so a settings
override never reaches the already-bound throttle (mirrors
``access/test_auth_cookie.py``).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations import http
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _tighten_credential_rate(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the ``credential_rotate`` scope to 2/min so the cap is reachable fast.

    Also clears the throttle cache (it lives in LocMem) before and after so the
    count starts at zero regardless of test ordering and a later test that hits
    these endpoints is not pre-throttled.
    """
    cache.clear()
    monkeypatch.setattr(
        ScopedRateThrottle,
        "THROTTLE_RATES",
        {**ScopedRateThrottle.THROTTLE_RATES, "credential_rotate": "2/min"},
    )
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _stub_token_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make PAT verification pass without touching the network.

    ``IntegrationCredentialViewSet.create`` pings the provider's ``/user``
    endpoint; these throttle tests assert the limiter, not egress, so stub it 200.
    """

    def _fake_get(
        url: str, *, headers: dict[str, str] | None = None, timeout: float = http.DEFAULT_TIMEOUT
    ) -> http.EgressResponse:
        return http.EgressResponse(
            status=200, body=b'{"username": "stub", "login": "stub"}', headers={}
        )

    monkeypatch.setattr(http, "get", _fake_get)


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def admin(project: Project) -> object:
    user = User.objects.create_user(username="throttle_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


def _auth(user: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_credential_upsert_throttles_past_the_cap(admin: object) -> None:
    """Two connect/rotate calls succeed; the third inside the window is 429."""
    client = _auth(admin)
    url = "/api/v1/me/credentials/github/"
    payload = {"secret": "ghp-very-secret"}

    first = client.post(url, payload, format="json")
    second = client.post(url, payload, format="json")
    third = client.post(url, payload, format="json")

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429


def test_credential_retrieve_throttles_past_the_cap(admin: object) -> None:
    """The single-provider read shares the bucket — the third GET is 429."""
    client = _auth(admin)
    url = "/api/v1/me/credentials/github/"

    statuses = [client.get(url).status_code for _ in range(3)]

    assert statuses[:2] == [200, 200]
    assert statuses[2] == 429


def test_git_automation_config_throttles_past_the_cap(project: Project, admin: object) -> None:
    """The config GET (reveals whether a secret is set) is 429 past the cap."""
    client = _auth(admin)
    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})

    statuses = [client.get(url).status_code for _ in range(3)]

    assert statuses[:2] == [200, 200]
    assert statuses[2] == 429


def test_git_automation_rotate_secret_throttles_past_the_cap(
    project: Project, admin: object
) -> None:
    """The secret-rotation POST (mints plaintext) is 429 past the cap."""
    client = _auth(admin)
    url = reverse("git-automation-rotate-secret", kwargs={"project_pk": str(project.pk)})

    statuses = [client.post(url).status_code for _ in range(3)]

    assert statuses[:2] == [201, 201]
    assert statuses[2] == 429
