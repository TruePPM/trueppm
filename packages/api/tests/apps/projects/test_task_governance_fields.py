"""Hybrid governance / delivery-mode Task fields (ADR-0036, #407).

The three foundational fields every hybrid feature reads — governance_class,
delivery_mode, parent_governance_inherited. Tests cover the additive defaults
(no behavioral change to existing rows), serializer read/write round-trip, and
choice validation.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    GovernanceClass,
    Project,
    Task,
)

User = get_user_model()


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Artemis", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _task(project: Project, **kwargs: object) -> Task:
    return Task.objects.create(project=project, name="T", wbs_path="1", **kwargs)


# ---------------------------------------------------------------------------
# Defaults — purely additive, no behavioral change to existing rows
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_defaults_preserve_waterfall_flow_semantics(project: Project) -> None:
    t = _task(project)
    assert t.governance_class == GovernanceClass.FLOW
    assert t.delivery_mode == DeliveryMode.WATERFALL
    assert t.parent_governance_inherited is True


# ---------------------------------------------------------------------------
# Serializer read/write round-trip
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_exposes_all_three_fields(client: APIClient, project: Project) -> None:
    t = _task(project)
    resp = client.get(f"/api/v1/tasks/{t.pk}/")
    assert resp.status_code == 200
    assert resp.data["governance_class"] == "flow"
    assert resp.data["delivery_mode"] == "waterfall"
    assert resp.data["parent_governance_inherited"] is True


@pytest.mark.django_db
def test_patch_writes_all_three_fields(client: APIClient, project: Project) -> None:
    t = _task(project)
    resp = client.patch(
        f"/api/v1/tasks/{t.pk}/",
        {
            "governance_class": "gated",
            "delivery_mode": "scrum",
            "parent_governance_inherited": False,
        },
        format="json",
    )
    assert resp.status_code == 200
    t.refresh_from_db()
    assert t.governance_class == GovernanceClass.GATED
    assert t.delivery_mode == DeliveryMode.SCRUM
    assert t.parent_governance_inherited is False


@pytest.mark.django_db
@pytest.mark.parametrize("mode", ["waterfall", "scrum", "kanban", "milestone"])
def test_all_delivery_modes_accepted(client: APIClient, project: Project, mode: str) -> None:
    t = _task(project)
    resp = client.patch(f"/api/v1/tasks/{t.pk}/", {"delivery_mode": mode}, format="json")
    assert resp.status_code == 200
    t.refresh_from_db()
    assert t.delivery_mode == mode


# ---------------------------------------------------------------------------
# Choice validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("field", "bad_value"),
    [("governance_class", "bogus"), ("delivery_mode", "agile")],
)
def test_invalid_choice_rejected(
    client: APIClient, project: Project, field: str, bad_value: str
) -> None:
    t = _task(project)
    resp = client.patch(f"/api/v1/tasks/{t.pk}/", {field: bad_value}, format="json")
    assert resp.status_code == 400
    assert field in resp.data
