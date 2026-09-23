"""The shared calendar library's write gate, and the 409 body's disclosure (#3600).

Calendars are workspace-global: ``working_days`` and ``hours_per_day`` are CPM inputs,
so one PATCH fans a recompute — and a ``project_calendar_changed`` broadcast — across
every project bound to the calendar, the workspace default covering every project with
no override of its own. Until #3600 that write was gated on ``IsOrgAdmin``, which is
*self-grantable*: nothing gates ``POST /api/v1/projects/`` and ``perform_create`` makes
the caller ``Role.OWNER``, so three requests from a fresh account rewrote the plan of
record installation-wide. #3174 met the same reach and shipped the attribution half (a
``CALENDAR_CHANGED`` audit row, pinned in ``test_calendar_change_attribution.py``); this
is the permission half it left open.

Two properties are asserted here, and they are different claims:

1. **The gate is a stored role, not a derived one.** A project Owner — the strongest
   project role there is, and one anybody can mint — is refused; a
   ``WorkspaceRole.ADMIN`` membership passes. Reads are deliberately untouched: a member
   has to be able to see which calendar schedules their plan.
2. **The 409 refusal is not a project-name oracle.** ``DELETE /calendars/{id}/`` names
   what still references the calendar so the caller can detach it, and a workspace ADMIN
   is *not* membership — ``ProjectViewSet``/``ProgramViewSet`` scope their querysets to
   the caller's own memberships with no workspace-role bypass. Blockers the caller
   cannot see are reported by type and id with no ``name``, while ``reference_count``
   still counts all of them.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Program,
    Project,
)

User = get_user_model()

MONDAY = date(2026, 6, 1)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Corporate", working_days=31, hours_per_day=8.0)


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project_owner(db: object, calendar: Calendar) -> Any:
    """A fresh account holding ``Role.OWNER`` — the self-grantable principal.

    This is exactly what ``POST /api/v1/projects/`` mints for any authenticated caller,
    so it stands in for "any account at all" rather than for a trusted one.
    """
    user = User.objects.create_user(username="fresh_owner", password="pw")
    own = Project.objects.create(name="Their own", start_date=MONDAY, calendar=calendar)
    ProjectMembership.objects.create(project=own, user=user, role=Role.OWNER)
    return user


@pytest.fixture
def workspace_admin(db: object, grant_workspace_admin: Any) -> Any:
    return grant_workspace_admin(User.objects.create_user(username="ws_admin", password="pw"))


# ---------------------------------------------------------------------------
# 1. The write gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_owner_cannot_patch_a_shared_calendar(
    project_owner: Any, calendar: Calendar
) -> None:
    """Owner on a project they created is not authority over the workspace's calendars."""
    resp = _client(project_owner).patch(
        f"/api/v1/calendars/{calendar.pk}/", {"working_days": 127}, format="json"
    )

    assert resp.status_code == status.HTTP_403_FORBIDDEN
    calendar.refresh_from_db()
    assert calendar.working_days == 31


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("method", "payload"),
    [
        ("post", {"name": "New", "working_days": 31}),
        ("put", {"name": "Replaced", "working_days": 31, "hours_per_day": 8.0}),
        ("delete", None),
    ],
)
def test_project_owner_is_refused_on_every_unsafe_calendar_method(
    project_owner: Any, calendar: Calendar, method: str, payload: dict[str, Any] | None
) -> None:
    """Not just PATCH — ``get_permissions`` branches on safe/unsafe, so pin the branch."""
    client = _client(project_owner)
    url = "/api/v1/calendars/" if method == "post" else f"/api/v1/calendars/{calendar.pk}/"
    call = getattr(client, method)
    resp = call(url, payload, format="json") if payload is not None else call(url)

    assert resp.status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.django_db
def test_project_owner_cannot_write_a_calendar_exception(
    project_owner: Any, calendar: Calendar
) -> None:
    """One holiday is the same blast radius as a ``working_days`` edit — same gate."""
    resp = _client(project_owner).post(
        f"/api/v1/calendars/{calendar.pk}/exceptions/",
        {"exc_start": "2026-07-04", "exc_end": "2026-07-04", "name": "Holiday"},
        format="json",
    )

    assert resp.status_code == status.HTTP_403_FORBIDDEN
    assert not CalendarException.objects.filter(calendar=calendar).exists()


@pytest.mark.django_db
def test_project_owner_cannot_delete_a_calendar_exception(
    project_owner: Any, calendar: Calendar
) -> None:
    exc = CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 7, 4), exc_end=date(2026, 7, 4)
    )

    resp = _client(project_owner).delete(f"/api/v1/calendars/{calendar.pk}/exceptions/{exc.pk}/")

    assert resp.status_code == status.HTTP_403_FORBIDDEN
    assert CalendarException.objects.filter(pk=exc.pk).exists()


