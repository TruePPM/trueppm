"""Timesheet review: reporting line, approve / return with reason, category (ADR-1495, #4811)."""

from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import DatabaseError
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification, NotificationEventType
from trueppm_api.apps.projects.models import ApiToken, Calendar, Project, Task
from trueppm_api.apps.timetracking import review
from trueppm_api.apps.timetracking.models import (
    ActiveTimer,
    ReportingLine,
    ReportingLineChange,
    TimeEntry,
    TimeEntryCategory,
    TimesheetStatus,
    TimesheetSubmission,
    TimesheetTransition,
    TimesheetWeekLocked,
)
from trueppm_api.apps.timetracking.signals import timesheet_review_changed
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()

TODAY = timezone.localdate()
MONDAY = TODAY - timedelta(days=TODAY.weekday())
WEEK = MONDAY.isoformat()


def _client(user: Any, token: Any = None) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user, token=token)
    return c


@pytest.fixture
def world(db: object) -> dict[str, Any]:
    cal = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="P1", start_date=date(2026, 1, 1), calendar=cal)
    secret = Project.objects.create(name="Secret", start_date=date(2026, 1, 1), calendar=cal)
    task = Task.objects.create(project=project, name="Build", duration=1)
    secret_task = Task.objects.create(project=secret, name="Hidden", duration=1)
    report = User.objects.create_user(username="report", password="pw")
    manager = User.objects.create_user(username="manager", password="pw")
    peer = User.objects.create_user(username="peer", password="pw")
    admin = User.objects.create_user(username="wsadmin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )
    for u in (report, manager, peer):
        ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    ProjectMembership.objects.create(project=secret, user=report, role=Role.MEMBER)
    ReportingLine.objects.create(user=report, manager=manager, updated_by=admin)
    ReportingLine.objects.create(user=peer, manager=admin, updated_by=admin)
    return {
        "project": project,
        "task": task,
        "secret_task": secret_task,
        "report": report,
        "manager": manager,
        "peer": peer,
        "admin": admin,
    }


def _log(user: Any, task: Any, minutes: int = 60, day: date = TODAY, **kw: Any) -> TimeEntry:
    return TimeEntry.objects.create(user=user, task=task, minutes=minutes, entry_date=day, **kw)


def _submit(user: Any) -> Any:
    return _client(user).post(f"/api/v1/me/timesheets/{WEEK}/submit/")


def _approve(actor: Any, target: Any, token: Any = None) -> Any:
    return _client(actor, token).post(f"/api/v1/me/reports/{target.pk}/timesheets/{WEEK}/approve/")


def _return(actor: Any, target: Any, reason: Any = "Missing Friday") -> Any:
    return _client(actor).post(
        f"/api/v1/me/reports/{target.pk}/timesheets/{WEEK}/return/",
        {"reason": reason},
        format="json",
    )


# --- permission matrix ----------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("who", "expected"),
    [("manager", 200), ("self", 404), ("peer", 404), ("admin", 404), ("anon", 401)],
)
def test_approve_permission_matrix(world: dict[str, Any], who: str, expected: int) -> None:
    """Only the report's manager approves; self, a peer and a non-manager admin get 404."""
    _log(world["report"], world["task"])
    assert _submit(world["report"]).status_code == 200
    if who == "anon":
        resp = APIClient().post(
            f"/api/v1/me/reports/{world['report'].pk}/timesheets/{WEEK}/approve/"
        )
    else:
        actor = world["report"] if who == "self" else world[who]
        resp = _approve(actor, world["report"])
    assert resp.status_code == expected
    sub = TimesheetSubmission.objects.get(user=world["report"], week_start=MONDAY)
    assert sub.status == (
        TimesheetStatus.APPROVED if expected == 200 else TimesheetStatus.SUBMITTED
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/me/reports/{id}/timesheets/{week}/",
        "/api/v1/me/reports/{id}/timesheets/{week}/approve/",
    ],
)
def test_non_report_and_missing_id_are_the_same_404(world: dict[str, Any], path: str) -> None:
    """IDOR: a non-report and a nonexistent id are indistinguishable."""
    method = "post" if path.endswith("approve/") else "get"
    c = _client(world["manager"])
    a = getattr(c, method)(path.format(id=world["peer"].pk, week=WEEK))
    b = getattr(c, method)(path.format(id=999_999, week=WEEK))
    assert a.status_code == b.status_code == 404


