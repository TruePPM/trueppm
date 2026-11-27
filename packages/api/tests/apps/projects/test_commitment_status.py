"""Sprint commitment status, at-risk detection and commitment notices (ADR-1485 D3, D8, D10)."""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from celery.exceptions import SoftTimeLimitExceeded
from django.contrib.auth import get_user_model
from django.utils import timezone
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
    Dependency,
    Program,
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
from trueppm_api.apps.projects.views import _dispatch_webhooks as _real_dispatch_webhooks

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


def _chain(pred_project: Project, succ_project: Project, sprint: Sprint) -> tuple[Task, Task]:
    """A predecessor and a successor committed to ``sprint``, joined FS (accepted)."""
    pred = Task.objects.create(project=pred_project, name="Pred", duration=3)
    succ = Task.objects.create(project=succ_project, name="Succ", duration=2, sprint=sprint)
    Dependency.objects.create(
        predecessor=pred, successor=succ, dep_type="FS", lag=0, accepted_at=timezone.now()
    )
    return pred, succ


def _end_sprint_at_successor_finish(sprint: Sprint, succ: Task, hook: Any) -> None:
    """Put the sprint end exactly on the successor's recalculated finish (not at risk).

    Read from the first real recalculation rather than hard-coded, so the test does
    not depend on where the engine's data date floors unstarted work.
    """
    succ.refresh_from_db()
    assert succ.early_finish is not None
    Sprint.objects.filter(pk=sprint.pk).update(
        start_date=min(sprint.start_date, succ.early_finish), finish_date=succ.early_finish
    )
    SprintCommitmentRisk.objects.all().delete()
    Notification.objects.all().delete()
    hook.reset_mock()


def _slip(pred: Task) -> None:
    Task.objects.filter(pk=pred.pk).update(duration=pred.duration + 10)


def _risk_webhooks(hook: Any) -> list[dict[str, Any]]:
    return [c.args[2] for c in hook.call_args_list if c.args[1] == "sprint.commitment_at_risk"]


def test_predecessor_slip_is_announced_by_the_real_recalculation(
    project: Project,
    sprint: Sprint,
    admin: Any,
    _no_broker: Any,
    django_capture_on_commit_callbacks: Any,
) -> None:
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    pred, succ = _chain(project, project, sprint)
    with django_capture_on_commit_callbacks(execute=True):
        assert recalculate_schedule.apply(args=[str(project.pk)]).successful()
    _end_sprint_at_successor_finish(sprint, succ, _no_broker)

    _slip(pred)
    with django_capture_on_commit_callbacks(execute=True):
        assert recalculate_schedule.apply(args=[str(project.pk)]).successful()

    (payload,) = _risk_webhooks(_no_broker)
    assert [t["task"] for t in payload["tasks"]] == [str(succ.pk)]
    assert payload["tasks"][0]["working_days_after_sprint_end"] == 10
    assert SprintCommitmentRisk.objects.filter(sprint=sprint, task=succ).exists()
    assert Notification.objects.filter(
        recipient=admin, event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
    ).exists()


