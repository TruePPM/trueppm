"""Webhook events for the baseline changeset, undo, and sprint scope requests
(#5121, #5131, ADR-1485 D6).

Each emitter dispatches through ``views._dispatch_webhooks`` inside
``transaction.on_commit`` (a registered outbox helper), so the tests patch that
trampoline and run the captured callbacks. The payload allow-lists are exact: a new
key must be a decision made here, not an accident (ids plus deltas only).
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import amend, baselines, views
from trueppm_api.apps.projects.commit_moment import commit_project
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectLifecycle,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.services import record_sprint_scope_change
from trueppm_api.apps.webhooks.models import (
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
    WebhookEventType,
)


@pytest.fixture
def owner(db: object) -> Any:
    return get_user_model().objects.create_user(username="ev-owner", password="pw")


def _task(project: Project, name: str, path: str, finish: date) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=5,
        wbs_path=path,
        early_start=finish - timedelta(days=4),
        early_finish=finish,
    )


@pytest.fixture
def committed(owner: Any) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(
        name="Pad", start_date=date(2026, 3, 2), calendar=cal, lifecycle=ProjectLifecycle.DRAFT
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    _task(p, "Permits", "1", date(2026, 3, 6))
    _task(p, "Pour", "2", date(2026, 3, 20))
    commit_project(p, user=owner)
    p.refresh_from_db()
    return p


def _events(mock: Any, name: str) -> list[dict[str, Any]]:
    return [c.args[2] for c in mock.call_args_list if c.args[1] == name]


# --- vocabulary ------------------------------------------------------------


def test_new_event_names_fit_the_column_and_are_registered() -> None:
    for name in (
        "schedule.change_undone",
        "sprint.scope_change_requested",
        "changeset.opened",
        "changeset.entry_added",
        "changeset.entry_reasoned",
        "baseline.kept",
    ):
        assert name in WebhookEventType.values
        assert len(name) <= 30
    # sprint.commitment_at_risk has no emitter until #5127 (which registers and
    # emits it): not advertised.
    assert "sprint.commitment_at_risk" not in WebhookEventType.values


# --- #5121 changeset ---------------------------------------------------------


@pytest.mark.django_db
def test_first_entry_opens_the_changeset_once(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        entry = amend.record_structural_change(
            committed, kind="move", surface="grid", actor=owner, tasks=tasks[:1]
        )
        # A second, different kind is a second entry, but not a second opener.
        amend.record_structural_change(
            committed, kind="add", surface="grid", actor=owner, tasks=tasks[1:]
        )
    opened = _events(dispatch, "changeset.opened")
    assert len(opened) == 1
    assert opened[0] == {
        "project": str(committed.pk),
        "baseline_id": str(entry.baseline_id),
        "baseline_version": 1,
        "entry": {
            "id": str(entry.pk),
            "kind": "move",
            "surface": "grid",
            "reason_state": "unreasoned",
            "task_ids": [str(tasks[0].pk)],
            "author": str(owner.pk),
            "actor": {"agent_actor_id": None, "on_behalf_of": None},
            "finish_impact": {
                "before": entry.finish_before.isoformat(),
                "after": None,
                "_provenance": {"source": "cpm_early_finish", "computed": False},
            },
            "opened_at": entry.opened_at.isoformat(),
        },
    }
    # The second entry is announced as an addition, not as a second opener.
    (added,) = _events(dispatch, "changeset.entry_added")
    assert added["entry"]["kind"] == "add"
    assert "baseline_version" not in added


@pytest.mark.django_db
def test_a_batched_act_does_not_reopen(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        for t in tasks:  # same (kind, surface, author) inside the window: absorbed
            amend.record_structural_change(
                committed, kind="move", surface="grid", actor=owner, tasks=[t]
            )
    assert len(_events(dispatch, "changeset.opened")) == 1
    assert _events(dispatch, "changeset.entry_added") == []


_ENTRY_KEYS = {
    "id",
    "kind",
    "surface",
    "reason_state",
    "task_ids",
    "author",
    "actor",
    "finish_impact",
    "opened_at",
}


@pytest.mark.django_db
def test_a_batched_session_after_the_opener_fires_exactly_one_entry_added(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    amend.record_structural_change(
        committed, kind="add", surface="grid", actor=owner, tasks=tasks[:1]
    )  # the opener
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        for t in tasks:  # one group: three acts, one entry
            amend.record_structural_change(
                committed, kind="move", surface="gantt", actor=owner, tasks=[t]
            )
    (added,) = _events(dispatch, "changeset.entry_added")
    assert set(added) == {"project", "baseline_id", "entry"}
    assert set(added["entry"]) == _ENTRY_KEYS
    assert added["entry"]["kind"] == "move"
    assert added["entry"]["task_ids"] == [str(tasks[0].pk)]  # built at the entry's birth
    assert _events(dispatch, "changeset.opened") == []


@pytest.mark.django_db
def test_an_agent_entry_names_the_agent_and_its_on_behalf_of_human(
    committed: Project, owner: Any
) -> None:
    """No 0.5 write path sets ``agent_actor_id``; the payload contract is pinned here."""
    tasks = list(Task.objects.filter(project=committed))
    entry = amend.record_structural_change(
        committed, kind="move", surface="api", actor=owner, tasks=tasks[:1]
    )
    agent = uuid.uuid4()
    entry.agent_actor_id = agent
    entry.finish_after = date(2026, 3, 27)
    body = amend.entry_webhook_payload(entry)
    assert body["actor"] == {"agent_actor_id": str(agent), "on_behalf_of": str(owner.pk)}
    assert body["finish_impact"]["after"] == "2026-03-27"
    assert body["finish_impact"]["_provenance"]["computed"] is True
    assert set(body) == _ENTRY_KEYS


@pytest.mark.django_db
def test_answering_a_reason_fires_entry_reasoned_once(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    entry = amend.record_structural_change(
        committed, kind="move", surface="grid", actor=owner, tasks=tasks[:1]
    )
    c = APIClient()
    c.force_authenticate(user=owner)
    url = f"/api/v1/projects/{committed.pk}/changeset/entries/{entry.pk}/"
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert c.patch(url, {"reason": "Permit slipped"}, format="json").status_code == 200
        assert c.patch(url, {"reason": "Again"}, format="json").status_code == 409
    (reasoned,) = _events(dispatch, "changeset.entry_reasoned")
    assert set(reasoned) == {"project", "baseline_id", "entry"}
    assert reasoned["entry"]["id"] == str(entry.pk)
    assert reasoned["entry"]["reason_state"] == "reasoned"
    assert "Permit slipped" not in str(reasoned)  # no reason text on the wire


@pytest.mark.django_db
def test_an_inline_reasoned_entry_is_not_also_announced_as_reasoned(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        amend.record_structural_change(
            committed, kind="move", surface="grid", actor=owner, tasks=tasks[:1], reason="Why"
        )
    assert _events(dispatch, "changeset.opened")[0]["entry"]["reason_state"] == "reasoned"
    assert _events(dispatch, "changeset.entry_reasoned") == []


@pytest.mark.django_db
def test_the_opener_check_locks_the_active_baseline(committed: Project, owner: Any) -> None:
    """Two concurrent first entries with different keys share no entry row to lock,
    so the "first since this baseline" read is serialized on the baseline row."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    tasks = list(Task.objects.filter(project=committed))
    with CaptureQueriesContext(connection) as ctx:
        amend.record_structural_change(
            committed, kind="move", surface="grid", actor=owner, tasks=tasks[:1], reason="r"
        )
    locked = [
        q["sql"]
        for q in ctx.captured_queries
        if q["sql"].lstrip().startswith("SELECT")
        and 'FROM "projects_baseline"' in q["sql"]
        and q["sql"].rstrip().endswith("FOR UPDATE")
    ]
    assert len(locked) == 1


