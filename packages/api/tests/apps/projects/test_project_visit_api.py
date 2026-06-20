"""Tests for POST /projects/:id/visit/ — last-visited recording (ADR-0150, #1182).

Covers: any-member (Viewer+) can record, write coalescing (200 no-op, never 429),
archived projects still record, non-members are rejected, and a visit is scoped to
request.user (no IDOR / cross-user write).

``claim_visit_window`` is monkeypatched per test so the coalesce branch is
deterministic without depending on a live Redis in the test environment.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.profiles.models import ProjectVisit
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


@pytest.fixture(autouse=True)
def _always_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default: the coalesce window is always open (record every ping).

    Individual tests override this to exercise the coalesced no-op branch.
    """
    monkeypatch.setattr(
        "trueppm_api.apps.projects.throttles.claim_visit_window",
        lambda *_args, **_kwargs: True,
    )


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def _project(calendar: Calendar, name: str = "Apollo", *, archived: bool = False) -> Project:
    return Project.objects.create(
        name=name, start_date=date(2026, 4, 1), calendar=calendar, is_archived=archived
    )


def _member(project: Project, role: int, username: str) -> object:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_member_records_visit(calendar: Calendar) -> None:
    proj = _project(calendar)
    user = _member(proj, Role.MEMBER, "mira")

    resp = _client(user).post(f"/api/v1/projects/{proj.pk}/visit/")

    assert resp.status_code == 200
    assert resp.json() == {"recorded": True}
    assert ProjectVisit.objects.filter(user=user, project=proj).count() == 1


@pytest.mark.django_db
def test_viewer_can_record_visit(calendar: Calendar) -> None:
    """A Viewer landing on a project they belong to is a real visit (ADR-0150 D4)."""
    proj = _project(calendar)
    viewer = _member(proj, Role.VIEWER, "vera")

    resp = _client(viewer).post(f"/api/v1/projects/{proj.pk}/visit/")

    assert resp.status_code == 200
    assert ProjectVisit.objects.filter(user=viewer, project=proj).exists()


@pytest.mark.django_db
def test_archived_project_still_records(calendar: Calendar) -> None:
    """The visit action skips IsProjectNotArchived — an archived visit still counts."""
    proj = _project(calendar, archived=True)
    user = _member(proj, Role.ADMIN, "arnav")

    resp = _client(user).post(f"/api/v1/projects/{proj.pk}/visit/")

    assert resp.status_code == 200
    assert ProjectVisit.objects.filter(user=user, project=proj).exists()


@pytest.mark.django_db
def test_coalesced_ping_is_a_200_no_op_not_429(
    calendar: Calendar, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A throttle-coalesced ping returns 200 {recorded: false}, never 429."""
    proj = _project(calendar)
    user = _member(proj, Role.MEMBER, "carl")
    monkeypatch.setattr(
        "trueppm_api.apps.projects.throttles.claim_visit_window",
        lambda *_a, **_k: False,
    )

    resp = _client(user).post(f"/api/v1/projects/{proj.pk}/visit/")

    assert resp.status_code == 200
    assert resp.json() == {"recorded": False}
    assert not ProjectVisit.objects.filter(user=user, project=proj).exists()


@pytest.mark.django_db
def test_non_member_cannot_record_visit(calendar: Calendar) -> None:
    proj = _project(calendar)
    _member(proj, Role.OWNER, "owner")
    stranger = User.objects.create_user(username="stranger", password="pw")

    resp = _client(stranger).post(f"/api/v1/projects/{proj.pk}/visit/")

    assert resp.status_code in (403, 404)
    assert not ProjectVisit.objects.filter(user=stranger).exists()


@pytest.mark.django_db
def test_unauthenticated_is_rejected(calendar: Calendar) -> None:
    proj = _project(calendar)
    resp = APIClient().post(f"/api/v1/projects/{proj.pk}/visit/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_visit_records_for_request_user_only(calendar: Calendar) -> None:
    """The upsert is scoped to request.user — no cross-user write (IDOR safety)."""
    proj = _project(calendar)
    actor = _member(proj, Role.MEMBER, "actor")
    other = _member(proj, Role.MEMBER, "other")

    _client(actor).post(f"/api/v1/projects/{proj.pk}/visit/")

    assert ProjectVisit.objects.filter(user=actor, project=proj).exists()
    assert not ProjectVisit.objects.filter(user=other).exists()


@pytest.mark.django_db
def test_repeat_visits_upsert_single_row(calendar: Calendar) -> None:
    """Two recorded pings keep one row (the unique constraint holds)."""
    proj = _project(calendar)
    user = _member(proj, Role.MEMBER, "rip")
    client = _client(user)

    client.post(f"/api/v1/projects/{proj.pk}/visit/")
    client.post(f"/api/v1/projects/{proj.pk}/visit/")

    assert ProjectVisit.objects.filter(user=user, project=proj).count() == 1