@pytest.mark.django_db
def test_token_cannot_approve(world: dict[str, Any]) -> None:
    """Approve is a person's attestation: an ApiToken caller is refused 403."""
    _log(world["report"], world["task"])
    _submit(world["report"])
    token = ApiToken.objects.create(
        name="t",
        token_prefix="abcd1234",
        token_hash="0" * 64,
        owner=world["manager"],
        created_by=world["manager"],
    )
    assert _approve(world["manager"], world["report"], token=token).status_code == 403
    sub = TimesheetSubmission.objects.get(user=world["report"])
    assert sub.status == TimesheetStatus.SUBMITTED


# --- state transitions ----------------------------------------------------------


@pytest.mark.django_db
def test_transition_table(world: dict[str, Any]) -> None:
    """draft -> submitted -> returned -> submitted -> approved, logged append-only."""
    r, m = world["report"], world["manager"]
    _log(r, world["task"])
    assert _submit(r).json()["status"] == TimesheetStatus.SUBMITTED
    assert _return(m, r).status_code == 200
    assert (
        _client(r)
        .get(f"/api/v1/me/time-entries/?from={WEEK}&to={WEEK}")
        .json()["submission"]["return_reason"]
        == "Missing Friday"
    )
    # A returned week is editable.
    entry = TimeEntry.objects.get(user=r)
    patched = _client(r).patch(
        f"/api/v1/me/time-entries/{entry.pk}/", {"minutes": 90}, format="json"
    )
    assert patched.status_code == 200
    assert _submit(r).status_code == 200
    assert _approve(m, r).status_code == 200
    sub = TimesheetSubmission.objects.get(user=r, week_start=MONDAY)
    assert (sub.status, sub.reviewer_id) == (TimesheetStatus.APPROVED, m.pk)
    steps = list(
        TimesheetTransition.objects.filter(submission=sub).values_list("from_status", "to_status")
    )
    assert steps == [
        ("draft", "submitted"),
        ("submitted", "returned"),
        ("returned", "submitted"),
        ("submitted", "approved"),
    ]
    # Approved: no resubmit, no withdraw, no second review.
    assert _submit(r).status_code == 409
    assert _client(r).delete(f"/api/v1/me/timesheets/{WEEK}/submit/").status_code == 409
    assert _approve(m, r).status_code == 409
    assert _return(m, r).status_code == 409


@pytest.mark.django_db
def test_review_of_unsubmitted_week_is_409(world: dict[str, Any]) -> None:
    assert _approve(world["manager"], world["report"]).status_code == 409


@pytest.mark.django_db
@pytest.mark.parametrize("reason", ["", "   ", None, 5])
def test_return_requires_a_reason(world: dict[str, Any], reason: Any) -> None:
    _log(world["report"], world["task"])
    _submit(world["report"])
    assert _return(world["manager"], world["report"], reason=reason).status_code == 400
    assert TimesheetSubmission.objects.get(user=world["report"]).status == TimesheetStatus.SUBMITTED


@pytest.mark.django_db
def test_withdraw_then_resubmit(world: dict[str, Any]) -> None:
    r = world["report"]
    _submit(r)
    assert _client(r).delete(f"/api/v1/me/timesheets/{WEEK}/submit/").status_code == 204
    assert TimesheetSubmission.objects.get(user=r).status == TimesheetStatus.DRAFT
    assert _submit(r).json()["status"] == TimesheetStatus.SUBMITTED


@pytest.mark.django_db
def test_approve_refuses_entries_changed_since_submit(world: dict[str, Any]) -> None:
    r = world["report"]
    entry = _log(r, world["task"])
    _submit(r)
    entry.minutes = 240
    entry.save()
    resp = _approve(world["manager"], r)
    assert resp.status_code == 409
    assert TimesheetSubmission.objects.get(user=r).status == TimesheetStatus.SUBMITTED


# --- notifications and reason visibility ---------------------------------------


