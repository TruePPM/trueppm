"""Tests for the integrations-summary aggregator endpoint (#569, ADR-0076).

Covers:
  GET /api/v1/projects/<pk>/integrations-summary/

The endpoint aggregates the project's outbound webhooks (ADR-0019) and
inbound API tokens (ADR-0068) into a single round-trip so the
Project → Settings → Integrations page avoids waterfall fetches.

Per ADR-0076, a subservice failure returns 503 with a ``{"failed": "<section>"}``
body so the frontend can fall back to fetching the failed section directly.
"""

from __future__ import annotations

import datetime
import hashlib
import secrets
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, ProjectApiToken
from trueppm_api.apps.webhooks.models import (
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
    WebhookEventType,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Alpha",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_webhook(
    project: Project, *, url: str = "https://example.com/h", is_active: bool = True
) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url=url,
        secret="s3cret",
        events=[WebhookEventType.TASK_CREATED.value],
        is_active=is_active,
    )


def _make_delivery(
    webhook: Webhook,
    *,
    status: str = DeliveryStatus.SUCCESS,
    days_ago: int = 0,
) -> WebhookDelivery:
    """Create a delivery row, then back-date `created_at` to `days_ago` days ago.

    `created_at` is `auto_now_add` so we cannot pass it to create(); the
    `WebhookDelivery.objects.filter(...).update(...)` round-trip keeps the
    helper compact while letting tests cover the 7-day failure window.
    """
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type=WebhookEventType.TASK_CREATED.value,
        payload={"task_id": "abc"},
        status=status,
        response_status=200 if status == DeliveryStatus.SUCCESS else 500,
        attempt_count=1,
    )
    if days_ago:
        past = datetime.datetime.now(tz=datetime.UTC) - datetime.timedelta(days=days_ago)
        WebhookDelivery.objects.filter(pk=delivery.pk).update(created_at=past)
        delivery.refresh_from_db()
    return delivery


def _make_token(project: Project, *, name: str = "CI", revoked: bool = False) -> ProjectApiToken:
    raw = secrets.token_hex(16)
    token = ProjectApiToken.objects.create(
        project=project,
        name=name,
        token_prefix=raw[:8],
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
    )
    if revoked:
        token.revoked_at = datetime.datetime.now(tz=datetime.UTC)
        token.save(update_fields=["revoked_at"])
    return token


