"""Tests for the configurable iteration-container label (ADR-0111, #862).

``Project.iteration_label`` is a display-only noun ("Sprint" default, or
"Iteration" / "PI" / a custom string). It is admin-gated for write by the
allowlist default in ``ProjectSerializer`` (it is NOT in
``_SCHEDULER_WRITABLE_FIELDS``), validated non-empty after trim, and exposed on
the project payload for read.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="LabelProj", start_date=date(2026, 3, 1), calendar=calendar)


def _client_for(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.mark.django_db
def test_default_override_is_null_effective_is_sprint(project: Project) -> None:
    """New projects default to NULL (inherit); the effective label resolves to
    "Sprint" via the workspace default (#1106) — zero visible behavior change."""
    from trueppm_api.apps.projects.iteration_label import resolve_effective_iteration_label

    assert project.iteration_label is None
    assert resolve_effective_iteration_label(project) == "Sprint"


@pytest.mark.django_db
def test_label_is_serialized_on_payload(project: Project) -> None:
    client = _client_for(project, Role.MEMBER, "u_member")
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["iteration_label"] is None
    assert resp.data["effective_iteration_label"] == "Sprint"


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.ADMIN, Role.OWNER])
def test_admin_can_set_label(project: Project, role: int) -> None:
    client = _client_for(project, role, f"u_{int(role)}")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"iteration_label": "Iteration"},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.iteration_label == "Iteration"


@pytest.mark.django_db
def test_scheduler_cannot_set_label(project: Project) -> None:
    """The label is a general PM setting — a Scheduler is rejected (400), not silently dropped.

    It is deliberately NOT in ``_SCHEDULER_WRITABLE_FIELDS``; the allowlist default
    makes every new writable field admin-only until explicitly added there.
    """
    client = _client_for(project, Role.SCHEDULER, "u_sched")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"iteration_label": "Iteration"},
        format="json",
    )
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.iteration_label is None


@pytest.mark.django_db
def test_scheduler_mixed_patch_rejected_atomically(project: Project) -> None:
    """A Scheduler patching an allowed field + iteration_label is rejected whole.

    The allowlist check inspects every changed field before deciding, so a mixed
    PATCH must not partially apply the allowed field — guards against smuggling the
    admin-only label past the gate alongside ``methodology``.
    """
    client = _client_for(project, Role.SCHEDULER, "u_sched_mix")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"methodology": "WATERFALL", "iteration_label": "PI"},
        format="json",
    )
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.iteration_label is None
    # The allowed field must NOT have been partially applied either.
    assert project.methodology != "WATERFALL"


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_below_scheduler_blocked_at_gate(project: Project, role: int) -> None:
    """Viewer/Member never reach the serializer — blocked at the permission gate (403)."""
    client = _client_for(project, role, f"u_{int(role)}")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"iteration_label": "Iteration"},
        format="json",
    )
    assert resp.status_code == 403
    project.refresh_from_db()
    assert project.iteration_label is None


@pytest.mark.django_db
@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_label_rejected(project: Project, blank: str) -> None:
    """An empty/whitespace label would erase the word everywhere — reject with 400."""
    client = _client_for(project, Role.ADMIN, "u_admin")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"iteration_label": blank},
        format="json",
    )
    assert resp.status_code == 400
    assert "iteration_label" in resp.data
    project.refresh_from_db()
    assert project.iteration_label is None


@pytest.mark.django_db
def test_label_is_stripped(project: Project) -> None:
    client = _client_for(project, Role.ADMIN, "u_admin")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"iteration_label": "  Cycle  "},
        format="json",
    )
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.iteration_label == "Cycle"


@pytest.mark.django_db
def test_label_too_long_rejected(project: Project) -> None:
    """``max_length=32`` guards UI layout — over-long labels are a 400, not truncation."""
    client = _client_for(project, Role.ADMIN, "u_admin")
    resp = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"iteration_label": "X" * 33},
        format="json",
    )
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.iteration_label is None