@pytest.mark.django_db
def test_a_stored_workspace_admin_may_patch_a_shared_calendar(
    workspace_admin: Any, calendar: Calendar
) -> None:
    """The negative tests above are only meaningful if *somebody* still gets in."""
    resp = _client(workspace_admin).patch(
        f"/api/v1/calendars/{calendar.pk}/", {"working_days": 127}, format="json"
    )

    assert resp.status_code == status.HTTP_200_OK
    calendar.refresh_from_db()
    assert calendar.working_days == 127


@pytest.mark.django_db
def test_a_stored_workspace_admin_may_write_a_calendar_exception(
    workspace_admin: Any, calendar: Calendar
) -> None:
    resp = _client(workspace_admin).post(
        f"/api/v1/calendars/{calendar.pk}/exceptions/",
        {"exc_start": "2026-07-04", "exc_end": "2026-07-04", "name": "Holiday"},
        format="json",
    )

    assert resp.status_code == status.HTTP_201_CREATED
    assert CalendarException.objects.filter(calendar=calendar).count() == 1


@pytest.mark.django_db
def test_reads_stay_open_to_any_authenticated_user(project_owner: Any, calendar: Calendar) -> None:
    """#3600 raised the write gate only. A member must still see their own schedule's
    calendar, so ``GET`` remains authentication-only on both viewsets."""
    client = _client(project_owner)

    assert client.get("/api/v1/calendars/").status_code == status.HTTP_200_OK
    assert client.get(f"/api/v1/calendars/{calendar.pk}/").status_code == status.HTTP_200_OK
    assert (
        client.get(f"/api/v1/calendars/{calendar.pk}/exceptions/").status_code == status.HTTP_200_OK
    )


# ---------------------------------------------------------------------------
# 2. The 409 body is not a project-name oracle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_409_names_only_the_blockers_the_caller_can_see(
    workspace_admin: Any, calendar: Calendar
) -> None:
    """A workspace ADMIN is a stronger principal than ``IsOrgAdmin`` — still not membership.

    Two projects and a program block the delete; the caller is a member of one project
    and no program. The visible project is named, the other two are reported by type and
    id only, and ``reference_count`` counts all three — a caller who can act on one
    blocker is not told how to enumerate the rest.
    """
    mine = Project.objects.create(name="Mine", start_date=MONDAY, calendar=calendar)
    ProjectMembership.objects.create(project=mine, user=workspace_admin, role=Role.MEMBER)
    theirs = Project.objects.create(
        name="Confidential merger", start_date=MONDAY, calendar=calendar
    )
    their_program = Program.objects.create(name="Project Fenix", calendar=calendar)

    resp = _client(workspace_admin).delete(f"/api/v1/calendars/{calendar.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    body = resp.json()
    assert body["reference_count"] == 3
    by_id = {entry["id"]: entry for entry in body["references"]}
    assert by_id[str(mine.pk)] == {"type": "project", "id": str(mine.pk), "name": "Mine"}
    assert by_id[str(theirs.pk)] == {"type": "project", "id": str(theirs.pk)}
    assert by_id[str(their_program.pk)] == {"type": "program", "id": str(their_program.pk)}
    # The names are the disclosure; assert on the serialized body, not just the dicts.
    assert "Confidential merger" not in resp.content.decode()
    assert "Project Fenix" not in resp.content.decode()


@pytest.mark.django_db
def test_409_names_a_program_the_caller_is_a_member_of(
    workspace_admin: Any, calendar: Calendar
) -> None:
    """The filter is membership, not a blanket redaction of programs."""
    program = Program.objects.create(name="Atlas", calendar=calendar)
    ProgramMembership.objects.create(program=program, user=workspace_admin, role=Role.MEMBER)

    resp = _client(workspace_admin).delete(f"/api/v1/calendars/{calendar.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.json()["references"] == [
        {"type": "program", "id": str(program.pk), "name": "Atlas"}
    ]


@pytest.mark.django_db
def test_409_withholds_the_name_of_an_overlay_only_project(
    workspace_admin: Any, calendar: Calendar
) -> None:
    """The overlay join row reports its *project*, and that name is filtered too.

    ``ProjectCalendarLayer`` is the one blocker the describer rewrites into a different
    model's id, so it is the one most likely to keep an unfiltered name after a partial
    fix.
    """
    from trueppm_api.apps.projects.models import CalendarRole, ProjectCalendarLayer

    base = Calendar.objects.create(name="Base")
    theirs = Project.objects.create(name="Confidential merger", start_date=MONDAY, calendar=base)
    ProjectCalendarLayer.objects.create(
        project=theirs, calendar=calendar, role=CalendarRole.HOLIDAYS, sort_order=0
    )

    resp = _client(workspace_admin).delete(f"/api/v1/calendars/{calendar.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.json()["references"] == [{"type": "project", "id": str(theirs.pk)}]
    assert "Confidential merger" not in resp.content.decode()
