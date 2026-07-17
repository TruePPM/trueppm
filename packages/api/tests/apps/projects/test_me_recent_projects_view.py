"""Tests for the Recent-projects surface (ADR-0508, issue #1557).

``GET /api/v1/me/recent-projects/`` returns the authenticated user's most
recently *visited* projects (from ``ProjectVisit`` telemetry, ADR-0150),
newest-first, as a fixed navigation strip for the ⌘K "Recent" group.

The endpoint MUST be hard-scoped to ``request.user``'s own visit rows AND
re-joined to live membership — a project the user was removed from, or that
was archived/deleted, must never surface from a stale visit row (the IDOR
guard). Default 5, hard max 10 via ``?limit``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.profiles.models import ProjectVisit
from trueppm_api.apps.projects.models import Calendar, Program, Project

User = get_user_model()

URL = "/api/v1/me/recent-projects/"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _project(calendar: Calendar, name: str, program: Program | None = None) -> Project:
    return Project.objects.create(
        name=name, start_date=date(2026, 4, 1), calendar=calendar, program=program
    )


def _member(project: Project, user: object, role: int = Role.MEMBER) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _visit(user: object, project: Project, when: datetime) -> ProjectVisit:
    return ProjectVisit.objects.create(user=user, project=project, visited_at=when)


def _at(day: int, hour: int = 12) -> datetime:
    return datetime(2026, 5, day, hour, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_requires_authentication(db: object) -> None:
    resp = APIClient().get(URL)
    assert resp.status_code in (401, 403)


def test_returns_visited_projects_newest_first(calendar: Calendar, alice: object) -> None:
    prog = Program.objects.create(name="Platform", code="PLT")
    p_old = _project(calendar, "Old", program=prog)
    p_mid = _project(calendar, "Mid", program=prog)
    p_new = _project(calendar, "New", program=prog)
    for p in (p_old, p_mid, p_new):
        _member(p, alice)
    _visit(alice, p_old, _at(1))
    _visit(alice, p_mid, _at(2))
    _visit(alice, p_new, _at(3))

    resp = _client(alice).get(URL)

    assert resp.status_code == 200
    names = [row["name"] for row in resp.data]
    assert names == ["New", "Mid", "Old"]  # newest-first
    top = resp.data[0]
    assert top["id"] == str(p_new.id)
    assert top["program_id"] == str(prog.id)
    assert top["program_name"] == "Platform"
    assert "visited_at" in top


def test_null_program_serializes_cleanly(calendar: Calendar, alice: object) -> None:
    solo = _project(calendar, "Solo", program=None)
    _member(solo, alice)
    _visit(alice, solo, _at(1))

    resp = _client(alice).get(URL)

    assert resp.status_code == 200
    assert resp.data[0]["program_id"] is None
    assert resp.data[0]["program_name"] is None


def test_excludes_revoked_membership(calendar: Calendar, alice: object) -> None:
    """A stale visit to a project the user was removed from must not leak (IDOR)."""
    lost = _project(calendar, "Lost")
    membership = _member(lost, alice)
    _visit(alice, lost, _at(5))
    # Membership revoked since the visit was recorded.
    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    resp = _client(alice).get(URL)

    assert resp.status_code == 200
    assert resp.data == []


def test_excludes_archived_and_deleted_projects(calendar: Calendar, alice: object) -> None:
    archived = _project(calendar, "Archived")
    deleted = _project(calendar, "Deleted")
    for p in (archived, deleted):
        _member(p, alice)
    _visit(alice, archived, _at(4))
    _visit(alice, deleted, _at(5))
    archived.is_archived = True
    archived.save(update_fields=["is_archived"])
    deleted.is_deleted = True
    deleted.save(update_fields=["is_deleted"])

    resp = _client(alice).get(URL)

    assert resp.status_code == 200
    assert resp.data == []


def test_does_not_leak_other_users_visits(calendar: Calendar, alice: object, bob: object) -> None:
    shared = _project(calendar, "Shared")
    _member(shared, alice)
    _member(shared, bob)
    _visit(bob, shared, _at(9))  # bob visited; alice did not

    resp = _client(alice).get(URL)

    assert resp.status_code == 200
    assert resp.data == []  # alice sees only her own visits


def _seed_many(calendar: Calendar, user: object, count: int) -> None:
    for i in range(count):
        p = _project(calendar, f"P{i:02d}")
        _member(p, user)
        _visit(user, p, _at(1, hour=i))


def test_limit_defaults_to_five(calendar: Calendar, alice: object) -> None:
    _seed_many(calendar, alice, 12)
    resp = _client(alice).get(URL)
    assert resp.status_code == 200
    assert len(resp.data) == 5


def test_limit_honored_and_capped_at_ten(calendar: Calendar, alice: object) -> None:
    _seed_many(calendar, alice, 12)
    assert len(_client(alice).get(f"{URL}?limit=3").data) == 3
    assert len(_client(alice).get(f"{URL}?limit=10").data) == 10
    # Over the hard max clamps to 10, never dumps the whole history.
    assert len(_client(alice).get(f"{URL}?limit=50").data) == 10


def test_invalid_limit_falls_back_to_default(calendar: Calendar, alice: object) -> None:
    _seed_many(calendar, alice, 8)
    assert len(_client(alice).get(f"{URL}?limit=abc").data) == 5
