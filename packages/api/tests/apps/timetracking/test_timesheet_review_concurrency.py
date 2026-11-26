"""Concurrent entry edit vs approve on the same week (ADR-1495 §3).

The entry-write guard and approve both take ``FOR UPDATE`` on the week's submission
row, so they serialize: an edit that is in flight when approve starts makes approve
wait, then see the changed entries and refuse with ``timesheet_changed_since_submit``.
Without the guard's lock, approve hashes the pre-edit entries, approves, and the edit
commits into an approved week. That outcome is what this test refuses.
"""

from __future__ import annotations

import threading
from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.timetracking import review
from trueppm_api.apps.timetracking.models import (
    ReportingLine,
    TimeEntry,
    TimesheetStatus,
    TimesheetSubmission,
)

User = get_user_model()


@pytest.mark.django_db(transaction=True)
def test_entry_edit_racing_approve_never_lands_in_an_approved_week() -> None:
    today = timezone.localdate()
    monday = today - timedelta(days=today.weekday())
    cal = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=cal)
    task = Task.objects.create(project=project, name="T", duration=1)
    report = User.objects.create_user(username="race-report", password="pw")
    manager = User.objects.create_user(username="race-manager", password="pw")
    ReportingLine.objects.create(user=report, manager=manager, updated_by=manager)
    entry = TimeEntry.objects.create(user=report, task=task, minutes=60, entry_date=today)
    review.submit_week(user=report, week_start=monday)

    edited = threading.Event()
    approve_done = threading.Event()
    outcome: list[str] = []
    errors: list[BaseException] = []

    def edit() -> None:
        try:
            with transaction.atomic():
                row = TimeEntry.objects.get(pk=entry.pk)
                row.minutes = 240
                row.save()
                edited.set()
                # Hold the transaction open: with the lock, approve is blocked behind
                # it and this times out; without it, approve finishes first.
                approve_done.wait(timeout=2)
        except BaseException as exc:
            errors.append(exc)
            edited.set()
        finally:
            connection.close()

    def approve() -> None:
        try:
            assert edited.wait(timeout=5)
            review.approve_week(reviewer=manager, user_id=report.pk, week_start=monday)
            outcome.append("approved")
        except review.TimesheetStateConflict as exc:
            outcome.append(str(exc.detail["code"]))  # type: ignore[index,call-overload]
        except BaseException as exc:
            errors.append(exc)
        finally:
            approve_done.set()
            connection.close()

    threads = [threading.Thread(target=edit), threading.Thread(target=approve)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    assert not errors, errors
    sub = TimesheetSubmission.objects.get(user=report, week_start=monday)
    assert TimeEntry.objects.get(pk=entry.pk).minutes == 240
    assert outcome == ["timesheet_changed_since_submit"]
    assert sub.status == TimesheetStatus.SUBMITTED
    # The invariant itself: an approved week's entries are always what was approved.
    assert sub.status != TimesheetStatus.APPROVED or sub.entries_digest == review.week_digest(
        report.pk, monday
    )
