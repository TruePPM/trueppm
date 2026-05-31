"""Mid-sprint scope-injection approve-gate tests (ADR-0102, #881).

Covers:
- the three math paths exclude pending tasks (committed/burndown/rollup);
- accept promotes into the commitment + recompute fires;
- reject removes from the sprint + writes history_change_reason;
- the team-owned gate: MEMBER is 403, and a non-member high-ordinal actor is
  403 *regardless of role ordinal* (the Enterprise back-door close, VoC 🔴 #1);
- no auto-accept: the guardrail/notify signal has zero input to status;
- bulk accept/reject (single sprint, ids + all-pending);
- close carry-over (pending re-flagged in next sprint) and close reject.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ScopeChangeStatus,
    Sprint,
    SprintCloseRequest,
    SprintScopeChange,
    SprintState,
    Task,
    TaskStatus,
    committed_sprint_tasks,
)
from trueppm_api.apps.projects.services import (
    ScopeAcceptForbidden,
    accept_scope_change,
    apply_pending_disposition,
    record_sprint_scope_change,
    reject_scope_change,
    snapshot_committed_metrics,
    upsert_burndown_for_sprint,
)

User = get_user_model()


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    """A user with NO ProjectMembership — the only way an org/PMO principal arrives."""
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def member(project: Project, member_user: object) -> object:
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    return member_user


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.ACTIVE,
        committed_points=8,
        committed_task_count=2,
    )


def _task(project: Project, name: str, **kwargs: object) -> Task:
    kwargs.setdefault("duration", 1)
    return Task.objects.create(project=project, name=name, **kwargs)


def _inject(task: Task, sprint: Sprint, by: object) -> SprintScopeChange:
    """Link a task to the active sprint and record a pending scope change."""
    task.sprint = sprint
    task.save(update_fields=["sprint"])
    return record_sprint_scope_change(task=task, sprint=sprint, by=by)


# --------------------------------------------------------------------------- #
# Math exclusion — pending contributes ZERO to each of the three paths.
# --------------------------------------------------------------------------- #


def test_committed_sprint_tasks_helper_excludes_pending(
    project: Project, sprint: Sprint, owner: object
) -> None:
    committed = _task(project, "Committed", sprint=sprint, story_points=5)
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    _inject(pending, sprint, owner)

    ids = set(committed_sprint_tasks(sprint.pk).values_list("pk", flat=True))
    assert committed.pk in ids
    assert pending.pk not in ids


def test_snapshot_committed_metrics_excludes_pending(
    project: Project, sprint: Sprint, owner: object
) -> None:
    _task(project, "Committed", sprint=sprint, story_points=5)
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    _inject(pending, sprint, owner)

    snapshot_committed_metrics(sprint)
    assert sprint.committed_points == 5
    assert sprint.committed_task_count == 1


def test_upsert_burndown_excludes_pending(project: Project, sprint: Sprint, owner: object) -> None:
    _task(project, "Committed", sprint=sprint, story_points=5, status=TaskStatus.IN_PROGRESS)
    pending = _task(
        project, "Pending", sprint=sprint, story_points=3, status=TaskStatus.IN_PROGRESS
    )
    _inject(pending, sprint, owner)

    upsert_burndown_for_sprint(sprint, snapshot_date=date(2026, 1, 6))
    snap = sprint.burn_snapshots.get(snapshot_date=date(2026, 1, 6))
    # Pending (3 pts) excluded — only the committed 5 pts remain.
    assert snap.remaining_points == 5
    assert snap.remaining_task_count == 1


def test_milestone_rollup_excludes_pending(project: Project, sprint: Sprint, owner: object) -> None:
    from trueppm_api.apps.projects.services import compute_milestone_rollup_payload

    milestone = _task(project, "M1", is_milestone=True, duration=0)
    sprint.target_milestone = milestone
    sprint.committed_points = 5
    sprint.save(update_fields=["target_milestone", "committed_points"])
    _task(project, "Committed", sprint=sprint, story_points=5, status=TaskStatus.COMPLETE)
    pending = _task(project, "Pending", sprint=sprint, story_points=3, status=TaskStatus.COMPLETE)
    _inject(pending, sprint, owner)

    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    # Pending completed task excluded from the numerator and the scope-change probe.
    assert payload["percent_complete"] == 100.0
    assert payload["sprint_scope_changed"] is False


# --------------------------------------------------------------------------- #
# Accept / reject happy paths.
# --------------------------------------------------------------------------- #


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_accept_promotes_into_commitment(
    _broadcast: object, project: Project, sprint: Sprint, owner: object
) -> None:
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)

    result = accept_scope_change(sc, owner)

    result.refresh_from_db()
    pending.refresh_from_db()
    assert result.status == ScopeChangeStatus.ACCEPTED
    assert pending.sprint_pending is False
    assert pending.sprint_id == sprint.pk  # still in the sprint
    # Now counted in the commitment math.
    assert pending.pk in set(committed_sprint_tasks(sprint.pk).values_list("pk", flat=True))


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_reject_removes_from_sprint_and_writes_history(
    _broadcast: object, project: Project, sprint: Sprint, owner: object
) -> None:
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)

    result = reject_scope_change(sc, owner)

    result.refresh_from_db()
    pending.refresh_from_db()
    assert result.status == ScopeChangeStatus.REJECTED
    assert pending.sprint_id is None  # removed from the sprint
    assert pending.sprint_pending is False
    latest = pending.history.first()
    assert latest.history_change_reason == "scope rejected — removed from sprint"


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_accept_is_idempotent(
    _broadcast: object, project: Project, sprint: Sprint, owner: object
) -> None:
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    accept_scope_change(sc, owner)
    # Second accept is a no-op — status stays ACCEPTED, no error.
    again = accept_scope_change(sc, owner)
    assert again.status == ScopeChangeStatus.ACCEPTED


# --------------------------------------------------------------------------- #
# Team-owned gate (VoC 🔴 #1 — the Enterprise back-door close).
# --------------------------------------------------------------------------- #


def test_member_cannot_accept(
    project: Project, sprint: Sprint, owner: object, member: object
) -> None:
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    with pytest.raises(ScopeAcceptForbidden):
        accept_scope_change(sc, member)


def test_non_member_high_ordinal_actor_is_forbidden(
    project: Project, sprint: Sprint, owner: object, outsider: object
) -> None:
    """A user holding NO ProjectMembership cannot accept — regardless of any role
    ordinal they might carry elsewhere. This is the structural close of the
    Enterprise/PMO back-door: org principals arrive without a project membership.
    """
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    # Even if the caller is a global superuser (a stand-in for a high-ordinal
    # custom Enterprise role), the membership-bound gate still 403s.
    outsider.is_superuser = True
    outsider.save(update_fields=["is_superuser"])
    with pytest.raises(ScopeAcceptForbidden):
        accept_scope_change(sc, outsider)
    with pytest.raises(ScopeAcceptForbidden):
        reject_scope_change(sc, outsider)


def test_member_high_role_not_admin_band_forbidden(
    project: Project, sprint: Sprint, owner: object
) -> None:
    """A SCHEDULER member (role 200, below ADMIN 300) cannot accept."""
    sched = User.objects.create_user(username="sched", password="pw")
    ProjectMembership.objects.create(project=project, user=sched, role=Role.SCHEDULER)
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    with pytest.raises(ScopeAcceptForbidden):
        accept_scope_change(sc, sched)


# --------------------------------------------------------------------------- #
# No auto-accept: the notify signal has zero input to status (ADR-0102 §3).
# --------------------------------------------------------------------------- #


def test_record_scope_change_only_ever_writes_pending(
    project: Project, sprint: Sprint, owner: object
) -> None:
    """The scope-change recorder (and its sprint_scope_changed signal) can only
    ever produce PENDING — there is no code path that flips status to ACCEPTED
    or REJECTED other than the two human-invoked services.
    """
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    sc.refresh_from_db()
    assert sc.status == ScopeChangeStatus.PENDING
    # The guardrail policy resolver path supplies policy, never an action — there
    # is no resolver hook that can set status. Confirm the helper default holds.
    sc2 = record_sprint_scope_change(
        task=_task(project, "Pending2", sprint=sprint), sprint=sprint, by=owner
    )
    assert sc2.status == ScopeChangeStatus.PENDING


# --------------------------------------------------------------------------- #
# Bulk accept / reject.
# --------------------------------------------------------------------------- #


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_bulk_accept_all_pending(
    _broadcast: object,
    owner_client: APIClient,
    project: Project,
    sprint: Sprint,
    owner: object,
) -> None:
    a = _task(project, "A", sprint=sprint, story_points=1)
    b = _task(project, "B", sprint=sprint, story_points=2)
    _inject(a, sprint, owner)
    _inject(b, sprint, owner)

    resp = owner_client.post(
        f"/api/v1/sprints/{sprint.pk}/scope-changes/accept/", {}, format="json"
    )
    assert resp.status_code == 200
    assert len(resp.data["accepted"]) == 2
    assert resp.data["pending_count"] == 0
    a.refresh_from_db()
    b.refresh_from_db()
    assert a.sprint_pending is False
    assert b.sprint_pending is False


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_bulk_reject_subset_by_ids(
    _broadcast: object,
    owner_client: APIClient,
    project: Project,
    sprint: Sprint,
    owner: object,
) -> None:
    a = _task(project, "A", sprint=sprint, story_points=1)
    b = _task(project, "B", sprint=sprint, story_points=2)
    sc_a = _inject(a, sprint, owner)
    _inject(b, sprint, owner)

    resp = owner_client.post(
        f"/api/v1/sprints/{sprint.pk}/scope-changes/reject/",
        {"ids": [str(sc_a.pk)]},
        format="json",
    )
    assert resp.status_code == 200
    assert len(resp.data["rejected"]) == 1
    # b is still pending.
    assert resp.data["pending_count"] == 1
    a.refresh_from_db()
    assert a.sprint_id is None


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_single_accept_endpoint(
    _broadcast: object,
    owner_client: APIClient,
    project: Project,
    sprint: Sprint,
    owner: object,
) -> None:
    a = _task(project, "A", sprint=sprint, story_points=1)
    sc = _inject(a, sprint, owner)
    resp = owner_client.post(f"/api/v1/scope-changes/{sc.pk}/accept/", {}, format="json")
    assert resp.status_code == 200
    assert resp.data["status"] == ScopeChangeStatus.ACCEPTED
    assert resp.data["pending_count"] == 0


def test_single_accept_endpoint_member_403(
    project: Project, sprint: Sprint, owner: object, member: object
) -> None:
    a = _task(project, "A", sprint=sprint, story_points=1)
    sc = _inject(a, sprint, owner)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(f"/api/v1/scope-changes/{sc.pk}/accept/", {}, format="json")
    assert resp.status_code == 403
    assert resp.data["code"] == "scope_accept_forbidden"


# --------------------------------------------------------------------------- #
# Close lifecycle — carry-over (re-flag pending in next sprint) and reject.
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> object:
    mock_client = MagicMock()
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


def _next_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 2",
        start_date=date(2026, 1, 17),
        finish_date=date(2026, 1, 30),
        state=SprintState.PLANNED,
    )


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_carry_over_reflags_pending_in_next_sprint(
    _broadcast: object, project: Project, sprint: Sprint, owner: object
) -> None:
    from trueppm_api.apps.projects.tasks import close_sprint

    target = _next_sprint(project)
    pending = _task(
        project, "Pending", sprint=sprint, story_points=3, status=TaskStatus.IN_PROGRESS
    )
    _inject(pending, sprint, owner)

    req = SprintCloseRequest.objects.create(
        sprint=sprint,
        requested_by=owner,
        carry_over_to=str(target.pk),
        pending_disposition="carry",
    )
    close_sprint.run(str(req.id))

    pending.refresh_from_db()
    assert pending.sprint_id == target.pk
    # Re-flagged pending in the incoming sprint with a fresh PENDING row.
    assert pending.sprint_pending is True
    fresh = SprintScopeChange.objects.filter(sprint=target, status=ScopeChangeStatus.PENDING)
    assert fresh.count() == 1


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_reject_disposition_removes_pending(
    _broadcast: object, project: Project, sprint: Sprint, owner: object
) -> None:
    from trueppm_api.apps.projects.tasks import close_sprint

    pending = _task(
        project, "Pending", sprint=sprint, story_points=3, status=TaskStatus.IN_PROGRESS
    )
    sc = _inject(pending, sprint, owner)

    req = SprintCloseRequest.objects.create(
        sprint=sprint,
        requested_by=owner,
        carry_over_to="backlog",
        pending_disposition="reject",
    )
    close_sprint.run(str(req.id))

    pending.refresh_from_db()
    sc.refresh_from_db()
    assert pending.sprint_id is None
    assert pending.sprint_pending is False
    assert sc.status == ScopeChangeStatus.REJECTED


def test_apply_pending_disposition_carry_to_backlog_clears_flag(
    project: Project, sprint: Sprint, owner: object
) -> None:
    """A pending task carried to the backlog (no sprint) has its flag cleared —
    there is no sprint for it to be pending in.
    """
    pending = _task(project, "Pending", sprint=sprint, story_points=3)
    _inject(pending, sprint, owner)
    # Simulate carry-over to backlog already moved it (sprint=None).
    pending.sprint = None
    pending.save(update_fields=["sprint"])
    apply_pending_disposition(sprint, "carry", by=owner)
    pending.refresh_from_db()
    assert pending.sprint_pending is False
