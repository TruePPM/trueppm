"""Tests for independent leaf-surface visibility toggles (ADR-0193, issue 956).

Four nullable booleans (show_reporting, show_time_tracking, show_baselines,
show_monte_carlo) let an Admin independently hide each leaf surface. The
effective value is project.show_<surface> if set, else the methodology default.
Hide-only (ADR-0041): the endpoint and route stay reachable regardless.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Methodology, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def waterfall_project(calendar: Calendar) -> Project:
    p = Project.objects.create(name="WaterfallProj", start_date=date(2026, 4, 1), calendar=calendar)
    p.methodology = Methodology.WATERFALL
    p.save()
    return p


@pytest.fixture
def agile_project(calendar: Calendar) -> Project:
    p = Project.objects.create(name="AgileProj", start_date=date(2026, 4, 1), calendar=calendar)
    p.methodology = Methodology.AGILE
    p.save()
    return p


def _client_for(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# ---------------------------------------------------------------------------
# Unit-level tests for the resolution logic
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_surface_visibility_defaults_by_methodology_waterfall(
    waterfall_project: Project,
) -> None:
    """Waterfall default: all four surfaces on."""
    from trueppm_api.apps.projects.surface_visibility import resolve_effective_visibility

    result = resolve_effective_visibility(waterfall_project)
    assert result == {
        "reporting": True,
        "time_tracking": True,
        "baselines": True,
        "monte_carlo": True,
    }


@pytest.mark.django_db
def test_surface_visibility_defaults_by_methodology_agile(
    agile_project: Project,
) -> None:
    """Agile default: reporting and time_tracking on; baselines and monte_carlo off."""
    from trueppm_api.apps.projects.surface_visibility import resolve_effective_visibility

    result = resolve_effective_visibility(agile_project)
    assert result == {
        "reporting": True,
        "time_tracking": True,
        "baselines": False,
        "monte_carlo": False,
    }


@pytest.mark.django_db
def test_explicit_override_beats_methodology_default(
    agile_project: Project,
) -> None:
    """An explicit show_baselines=True overrides the AGILE default of False."""
    from trueppm_api.apps.projects.surface_visibility import resolve_effective_visibility

    agile_project.show_baselines = True
    agile_project.save()

    result = resolve_effective_visibility(agile_project)
    assert result["baselines"] is True
    # The other AGILE-off surface is still off (no override for monte_carlo).
    assert result["monte_carlo"] is False


@pytest.mark.django_db
def test_null_falls_back_to_methodology_default(
    waterfall_project: Project,
) -> None:
    """show_reporting=None means inherit: waterfall default is True."""
    from trueppm_api.apps.projects.surface_visibility import resolve_effective_visibility

    # Explicit NULL — same as the default, but ensures the path is exercised.
    waterfall_project.show_reporting = None
    waterfall_project.save()

    result = resolve_effective_visibility(waterfall_project)
    assert result["reporting"] is True


# ---------------------------------------------------------------------------
# Serializer / API-level tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_effective_surface_visibility_in_serializer(
    waterfall_project: Project,
) -> None:
    """GET /api/v1/projects/{id}/ → effective_surface_visibility + inherited_surface_visibility."""
    client = _client_for(waterfall_project, Role.MEMBER, "sv_reader")
    resp = client.get(f"/api/v1/projects/{waterfall_project.pk}/")
    assert resp.status_code == 200
    eff = resp.data["effective_surface_visibility"]
    inh = resp.data["inherited_surface_visibility"]
    # Both dicts must be present and carry all four keys.
    for key in ("reporting", "time_tracking", "baselines", "monte_carlo"):
        assert key in eff, f"effective missing key: {key}"
        assert key in inh, f"inherited missing key: {key}"
    # Waterfall: all on.
    assert eff == {"reporting": True, "time_tracking": True, "baselines": True, "monte_carlo": True}
    assert inh == {"reporting": True, "time_tracking": True, "baselines": True, "monte_carlo": True}


@pytest.mark.django_db
def test_admin_can_set_surface_override(
    waterfall_project: Project,
) -> None:
    """PATCH show_reporting=False by an Admin succeeds (200) and persists."""
    client = _client_for(waterfall_project, Role.ADMIN, "sv_admin")
    resp = client.patch(
        f"/api/v1/projects/{waterfall_project.pk}/",
        {"show_reporting": False},
        format="json",
    )
    assert resp.status_code == 200
    waterfall_project.refresh_from_db()
    assert waterfall_project.show_reporting is False
    # The serializer should echo the new effective value.
    assert resp.data["effective_surface_visibility"]["reporting"] is False


@pytest.mark.django_db
def test_non_admin_cannot_set_surface_override(
    waterfall_project: Project,
) -> None:
    """Member-role PATCH show_reporting=False is rejected with 403 (permission gate)."""
    client = _client_for(waterfall_project, Role.MEMBER, "sv_member")
    resp = client.patch(
        f"/api/v1/projects/{waterfall_project.pk}/",
        {"show_reporting": False},
        format="json",
    )
    assert resp.status_code == 403
    waterfall_project.refresh_from_db()
    # Field must remain unchanged (None = inherit).
    assert waterfall_project.show_reporting is None
