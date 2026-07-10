"""Tests for Project.methodology preset (issue #233 / ADR-0041).

The field controls UI tab visibility only — every API endpoint remains
reachable regardless of methodology. These tests verify the model default,
the serializer field exposure, the choice constraint, and PATCH semantics.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Methodology, Project

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def scheduler(project: Project) -> object:
    u = User.objects.create_user(username="scheduler", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.SCHEDULER)
    return u


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_methodology_defaults_to_hybrid(project: Project) -> None:
    """HYBRID default keeps existing pre-ADR-0041 projects fully functional."""
    assert project.methodology == Methodology.HYBRID


@pytest.mark.django_db
def test_methodology_exposed_on_serializer(project: Project, member: object) -> None:
    c = _client(member)
    resp = c.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["methodology"] == Methodology.HYBRID


@pytest.mark.django_db
def test_methodology_patch_writable(project: Project, scheduler: object) -> None:
    c = _client(scheduler)
    resp = c.patch(
        f"/api/v1/projects/{project.pk}/",
        {"methodology": Methodology.WATERFALL},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.methodology == Methodology.WATERFALL


@pytest.mark.django_db
@pytest.mark.parametrize("value", ["WATERFALL", "AGILE", "HYBRID"])
def test_all_three_methodology_values_accepted(
    project: Project, scheduler: object, value: str
) -> None:
    c = _client(scheduler)
    resp = c.patch(
        f"/api/v1/projects/{project.pk}/",
        {"methodology": value},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.methodology == value


@pytest.mark.django_db
def test_invalid_methodology_value_rejected(project: Project, scheduler: object) -> None:
    c = _client(scheduler)
    resp = c.patch(
        f"/api/v1/projects/{project.pk}/",
        {"methodology": "SCRUMBAN"},  # not in the choice set
        format="json",
    )
    assert resp.status_code == 400
    assert "methodology" in resp.data


@pytest.mark.django_db
def test_methodology_does_not_gate_api_access(project: Project, member: object) -> None:
    """ADR-0041 explicitly states methodology is a UI hint, not an access gate."""
    project.methodology = Methodology.WATERFALL
    project.save(update_fields=["methodology"])
    # Sprint endpoints remain reachable on a WATERFALL project — only the UI
    # hides the tab. The backend never returns 403/404 because of methodology.
    c = _client(member)
    resp = c.get(f"/api/v1/projects/{project.pk}/sprints/")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# agile_features is derived from effective_methodology, not stored (#1766).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("methodology", "expected"),
    [
        (Methodology.WATERFALL, False),
        (Methodology.AGILE, True),
        (Methodology.HYBRID, True),
    ],
)
def test_agile_features_derived_from_methodology(
    project: Project, member: object, methodology: str, expected: bool
) -> None:
    """The serialized flag follows the methodology preset: on for anything but WATERFALL."""
    project.methodology = methodology
    project.save(update_fields=["methodology"])
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["agile_features"] is expected


@pytest.mark.django_db
def test_agile_features_tracks_methodology_change(project: Project, scheduler: object) -> None:
    """The #1766 drift scenario: switching methodology re-derives agile_features.

    A stored boolean set once at create time stayed False after a WATERFALL → AGILE
    switch, so the board never surfaced sprint/points fields on a now-agile project.
    Because the flag is now computed on read, the PATCH that changes the methodology
    is enough — no second write, no stale column.
    """
    c = _client(scheduler)
    project.methodology = Methodology.WATERFALL
    project.save(update_fields=["methodology"])
    assert c.get(f"/api/v1/projects/{project.pk}/").data["agile_features"] is False

    resp = c.patch(
        f"/api/v1/projects/{project.pk}/",
        {"methodology": Methodology.AGILE},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["agile_features"] is True
    assert c.get(f"/api/v1/projects/{project.pk}/").data["agile_features"] is True


@pytest.mark.django_db
def test_agile_features_is_read_only(project: Project, scheduler: object) -> None:
    """agile_features is no longer a settable column — a client value is ignored.

    The methodology is the single source of truth; a stray ``agile_features`` in the
    request body must not create a second, drifting signal (#1766).
    """
    project.methodology = Methodology.WATERFALL
    project.save(update_fields=["methodology"])
    resp = _client(scheduler).patch(
        f"/api/v1/projects/{project.pk}/",
        {"agile_features": True},  # ignored — not writable
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["agile_features"] is False  # still follows WATERFALL
