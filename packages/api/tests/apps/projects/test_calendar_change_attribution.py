"""Attribution for shared-calendar edits that reschedule other people's projects (#3174).

``IsOrgAdmin`` passes anyone holding ADMIN on *at least one* project, and a Calendar is
an org-global resource. So a PM on one small project can add a single holiday and shift
finish dates on every project bound to that calendar — including projects they are not a
member of, whose owners previously saw dates move with nothing naming who did it.

Whether that permission boundary is right is a separate, open question (see the issue).
These tests pin the attribution half: one ``CALENDAR_CHANGED`` audit row per edit naming
the actor and the affected set, and an actor label on the live broadcast.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.workspace.models import AuditEvent, AuditEventType

User = get_user_model()

MONDAY = date(2026, 6, 1)

BROADCAST = "trueppm_api.apps.sync.broadcast.broadcast_board_event"


@pytest.fixture
def shared_calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Corporate", working_days=31, hours_per_day=8.0)


@pytest.fixture
def outsider_project(shared_calendar: Calendar) -> Project:
    """A project bound to the shared calendar that the actor is NOT a member of."""
    return Project.objects.create(
        name="Someone else's", start_date=MONDAY, calendar=shared_calendar
    )


@pytest.fixture
def actor(db: object, shared_calendar: Calendar) -> Any:
    """A PM on one unrelated project — the minimum IsOrgAdmin accepts."""
    user = User.objects.create_user(username="pm", email="pm@example.com", password="pw")
    own = Project.objects.create(name="Their own", start_date=MONDAY, calendar=shared_calendar)
    ProjectMembership.objects.create(project=own, user=user, role=Role.ADMIN)
    return user


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_holiday_on_a_shared_calendar_writes_one_attributed_audit_row(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    with patch(BROADCAST):
        resp = _client(actor).post(
            f"/api/v1/calendars/{shared_calendar.pk}/exceptions/",
            {"exc_start": "2026-07-04", "exc_end": "2026-07-04", "name": "Holiday"},
            format="json",
        )
    assert resp.status_code == 201

    (row,) = AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED)
    assert row.actor_id == actor.pk
    assert row.actor_label
    assert row.target_label == "Corporate"
    # The blast radius is the point of the record: a project the actor is not a member
    # of is in the affected set, and the count says how wide it went.
    assert str(outsider_project.pk) in row.metadata["affected_project_ids"]
    assert row.metadata["affected_project_count"] >= 2


@pytest.mark.django_db(transaction=True)
def test_the_broadcast_names_the_actor(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    """An owner watching a project they DID nothing to should see a name, not just movement.

    ``transaction=True`` because the broadcast is deferred to ``transaction.on_commit``,
    which never runs under the default rollback-per-test fixture — the assertion would
    vacuum out on an empty ``call_args_list`` and pass against an unfixed build. The
    sibling recompute seam writes to the ScheduleRequest outbox (a DB row), so patching
    the broadcast is enough to keep this off Valkey.
    """
    with patch(BROADCAST) as broadcast:
        _client(actor).post(
            f"/api/v1/calendars/{shared_calendar.pk}/exceptions/",
            {"exc_start": "2026-07-04", "exc_end": "2026-07-04", "name": "Holiday"},
            format="json",
        )

    payloads = [
        call.args[2]
        for call in broadcast.call_args_list
        if call.args[1] == "project_calendar_changed"
    ]
    assert payloads, "no project_calendar_changed broadcast fired"
    assert all(p["actor"] for p in payloads)


@pytest.mark.django_db
def test_working_days_edit_is_also_attributed(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    """The other CPM input on Calendar — same fan-out, same record."""
    with patch(BROADCAST):
        resp = _client(actor).patch(
            f"/api/v1/calendars/{shared_calendar.pk}/",
            {"working_days": 127},
            format="json",
        )
    assert resp.status_code == 200
    assert AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED).count() == 1


@pytest.mark.django_db
def test_a_metadata_only_edit_records_nothing(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    """Renaming a calendar moves no dates, so it must not fan out or claim it did.

    Guards the over-triggering direction: an audit log that records a no-op edit as a
    schedule change is noise that trains readers to ignore the verb.
    """
    with patch(BROADCAST):
        resp = _client(actor).patch(
            f"/api/v1/calendars/{shared_calendar.pk}/", {"name": "Renamed"}, format="json"
        )
    assert resp.status_code == 200
    assert not AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED).exists()
