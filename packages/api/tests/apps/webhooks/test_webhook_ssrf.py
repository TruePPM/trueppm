"""SSRF guard tests for webhook registration and delivery (#768).

Webhook.url is configured by a project admin (an RBAC role, not an infra
operator), so outbound delivery is untrusted egress. The serializer rejects
obviously unsafe targets at registration and ``deliver_webhook`` re-checks at
delivery time as the authoritative guard. Both route through the shared
integrations egress chokepoint (``assert_url_allowed``, ADR-0049 §3).
"""

from __future__ import annotations

import urllib.request
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks.models import DeliveryStatus, Webhook, WebhookDelivery

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="SSRFProj", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="ssrf_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
@pytest.mark.parametrize(
    "blocked_url",
    [
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://127.0.0.1/internal",  # loopback
        "http://10.0.0.5/admin",  # RFC1918 private
        "ftp://example.com/payload",  # disallowed scheme
    ],
)
def test_create_webhook_rejects_ssrf_url(
    admin_client: APIClient, project: Project, blocked_url: str
) -> None:
    """Registration rejects private/loopback/link-local/bad-scheme URLs with a 400."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": blocked_url, "secret": "s3cret", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 400
    assert "url" in resp.data
    assert not Webhook.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_create_webhook_allows_public_url(admin_client: APIClient, project: Project) -> None:
    """A public (or not-yet-resolvable) URL passes registration validation."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "https://hooks.example.com/x", "secret": "s3cret", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 201


@pytest.mark.django_db
def test_deliver_webhook_blocked_url_fails_without_request(project: Project) -> None:
    """Delivery to a private/loopback URL is blocked before any socket opens.

    A webhook can reach a blocked URL even when registration validation is
    bypassed (e.g. a row created directly, or DNS rebinding after registration),
    so the delivery-time guard is the authoritative SSRF defense.
    """
    user = User.objects.create_user(username="ssrf_owner", password="pw")
    webhook = Webhook.objects.create(
        project=project,
        url="http://169.254.169.254/latest/meta-data/",
        secret="s3cret",
        events=["task.created"],
        created_by=user,
    )
    delivery = WebhookDelivery.objects.create(
        webhook=webhook, event_type="task.created", payload={"id": "t1"}
    )

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(urllib.request, "urlopen") as mock_urlopen:
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    mock_urlopen.assert_not_called()
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    assert delivery.attempt_count == 1
    assert delivery.completed_at is not None
