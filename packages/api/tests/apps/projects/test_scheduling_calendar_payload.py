"""``ProjectDetailSerializer.scheduling_calendar`` — the drag preview's calendar (#4170).

The Schedule's drag/resize/keyboard preview recomputes dates in the browser
(ADR-0599's preview carve-out). It needs the calendar the server actually
schedules with — the ``compose_project_calendar`` overlay of base + layers, with
inheritance resolved — not the raw rows and not just ``effective_calendar``'s
base mask and holiday count. Covers:

- payload content: the AND-ed mask and the union of every applied calendar's
  exceptions, exactly matching what the engine composes;
- inheritance (a program-tier base reaches the payload);
- RBAC: Viewer reads it, a non-member cannot, anonymous is refused;
- query count: more layers and more exceptions add no per-row query.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Program,
    Project,
    ProjectCalendarLayer,
)
from trueppm_api.apps.scheduling.calendars import compose_project_calendar

User = get_user_model()

START = date(2026, 3, 2)  # a Monday


def _exc(cal: Calendar, start: date, end: date) -> None:
    CalendarException.objects.create(calendar=cal, exc_start=start, exc_end=end)


def _client_for(project: Project, role: str, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/"


@pytest.fixture
def layered_project(db: object) -> Project:
    """Mon-Sat base with a one-day holiday, plus a Mon-Fri holidays overlay whose
    range overlaps the base's and repeats one of its own rows."""
    base = Calendar.objects.create(name="Six-day", working_days=0b0111111)
    _exc(base, date(2026, 3, 4), date(2026, 3, 4))
    overlay = Calendar.objects.create(name="Holidays", working_days=0b0011111)
    _exc(overlay, date(2026, 3, 4), date(2026, 3, 6))
    _exc(overlay, date(2026, 4, 3), date(2026, 4, 3))
    # An exact duplicate of a row the base already carries.
    _exc(overlay, date(2026, 3, 4), date(2026, 3, 4))
    project = Project.objects.create(name="P", start_date=START, status_date=START, calendar=base)
    ProjectCalendarLayer.objects.create(
        project=project, calendar=overlay, role="holidays", sort_order=0
    )
    return project


@pytest.mark.django_db
def test_payload_is_the_composed_calendar(layered_project: Project) -> None:
    """Mask is the AND of every applied mask; exceptions are their union.

    Sorted, exact duplicates dropped, overlaps left for the reader to coalesce —
    dropping a duplicate pair changes no day's working status, and coalescing is
    the engine's private lookup index, not a fact the payload has to carry.
    """
    client = _client_for(layered_project, Role.VIEWER, "viewer")
    resp = client.get(_url(layered_project))
    assert resp.status_code == 200
    assert resp.data["scheduling_calendar"] == {
        "working_days": 0b0011111,
        "exceptions": [
            {"start": "2026-03-04", "end": "2026-03-04"},
            {"start": "2026-03-04", "end": "2026-03-06"},
            {"start": "2026-04-03", "end": "2026-04-03"},
        ],
    }


@pytest.mark.django_db
def test_payload_agrees_with_the_engine_on_every_day(layered_project: Project) -> None:
    """The payload is not a second implementation: rebuilt into a scheduler
    ``Calendar``, it answers ``is_working_day`` exactly as the composed one does."""
    from datetime import timedelta

    from trueppm_scheduler.models import Calendar as SchedCalendar

    client = _client_for(layered_project, Role.VIEWER, "viewer2")
    payload = client.get(_url(layered_project)).data["scheduling_calendar"]
    rebuilt = SchedCalendar.from_dict(
        {"working_days": payload["working_days"], "exceptions": payload["exceptions"]}
    )
    project = (
        Project.objects.select_related("calendar", "program__calendar")
        .prefetch_related("calendar__exceptions", "calendar_layers__calendar__exceptions")
        .get(pk=layered_project.pk)
    )
    engine = compose_project_calendar(project)
    for offset in range(0, 60):
        d = START + timedelta(days=offset)
        assert rebuilt.is_working_day(d) == engine.is_working_day(d), d


@pytest.mark.django_db
def test_payload_resolves_an_inherited_program_calendar(db: object) -> None:
    """A project with no calendar of its own previews on its program's (ADR-0441)."""
    program_cal = Calendar.objects.create(name="Program", working_days=0b1111111)
    _exc(program_cal, date(2026, 12, 24), date(2026, 12, 26))
    program = Program.objects.create(name="Prog", calendar=program_cal)
    project = Project.objects.create(
        name="Inherits", start_date=START, status_date=START, program=program
    )
    client = _client_for(project, Role.VIEWER, "viewer3")
    resp = client.get(_url(project))
    assert resp.status_code == 200
    assert resp.data["scheduling_calendar"] == {
        "working_days": 0b1111111,
        "exceptions": [{"start": "2026-12-24", "end": "2026-12-26"}],
    }