@pytest.mark.django_db
def test_return_and_resubmit_write_inbox_items(world: dict[str, Any]) -> None:
    r, m = world["report"], world["manager"]
    _submit(r)
    _return(m, r, reason="Fix Tuesday")
    returned = Notification.objects.get(
        recipient=r, event_type=NotificationEventType.TIMESHEET_RETURNED
    )
    assert returned.body == "Fix Tuesday"
    _submit(r)
    assert Notification.objects.filter(
        recipient=m, event_type=NotificationEventType.TIMESHEET_RESUBMITTED
    ).exists()


@pytest.mark.django_db
def test_reason_hidden_from_a_later_manager(world: dict[str, Any]) -> None:
    """The reason is for the submitter and the reviewer who wrote it, not a successor."""
    r, m, admin = world["report"], world["manager"], world["admin"]
    _submit(r)
    _return(m, r, reason="private")
    assert (
        _client(m).get(f"/api/v1/me/reports/{r.pk}/timesheets/{WEEK}/").json()["return_reason"]
        == "private"
    )
    review.set_manager(actor=admin, user=r, manager=world["peer"])
    body = _client(world["peer"]).get(f"/api/v1/me/reports/{r.pk}/timesheets/{WEEK}/").json()
    assert body["return_reason"] == ""
    # The old manager lost access the moment the line changed.
    assert _client(m).get(f"/api/v1/me/reports/{r.pk}/timesheets/{WEEK}/").status_code == 404


@pytest.mark.django_db
def test_manager_sees_entry_detail_only_on_shared_projects(world: dict[str, Any]) -> None:
    r = world["report"]
    _log(r, world["task"], note="visible")
    _log(r, world["secret_task"], minutes=30, note="classified")
    body = _client(world["manager"]).get(f"/api/v1/me/reports/{r.pk}/timesheets/{WEEK}/").json()
    assert body["week_minutes"] == 90
    by_restricted = {e["restricted"]: e for e in body["entries"]}
    assert by_restricted[False]["task_name"] == "Build"
    hidden = by_restricted[True]
    assert (hidden["task_name"], hidden["project_name"], hidden["note"]) == (None, None, "")


@pytest.mark.django_db
def test_queue_lists_only_direct_reports(world: dict[str, Any]) -> None:
    _log(world["report"], world["task"], minutes=45)
    _submit(world["report"])
    rows = _client(world["manager"]).get(f"/api/v1/me/reports/?week={WEEK}").json()["results"]
    assert [(row["user"]["username"], row["status"], row["week_minutes"]) for row in rows] == [
        ("report", "submitted", 45)
    ]
    assert _client(world["report"]).get("/api/v1/me/reports/").json()["results"] == []


# --- approved-week lock across write paths -------------------------------------


@pytest.mark.django_db
def test_approved_week_refuses_every_write_path(world: dict[str, Any]) -> None:
    r, task = world["report"], world["task"]
    entry = _log(r, task)
    _submit(r)
    _approve(world["manager"], r)
    c = _client(r)
    # REST create, edit, delete.
    assert (
        c.post(
            f"/api/v1/tasks/{task.pk}/time-entries/",
            {"minutes": 10, "entry_date": TODAY.isoformat()},
            format="json",
        ).status_code
        == 409
    )
    assert (
        c.patch(f"/api/v1/me/time-entries/{entry.pk}/", {"minutes": 5}, format="json").status_code
        == 409
    )
    assert c.delete(f"/api/v1/me/time-entries/{entry.pk}/").status_code == 409
    # Moving an entry out of the approved week is refused too.
    with pytest.raises(TimesheetWeekLocked):
        entry.entry_date = MONDAY - timedelta(days=7)
        entry.save()
    # Timer stop into the approved week discards rather than logs.
    ActiveTimer.objects.create(user=r, task=task, started_at=timezone.now())
    assert c.post("/api/v1/me/timer/stop").status_code == 409
    assert not ActiveTimer.objects.filter(user=r).exists()
    assert TimeEntry.objects.filter(user=r, is_deleted=False).count() == 1