@pytest.mark.django_db
def test_a_draft_plan_opens_nothing(owner: Any, django_capture_on_commit_callbacks: Any) -> None:
    p = Project.objects.create(
        name="Draft",
        start_date=date(2026, 3, 2),
        calendar=Calendar.objects.create(name="S"),
        lifecycle=ProjectLifecycle.DRAFT,
    )
    t = _task(p, "A", "1", date(2026, 3, 6))
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        amend.record_structural_change(p, kind="move", surface="grid", actor=owner, tasks=[t])
    dispatch.assert_not_called()


@pytest.mark.django_db
def test_keep_v1_fires_baseline_kept_and_not_captured(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    amend.record_structural_change(
        committed, kind="move", surface="grid", actor=owner, tasks=tasks[:1]
    )
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        row = baselines.decide(
            committed,
            user=owner,
            data=baselines.DecisionInput(kind="kept", note="Living with it"),
        )
    assert _events(dispatch, "baseline.captured") == []
    (kept,) = _events(dispatch, "baseline.kept")
    assert set(kept) == {
        "project",
        "decision_id",
        "baseline_id",
        "from_baseline_id",
        "baseline_version",
        "note",
        "open_entries",
        "variance_wd",
        "actor",
    }
    assert kept["decision_id"] == str(row.pk)
    # The baseline that stays active, under both names: from_baseline_id is the
    # one Take v2's baseline.captured uses for the baseline it replaces.
    assert kept["baseline_id"] == kept["from_baseline_id"] == str(row.from_baseline_id)
    assert kept["note"] == "Living with it"
    assert kept["open_entries"] == 1
    assert kept["baseline_version"] == 1
    assert kept["actor"] == str(owner.pk)


@pytest.mark.django_db
def test_keep_v1_without_a_note_sends_null(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        baselines.decide(committed, user=owner, data=baselines.DecisionInput(kind="kept"))
    assert _events(dispatch, "baseline.kept")[0]["note"] is None


@pytest.mark.django_db(transaction=True)
def test_a_failing_variance_read_still_commits_keep_and_sends_null(
    committed: Project, owner: Any
) -> None:
    """A database error in the variance read cannot undo the Keep it describes.

    ``transaction=True`` so the on-commit callback runs after a real commit, the way
    production runs it: the read raises a genuine database error, not a mock one.
    """
    from django.db import connection

    from trueppm_api.apps.projects import baseline_variance as bv
    from trueppm_api.apps.projects.models import BaselineDecision

    def _broken(*_a: Any, **_k: Any) -> Any:
        with connection.cursor() as cur:
            cur.execute("SELECT * FROM no_such_table_5121")
        raise AssertionError("unreachable")

    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        patch.object(bv, "baseline_variance", _broken),
    ):
        row = baselines.decide(committed, user=owner, data=baselines.DecisionInput(kind="kept"))
    assert BaselineDecision.objects.filter(pk=row.pk, kind="kept").exists()
    (kept,) = _events(dispatch, "baseline.kept")
    assert kept["decision_id"] == str(row.pk)
    assert kept["variance_wd"] is None


@pytest.mark.django_db
def test_take_v2_captured_carries_the_reason_and_v1_does_not(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    tasks = list(Task.objects.filter(project=committed))
    amend.record_structural_change(
        committed,
        kind="move",
        surface="grid",
        actor=owner,
        tasks=tasks[:1],
        reason="Permit slipped",
    )
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        row = baselines.decide(
            committed,
            user=owner,
            data=baselines.DecisionInput(
                kind="taken", reason_code="scope_change", reason="Owner added scope"
            ),
        )
    (captured,) = _events(dispatch, "baseline.captured")
    assert set(captured) == {
        "id",
        "project",
        "name",
        "has_cpm_dates",
        "task_count",
        "created_by",
        "source",
        "reason_code",
        "reason",
        "commitment_moved",
        "changeset_id",
        "decision_id",
        "from_baseline_id",
    }
    # The capture names the decision it resolves under the same key baseline.kept
    # uses, and the baseline it replaces; ``id`` is the new baseline.
    assert captured["decision_id"] == captured["changeset_id"] == str(row.pk)
    assert captured["from_baseline_id"] == str(row.from_baseline_id)
    assert captured["id"] == str(row.to_baseline_id)
    assert captured["reason_code"] == "scope_change"
    assert captured["reason"] == "Owner added scope"
    # Derived from the decision, not asserted: the row and the event agree, and a
    # True is refused until #3901 (test below), so both are False today.
    assert captured["commitment_moved"] is row.commitment_moved is False
    assert captured["changeset_id"] == str(row.pk)
    assert _events(dispatch, "baseline.kept") == []

    # A plain (non-decision) capture keeps the unchanged payload.
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        baselines.capture(committed, owner, "Named snapshot", active=False, source="api")
    (plain,) = _events(dispatch, "baseline.captured")
    assert "reason_code" not in plain
    assert "changeset_id" not in plain


# --- #5131 sprint scope requests --------------------------------------------


_SCOPE_KEYS = {
    "id",
    "sprint",
    "project",
    "task",
    "status",
    "kind",
    "goal_impact",
    "requested_by",
    "decided_by",
    "added_at",
    "source",
}
_SLIP_KEYS = {"batch_id", "proposed_start", "proposed_finish", "proposed_duration"}


@pytest.fixture
def active_sprint(committed: Project) -> Sprint:
    sprint = Sprint.objects.create(
        project=committed,
        name="S1",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 13),
        state=SprintState.ACTIVE,
    )
    Task.objects.filter(project=committed).update(sprint=sprint)
    return sprint


def _slip(task: Task, sprint: Sprint, by: Any, **kw: Any) -> Any:
    from trueppm_api.apps.projects.services import record_commitment_slip

    return record_commitment_slip(
        task=task,
        sprint=sprint,
        by=by,
        proposed_start=task.planned_start,
        proposed_finish=date(2026, 3, 27),
        proposed_duration=task.duration + 5,
        base_start=task.planned_start,
        base_duration=task.duration,
        **kw,
    )


@pytest.mark.django_db
def test_a_direct_slip_with_a_reason_is_a_decision(
    committed: Project, owner: Any, active_sprint: Sprint, django_capture_on_commit_callbacks: Any
) -> None:
    task = Task.objects.filter(project=committed).first()
    assert task is not None
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        _slip(task, active_sprint, owner, status="accepted", reason="Vendor late")
    (changed,) = _events(dispatch, "sprint.scope_changed")
    assert set(changed) == _SCOPE_KEYS | _SLIP_KEYS | {"item_name", "closed_by"}  # D6 amendment
    assert changed["status"] == "accepted"
    assert changed["closed_by"] == "person"
    assert changed["kind"] == "slip"
    assert changed["decided_by"] == str(owner.pk)
    assert _events(dispatch, "sprint.scope_change_requested") == []


@pytest.mark.django_db
def test_a_pending_slip_requests_and_its_reject_decides(
    committed: Project, owner: Any, active_sprint: Sprint, django_capture_on_commit_callbacks: Any
) -> None:
    from trueppm_api.apps.projects.services import reject_scope_change

    task = Task.objects.filter(project=committed).first()
    assert task is not None
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        row = _slip(task, active_sprint, owner)
    (requested,) = _events(dispatch, "sprint.scope_change_requested")
    assert set(requested) == _SCOPE_KEYS | _SLIP_KEYS
    assert _events(dispatch, "sprint.scope_changed") == []

    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        reject_scope_change(row, owner)
    (changed,) = _events(dispatch, "sprint.scope_changed")
    assert changed["id"] == str(row.pk)
    assert changed["status"] == "rejected"
    assert changed["decided_by"] == str(owner.pk)
    assert changed["closed_by"] == "person"


@pytest.mark.django_db
def test_a_pending_slip_accept_decides(
    committed: Project, owner: Any, active_sprint: Sprint, django_capture_on_commit_callbacks: Any
) -> None:
    from trueppm_api.apps.projects.services import accept_scope_change

    task = Task.objects.filter(project=committed).first()
    assert task is not None
    row = _slip(task, active_sprint, owner)
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        accept_scope_change(row, owner, reason="Fine")
    (changed,) = _events(dispatch, "sprint.scope_changed")
    assert changed["id"] == str(row.pk)
    assert changed["status"] == "accepted"


@pytest.mark.django_db
def test_a_superseded_slip_is_closed_by_the_system_on_the_wire(
    committed: Project, owner: Any, active_sprint: Sprint, django_capture_on_commit_callbacks: Any
) -> None:
    """A superseded slip got a scope_change_requested; it must also get its close."""
    task = Task.objects.filter(project=committed).first()
    assert task is not None
    first = _slip(task, active_sprint, owner)
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        second = _slip(task, active_sprint, owner)
    first.refresh_from_db()
    assert first.status == "rejected" and first.decided_by_id is None
    (closed,) = _events(dispatch, "sprint.scope_changed")
    assert set(closed) == _SCOPE_KEYS | _SLIP_KEYS | {"item_name", "closed_by"}
    assert closed["id"] == str(first.pk)
    assert closed["status"] == "rejected"
    assert closed["decided_by"] is None
    assert closed["closed_by"] == "system"
    assert [e["id"] for e in _events(dispatch, "sprint.scope_change_requested")] == [str(second.pk)]


@pytest.mark.django_db
def test_a_slip_found_stale_on_accept_is_closed_by_the_system_on_the_wire(
    committed: Project, owner: Any, active_sprint: Sprint, django_capture_on_commit_callbacks: Any
) -> None:
    """Accepting a stale slip closes it unapplied: decided_by null, closed_by system."""
    from trueppm_api.apps.projects.services import accept_scope_change

    task = Task.objects.filter(project=committed).first()
    assert task is not None
    row = _slip(task, active_sprint, owner)
    # The task's dates move after the proposal, so the stored dates are stale.
    Task.objects.filter(pk=task.pk).update(duration=task.duration + 1)
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        accept_scope_change(row, owner, reason="Fine")
    row.refresh_from_db()
    assert row.status == "rejected" and row.decided_by_id is None
    (closed,) = _events(dispatch, "sprint.scope_changed")
    assert closed["id"] == str(row.pk)
    assert closed["status"] == "rejected"
    assert closed["decided_by"] is None
    assert closed["closed_by"] == "system"


@pytest.mark.django_db
def test_an_injection_request_fires_scope_change_requested(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    sprint = Sprint.objects.create(
        project=committed,
        name="S1",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 13),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.filter(project=committed).first()
    assert task is not None
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        sc = record_sprint_scope_change(task, sprint, owner)
    (payload,) = _events(dispatch, "sprint.scope_change_requested")
    assert payload == {
        "id": str(sc.pk),
        "sprint": str(sprint.pk),
        "project": str(committed.pk),
        "task": str(task.pk),
        "status": "pending",
        "kind": "injection",
        "goal_impact": False,
        "requested_by": str(owner.pk),
        "decided_by": None,
        "added_at": sc.added_at.isoformat(),
        "source": "api",
    }
    # ADR-1485 D6: a new event carries no names beyond the actor.
    assert "item_name" not in payload
    assert _events(dispatch, "sprint.scope_changed") == []


# --- #5131 undo --------------------------------------------------------------


@pytest.mark.django_db
def test_undo_fires_change_undone_with_the_reversed_event_id(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    from trueppm_api.apps.projects.models import StructuralOperation
    from trueppm_api.apps.projects.structural_operation_services import (
        undo_structural_operation,
    )

    task = Task.objects.filter(project=committed).first()
    assert task is not None
    op = StructuralOperation.objects.create(
        project=committed,
        applied_by=owner,
        kind="indent",
        anchor_task_ids=[str(task.pk)],
        created_task_ids=[],
        deleted_task_ids=[],
        shape_before={},
        shape_after={},
    )
    with (
        patch.object(views, "_dispatch_webhooks") as dispatch,
        patch(
            "trueppm_api.apps.projects.structural_operation_services."
            "broadcast_tasks_restructured_and_recalc"
        ),
        django_capture_on_commit_callbacks(execute=True),
    ):
        undo_structural_operation(op, undone_by=owner)
        undo_structural_operation(op, undone_by=owner)  # idempotent: no second event
    (payload,) = _events(dispatch, "schedule.change_undone")
    assert set(payload) == {
        "project",
        "event_id",
        "operation_kind",
        "undone_by",
        "applied_by",
        "undone_at",
        "summary",
    }
    assert payload["event_id"] == str(op.pk)
    assert payload["undone_by"] == str(owner.pk)


# --- replay + dead letter ----------------------------------------------------


def _webhook(project: Project, admin: Any) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s" * 40,
        events=["baseline.kept"],
        created_by=admin,
    )


def _failed_delivery(webhook: Webhook, status: str = DeliveryStatus.FAILED) -> WebhookDelivery:
    return WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="baseline.kept",
        payload={"project": "x", "_meta": {"sequence": 1}},
        status=status,
        attempt_count=5,
        response_status=500,
    )


def _replay_url(project: Project, webhook: Webhook, delivery: WebhookDelivery) -> str:
    return f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/{delivery.pk}/replay/"


@pytest.mark.django_db
def test_replay_requeues_a_failed_delivery_under_the_same_identity(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    hook = _webhook(committed, owner)
    delivery = _failed_delivery(hook)
    sequence = delivery.sequence_number
    before = delivery.created_at
    c = APIClient()
    c.force_authenticate(user=owner)
    with (
        patch("trueppm_api.apps.webhooks.views.deliver_webhook") as task,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = c.post(_replay_url(committed, hook, delivery))
    assert resp.status_code == 202
    assert resp.json() == {"queued": True, "delivery_id": str(delivery.pk)}
    task.delay.assert_called_once_with(str(delivery.pk))
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.PENDING
    assert delivery.attempt_count == 0
    assert delivery.sequence_number == sequence
    # The drain clock restarts, so the next drain tick does not resend it.
    assert delivery.created_at > before


@pytest.mark.django_db
def test_commitment_moved_cannot_be_taken_until_the_field_exists(
    committed: Project, owner: Any
) -> None:
    """If #3901 lifts this refusal, ``commitment_moved`` starts flowing from the input."""
    with pytest.raises(baselines.DecisionRefused) as refused:
        baselines.decide(
            committed,
            user=owner,
            data=baselines.DecisionInput(
                kind="taken", reason_code="scope_change", reason="x", commitment_moved=True
            ),
        )
    assert refused.value.body == {"code": "commitment_not_available"}


@pytest.mark.django_db
def test_two_dispatches_of_a_replayed_delivery_send_one_request(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    from datetime import timedelta as td
    from unittest.mock import MagicMock

    from django.utils import timezone

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    hook = _webhook(committed, owner)
    delivery = _failed_delivery(hook)
    # An old dead letter: before the fix, its created_at put it straight back in
    # the drain's stranded selector the moment replay reset it to PENDING.
    WebhookDelivery.objects.filter(pk=delivery.pk).update(created_at=timezone.now() - td(days=3))
    c = APIClient()
    c.force_authenticate(user=owner)
    with (
        patch("trueppm_api.apps.webhooks.views.deliver_webhook"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert c.post(_replay_url(committed, hook, delivery)).status_code == 202

    sent: list[object] = []

    def ok(req: object, **kwargs: object) -> MagicMock:
        sent.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=ok),
        patch.object(wh_tasks.deliver_webhook, "delay") as drained,
    ):
        wh_tasks._do_drain_webhooks()  # the next drain tick
        assert drained.call_count == 0
        wh_tasks.deliver_webhook.run(str(delivery.pk))  # the replay's own dispatch
        wh_tasks.deliver_webhook.run(str(delivery.pk))  # any late duplicate
    assert len(sent) == 1
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.SUCCESS


def _program_hook(owner: Any) -> tuple[Any, Webhook]:
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.projects.models import Program

    program = Program.objects.create(name="Prog")
    ProgramMembership.objects.create(program=program, user=owner, role=Role.ADMIN)
    hook = Webhook.objects.create(
        program=program,
        url="https://example.com/hook",
        secret="s" * 40,
        events=["baseline.kept"],
        created_by=owner,
    )
    return program, hook


def _program_replay_url(program: Any, hook: Webhook, delivery: WebhookDelivery) -> str:
    return f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/deliveries/{delivery.pk}/replay/"


@pytest.mark.django_db
def test_program_replay_is_registrant_only(
    owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    from trueppm_api.apps.access.models import ProgramMembership

    program, hook = _program_hook(owner)
    delivery = _failed_delivery(hook)
    other_admin = get_user_model().objects.create_user(username="ev-padmin", password="pw")
    ProgramMembership.objects.create(program=program, user=other_admin, role=Role.ADMIN)
    oc = APIClient()
    oc.force_authenticate(user=other_admin)
    assert oc.post(_program_replay_url(program, hook, delivery)).status_code == 403

    c = APIClient()
    c.force_authenticate(user=owner)
    with (
        patch("trueppm_api.apps.webhooks.views.deliver_webhook") as task,
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert c.post(_program_replay_url(program, hook, delivery)).status_code == 202
    task.delay.assert_called_once_with(str(delivery.pk))


@pytest.mark.django_db
def test_replay_is_not_lifecycle_gated(
    committed: Project, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """A closed program's and an archived project's dead letters stay replayable.

    A closed program's webhook keeps delivering child-project events, so its dead
    letters keep accruing; like ``deliveries`` and ``test_ping``, replay changes no
    program or project state and is not refused by the lifecycle gates.
    """
    program, program_hook = _program_hook(owner)
    program.is_closed = True
    program.save(update_fields=["is_closed"])
    program_delivery = _failed_delivery(program_hook)

    project_hook = _webhook(committed, owner)
    project_delivery = _failed_delivery(project_hook)
    Project.objects.filter(pk=committed.pk).update(is_archived=True)

    c = APIClient()
    c.force_authenticate(user=owner)
    with (
        patch("trueppm_api.apps.webhooks.views.deliver_webhook") as task,
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert (
            c.post(_program_replay_url(program, program_hook, program_delivery)).status_code == 202
        )
        assert c.post(_replay_url(committed, project_hook, project_delivery)).status_code == 202
    assert task.delay.call_count == 2


@pytest.mark.django_db
def test_replay_cannot_reach_another_scopes_delivery(committed: Project, owner: Any) -> None:
    """IDOR: a delivery id from another project's or another program's webhook is 404."""
    elsewhere = Project.objects.create(name="Other", start_date=date(2026, 3, 2))
    ProjectMembership.objects.create(project=elsewhere, user=owner, role=Role.OWNER)
    foreign_project_delivery = _failed_delivery(_webhook(elsewhere, owner))
    program, program_hook = _program_hook(owner)
    foreign_program_delivery = _failed_delivery(program_hook)

    mine = _webhook(committed, owner)
    c = APIClient()
    c.force_authenticate(user=owner)
    for foreign in (foreign_project_delivery, foreign_program_delivery):
        assert c.post(_replay_url(committed, mine, foreign)).status_code == 404
        foreign.refresh_from_db()
        assert foreign.status == DeliveryStatus.FAILED
    # And the program route cannot reach a project webhook's delivery.
    assert (
        c.post(_program_replay_url(program, program_hook, foreign_project_delivery)).status_code
        == 404
    )


@pytest.mark.django_db
def test_replay_refuses_a_delivery_that_is_not_dead_lettered(
    committed: Project, owner: Any
) -> None:
    hook = _webhook(committed, owner)
    c = APIClient()
    c.force_authenticate(user=owner)
    for status in (DeliveryStatus.SUCCESS, DeliveryStatus.PENDING):
        d = _failed_delivery(hook, status)
        assert c.post(_replay_url(committed, hook, d)).status_code == 409


@pytest.mark.django_db
def test_replay_refuses_an_inactive_subscription_and_unknown_delivery(
    committed: Project, owner: Any
) -> None:
    hook = _webhook(committed, owner)
    d = _failed_delivery(hook)
    c = APIClient()
    c.force_authenticate(user=owner)
    Webhook.objects.filter(pk=hook.pk).update(is_active=False)
    assert c.post(_replay_url(committed, hook, d)).status_code == 409
    ghost = WebhookDelivery(pk=uuid.uuid4())
    assert c.post(_replay_url(committed, hook, ghost)).status_code == 404


@pytest.mark.django_db
def test_replay_is_scoped_to_the_webhooks_own_deliveries(committed: Project, owner: Any) -> None:
    mine = _webhook(committed, owner)
    other = _webhook(committed, owner)
    d = _failed_delivery(other)
    c = APIClient()
    c.force_authenticate(user=owner)
    assert c.post(_replay_url(committed, mine, d)).status_code == 404


@pytest.mark.django_db
def test_replay_refused_for_a_member_and_a_full_access_token(
    committed: Project, owner: Any
) -> None:
    from tests.apps.webhooks.test_webhooks_manage_scope import _client_and_token
    from trueppm_api.apps.projects.models import SCOPE_API_FULL, SCOPE_WEBHOOKS_MANAGE

    hook = _webhook(committed, owner)
    d = _failed_delivery(hook)

    member = get_user_model().objects.create_user(username="ev-member", password="pw")
    ProjectMembership.objects.create(project=committed, user=member, role=Role.MEMBER)
    mc = APIClient()
    mc.force_authenticate(user=member)
    assert mc.post(_replay_url(committed, hook, d)).status_code == 403

    full, _ = _client_and_token(owner, [SCOPE_API_FULL])
    assert full.post(_replay_url(committed, hook, d)).status_code == 403
    d.refresh_from_db()
    assert d.status == DeliveryStatus.FAILED

    manage, _ = _client_and_token(owner, [SCOPE_WEBHOOKS_MANAGE])
    with patch("trueppm_api.apps.webhooks.views.deliver_webhook"):
        assert manage.post(_replay_url(committed, hook, d)).status_code == 202


@pytest.mark.django_db
def test_dead_letter_list_filters_by_status(committed: Project, owner: Any) -> None:
    hook = _webhook(committed, owner)
    failed = _failed_delivery(hook)
    _failed_delivery(hook, DeliveryStatus.SUCCESS)
    c = APIClient()
    c.force_authenticate(user=owner)
    base = f"/api/v1/projects/{committed.pk}/webhooks/{hook.pk}/deliveries/"
    resp = c.get(base, {"status": "failed"})
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()["results"]] == [str(failed.pk)]
    assert c.get(base, {"status": "bogus"}).status_code == 400
