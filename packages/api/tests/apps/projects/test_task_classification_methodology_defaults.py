"""Methodology-aware governance_class/delivery_mode defaults on task create (#2667).

Before this change, a new task always defaulted to ``governance_class='flow'`` /
``delivery_mode='waterfall'`` regardless of the owning project's methodology — a
self-contradictory dialog on a WATERFALL project (Flow governance describes itself
as "agile, sprint- or kanban-governed work" on a project with no sprints or board
governance) and a correctness bug on AGILE (delivery_mode stuck at waterfall never
engages point-burndown rollup or agile-aware Monte Carlo). These tests cover the
three methodologies plus the omitted-field precedence rule from
``TaskSerializer._resolve_classification_defaults``.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BoardCadence,
    Calendar,
    DeliveryMode,
    GovernanceClass,
    Methodology,
    Project,
    Task,
)

User = get_user_model()


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _project(
    owner: object, *, methodology: str, board_cadence: str = BoardCadence.SPRINT
) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(
        name="Artemis",
        start_date=date(2026, 1, 1),
        calendar=cal,
        methodology=methodology,
        board_cadence=board_cadence,
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


# ---------------------------------------------------------------------------
# Create — omitted classification fields default from effective_methodology
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_waterfall_project_defaults_to_gated_waterfall(client: APIClient, owner: object) -> None:
    project = _project(owner, methodology=Methodology.WATERFALL)
    resp = client.post(
        "/api/v1/tasks/",
        {"name": "T", "duration": 1, "project": str(project.pk)},
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.GATED.value
    assert resp.data["delivery_mode"] == DeliveryMode.WATERFALL.value


@pytest.mark.django_db
def test_agile_sprint_project_defaults_to_flow_scrum(client: APIClient, owner: object) -> None:
    project = _project(owner, methodology=Methodology.AGILE, board_cadence=BoardCadence.SPRINT)
    resp = client.post(
        "/api/v1/tasks/",
        {"name": "T", "duration": 1, "project": str(project.pk)},
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.FLOW.value
    assert resp.data["delivery_mode"] == DeliveryMode.SCRUM.value


@pytest.mark.django_db
def test_agile_continuous_flow_project_defaults_to_flow_kanban(
    client: APIClient, owner: object
) -> None:
    """A board that already runs continuous-flow Kanban (ADR-0164) with no sprint
    cadence defaults new tasks to kanban rather than scrum — the "deliberate
    flow-without-sprints choice" carved out in #2667's resolution."""
    project = _project(owner, methodology=Methodology.AGILE, board_cadence=BoardCadence.CONTINUOUS)
    resp = client.post(
        "/api/v1/tasks/",
        {"name": "T", "duration": 1, "project": str(project.pk)},
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.FLOW.value
    assert resp.data["delivery_mode"] == DeliveryMode.KANBAN.value


@pytest.mark.django_db
def test_hybrid_project_keeps_flow_waterfall_default(client: APIClient, owner: object) -> None:
    """HYBRID is the preset that mixes both models — no behavior change (AC)."""
    project = _project(owner, methodology=Methodology.HYBRID)
    resp = client.post(
        "/api/v1/tasks/",
        {"name": "T", "duration": 1, "project": str(project.pk)},
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.FLOW.value
    assert resp.data["delivery_mode"] == DeliveryMode.WATERFALL.value


# ---------------------------------------------------------------------------
# Omitted-field precedence — explicit values always win, on create and update
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_explicit_value_wins_over_methodology_default(client: APIClient, owner: object) -> None:
    """An explicit off-preset value on a WATERFALL project is honored, not
    overridden — the taxonomy stays additive/opt-in per the documented hybrid
    seam (a PM may deliberately mark one subtree agile inside a waterfall
    project)."""
    project = _project(owner, methodology=Methodology.WATERFALL)
    resp = client.post(
        "/api/v1/tasks/",
        {
            "name": "T",
            "duration": 1,
            "project": str(project.pk),
            "governance_class": "hybrid",
            "delivery_mode": "scrum",
        },
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.HYBRID.value
    assert resp.data["delivery_mode"] == DeliveryMode.SCRUM.value


@pytest.mark.django_db
def test_only_one_field_omitted_still_defaults_independently(
    client: APIClient, owner: object
) -> None:
    """Sending one classification field but not the other defaults only the
    missing one — the two fields are independently additive."""
    project = _project(owner, methodology=Methodology.WATERFALL)
    resp = client.post(
        "/api/v1/tasks/",
        {
            "name": "T",
            "duration": 1,
            "project": str(project.pk),
            "governance_class": "hybrid",
            # delivery_mode omitted — should still default from methodology.
        },
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.HYBRID.value
    assert resp.data["delivery_mode"] == DeliveryMode.WATERFALL.value


@pytest.mark.django_db
def test_milestone_create_still_defaults_governance_class(client: APIClient, owner: object) -> None:
    """Milestone create omits the whole classification triple client-side
    (TaskFormModal.buildCreatePayload), but delivery_mode is driven to
    'milestone' by the is_milestone coupling — governance_class is independent
    and must still resolve the project's methodology default."""
    project = _project(owner, methodology=Methodology.AGILE, board_cadence=BoardCadence.SPRINT)
    resp = client.post(
        "/api/v1/tasks/",
        {
            "name": "Kickoff",
            "duration": 0,
            "project": str(project.pk),
            "is_milestone": "true",
        },
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["governance_class"] == GovernanceClass.FLOW.value
    assert resp.data["delivery_mode"] == DeliveryMode.MILESTONE.value


# ---------------------------------------------------------------------------
# Update — a stored task's classification is never coerced by a later
# methodology change (AC: "opening an existing off-preset task ... does not
# coerce them on save")
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_never_defaults_or_coerces_stored_classification(
    client: APIClient, owner: object
) -> None:
    project = _project(owner, methodology=Methodology.WATERFALL)
    task = Task.objects.create(project=project, name="T", wbs_path="1")
    assert task.governance_class == GovernanceClass.FLOW
    assert task.delivery_mode == DeliveryMode.WATERFALL

    # Project later moves to AGILE — an unrelated PATCH on the task must not
    # retroactively touch its stored classification.
    project.methodology = Methodology.AGILE
    project.save(update_fields=["methodology"])

    resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "T renamed"}, format="json")
    assert resp.status_code == 200, resp.data
    task.refresh_from_db()
    assert task.governance_class == GovernanceClass.FLOW
    assert task.delivery_mode == DeliveryMode.WATERFALL