def test_time_entry_write_paths_are_enumerated() -> None:
    """Every write of TimeEntry must go through ``save()``, where the approved-week lock is.

    ``bulk_create`` and ``QuerySet.update`` bypass ``save()``. The only callers allowed to
    use them are the demo seed tools, which never run against a user's approved week. A
    new bypassing caller fails here and must route through ``save()`` or be justified.
    """
    root = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
    allowed = {"apps/projects/seed/importer.py", "apps/projects/seed/replay.py"}
    pattern = re.compile(r"TimeEntry\.objects[\s\S]{0,200}?\.(update|bulk_create|bulk_update)\(")
    bulk = re.compile(r"_bulk_insert\(\s*TimeEntry")
    offenders = []
    for path in root.rglob("*.py"):
        rel = path.relative_to(root).as_posix()
        if "/migrations/" in rel or rel in allowed:
            continue
        text = path.read_text()
        if pattern.search(text) or bulk.search(text):
            offenders.append(rel)
    assert offenders == []


# --- reporting line -------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(("who", "expected"), [("admin", 200), ("manager", 403), ("report", 403)])
def test_only_admins_set_reporting_lines(world: dict[str, Any], who: str, expected: int) -> None:
    """Setting a manager grants approval authority, so a member cannot set their own."""
    target = world["report"]
    resp = _client(world[who]).put(
        f"/api/v1/reporting-lines/{target.pk}/", {"manager": world["peer"].pk}, format="json"
    )
    assert resp.status_code == expected
    assert _client(world[who]).get("/api/v1/reporting-lines/").status_code == expected


@pytest.mark.django_db
def test_reporting_line_refuses_self_and_cycles_and_audits(world: dict[str, Any]) -> None:
    admin, r, m = world["admin"], world["report"], world["manager"]
    c = _client(admin)
    assert (
        c.put(f"/api/v1/reporting-lines/{r.pk}/", {"manager": r.pk}, format="json").status_code
        == 400
    )
    # m -> r would close the loop r -> m -> r (mutual approval).
    assert (
        c.put(f"/api/v1/reporting-lines/{m.pk}/", {"manager": r.pk}, format="json").status_code
        == 400
    )
    # A longer cycle: manager reports to peer, then peer -> report would loop.
    assert (
        c.put(
            f"/api/v1/reporting-lines/{m.pk}/", {"manager": world["peer"].pk}, format="json"
        ).status_code
        == 200
    )
    assert (
        c.put(
            f"/api/v1/reporting-lines/{world['peer'].pk}/", {"manager": r.pk}, format="json"
        ).status_code
        == 400
    )
    assert c.delete(f"/api/v1/reporting-lines/{m.pk}/").status_code == 204
    changes = list(
        ReportingLineChange.objects.filter(user=m).values_list("new_manager_id", "actor_id")
    )
    assert changes == [(world["peer"].pk, admin.pk), (None, admin.pk)]


# --- extension signal and category ---------------------------------------------


@pytest.mark.django_db
def test_raising_receiver_does_not_abort_the_transition(world: dict[str, Any]) -> None:
    def boom(**_: Any) -> None:
        raise DatabaseError("enterprise receiver failed")

    timesheet_review_changed.connect(boom, dispatch_uid="test-boom")
    try:
        assert _submit(world["report"]).status_code == 200
    finally:
        timesheet_review_changed.disconnect(dispatch_uid="test-boom")
    assert TimesheetSubmission.objects.get(user=world["report"]).status == TimesheetStatus.SUBMITTED


@pytest.mark.django_db
def test_category_defaults_to_task_and_is_writable(world: dict[str, Any]) -> None:
    c = _client(world["report"])
    url = f"/api/v1/tasks/{world['task'].pk}/time-entries/"
    assert c.post(url, {"minutes": 10}, format="json").json()["category"] == "task"
    assert (
        c.post(url, {"minutes": 10, "category": "pto"}, format="json").json()["category"] == "pto"
    )
    assert c.post(url, {"minutes": 10, "category": "holiday"}, format="json").status_code == 400


@pytest.mark.django_db
def test_non_task_categories_are_not_costed(world: dict[str, Any]) -> None:
    from trueppm_api.apps.projects.cost import _load_inputs

    r, task = world["report"], world["task"]
    _log(r, task, minutes=60)
    for cat in (TimeEntryCategory.PTO, TimeEntryCategory.ADMIN, TimeEntryCategory.TRAINING):
        _log(r, task, minutes=600, category=cat)
    rows = _load_inputs([world["project"].pk]).time_rows
    assert [row["m"] for row in rows] == [60]
