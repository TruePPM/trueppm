"""Tests for RiskSerializer.validate_mitigation_due_date (non-blocking)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk, RiskStatus

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(user=user, project=project, role=Role.ADMIN)


@pytest.fixture
def risk(project: Project, user: object) -> Risk:
    return Risk.objects.create(
        project=project,
        title="Schedule slippage",
        probability=3,
        impact=4,
        status=RiskStatus.MITIGATING,
        created_by=user,
    )


class TestValidateMitigationDueDate:
    """validate_mitigation_due_date is non-blocking: saves always succeed."""

    def test_past_date_with_mitigating_status_does_not_block_save(
        self, client: APIClient, project: Project, risk: Risk, membership: object
    ) -> None:
        past = (date.today() - timedelta(days=10)).isoformat()
        url = f"/api/v1/projects/{project.pk}/risks/{risk.pk}/"
        resp = client.patch(url, {"mitigation_due_date": past}, format="json")
        assert resp.status_code == 200
        risk.refresh_from_db()
        assert str(risk.mitigation_due_date) == past

    def test_future_date_accepted(
        self, client: APIClient, project: Project, risk: Risk, membership: object
    ) -> None:
        future = (date.today() + timedelta(days=30)).isoformat()
        url = f"/api/v1/projects/{project.pk}/risks/{risk.pk}/"
        resp = client.patch(url, {"mitigation_due_date": future}, format="json")
        assert resp.status_code == 200
        risk.refresh_from_db()
        assert str(risk.mitigation_due_date) == future

    def test_null_date_accepted(
        self, client: APIClient, project: Project, risk: Risk, membership: object
    ) -> None:
        risk.mitigation_due_date = date.today() + timedelta(days=5)
        risk.save()
        url = f"/api/v1/projects/{project.pk}/risks/{risk.pk}/"
        resp = client.patch(url, {"mitigation_due_date": None}, format="json")
        assert resp.status_code == 200
        risk.refresh_from_db()
        assert risk.mitigation_due_date is None