# ---------------------------------------------------------------------------
# GET /api/v1/projects/<pk>/integrations-summary/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIntegrationsSummary:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/integrations-summary/"

    # --- RBAC ---------------------------------------------------------------

    def test_unauthenticated_returns_401(
        self, anon_client: APIClient, project: Project, membership: object
    ) -> None:
        res = anon_client.get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_404(
        self, other_user: object, project: Project, membership: object
    ) -> None:
        # ProjectScopedViewSet filters the queryset to member projects, so
        # the project is invisible to a non-member and get_object() raises
        # 404 before the permission check fires. This is the consistent
        # pattern across @action(detail=True) endpoints on ProjectViewSet.
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 404

    def test_member_can_read(self, client: APIClient, project: Project, membership: object) -> None:
        # Members (lowest non-viewer role) can read the summary — matches the
        # Project-Member RBAC contract in ADR-0076.
        res = client.get(self.url(project.pk))
        assert res.status_code == 200

    def test_viewer_can_read(self, project: Project, calendar: Calendar) -> None:
        # Viewer (role=0) is the most restrictive role above non-member; the
        # ADR specifies Project Member to read, and Viewer satisfies that
        # since they're a project member with read-only rights.
        viewer = User.objects.create_user(username="viewer", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        c = APIClient()
        c.force_authenticate(user=viewer)
        res = c.get(self.url(project.pk))
        assert res.status_code == 200

    def test_unknown_project_returns_404(self, client: APIClient, membership: object) -> None:
        import uuid

        res = client.get(self.url(uuid.uuid4()))
        assert res.status_code == 404

    # --- Empty state --------------------------------------------------------

    def test_empty_project_returns_zero_counts(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        data = res.json()
        assert data["webhooks"]["total"] == 0
        assert data["webhooks"]["items"] == []
        assert data["webhooks"]["last_delivery_at"] is None
        assert data["api_tokens"]["active_total"] == 0
        assert data["api_tokens"]["items"] == []
        assert data["api_tokens"]["last_used_at"] is None

    # --- Webhooks section ---------------------------------------------------

    def test_webhooks_section_returns_items(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        _make_webhook(project, url="https://example.com/a")
        _make_webhook(project, url="https://example.com/b")
        res = client.get(self.url(project.pk))
        data = res.json()
        assert data["webhooks"]["total"] == 2
        assert data["webhooks"]["active_total"] == 2
        urls = {item["url"] for item in data["webhooks"]["items"]}
        assert urls == {"https://example.com/a", "https://example.com/b"}

    def test_webhooks_section_caps_items_at_five(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        for i in range(7):
            _make_webhook(project, url=f"https://example.com/{i}")
        res = client.get(self.url(project.pk))
        data = res.json()
        assert data["webhooks"]["total"] == 7
        # Items list is capped at 5 per `_INTEGRATIONS_SUMMARY_ITEM_LIMIT`.
        assert len(data["webhooks"]["items"]) == 5

    def test_webhook_recent_failure_count_uses_seven_day_window(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        wh = _make_webhook(project)
        _make_delivery(wh, status=DeliveryStatus.FAILED, days_ago=3)
        _make_delivery(wh, status=DeliveryStatus.FAILED, days_ago=10)  # outside window
        _make_delivery(wh, status=DeliveryStatus.SUCCESS, days_ago=1)
        res = client.get(self.url(project.pk))
        item = res.json()["webhooks"]["items"][0]
        assert item["recent_failure_count"] == 1  # only the 3-days-ago FAILED counts

    def test_webhook_last_delivery_is_most_recent(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        wh = _make_webhook(project)
        _make_delivery(wh, status=DeliveryStatus.FAILED, days_ago=2)
        _make_delivery(wh, status=DeliveryStatus.SUCCESS, days_ago=0)
        res = client.get(self.url(project.pk))
        item = res.json()["webhooks"]["items"][0]
        # The just-created success delivery is the most recent.
        assert item["last_delivery"]["status"] == DeliveryStatus.SUCCESS

    # --- API tokens section -------------------------------------------------

    def test_api_tokens_section_hides_revoked(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        _make_token(project, name="Active")
        _make_token(project, name="Old", revoked=True)
        res = client.get(self.url(project.pk))
        data = res.json()
        # Revoked tokens are hidden from the summary; the active_total reflects
        # only non-revoked rows.
        assert data["api_tokens"]["active_total"] == 1
        names = {item["name"] for item in data["api_tokens"]["items"]}
        assert names == {"Active"}

    def test_api_tokens_section_returns_token_prefix(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        token = _make_token(project, name="CI")
        res = client.get(self.url(project.pk))
        item = res.json()["api_tokens"]["items"][0]
        assert item["token_prefix"] == token.token_prefix

    # --- 503 per-section fallback (ADR-0076 §Durable Execution Q8) -----------

    def test_webhooks_subservice_failure_returns_503(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        with patch(
            "trueppm_api.apps.projects.views._summarize_webhooks",
            side_effect=RuntimeError("simulated"),
        ):
            res = client.get(self.url(project.pk))
        assert res.status_code == 503
        assert res.json() == {"failed": "webhooks"}

    def test_api_tokens_subservice_failure_returns_503(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        with patch(
            "trueppm_api.apps.projects.views._summarize_api_tokens",
            side_effect=RuntimeError("simulated"),
        ):
            res = client.get(self.url(project.pk))
        assert res.status_code == 503
        assert res.json() == {"failed": "api_tokens"}

    # --- Cross-project isolation --------------------------------------------

    def test_webhooks_from_other_project_are_not_included(
        self,
        client: APIClient,
        project: Project,
        calendar: Calendar,
        membership: object,
    ) -> None:
        other = Project.objects.create(
            name="Beta", start_date=datetime.date(2026, 1, 1), calendar=calendar
        )
        _make_webhook(other, url="https://other.example.com/h")
        res = client.get(self.url(project.pk))
        assert res.json()["webhooks"]["total"] == 0
