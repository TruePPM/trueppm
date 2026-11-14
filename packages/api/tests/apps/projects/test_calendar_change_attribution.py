"""Attribution for shared-calendar edits that reschedule other people's projects (#3174).

A Calendar is a workspace-global resource, so one holiday added to it shifts finish
dates on every project bound to that calendar — including projects the editor is not a
member of, whose owners previously saw dates move with nothing naming who did it.

The permission question these tests used to leave open closed in #3600: the write gate
moved from the self-grantable ``IsOrgAdmin`` derivation to ``IsWorkspaceAdminStrict``.
That raises who may trigger the fan-out and narrows nothing about its reach, so the
attribution half these tests pin is not made redundant by it — one ``CALENDAR_CHANGED``
audit row per edit naming the actor and the affected set, and an actor label on the
live broadcast. #3245 widened the record to a rename and to an edit with no bound
project.
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
def actor(db: object, shared_calendar: Calendar, grant_workspace_admin: Any) -> Any:
    """A workspace ADMIN who is a member of exactly one of the affected projects.

    Workspace ADMIN because that is the gate on calendar writes since #3600. Member of
    only "Their own" because the blast radius is what these tests are about: the edit
    must still reach ``outsider_project``, which the actor cannot see.
    """
    user = User.objects.create_user(username="pm", email="pm@example.com", password="pw")
    own = Project.objects.create(name="Their own", start_date=MONDAY, calendar=shared_calendar)
    ProjectMembership.objects.create(project=own, user=user, role=Role.ADMIN)
    return grant_workspace_admin(user)


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


@pytest.mark.django_db(transaction=True)
def test_a_rename_is_recorded_without_claiming_a_schedule_change(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    """A rename moves no dates, but it is still an edit to a shared calendar (#3245).

    The verb ``calendar_changed`` promises a record of edits to a shared calendar, and
    before #3245 a rename wrote none. The row must not claim a schedule change it did
    not cause, though — an audit log that reports a no-op edit as rescheduling trains
    readers to ignore the verb — so it names the changed field and an affected count
    of 0, and no recompute or broadcast fans out. ``transaction=True`` so the deferred
    broadcast would actually run if one were registered.
    """
    with patch(BROADCAST) as broadcast:
        resp = _client(actor).patch(
            f"/api/v1/calendars/{shared_calendar.pk}/", {"name": "Renamed"}, format="json"
        )
    assert resp.status_code == 200
    (row,) = AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED)
    assert row.actor_id == actor.pk
    assert row.target_label == "Renamed"
    assert row.metadata["changed_fields"] == ["name"]
    assert row.metadata["previous_name"] == "Corporate"
    assert row.metadata["affected_project_count"] == 0
    assert not [c for c in broadcast.call_args_list if c.args[1] == "project_calendar_changed"]


@pytest.mark.django_db
def test_rename_plus_working_days_edit_keeps_the_rename_in_the_single_audit_row(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    """A combined edit writes ONE row, and that row still names the rename (#3245).

    ``perform_update`` hands the working-time edit to the recalc fan-out and returns,
    which used to drop the rename's ``changed_fields`` / ``previous_name`` on the floor.
    """
    with patch(BROADCAST):
        resp = _client(actor).patch(
            f"/api/v1/calendars/{shared_calendar.pk}/",
            {"name": "Renamed", "working_days": 127},
            format="json",
        )
    assert resp.status_code == 200
    (row,) = AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED)
    assert row.metadata["changed_fields"] == ["name"]
    assert row.metadata["previous_name"] == "Corporate"
    assert row.metadata["affected_project_count"] >= 1


@pytest.mark.django_db
def test_a_resave_with_no_change_records_nothing(
    actor: Any, shared_calendar: Calendar, outsider_project: Project
) -> None:
    """A PUT that re-sends today's values is not an edit and must not write a row."""
    with patch(BROADCAST):
        resp = _client(actor).patch(
            f"/api/v1/calendars/{shared_calendar.pk}/", {"name": "Corporate"}, format="json"
        )
    assert resp.status_code == 200
    assert not AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED).exists()


@pytest.mark.django_db
def test_an_edit_to_a_calendar_with_no_bound_project_is_still_recorded(
    db: object, grant_workspace_admin: Any
) -> None:
    """Zero bound projects means nothing to recompute, not nothing to record (#3245).

    ``_enqueue_calendar_recalc`` used to return before the audit write when the
    affected set was empty, so a working-days or holiday edit to an unbound calendar
    left no trace — and a project bound to it later silently inherits the edit.
    """
    lonely = Calendar.objects.create(name="Unbound", working_days=31, hours_per_day=8.0)
    admin = grant_workspace_admin(
        User.objects.create_user(username="solo", email="solo@example.com", password="pw")
    )
    with patch(BROADCAST) as broadcast:
        resp = _client(admin).patch(
            f"/api/v1/calendars/{lonely.pk}/", {"working_days": 15}, format="json"
        )
        exc = _client(admin).post(
            f"/api/v1/calendars/{lonely.pk}/exceptions/",
            {"exc_start": "2026-07-04", "exc_end": "2026-07-04", "name": "Holiday"},
            format="json",
        )
    assert resp.status_code == 200
    assert exc.status_code == 201
    rows = list(AuditEvent.objects.filter(event_type=AuditEventType.CALENDAR_CHANGED))
    assert len(rows) == 2
    assert all(r.actor_id == admin.pk for r in rows)
    assert all(r.metadata["affected_project_count"] == 0 for r in rows)
    assert not broadcast.called
