"""Tests for program-scoped webhook CRUD (#600 pulled forward, ADR-0076).

The project-scope WebhookViewSet is covered by test_webhooks.py; this file
covers the parallel ProgramWebhookViewSet at /api/v1/programs/<pk>/webhooks/.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.webhooks.models import Webhook

User = get_user_model()


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Artemis")


@pytest.fixture
def other_program(db: object) -> Program:
    return Program.objects.create(name="Helios")


@pytest.fixture
def admin_client(program: Program) -> APIClient:
    admin = User.objects.create_user(username="prog_admin", password="pw")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.fixture
def member_client(program: Program) -> APIClient:
    member = User.objects.create_user(username="prog_member", password="pw")
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    return c


def _url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/webhooks/"


@pytest.mark.django_db
def test_program_admin_can_create_webhook(admin_client: APIClient, program: Program) -> None:
    resp = admin_client.post(
        _url(program),
        {
            "url": "https://hooks.slack.com/services/x",
            "secret": "s3cret",
            "events": ["task.assigned"],
            "format": "slack",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert str(resp.data["program"]) == str(program.pk)
    assert resp.data["project"] is None
    assert resp.data["format"] == "slack"
    wh = Webhook.objects.get(pk=resp.data["id"])
    assert wh.program_id == program.pk and wh.project_id is None


@pytest.mark.django_db
def test_program_member_cannot_create_webhook(member_client: APIClient, program: Program) -> None:
    resp = member_client.post(
        _url(program),
        {"url": "https://example.com/h", "secret": "s", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_program_member_can_list_webhooks(member_client: APIClient, program: Program) -> None:
    Webhook.objects.create(
        program=program, url="https://example.com/h", secret="s", events=["task.created"]
    )
    resp = member_client.get(_url(program))
    assert resp.status_code == 200
    assert resp.data["count"] == 1


@pytest.mark.django_db
def test_program_webhooks_are_scope_isolated(
    admin_client: APIClient, program: Program, other_program: Program
) -> None:
    Webhook.objects.create(
        program=other_program, url="https://example.com/h", secret="s", events=["task.created"]
    )
    resp = admin_client.get(_url(program))
    assert resp.status_code == 200
    assert resp.data["count"] == 0


@pytest.mark.django_db
def test_program_webhook_rejects_unknown_format(admin_client: APIClient, program: Program) -> None:
    resp = admin_client.post(
        _url(program),
        {
            "url": "https://example.com/h",
            "secret": "s",
            "events": ["task.created"],
            "format": "pigeon",
        },
        format="json",
    )
    assert resp.status_code == 400
    assert "format" in resp.data


@pytest.mark.django_db
def test_program_webhook_test_action(admin_client: APIClient, program: Program) -> None:
    wh = Webhook.objects.create(
        program=program, url="https://example.com/h", secret="s", events=["task.created"]
    )
    resp = admin_client.post(f"{_url(program)}{wh.pk}/test/")
    assert resp.status_code == 202
    assert "delivery_id" in resp.data
