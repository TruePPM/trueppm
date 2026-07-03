"""Percent-complete behavior when a task's duration changes (ADR-0151, #414).

When a user edit changes a task's ``duration``, ``task_duration_change_percent_policy``
decides what happens to its ``percent_complete``:

- ``keep`` (default): the PM-entered ``%`` is the source of truth — leave it untouched.
- ``prorate``: scale ``% = round(old% * old_dur / new_dur, 1)`` clamped to [0, 100],
  unless the same payload set ``%`` explicitly (the caller wins).
- ``confirm``: keep ``%`` server-side; the client offers an inline re-estimate.

The policy is inheritable Workspace → Program → Project (ADR-0135 pattern). Every
qualifying change records exactly one :class:`TaskDurationChangeEvent` and broadcasts
the WS-only ``task_duration_changed`` event on commit. No event is recorded when the
duration is unchanged, the task is a milestone, or progress is zero (the summary-task
exclusion — ``validate`` keeps summary ``%`` at 0).

Covers: model/workspace defaults, resolver precedence under SUGGEST, the ENFORCE
enterprise seam (OSS no-op + active-provider lock), the three serializer policies,
the caller-wins guard, the unchanged / milestone / zero-progress no-ops, the audit
event fields, the sprint-aware capture, the on-commit broadcast, and the read
``@action`` (member read + IDOR 404).
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DurationChangePercentPolicy,
    DurationChangeSource,
    Program,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskDurationChangeEvent,
)
from trueppm_api.apps.projects.task_duration_settings import (
    register_duration_policy_enforcement_provider,
    resolve_effective_duration_policy,
    resolve_inherited_duration_policy,
)
from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


def _project(calendar: Calendar, **kw: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar, **kw)


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def enterprise_lock() -> Iterator[None]:
    """Register an active enforcement provider and clear it on teardown.

    OSS registers no provider; a test that wants ENFORCE to lock must register one
    and MUST clear it (module-global state) or it leaks into later tests.
    """
    register_duration_policy_enforcement_provider(lambda: True)
    try:
        yield
    finally:
        register_duration_policy_enforcement_provider(None)


def _set_workspace_policy(
    value: str = DurationChangePercentPolicy.KEEP,
    override_policy: str = TermOverridePolicy.SUGGEST,
) -> Workspace:
    ws = Workspace.load()
    ws.task_duration_change_percent_policy = value
    ws.task_duration_change_percent_override_policy = override_policy
    ws.save()
    return ws


def _patch(client: APIClient, task: Task, data: dict[str, Any]) -> Any:
    """PATCH a task with scheduling + broadcast mocked out (both async, irrelevant here)."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        return client.patch(f"/api/v1/tasks/{task.pk}/", data, format="json")


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_defaults_to_keep_and_suggest() -> None:
    """A fresh workspace keeps percent-complete by default and allows overrides."""
    ws = Workspace.load()
    assert ws.task_duration_change_percent_policy == DurationChangePercentPolicy.KEEP
    assert ws.task_duration_change_percent_override_policy == TermOverridePolicy.SUGGEST


@pytest.mark.django_db
def test_program_and_project_override_default_to_inherit(calendar: Calendar) -> None:
    """The Program/Project override fields are NULL (= inherit) until set."""
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)
    assert prog.task_duration_change_percent_policy is None
    assert p.task_duration_change_percent_policy is None


# ---------------------------------------------------------------------------
# Resolver precedence (no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_project_override_wins(calendar: Calendar) -> None:
    """SUGGEST: a project's own override beats program and workspace."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    prog = Program.objects.create(
        name="Prog", task_duration_change_percent_policy=DurationChangePercentPolicy.CONFIRM
    )
    p = _project(
        calendar,
        program=prog,
        task_duration_change_percent_policy=DurationChangePercentPolicy.PRORATE,
    )

    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.PRORATE
    # inherited skips the project's own override → the program tier (confirm).
    assert resolve_inherited_duration_policy(p) == DurationChangePercentPolicy.CONFIRM


@pytest.mark.django_db
def test_resolver_program_override_inherited_by_project(calendar: Calendar) -> None:
    """SUGGEST: a project with no override inherits its program's override."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    prog = Program.objects.create(
        name="Prog", task_duration_change_percent_policy=DurationChangePercentPolicy.PRORATE
    )
    p = _project(calendar, program=prog)

    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.PRORATE
    assert resolve_inherited_duration_policy(p) == DurationChangePercentPolicy.PRORATE


