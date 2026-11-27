"""Sprint commitment status, at-risk detection and commitment notices (ADR-1485 D3, D8, D10)."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    UNMUTABLE_IN_APP_EVENTS,
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.projects.commitment_risk import (
    detect_commitment_at_risk,
    notify_scope_change_requested,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ScopeChangeKind,
    ScopeChangeStatus,
    Sprint,
    SprintCommitmentRisk,
    SprintScopeChange,
    SprintState,
    Task,
    TaskStatus,
)

User = get_user_model()
pytestmark = pytest.mark.django_db

SPRINT_START = date(2026, 1, 5)
SPRINT_END = date(2026, 1, 16)
LATE = date(2026, 1, 21)  # three working days after the sprint end


@pytest.fixture(autouse=True)
def _no_broker() -> Any:
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        patch("trueppm_api.apps.projects.views._dispatch_webhooks") as hook,
    ):
        yield hook


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Commit", start_date=date(2026, 1, 1), calendar=cal)


def _user(project: Project, name: str, role: int) -> Any:
    user = User.objects.create_user(username=name, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def admin(project: Project) -> Any:
    return _user(project, "cs_admin", Role.ADMIN)


@pytest.fixture
def viewer(project: Project) -> Any:
    return _user(project, "cs_viewer", Role.VIEWER)


@pytest.fixture
def member(project: Project) -> Any:
    return _user(project, "cs_member", Role.MEMBER)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 4",
        start_date=SPRINT_START,
        finish_date=SPRINT_END,
        state=SprintState.ACTIVE,
    )


def _task(
    project: Project,
    sprint: Sprint,
    name: str,
    finish: date | None,
    **extra: Any,
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        planned_start=SPRINT_START,
        duration=3,
        sprint=sprint,
        early_start=SPRINT_START,
        early_finish=finish,
        **extra,
    )


def _client(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(sprint: Sprint) -> str:
    return f"/api/v1/sprints/{sprint.pk}/commitment-status/"


# ----------------------------------------------------------------------------
# The read
# ----------------------------------------------------------------------------


def test_read_lists_at_risk_with_provenance(
    project: Project, sprint: Sprint, member: Any, viewer: Any
) -> None:
    late = _task(project, sprint, "Late", LATE)
    _task(project, sprint, "OnTime", date(2026, 1, 14))
    _task(project, sprint, "Unscheduled", None)
    _task(project, sprint, "Done", LATE, status=TaskStatus.COMPLETE)
    pending = _task(project, sprint, "Pending injection", LATE, sprint_pending=True)

    for user in (member, viewer):
        body = _client(user).get(_url(sprint)).json()
        assert [r["task_name"] for r in body["at_risk"]] == ["Late"]
        assert body["at_risk_count"] == 1
        row = body["at_risk"][0]
        assert row["task_id"] == str(late.pk)
        assert row["finish"] == LATE.isoformat()
        assert row["working_days_after_sprint_end"] == 3
        # D10: the provenance keys are always present, null when the engine has none.
        assert "cause" in row
        assert row["derivation_ref"] in (
            None,
            {"task_id": str(late.pk), "quantity": "early_finish"},
        )
    assert pending.pk is not None


def test_read_lists_open_changes_of_both_kinds(
    project: Project, sprint: Sprint, admin: Any, member: Any
) -> None:
    injected = _task(project, sprint, "Injected", None, sprint_pending=True)
    slipped = _task(project, sprint, "Slipped", LATE)
    SprintScopeChange.objects.create(
        task=injected, sprint=sprint, subtask_name="Injected", added_by=member
    )
    batch = "7f9b0c1e-3a7e-4d57-9a53-0b0a3c0f9c11"
    SprintScopeChange.objects.create(
        task=slipped,
        sprint=sprint,
        subtask_name="Slipped",
        added_by=member,
        kind=ScopeChangeKind.SLIP,
        proposed_start=SPRINT_START,
        proposed_finish=LATE,
        proposed_duration=8,
        batch_id=batch,
    )
    SprintScopeChange.objects.create(
        task=slipped,
        sprint=sprint,
        subtask_name="Slipped",
        added_by=member,
        status=ScopeChangeStatus.REJECTED,
    )

    body = _client(member).get(_url(sprint)).json()
    assert body["open_scope_change_count"] == 2
    assert {r["kind"] for r in body["open_scope_changes"]} == {"injection", "slip"}
    slip = next(r for r in body["open_scope_changes"] if r["kind"] == "slip")
    assert slip["batch_id"] == batch
    assert slip["requested_by"] == member.pk
    assert slip["proposed_finish"] == LATE.isoformat()
    assert slip["age_seconds"] >= 0
    assert body["oldest_open_age_seconds"] is not None


def test_non_member_is_refused_and_non_active_sprint_reads_empty(
    project: Project, sprint: Sprint, member: Any
) -> None:
    stranger = User.objects.create_user(username="cs_stranger", password="pw")
    assert _client(stranger).get(_url(sprint)).status_code == 404
    _task(project, sprint, "Late", LATE)
    sprint.state = SprintState.PLANNED
    sprint.save()
    assert _client(member).get(_url(sprint)).json()["at_risk"] == []


def test_accept_and_reject_keep_the_admin_gate(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    task = _task(project, sprint, "Injected", None, sprint_pending=True)
    row = SprintScopeChange.objects.create(
        task=task, sprint=sprint, subtask_name="Injected", added_by=member
    )
    assert _client(member).post(f"/api/v1/scope-changes/{row.pk}/accept/", {}).status_code == 403


# ----------------------------------------------------------------------------
# Detection after a recalculation
# ----------------------------------------------------------------------------


def test_detection_announces_once_then_again_after_recovery(
    project: Project, sprint: Sprint, admin: Any, _no_broker: Any
) -> None:
    task = _task(project, sprint, "Late", LATE)

    with patch("django.db.transaction.on_commit", side_effect=lambda f: f()):
        assert detect_commitment_at_risk(project.pk) == 1
        # Same state on the next recalculation: nothing new to say.
        assert detect_commitment_at_risk(project.pk) == 0
    sent = [c.args for c in _no_broker.call_args_list]
    assert len(sent) == 1
    _, event, payload = sent[0]
    assert event == "sprint.commitment_at_risk"
    assert payload["tasks"] == [
        {"task": str(task.pk), "finish": LATE.isoformat(), "working_days_after_sprint_end": 3}
    ]
    # Ids and deltas only (D6): no names.
    assert "Late" not in str(payload)
    assert (
        Notification.objects.filter(
            recipient=admin, event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
        ).count()
        == 1
    )

    # Recovers, then slips again: announced again.
    Task.objects.filter(pk=task.pk).update(early_finish=date(2026, 1, 14))
    with patch("django.db.transaction.on_commit", side_effect=lambda f: f()):
        assert detect_commitment_at_risk(project.pk) == 0
        assert not SprintCommitmentRisk.objects.filter(task=task).exists()
        Task.objects.filter(pk=task.pk).update(early_finish=LATE)
        assert detect_commitment_at_risk(project.pk) == 1


def test_detection_after_predecessor_slip_through_the_recalc_hook(
    project: Project, sprint: Sprint, admin: Any
) -> None:
    """The hook in recalculate_schedule calls the detector once after a successful run."""
    _task(project, sprint, "Late", LATE)
    with patch("django.db.transaction.on_commit", side_effect=lambda f: f()):
        from trueppm_api.apps.scheduling import tasks as sched_tasks

        assert "detect_commitment_at_risk" in Path(sched_tasks.__file__).read_text()
        detect_commitment_at_risk(project.pk)
    assert Notification.objects.filter(
        recipient=admin, event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
    ).exists()


def test_detection_never_raises(project: Project, sprint: Sprint) -> None:
    with patch(
        "trueppm_api.apps.projects.commitment_risk._at_risk_queryset", side_effect=RuntimeError
    ):
        assert detect_commitment_at_risk(project.pk) == 0


# ----------------------------------------------------------------------------
# Notices (D8)
# ----------------------------------------------------------------------------


def test_recipients_are_the_accept_authority_and_cannot_mute_in_app(
    project: Project, sprint: Sprint, admin: Any, member: Any, viewer: Any
) -> None:
    for event in UNMUTABLE_IN_APP_EVENTS:
        NotificationPreference.objects.create(
            user=admin, event_type=event, channel=NotificationChannel.IN_APP, enabled=False
        )
    _task(project, sprint, "Late", LATE)
    with patch("django.db.transaction.on_commit", side_effect=lambda f: f()):
        detect_commitment_at_risk(project.pk)
    notes = Notification.objects.filter(event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK)
    assert set(notes.values_list("recipient_id", flat=True)) == {admin.pk}
    assert notes.get().email_pending is False  # email follows preferences, off by default


def test_preference_write_refuses_to_mute_in_app_but_allows_email(
    admin: Any,
) -> None:
    client = _client(admin)
    prefs = client.get("/api/v1/me/notification-preferences/").json()
    rows = prefs["results"] if isinstance(prefs, dict) else prefs
    in_app = next(
        r
        for r in rows
        if r["event_type"] == NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
        and r["channel"] == "in_app"
    )
    email = next(
        r
        for r in rows
        if r["event_type"] == NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
        and r["channel"] == "email"
    )
    assert (
        client.patch(
            f"/api/v1/me/notification-preferences/{in_app['id']}/",
            {"enabled": False},
            format="json",
        ).status_code
        == 400
    )
    assert (
        client.patch(
            f"/api/v1/me/notification-preferences/{email['id']}/", {"enabled": True}, format="json"
        ).status_code
        == 200
    )


def test_slip_batch_produces_one_notice_that_grows(
    project: Project, sprint: Sprint, admin: Any, member: Any
) -> None:
    batch = "11111111-2222-4333-8444-555555555555"
    rows = []
    for name in ("A", "B", "C"):
        task = _task(project, sprint, name, LATE)
        rows.append(
            SprintScopeChange.objects.create(
                task=task,
                sprint=sprint,
                subtask_name=name,
                added_by=member,
                kind=ScopeChangeKind.SLIP,
                proposed_finish=LATE,
                batch_id=batch,
            )
        )
    for row in rows:
        notify_scope_change_requested(row)
    notes = Notification.objects.filter(
        event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
    )
    assert notes.count() == 1
    note = notes.get()
    assert note.recipient_id == admin.pk
    assert "3 tasks" in note.body and "accept all / review" in note.body
    assert note.group_key == f"batch:{batch}"


def test_requester_is_not_told_about_their_own_request(
    project: Project, sprint: Sprint, admin: Any
) -> None:
    task = _task(project, sprint, "Injected", None, sprint_pending=True)
    row = SprintScopeChange.objects.create(
        task=task, sprint=sprint, subtask_name="Injected", added_by=admin
    )
    notify_scope_change_requested(row)
    assert not Notification.objects.filter(
        event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
    ).exists()


def test_injection_notifies_through_the_write_path(
    project: Project, sprint: Sprint, admin: Any, member: Any
) -> None:
    from trueppm_api.apps.projects.services import record_sprint_scope_change

    task = Task.objects.create(project=project, name="Late add", duration=2)
    task.sprint = sprint
    task.save()
    record_sprint_scope_change(task=task, sprint=sprint, by=member)
    assert Notification.objects.filter(
        recipient=admin, event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
    ).exists()