def test_read_carries_the_engine_cause_after_a_real_recalculation(
    project: Project,
    sprint: Sprint,
    member: Any,
    _no_broker: Any,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """D10: a non-null cause and derivation_ref, from the same pass that stored the finish."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    pred, succ = _chain(project, project, sprint)
    with django_capture_on_commit_callbacks(execute=True):
        recalculate_schedule.apply(args=[str(project.pk)])
    _end_sprint_at_successor_finish(sprint, succ, _no_broker)
    _slip(pred)
    with django_capture_on_commit_callbacks(execute=True):
        recalculate_schedule.apply(args=[str(project.pk)])

    (row,) = _client(member).get(_url(sprint)).json()["at_risk"]
    assert row["task_id"] == str(succ.pk)
    assert isinstance(row["cause"], str) and row["cause"].strip()
    assert row["derivation_ref"] == {"task_id": str(succ.pk), "quantity": "early_finish"}


def test_an_escalated_program_recalculation_announces_at_risk(
    project: Project, _no_broker: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """A member project with an accepted cross-project edge hands off to the program pass.

    The single-project task returns early on escalation, so the program pass is the
    only place detection can run for these projects.
    """
    from trueppm_api.apps.scheduling.tasks import recalculate_program_schedule, recalculate_schedule

    program = Program.objects.create(name="Program")
    other = Project.objects.create(
        name="Other", start_date=project.start_date, calendar=project.calendar, program=program
    )
    Project.objects.filter(pk=project.pk).update(program=program)
    lead = _user(other, "cs_other_admin", Role.ADMIN)
    other_sprint = Sprint.objects.create(
        project=other,
        name="Sprint 9",
        start_date=SPRINT_START,
        finish_date=SPRINT_END,
        state=SprintState.ACTIVE,
    )
    pred, succ = _chain(project, other, other_sprint)
    with django_capture_on_commit_callbacks(execute=True):
        assert recalculate_program_schedule.apply(args=[str(program.pk)]).successful()
    _end_sprint_at_successor_finish(other_sprint, succ, _no_broker)

    _slip(pred)
    with (
        patch.object(
            recalculate_program_schedule,
            "delay",
            side_effect=lambda pid: recalculate_program_schedule.apply(args=[pid]),
        ) as escalate,
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert recalculate_schedule.apply(args=[str(project.pk)]).successful()

    escalate.assert_called_once_with(str(program.pk))
    (payload,) = _risk_webhooks(_no_broker)
    assert payload["project"] == str(other.pk)
    assert [t["task"] for t in payload["tasks"]] == [str(succ.pk)]
    assert Notification.objects.filter(
        recipient=lead, event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
    ).exists()


@pytest.mark.parametrize("failure", [RuntimeError("boom"), SoftTimeLimitExceeded()])
def test_a_failing_detector_cannot_break_the_recalculation(
    project: Project,
    sprint: Sprint,
    failure: BaseException,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """The CPM run has persisted; a detector failure, even the soft limit, is not its failure."""
    from trueppm_api.apps.scheduling import tasks as sched_tasks

    _pred, succ = _chain(project, project, sprint)
    with (
        patch(
            "trueppm_api.apps.projects.commitment_risk._detect_for_sprint", side_effect=failure
        ) as detector,
        patch.object(sched_tasks, "_dead_letter_current") as dead_letter,
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert sched_tasks.recalculate_schedule.apply(args=[str(project.pk)]).successful()

    assert detector.called
    dead_letter.assert_not_called()
    succ.refresh_from_db()
    assert succ.early_finish is not None
    project.refresh_from_db()
    assert project.recalculated_at is not None


def test_one_sprint_failing_does_not_skip_the_others(project: Project, admin: Any) -> None:
    from trueppm_api.apps.projects import commitment_risk

    for n in (1, 2):
        sp = Sprint.objects.create(
            project=project,
            name=f"Sprint {n}",
            start_date=SPRINT_START,
            finish_date=SPRINT_END,
            state=SprintState.ACTIVE,
        )
        _task(project, sp, f"Late {n}", LATE)
    real = commitment_risk._detect_for_sprint
    calls: list[Any] = []

    def _first_fails(sp: Sprint) -> int:
        calls.append(sp.pk)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return real(sp)

    with (
        patch.object(commitment_risk, "_detect_for_sprint", side_effect=_first_fails),
        patch("django.db.transaction.on_commit", side_effect=lambda f: f()),
    ):
        assert detect_commitment_at_risk(project.pk) == 1
    assert len(calls) == 2
    assert SprintCommitmentRisk.objects.filter(sprint_id=calls[1]).count() == 1


def test_no_dedupe_row_survives_a_lost_dispatch(
    project: Project, sprint: Sprint, admin: Any, _no_broker: Any
) -> None:
    """A crash before the commit leaves nothing marked announced, and no notice either."""
    _task(project, sprint, "Late", LATE)
    _no_broker.side_effect = RuntimeError("process died before the commit")
    assert detect_commitment_at_risk(project.pk) == 0
    assert not SprintCommitmentRisk.objects.exists()
    assert not Notification.objects.filter(
        event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
    ).exists()
    _no_broker.side_effect = None
    assert detect_commitment_at_risk(project.pk) == 1
    assert len(_risk_webhooks(_no_broker)) == 2
    assert SprintCommitmentRisk.objects.count() == 1
    assert (
        Notification.objects.filter(
            recipient=admin, event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
        ).count()
        == 1
    )


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


def _committed_for(project: Project, sprint: Sprint, name: str, member: Any) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        planned_start=SPRINT_START,
        duration=3,
        sprint=sprint,
        assignee=member,
    )


def test_a_deferred_slip_notifies_through_the_409_write_path(
    project: Project, sprint: Sprint, admin: Any, member: Any
) -> None:
    task = _committed_for(project, sprint, "Slips", member)
    res = _client(member).patch(f"/api/v1/tasks/{task.pk}/", {"duration": 15}, format="json")
    assert res.status_code == 409, res.data
    note = Notification.objects.get(
        recipient=admin, event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
    )
    assert "Slips" in note.body
    assert not Notification.objects.filter(recipient=member).exists()


def test_a_bulk_slip_makes_one_batched_notice_through_the_write_path(
    project: Project, sprint: Sprint, admin: Any, member: Any
) -> None:
    tasks = [_committed_for(project, sprint, name, member) for name in ("A", "B")]
    ops = [{"op": "update", "id": str(t.pk), "data": {"duration": 20}} for t in tasks]
    res = _client(member).post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/", {"operations": ops}, format="json"
    )
    assert res.status_code in (200, 207), res.data
    batch = SprintScopeChange.objects.filter(kind=ScopeChangeKind.SLIP).values_list(
        "batch_id", flat=True
    )
    (batch_id,) = set(batch)
    note = Notification.objects.get(
        recipient=admin, event_type=NotificationEventType.SPRINT_SCOPE_CHANGE_REQUESTED
    )
    assert note.group_key == f"batch:{batch_id}"
    assert "2 tasks" in note.body


# ----------------------------------------------------------------------------
# Delivery ordering, concurrent detections, and the sprint writes that detect
# ----------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_every_delivery_job_is_queued_after_its_rows_commit(
    project: Project, sprint: Sprint, admin: Any
) -> None:
    """The real dispatch: each job finds its delivery row and the dedupe row committed."""
    from django.db import connection

    from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery

    for n in range(2):
        Webhook.objects.create(
            project=project,
            url=f"https://example.com/hook-{n}",
            secret="test-secret-123",
            events=["sprint.commitment_at_risk"],
            created_by=admin,
        )
    _task(project, sprint, "Late", LATE)
    seen: list[tuple[bool, bool, bool]] = []

    def _delay(pk: str) -> None:
        seen.append(
            (
                connection.in_atomic_block,
                WebhookDelivery.objects.filter(pk=pk).exists(),
                SprintCommitmentRisk.objects.filter(sprint=sprint).exists(),
            )
        )

    with (
        patch("trueppm_api.apps.projects.views._dispatch_webhooks", new=_real_dispatch_webhooks),
        patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay", side_effect=_delay),
    ):
        assert detect_commitment_at_risk(project.pk) == 1
    # Outside any transaction, so what the job reads is committed.
    assert seen == [(False, True, True), (False, True, True)]


@pytest.mark.django_db(transaction=True)
def test_interleaved_detections_announce_once(project: Project, sprint: Sprint, admin: Any) -> None:
    """A second detection that starts while the first holds the lock sees its rows."""
    import threading

    from django.db import connection

    _task(project, sprint, "Late", LATE)
    first_inside = threading.Event()
    release = threading.Event()
    results: list[int] = []
    calls: list[str] = []

    def _hook(pid: str, event: str, payload: Any, **_: Any) -> None:
        calls.append(event)
        if len(calls) == 1:
            first_inside.set()
            release.wait(10)

    def _run() -> None:
        try:
            results.append(detect_commitment_at_risk(project.pk))
        finally:
            connection.close()

    with patch("trueppm_api.apps.projects.views._dispatch_webhooks", side_effect=_hook):
        first = threading.Thread(target=_run)
        first.start()
        assert first_inside.wait(10)
        second = threading.Thread(target=_run)
        second.start()
        second.join(1)  # blocked on the sprint lock the first still holds
        release.set()
        first.join(10)
        second.join(10)
    assert sorted(results) == [0, 1]
    assert calls == ["sprint.commitment_at_risk"]
    assert SprintCommitmentRisk.objects.count() == 1
    assert (
        Notification.objects.filter(
            recipient=admin, event_type=NotificationEventType.SPRINT_COMMITMENT_AT_RISK
        ).count()
        == 1
    )


def test_activating_a_sprint_with_tasks_already_late_announces(
    project: Project, admin: Any, _no_broker: Any
) -> None:
    planned = Sprint.objects.create(
        project=project,
        name="Sprint 5",
        start_date=SPRINT_START,
        finish_date=SPRINT_END,
        state=SprintState.PLANNED,
    )
    task = _task(project, planned, "Late", LATE)
    resp = _client(admin).post(f"/api/v1/sprints/{planned.pk}/activate/")
    assert resp.status_code == 200, resp.data
    (payload,) = _risk_webhooks(_no_broker)
    assert [t["task"] for t in payload["tasks"]] == [str(task.pk)]
    assert SprintCommitmentRisk.objects.filter(sprint=planned, task=task).exists()