@pytest.mark.django_db
def test_resolver_falls_through_to_workspace(calendar: Calendar) -> None:
    """SUGGEST: project + program both unset → the workspace value applies."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)

    assert resolve_effective_duration_policy(prog) == DurationChangePercentPolicy.PRORATE
    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.PRORATE


@pytest.mark.django_db
def test_resolver_standalone_project_uses_workspace(calendar: Calendar) -> None:
    """A project with no program resolves directly against the workspace."""
    _set_workspace_policy(DurationChangePercentPolicy.CONFIRM)
    p = _project(calendar)
    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.CONFIRM


# ---------------------------------------------------------------------------
# ENFORCE enterprise seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_enforce_is_noop_in_oss(calendar: Calendar) -> None:
    """ENFORCE with no provider (OSS default) degrades to SUGGEST: the override wins."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP, TermOverridePolicy.ENFORCE)
    p = _project(calendar, task_duration_change_percent_policy=DurationChangePercentPolicy.PRORATE)
    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.PRORATE


@pytest.mark.django_db
def test_enforce_locks_to_workspace_when_provider_active(
    calendar: Calendar, enterprise_lock: None
) -> None:
    """ENFORCE + active provider: the workspace value is mandatory; overrides are lost."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP, TermOverridePolicy.ENFORCE)
    prog = Program.objects.create(
        name="Prog", task_duration_change_percent_policy=DurationChangePercentPolicy.PRORATE
    )
    p = _project(
        calendar,
        program=prog,
        task_duration_change_percent_policy=DurationChangePercentPolicy.CONFIRM,
    )

    assert resolve_effective_duration_policy(prog) == DurationChangePercentPolicy.KEEP
    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.KEEP
    # inherited under a lock is the (ceiling) workspace value too.
    assert resolve_inherited_duration_policy(p) == DurationChangePercentPolicy.KEEP


@pytest.mark.django_db
def test_suggest_never_locks_even_with_provider(calendar: Calendar, enterprise_lock: None) -> None:
    """SUGGEST never locks, even when a provider is active."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP, TermOverridePolicy.SUGGEST)
    p = _project(calendar, task_duration_change_percent_policy=DurationChangePercentPolicy.PRORATE)
    assert resolve_effective_duration_policy(p) == DurationChangePercentPolicy.PRORATE


# ---------------------------------------------------------------------------
# Serializer behavior — keep (default)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_keep_leaves_percent_untouched_and_records_event(
    admin_client: APIClient, project: Project
) -> None:
    """Default KEEP: a duration change leaves % alone but still records an event."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    r = _patch(admin_client, task, {"duration": 20})
    assert r.status_code == 200

    task.refresh_from_db()
    assert task.duration == 20
    assert task.percent_complete == 50.0  # untouched — PM value is source of truth

    event = TaskDurationChangeEvent.objects.get(task=task)
    assert event.old_duration == 10
    assert event.new_duration == 20
    assert event.percent_complete_at_change == 50.0
    assert event.percent_complete_after is None
    assert event.policy_applied == DurationChangePercentPolicy.KEEP
    assert event.source == DurationChangeSource.USER_EDIT


# ---------------------------------------------------------------------------
# Serializer behavior — prorate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_prorate_scales_percent_down_when_duration_grows(
    admin_client: APIClient, project: Project
) -> None:
    """PRORATE: doubling duration halves % (same work is now a smaller fraction)."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    r = _patch(admin_client, task, {"duration": 20})
    assert r.status_code == 200

    task.refresh_from_db()
    assert task.percent_complete == 25.0  # 50 * 10 / 20

    event = TaskDurationChangeEvent.objects.get(task=task)
    assert event.policy_applied == DurationChangePercentPolicy.PRORATE
    assert event.percent_complete_after == 25.0


