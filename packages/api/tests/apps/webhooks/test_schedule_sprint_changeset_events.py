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
        "baseline.kept",
    ):
        assert name in WebhookEventType.values
        assert len(name) <= 30
    # sprint.commitment_at_risk has no emitter until #5127: not advertised.
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
            "agent_actor_id": None,
            "opened_at": entry.opened_at.isoformat(),
        },
    }


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
        "baseline_version",
        "note",
        "open_entries",
        "variance_wd",
        "actor",
    }
    assert kept["decision_id"] == str(row.pk)
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
    assert captured["reason_code"] == "scope_change"
    assert captured["reason"] == "Owner added scope"
    assert captured["commitment_moved"] is False
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
        "item_name": task.name,
        "status": "pending",
        "kind": "injection",
        "goal_impact": False,
        "requested_by": str(owner.pk),
        "decided_by": None,
        "added_at": sc.added_at.isoformat(),
        "source": "api",
    }
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
