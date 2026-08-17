"""API endpoint tests for VelocitySuggestionViewSet (ADR-0065)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling.models import VelocitySuggestion

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
        completed_points=20,
    )


@pytest.fixture
def task(project: Project, sprint: Sprint) -> Task:
    return Task.objects.create(
        project=project,
        name="Build",
        duration=2,
        most_likely_duration=2,
        sprint=sprint,
        story_points=5,
    )


@pytest.fixture
def suggestion(task: Task, sprint: Sprint) -> VelocitySuggestion:
    return VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=3,
        team_velocity_per_day=Decimal("1.667"),
    )


def _client_for(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Auth + membership gates
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_requires_authentication(suggestion: VelocitySuggestion) -> None:
    resp = APIClient().get("/api/v1/velocity-suggestions/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_list_returns_only_member_projects(
    project: Project, suggestion: VelocitySuggestion
) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.VIEWER)

    outsider_resp = _client_for(outsider).get("/api/v1/velocity-suggestions/")
    assert outsider_resp.status_code == 200
    assert outsider_resp.json()["count"] == 0

    member_resp = _client_for(member).get("/api/v1/velocity-suggestions/")
    assert member_resp.status_code == 200
    assert member_resp.json()["count"] == 1


@pytest.mark.django_db
def test_list_filter_by_task(
    project: Project, sprint: Sprint, task: Task, suggestion: VelocitySuggestion
) -> None:
    other_task = Task.objects.create(
        project=project, name="Other", duration=1, sprint=sprint, story_points=2
    )
    VelocitySuggestion.objects.create(
        task=other_task,
        sprint=sprint,
        suggested_duration=1,
        team_velocity_per_day=Decimal("2.000"),
    )
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).get(f"/api/v1/velocity-suggestions/?task={task.id}")
    assert resp.status_code == 200
    ids = [row["id"] for row in resp.json()["results"]]
    assert str(suggestion.id) in ids
    assert len(ids) == 1


@pytest.mark.django_db
def test_list_filter_pending_only(
    project: Project, sprint: Sprint, task: Task, suggestion: VelocitySuggestion
) -> None:
    from django.utils import timezone

    # Add a dismissed sibling — it should be filtered out by pending=true.
    other_task = Task.objects.create(
        project=project, name="Done", duration=1, sprint=sprint, story_points=2
    )
    VelocitySuggestion.objects.create(
        task=other_task,
        sprint=sprint,
        suggested_duration=1,
        team_velocity_per_day=Decimal("2.000"),
        dismissed_at=timezone.now(),
    )
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).get("/api/v1/velocity-suggestions/?pending=true")
    assert resp.status_code == 200
    rows = resp.json()["results"]
    assert len(rows) == 1
    assert rows[0]["id"] == str(suggestion.id)


# ---------------------------------------------------------------------------
# Accept
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_accept(project: Project, task: Task, suggestion: VelocitySuggestion) -> None:
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_scheduler_cannot_accept(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    scheduler = User.objects.create_user(username="sched", password="pw")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)

    resp = _client_for(scheduler).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 403


@pytest.mark.django_db(transaction=True)
def test_admin_accept_writes_duration_and_enqueues_cpm(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_result = MagicMock()
        mock_result.id = "celery-id"
        mock_task.delay = MagicMock(return_value=mock_result)

        resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")

    assert resp.status_code == 200
    suggestion.refresh_from_db()
    task.refresh_from_db()
    assert task.most_likely_duration == 3  # Was 2; suggestion was 3.
    assert suggestion.accepted_at is not None
    assert suggestion.accepted_by_id == pm.pk
    assert suggestion.dismissed_at is None
    # CPM recompute enqueued.
    mock_task.delay.assert_called_once_with(str(project.pk))


@pytest.mark.django_db
def test_accept_refuses_when_it_would_break_three_point_ordering(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    """#2002: accept writes most_likely alone; guard the resulting triple.

    Task has a complete estimate (opt=1, pess=2); the suggested most_likely of 3
    would violate optimistic <= most_likely <= pessimistic. Refuse with 422 and
    leave the task and suggestion untouched, rather than persisting a triple the
    scheduler rejects at compute time.
    """
    task.optimistic_duration = 1
    task.pessimistic_duration = 2
    task.save(update_fields=["optimistic_duration", "pessimistic_duration"])
    assert suggestion.suggested_duration == 3  # breaks 1 <= 3 <= 2

    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")

    assert resp.status_code == 422
    task.refresh_from_db()
    suggestion.refresh_from_db()
    assert task.most_likely_duration == 2  # unchanged
    assert suggestion.accepted_at is None


@pytest.mark.django_db(transaction=True)
def test_accept_succeeds_with_valid_complete_three_point_estimate(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    """The guard is a no-op when the suggested most_likely keeps the triple ordered."""
    task.optimistic_duration = 1
    task.pessimistic_duration = 5
    task.save(update_fields=["optimistic_duration", "pessimistic_duration"])
    assert suggestion.suggested_duration == 3  # 1 <= 3 <= 5 is valid

    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")

    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.most_likely_duration == 3


@pytest.mark.django_db
def test_accept_idempotent_when_already_accepted(
    project: Project, suggestion: VelocitySuggestion
) -> None:
    from django.utils import timezone

    suggestion.accepted_at = timezone.now()
    suggestion.save(update_fields=["accepted_at"])
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_accept_after_dismiss_is_409(project: Project, suggestion: VelocitySuggestion) -> None:
    from django.utils import timezone

    suggestion.dismissed_at = timezone.now()
    suggestion.save(update_fields=["dismissed_at"])
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Dismiss
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_dismiss(project: Project, suggestion: VelocitySuggestion) -> None:
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_admin_dismiss_stamps_audit_only(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 200
    suggestion.refresh_from_db()
    task.refresh_from_db()
    assert suggestion.dismissed_at is not None
    assert suggestion.dismissed_by_id == pm.pk
    assert suggestion.accepted_at is None
    # Task duration untouched.
    assert task.most_likely_duration == 2


@pytest.mark.django_db
def test_dismiss_after_accept_is_409(project: Project, suggestion: VelocitySuggestion) -> None:
    from django.utils import timezone

    suggestion.accepted_at = timezone.now()
    suggestion.save(update_fields=["accepted_at"])
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 409


@pytest.mark.django_db
def test_team_velocity_per_day_suppressed_for_below_audience_reader(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    """#949/#1099: ``team_velocity_per_day`` is the same point-based velocity number
    the ADR-0104 gate strips from /velocity/, and ``suggested_duration`` is computed
    *from* it. A reader below the velocity audience (here a PM at the default
    team-private posture, who is suppressed on /velocity/) must not recover either
    from the calibration-suggestion surface, while an in-audience MEMBER reads both."""
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)
    member = User.objects.create_user(username="dev", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    pm_row = (
        _client_for(pm).get(f"/api/v1/velocity-suggestions/?task={task.id}").json()["results"][0]
    )
    # Both the raw rate and the value derived from it are stripped (#1099).
    assert pm_row["team_velocity_per_day"] is None
    assert pm_row["suggested_duration"] is None

    member_row = (
        _client_for(member)
        .get(f"/api/v1/velocity-suggestions/?task={task.id}")
        .json()["results"][0]
    )
    assert member_row["team_velocity_per_day"] is not None
    assert member_row["suggested_duration"] is not None


@pytest.mark.django_db
def test_dismiss_response_suppresses_team_velocity_for_below_audience(
    project: Project, suggestion: VelocitySuggestion
) -> None:
    """#949/#1099: the accept/dismiss action responses build the serializer too — they
    must carry request context so the velocity gate fires there as well. A PM
    (suppressed by default) must not recover team_velocity_per_day or the
    velocity-derived suggested_duration from a dismiss."""
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 200
    assert resp.json()["team_velocity_per_day"] is None
    assert resp.json()["suggested_duration"] is None


@pytest.mark.django_db
def test_accept_still_applies_suggested_duration_when_suppressed_for_pm(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    """#1099 must not break the write path: accept reads suggested_duration from the
    *model*, not the serialized (suppressed) value, so a PM whose read is gated still
    applies the calibration. Only the visible number is hidden, not the action."""
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 200
    # Response is gated...
    assert resp.json()["suggested_duration"] is None
    # ...but the task duration was set from the model's real value.
    task.refresh_from_db()
    assert task.most_likely_duration == suggestion.suggested_duration


@pytest.mark.django_db
def test_serializer_fails_closed_without_request_context(
    suggestion: VelocitySuggestion,
) -> None:
    """#1099: the velocity gate cannot establish a reader's tier without request
    context, so a render with no request in context must suppress both the raw
    rate and the velocity-derived suggestion rather than leak them. Exercises the
    fail-closed branch the HTTP views never hit (they always carry a request)."""
    from trueppm_api.apps.scheduling.serializers import VelocitySuggestionSerializer

    data = VelocitySuggestionSerializer(suggestion, context={}).data

    assert data["team_velocity_per_day"] is None
    assert data["suggested_duration"] is None


# ---------------------------------------------------------------------------
# Live-update broadcasts (#2845)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAcceptDismissBroadcast:
    """Both decisions mutate shared state; before #2845 neither emitted anything.

    Accept's ``enqueue_recalculate`` does not cover it: ``most_likely_duration`` is a
    Monte Carlo input absent from ``_CPM_DELTA_FIELDS``, so the recalc's
    ``task_dates_updated`` delta — built only from tasks whose ``_CPM_DELTA_FIELDS``
    moved — will not carry this task, and the ``cpm_complete`` that does fire
    unconditionally is documented client-side as pill-and-stats only (ADR-0091).
    """

    @staticmethod
    def _admin(project: Project) -> APIClient:
        user = User.objects.create_user(username="pm2845", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
        return _client_for(user)

    def test_accept_broadcasts_the_task_field_change_and_the_settlement(
        self,
        project: Project,
        task: Task,
        suggestion: VelocitySuggestion,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast,
            patch("trueppm_api.apps.sync.broadcast.broadcast_task_updated", MagicMock()) as tupd,
        ):
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                resp = self._admin(project).post(
                    f"/api/v1/velocity-suggestions/{suggestion.pk}/accept/"
                )
            assert resp.status_code == 200, resp.data

        tupd.assert_called_once()
        assert tupd.call_args.kwargs["changed_fields"] == ["most_likely_duration"]
        assert tupd.call_args.kwargs["task_id"] == str(task.pk)

        settled = [c for c in bcast.call_args_list if c.args[1].startswith("velocity_suggestion_")]
        assert len(settled) == 1
        assert settled[0].args[1] == "velocity_suggestion_accepted"
        assert settled[0].args[2] == {"id": str(suggestion.pk)}

    def test_dismiss_broadcasts_the_settlement(
        self,
        project: Project,
        suggestion: VelocitySuggestion,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast:
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                resp = self._admin(project).post(
                    f"/api/v1/velocity-suggestions/{suggestion.pk}/dismiss/"
                )
            assert resp.status_code == 200, resp.data

        settled = [c for c in bcast.call_args_list if c.args[1].startswith("velocity_suggestion_")]
        assert len(settled) == 1
        assert settled[0].args[1] == "velocity_suggestion_dismissed"
        assert settled[0].args[2] == {"id": str(suggestion.pk)}

    def test_an_idempotent_repeat_does_not_re_broadcast(
        self,
        project: Project,
        suggestion: VelocitySuggestion,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """A second dismiss returns 200 from the idempotency guard and writes nothing.

        Re-broadcasting on a no-op would make every client re-read for a change that
        did not happen — the guard returns before the UPDATE, so it must return
        before the broadcast too.
        """
        client = self._admin(project)
        with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
            client.post(f"/api/v1/velocity-suggestions/{suggestion.pk}/dismiss/")

        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast:
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                resp = client.post(f"/api/v1/velocity-suggestions/{suggestion.pk}/dismiss/")
            assert resp.status_code == 200
        assert not [c for c in bcast.call_args_list if c.args[1].startswith("velocity_suggestion_")]