@pytest.mark.django_db
def test_prorate_clamps_to_100(admin_client: APIClient, project: Project) -> None:
    """PRORATE: shrinking duration enough to exceed 100% clamps at 100."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=80.0)

    r = _patch(admin_client, task, {"duration": 4})  # 80 * 10 / 4 = 200 → clamp 100
    assert r.status_code == 200

    task.refresh_from_db()
    assert task.percent_complete == 100.0


@pytest.mark.django_db
def test_prorate_caller_wins_when_percent_explicit(
    admin_client: APIClient, project: Project
) -> None:
    """PRORATE: if the same payload sets % explicitly, the caller's value is kept."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    r = _patch(admin_client, task, {"duration": 20, "percent_complete": 60})
    assert r.status_code == 200

    task.refresh_from_db()
    assert task.percent_complete == 60.0  # caller's explicit value, not the prorated 25

    event = TaskDurationChangeEvent.objects.get(task=task)
    # No server-applied proration → percent_complete_after is null.
    assert event.percent_complete_after is None


# ---------------------------------------------------------------------------
# Serializer behavior — confirm
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_confirm_keeps_percent_and_records_event(admin_client: APIClient, project: Project) -> None:
    """CONFIRM: % is kept server-side (the client renders an inline confirm)."""
    _set_workspace_policy(DurationChangePercentPolicy.CONFIRM)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=40.0)

    r = _patch(admin_client, task, {"duration": 15})
    assert r.status_code == 200

    task.refresh_from_db()
    assert task.percent_complete == 40.0  # untouched server-side

    event = TaskDurationChangeEvent.objects.get(task=task)
    assert event.policy_applied == DurationChangePercentPolicy.CONFIRM
    assert event.percent_complete_after is None


# ---------------------------------------------------------------------------
# No-op cases — no event recorded
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_no_event_when_duration_unchanged(admin_client: APIClient, project: Project) -> None:
    """Editing other fields without changing duration records nothing."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    r = _patch(admin_client, task, {"duration": 10, "name": "Renamed"})
    assert r.status_code == 200
    assert not TaskDurationChangeEvent.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_no_event_when_progress_zero(admin_client: APIClient, project: Project) -> None:
    """A not-started task (0%) has no progress to protect — no event (summary-safe)."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=0.0)

    r = _patch(admin_client, task, {"duration": 20})
    assert r.status_code == 200

    task.refresh_from_db()
    assert task.percent_complete == 0.0  # not prorated
    assert not TaskDurationChangeEvent.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_no_event_for_milestone(admin_client: APIClient, project: Project) -> None:
    """Milestones are zero-duration gates — excluded from the policy entirely."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(
        project=project, name="M", duration=5, percent_complete=50.0, is_milestone=True
    )

    r = _patch(admin_client, task, {"duration": 10})
    assert r.status_code == 200
    assert not TaskDurationChangeEvent.objects.filter(task=task).exists()


# ---------------------------------------------------------------------------
# Actor + sprint capture
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_event_records_actor(admin_client: APIClient, project: Project) -> None:
    """The acting user is recorded on the event for attribution."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    _patch(admin_client, task, {"duration": 20})

    event = TaskDurationChangeEvent.objects.get(task=task)
    assert event.actor is not None
    assert event.actor.get_username() == "pm"