@pytest.mark.django_db
def test_payload_defaults_to_mon_fri_without_any_calendar(db: object) -> None:
    project = Project.objects.create(name="Plain", start_date=START, status_date=START)
    client = _client_for(project, Role.VIEWER, "viewer4")
    resp = client.get(_url(project))
    assert resp.data["scheduling_calendar"] == {"working_days": 0b0011111, "exceptions": []}


@pytest.mark.django_db
def test_payload_is_detail_only(layered_project: Project) -> None:
    """The project list must not inline every exception on every row."""
    client = _client_for(layered_project, Role.VIEWER, "viewer5")
    resp = client.get("/api/v1/projects/")
    assert resp.status_code == 200
    assert "scheduling_calendar" not in resp.data["results"][0]


@pytest.mark.django_db
def test_non_member_cannot_read_another_projects_calendar(layered_project: Project) -> None:
    """Calendar dates are scoped by project membership like the rest of the detail."""
    other = Project.objects.create(name="Mine", start_date=START, status_date=START)
    client = _client_for(other, Role.OWNER, "outsider")
    resp = client.get(_url(layered_project))
    assert resp.status_code == 404
    assert "scheduling_calendar" not in resp.data


@pytest.mark.django_db
def test_anonymous_is_refused(layered_project: Project) -> None:
    resp = APIClient().get(_url(layered_project))
    assert resp.status_code == 401


@pytest.mark.django_db
def test_more_layers_and_exceptions_add_no_queries(db: object) -> None:
    """Layers and exceptions are prefetched on retrieve: the count is flat."""
    base = Calendar.objects.create(name="Base")
    _exc(base, date(2026, 3, 4), date(2026, 3, 4))
    project = Project.objects.create(name="Q", start_date=START, status_date=START, calendar=base)
    client = _client_for(project, Role.VIEWER, "viewer6")
    one_layer = Calendar.objects.create(name="L0")
    _exc(one_layer, date(2026, 5, 1), date(2026, 5, 1))
    ProjectCalendarLayer.objects.create(
        project=project, calendar=one_layer, role="holidays", sort_order=0
    )
    client.get(_url(project))  # warm any per-process caches
    with CaptureQueriesContext(connection) as few:
        resp = client.get(_url(project))
    assert resp.status_code == 200
    assert len(resp.data["scheduling_calendar"]["exceptions"]) == 2

    for i in range(1, 4):
        cal = Calendar.objects.create(name=f"L{i}")
        for day in range(1, 6):
            _exc(cal, date(2026, 6 + i, day), date(2026, 6 + i, day))
        ProjectCalendarLayer.objects.create(
            project=project, calendar=cal, role="holidays", sort_order=i
        )
    for day in range(10, 20):
        _exc(base, date(2026, 3, day), date(2026, 3, day))
    with CaptureQueriesContext(connection) as many:
        resp = client.get(_url(project))
    assert resp.status_code == 200
    assert len(resp.data["scheduling_calendar"]["exceptions"]) == 2 + 15 + 10
    assert len(many.captured_queries) == len(few.captured_queries)


@pytest.mark.django_db
def test_an_inverted_exception_row_is_skipped_not_a_500(
    layered_project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    """One malformed row (end before start) — from an admin script or a seed — must
    not take down the project shell of every project on that calendar. It is left
    out of the payload, logged, and the rest of the calendar still arrives."""
    import logging

    base = layered_project.calendar
    assert base is not None
    _exc(base, date(2026, 5, 10), date(2026, 5, 1))  # inverted
    client = _client_for(layered_project, Role.VIEWER, "viewer_bad_row")
    with caplog.at_level(logging.WARNING):
        resp = client.get(_url(layered_project))
    assert resp.status_code == 200
    ranges = resp.data["scheduling_calendar"]["exceptions"]
    assert {"start": "2026-05-10", "end": "2026-05-01"} not in ranges
    assert {"start": "2026-03-04", "end": "2026-03-06"} in ranges
    assert any("malformed exception" in r.getMessage() for r in caplog.records)


@pytest.mark.django_db
def test_cpm_still_refuses_an_inverted_exception_row(layered_project: Project) -> None:
    """Only the display path skips; scheduling keeps failing loudly on the same row."""
    base = layered_project.calendar
    assert base is not None
    _exc(base, date(2026, 5, 10), date(2026, 5, 1))
    project = (
        Project.objects.select_related("calendar", "program__calendar")
        .prefetch_related("calendar__exceptions", "calendar_layers__calendar__exceptions")
        .get(pk=layered_project.pk)
    )
    with pytest.raises(ValueError):
        compose_project_calendar(project)
