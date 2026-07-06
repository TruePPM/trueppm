"""Composable working calendars — overlay multiple calendars as the CPM mask (#906).

Covers the OSS slice of ADR-0251:
- composition semantics reach the engine (an overlay holiday shifts CPM dates);
- the ``/projects/{id}/calendars/`` GET/PUT applied-calendars resource, its RBAC
  (Scheduler+ to apply, member to read) and validation;
- the effective-working-time preview with per-day source provenance;
- the recompute fan-out when a calendar edited as an *overlay* changes.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Project,
    ProjectCalendarLayer,
    Task,
)
from trueppm_api.apps.scheduling.models import ScheduleRequest

User = get_user_model()

# Monday, so a standard Mon-Fri calendar starts work immediately.
START = date(2026, 3, 2)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def base_calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard Mon-Fri")


@pytest.fixture
def holidays_calendar(db: object) -> Calendar:
    """A holidays calendar: all 7 days working (mask 127), contributes only a
    single-day exception on Wednesday 2026-03-04."""
    cal = Calendar.objects.create(name="US Holidays 2026", working_days=127)
    CalendarException.objects.create(
        calendar=cal, exc_start=date(2026, 3, 4), exc_end=date(2026, 3, 4), description="Holiday"
    )
    return cal


@pytest.fixture
def project(base_calendar: Calendar) -> Project:
    return Project.objects.create(name="Overlay Project", start_date=START, calendar=base_calendar)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def scheduler_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="sched_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    return _client(user)


@pytest.fixture
def member_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="member_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    return _client(user)


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/calendars/"


def _preview_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/calendars/preview/"


# ---------------------------------------------------------------------------
# Composition semantics reach the engine
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_overlay_holiday_shifts_cpm_finish(project: Project, holidays_calendar: Calendar) -> None:
    """A 5-day task finishes one day later once an OVERLAY holiday blocks Wednesday.

    The base project calendar has no exceptions, so Mon 2026-03-02 + 5 working days
    finishes Fri 2026-03-06. Applying the holidays calendar as an overlay — whose
    exception the base calendar does not carry — must push the finish to Mon
    2026-03-09, proving ``compose_project_calendar`` unions overlay exceptions into
    the CPM mask (not just the base calendar's own).
    """
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    task = Task.objects.create(project=project, name="Build", duration=5)
    ProjectCalendarLayer.objects.create(
        project=project, calendar=holidays_calendar, role="holidays", sort_order=0
    )

    _run_schedule(str(project.pk), tracker=None)

    task.refresh_from_db()
    assert task.early_finish == date(2026, 3, 9)


@pytest.mark.django_db
def test_compose_working_days_is_intersection(project: Project) -> None:
    """Composed working_days is the AND of applied masks (a day off in any is off)."""
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar

    part_time = Calendar.objects.create(name="Mon-Thu", working_days=0b0001111)  # Mon-Thu
    ProjectCalendarLayer.objects.create(
        project=project, calendar=part_time, role="workspace", sort_order=0
    )

    sched = compose_project_calendar(project)
    assert sched.is_working_day(date(2026, 3, 5))  # Thursday — working in both
    assert not sched.is_working_day(date(2026, 3, 6))  # Friday — dropped by part-time overlay


# ---------------------------------------------------------------------------
# GET /projects/{id}/calendars/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_applied_calendars_returns_base_and_ordered_overlays(
    project: Project, base_calendar: Calendar, holidays_calendar: Calendar, member_client: APIClient
) -> None:
    ProjectCalendarLayer.objects.create(
        project=project, calendar=holidays_calendar, role="holidays", sort_order=0
    )

    resp = member_client.get(_url(project))

    assert resp.status_code == 200
    body = resp.json()
    assert body["base"]["id"] == str(base_calendar.id)
    assert len(body["overlays"]) == 1
    assert body["overlays"][0]["role"] == "holidays"
    assert body["overlays"][0]["calendar"]["id"] == str(holidays_calendar.id)
    # applied = [base, ...overlays] in order; base first with role "project".
    assert [a["role"] for a in body["applied"]] == ["project", "holidays"]
    assert body["applied"][0]["layer_id"] is None


# ---------------------------------------------------------------------------
# PUT /projects/{id}/calendars/ — atomic replace + RBAC + validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_put_replaces_applied_set_and_enqueues_recompute(
    project: Project,
    base_calendar: Calendar,
    holidays_calendar: Calendar,
    scheduler_client: APIClient,
) -> None:
    shutdown = Calendar.objects.create(name="Winter Shutdown", working_days=127)

    resp = scheduler_client.put(
        _url(project),
        {
            "base_calendar_id": str(base_calendar.id),
            "overlays": [
                {"calendar_id": str(holidays_calendar.id), "role": "holidays"},
                {"calendar_id": str(shutdown.id), "role": "workspace"},
            ],
        },
        format="json",
    )

    assert resp.status_code == 200
    layers = list(ProjectCalendarLayer.objects.filter(project=project).order_by("sort_order"))
    assert [(str(layer.calendar_id), layer.role, layer.sort_order) for layer in layers] == [
        (str(holidays_calendar.id), "holidays", 0),
        (str(shutdown.id), "workspace", 1),
    ]
    # Applying calendars must fan out a CPM recompute (composed mask changed).
    assert ScheduleRequest.objects.filter(project=project).exists()


@pytest.mark.django_db(transaction=True)
def test_put_is_a_full_replace(
    project: Project,
    base_calendar: Calendar,
    holidays_calendar: Calendar,
    scheduler_client: APIClient,
) -> None:
    ProjectCalendarLayer.objects.create(
        project=project, calendar=holidays_calendar, role="holidays", sort_order=0
    )

    resp = scheduler_client.put(
        _url(project),
        {"base_calendar_id": str(base_calendar.id), "overlays": []},
        format="json",
    )

    assert resp.status_code == 200
    assert not ProjectCalendarLayer.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_put_requires_scheduler(
    project: Project, base_calendar: Calendar, member_client: APIClient
) -> None:
    resp = member_client.put(
        _url(project),
        {"base_calendar_id": str(base_calendar.id), "overlays": []},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_put_rejects_unknown_calendar(
    project: Project, base_calendar: Calendar, scheduler_client: APIClient
) -> None:
    resp = scheduler_client.put(
        _url(project),
        {
            "base_calendar_id": str(base_calendar.id),
            "overlays": [
                {"calendar_id": "00000000-0000-0000-0000-000000000000", "role": "holidays"}
            ],
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_put_rejects_duplicate_overlay(
    project: Project,
    base_calendar: Calendar,
    holidays_calendar: Calendar,
    scheduler_client: APIClient,
) -> None:
    resp = scheduler_client.put(
        _url(project),
        {
            "base_calendar_id": str(base_calendar.id),
            "overlays": [
                {"calendar_id": str(holidays_calendar.id), "role": "holidays"},
                {"calendar_id": str(holidays_calendar.id), "role": "workspace"},
            ],
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_put_rejects_base_as_overlay(
    project: Project, base_calendar: Calendar, scheduler_client: APIClient
) -> None:
    resp = scheduler_client.put(
        _url(project),
        {
            "base_calendar_id": str(base_calendar.id),
            "overlays": [{"calendar_id": str(base_calendar.id), "role": "holidays"}],
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_put_rejects_project_role_on_overlay(
    project: Project,
    base_calendar: Calendar,
    holidays_calendar: Calendar,
    scheduler_client: APIClient,
) -> None:
    """role="project" names the base FK and is not an assignable overlay role."""
    resp = scheduler_client.put(
        _url(project),
        {
            "base_calendar_id": str(base_calendar.id),
            "overlays": [{"calendar_id": str(holidays_calendar.id), "role": "project"}],
        },
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Preview provenance
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_preview_reports_non_working_days_with_source(
    project: Project, holidays_calendar: Calendar, member_client: APIClient
) -> None:
    ProjectCalendarLayer.objects.create(
        project=project, calendar=holidays_calendar, role="holidays", sort_order=0
    )

    resp = member_client.get(_preview_url(project), {"start": "2026-03-02", "end": "2026-03-06"})

    assert resp.status_code == 200
    by_date = {d["date"]: d for d in resp.json()["days"]}
    # Wednesday is blocked by the holidays overlay, attributed to it.
    wed = by_date["2026-03-04"]
    assert wed["working"] is False
    assert wed["sources"][0]["role"] == "holidays"
    assert wed["sources"][0]["name"] == "US Holidays 2026"
    # A normal weekday is working with no blocking source.
    assert by_date["2026-03-05"]["working"] is True
    assert by_date["2026-03-05"]["sources"] == []


@pytest.mark.django_db
def test_preview_requires_window_params(project: Project, member_client: APIClient) -> None:
    assert member_client.get(_preview_url(project)).status_code == 400


@pytest.mark.django_db
def test_preview_caps_window(project: Project, member_client: APIClient) -> None:
    resp = member_client.get(_preview_url(project), {"start": "2026-01-01", "end": "2027-12-31"})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Recompute fan-out includes overlay usage
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_overlay_calendar_edit_recomputes_using_project(
    project: Project, holidays_calendar: Calendar
) -> None:
    """Editing a calendar used only as an OVERLAY must recompute the project (#906).

    Before this fix ``_recalc_projects_for_calendar`` fanned out by base FK only,
    so an overlay-calendar mask edit silently skipped the CPM recompute for every
    project that applied it as an overlay.
    """
    ProjectCalendarLayer.objects.create(
        project=project, calendar=holidays_calendar, role="holidays", sort_order=0
    )
    admin = User.objects.create_user(username="orgadmin", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ScheduleRequest.objects.filter(project=project).delete()

    resp = _client(admin).patch(
        f"/api/v1/calendars/{holidays_calendar.id}/", {"working_days": 15}, format="json"
    )

    assert resp.status_code == 200
    assert ScheduleRequest.objects.filter(project=project).exists()