@pytest.mark.django_db
def test_event_records_active_sprint(admin_client: APIClient, project: Project) -> None:
    """A task in an ACTIVE sprint records the sprint, so it can surface on burndown."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(
        project=project, name="T", duration=10, percent_complete=50.0, sprint=sprint
    )

    _patch(admin_client, task, {"duration": 20})

    event = TaskDurationChangeEvent.objects.get(task=task)
    assert event.sprint_id == sprint.pk


@pytest.mark.django_db
def test_event_omits_non_active_sprint(admin_client: APIClient, project: Project) -> None:
    """A task in a PLANNED sprint records no sprint (only live sprints surface)."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )
    task = Task.objects.create(
        project=project, name="T", duration=10, percent_complete=50.0, sprint=sprint
    )

    _patch(admin_client, task, {"duration": 20})

    event = TaskDurationChangeEvent.objects.get(task=task)
    assert event.sprint_id is None


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_broadcasts_task_duration_changed_on_commit(
    admin_client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A qualifying duration change broadcasts the WS-only task_duration_changed event."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
        # Patch the recalc enqueue seam (not .delay) so executing the on-commit
        # callbacks fires our broadcast without the real ScheduleRequest bookkeeping.
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = admin_client.patch(f"/api/v1/tasks/{task.pk}/", {"duration": 20}, format="json")
    assert r.status_code == 200

    duration_calls = [c for c in broadcast.call_args_list if c.args[1] == "task_duration_changed"]
    assert len(duration_calls) == 1
    args = duration_calls[0].args
    assert args[0] == str(project.pk)
    payload = args[2]
    assert payload["task_id"] == str(task.pk)
    assert payload["old_duration"] == 10
    assert payload["new_duration"] == 20
    assert payload["policy_applied"] == DurationChangePercentPolicy.PRORATE
    assert payload["percent_complete_after"] == 25.0


# ---------------------------------------------------------------------------
# Read @action
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_duration_events_action_returns_newest_first(
    admin_client: APIClient, project: Project
) -> None:
    """GET /tasks/{id}/duration-events/ lists the task's events, newest first."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    _patch(admin_client, task, {"duration": 20})
    task.refresh_from_db()
    _patch(admin_client, task, {"duration": 30})

    r = admin_client.get(f"/api/v1/tasks/{task.pk}/duration-events/")
    assert r.status_code == 200
    results = r.data["results"]
    assert len(results) == 2
    # Newest first: the 20→30 change precedes the 10→20 change.
    assert results[0]["old_duration"] == 20
    assert results[0]["new_duration"] == 30
    assert results[1]["old_duration"] == 10
    assert results[0]["actor_name"] == "pm"


@pytest.mark.django_db
def test_duration_events_action_404_for_outsider(project: Project, calendar: Calendar) -> None:
    """A non-member gets 404 (IDOR-safe) — the queryset hides foreign projects."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    task = Task.objects.create(project=project, name="T", duration=10, percent_complete=50.0)

    outsider = User.objects.create_user(username="nobody", password="pw")
    client = APIClient()
    client.force_authenticate(user=outsider)

    r = client.get(f"/api/v1/tasks/{task.pk}/duration-events/")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Per-sprint read @action (issue 1254 — sprint changes-log feed)
# ---------------------------------------------------------------------------


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )


@pytest.mark.django_db
def test_sprint_duration_events_returns_captured_events(
    admin_client: APIClient, project: Project
) -> None:
    """GET /sprints/{id}/duration-events/ returns the sprint's duration changes."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)
    sprint = _active_sprint(project)
    task = Task.objects.create(
        project=project, name="Design", duration=10, percent_complete=50.0, sprint=sprint
    )

    _patch(admin_client, task, {"duration": 20})

    r = admin_client.get(f"/api/v1/sprints/{sprint.pk}/duration-events/")
    assert r.status_code == 200
    events = r.data["events"]
    assert len(events) == 1
    ev = events[0]
    assert ev["task_id"] == str(task.pk)
    assert ev["task_name"] == "Design"
    assert ev["old_duration"] == 10
    assert ev["new_duration"] == 20
    assert ev["policy_applied"] == DurationChangePercentPolicy.PRORATE
    assert ev["percent_complete_after"] == 25.0
    assert ev["actor_name"] == "pm"


@pytest.mark.django_db
def test_sprint_duration_events_empty_when_none(admin_client: APIClient, project: Project) -> None:
    """A sprint with no duration changes returns an empty feed, not an error."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    sprint = _active_sprint(project)

    r = admin_client.get(f"/api/v1/sprints/{sprint.pk}/duration-events/")
    assert r.status_code == 200
    assert r.data["events"] == []


@pytest.mark.django_db
def test_sprint_duration_events_forbidden_for_outsider(
    project: Project, calendar: Calendar
) -> None:
    """A non-member is denied — object-permission check rejects (mirrors scope-changes)."""
    _set_workspace_policy(DurationChangePercentPolicy.KEEP)
    sprint = _active_sprint(project)

    outsider = User.objects.create_user(username="nobody", password="pw")
    client = APIClient()
    client.force_authenticate(user=outsider)

    r = client.get(f"/api/v1/sprints/{sprint.pk}/duration-events/")
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Serializer surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_effective_policy(
    admin_client: APIClient, project: Project
) -> None:
    """The project payload carries the server-resolved effective policy."""
    _set_workspace_policy(DurationChangePercentPolicy.PRORATE)

    r = admin_client.get(f"/api/v1/projects/{project.pk}/")
    assert r.status_code == 200
    assert (
        r.data["effective_task_duration_change_percent_policy"]
        == DurationChangePercentPolicy.PRORATE
    )
    assert r.data["task_duration_change_percent_policy"] is None  # no own override
