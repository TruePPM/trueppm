"""Integration tests for the seed v2 event-replay importer (ADR-0114, #1074).

These exercise the replay engine end-to-end: a v2 seed with an explicit anchor
(for determinism) is imported and we assert the demo reads as a program that has
*run* — backdated history that traverses every column, real burndown snapshots,
the scope-injection audit row, baseline-vs-actual actuals — and that replay does
not leak a live side effect (no today-dated burndown).
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    EstimateStatus,
    Project,
    RetroActionItem,
    Risk,
    ScopeChangeStatus,
    Sprint,
    SprintBurnSnapshot,
    SprintRetro,
    SprintScopeChange,
    SprintState,
    SprintTaskDisposition,
    SprintTaskOutcome,
    Task,
    TaskComment,
    TaskStatus,
)
from trueppm_api.apps.projects.seed import import_seed

pytestmark = pytest.mark.django_db

User = get_user_model()

# Explicit, clearly-past anchor so every resolved date is deterministic and
# safely before "today" regardless of when CI runs.
ANCHOR = "2026-02-01"


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="replay-owner", email="o@example.com")


def _v2_seed() -> dict[str, Any]:
    """One agile project, one completed sprint, three tasks at distinct end states."""
    return {
        "schema_version": "2.0",
        "anchor": ANCHOR,
        "program": {"slug": "demo", "name": "Demo", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "demo-alex", "display_name": "Alex", "role": "OWNER"},
            {"slug": "priya", "username": "demo-priya", "display_name": "Priya", "role": "MEMBER"},
        ],
        "calendars": [{"slug": "std", "name": "Std 5-day", "working_days": 31}],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "agile_features": True,
                "start_date": "A-25",
                "calendar": "std",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "COMPLETED",
                        "start_date": "A-20",
                        "finish_date": "A-6",
                        "committed_points": 10,
                        "completed_points": 8,
                    }
                ],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build auth",
                        "type": "story",
                        "status": "COMPLETE",
                        "story_points": 5,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                    {
                        # Ends in flight at an authored 40%. Replay births it at
                        # 0% to walk it forward, so the number only survives if
                        # the finalize pass restores it (#3486). Declares no
                        # remaining_points, so its dated task.points beat below
                        # stays authoritative for that field.
                        "wbs_path": "2",
                        "name": "Wire login UI",
                        "type": "story",
                        "status": "IN_PROGRESS",
                        "percent_complete": 40.0,
                        "story_points": 3,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                    {
                        "wbs_path": "3",
                        "name": "Rate limiting",
                        "type": "story",
                        "status": "NOT_STARTED",
                        "story_points": 2,
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                    {
                        # Injected mid-sprint then rejected — exercises the
                        # scope_resolve REJECTED path (task drops out of the sprint).
                        "wbs_path": "4",
                        "name": "Telemetry",
                        "type": "story",
                        "status": "NOT_STARTED",
                        "story_points": 2,
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                    {
                        # In flight with both progress fields authored and no
                        # events of its own — the pure synthesized path, where
                        # nothing but the finalize pass can put 25% / 3 points
                        # remaining back (#3486).
                        "wbs_path": "5",
                        "name": "Session storage",
                        "type": "story",
                        "status": "IN_PROGRESS",
                        "percent_complete": 25.0,
                        "story_points": 5,
                        "remaining_points": 3,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                ],
                "risks": [
                    {
                        "slug": "r1",
                        "title": "Auth vendor risk",
                        "status": "OPEN",
                        "probability": 4,
                        "impact": 4,
                    }
                ],
            }
        ],
        "events": [
            # Authored sprint lifecycle — drives the activate/close handlers
            # (the synthesizer is suppressed for sprints the timeline touches).
            {
                "at": "A-20T09:00",
                "actor": "alex",
                "action": "sprint.activate",
                "target": "sprint:core:s1",
            },
            {
                "at": "A-18T12:00",
                "actor": "alex",
                "action": "baseline.capture",
                "target": "project:core",
                "body": "Sprint 1 commitment baseline",
            },
            {
                "at": "A-15T10:00",
                "actor": "alex",
                "action": "task.comment",
                "target": "task:core:1",
                "body": "Auth flow reviewed — looks good.",
            },
            {
                "at": "A-14T09:00",
                "actor": "priya",
                "action": "task.assign",
                "target": "task:core:2",
                "assignee": "alex",
            },
            {
                "at": "A-14T10:00",
                "actor": "priya",
                "action": "task.estimate",
                "target": "task:core:2",
                "estimate": {"optimistic": 2, "most_likely": 3, "pessimistic": 5},
            },
            {
                "at": "A-13T10:00",
                "actor": "priya",
                "action": "task.ac_met",
                "target": "task:core:2",
            },
            {
                "at": "A-12T11:00",
                "actor": "priya",
                "action": "sprint.scope_inject",
                "target": "task:core:3",
                "goal_impact": True,
            },
            {
                "at": "A-11T11:00",
                "actor": "priya",
                "action": "sprint.scope_inject",
                "target": "task:core:4",
            },
            {
                "at": "A-10T09:00",
                "actor": "alex",
                "action": "risk.status",
                "target": "risk:r1",
                "from": "OPEN",
                "to": "MITIGATING",
            },
            {
                "at": "A-9T10:00",
                "actor": "priya",
                "action": "task.points",
                "target": "task:core:2",
                "remaining_points": 2,
            },
            {
                "at": "A-8T11:00",
                "actor": "alex",
                "action": "sprint.scope_resolve",
                "target": "task:core:4",
                "to": "REJECTED",
            },
            {
                "at": "A-6T17:00",
                "actor": "alex",
                "action": "sprint.close",
                "target": "sprint:core:s1",
                "goal_outcome": "PARTIAL",
            },
        ],
    }


@pytest.fixture
def program(owner: Any) -> Any:
    return import_seed(_v2_seed(), owner=owner, create_users=True)


def _task(program: Any, wbs: str) -> Task:
    return Task.objects.get(project__program=program, wbs_path=wbs)


def test_complete_task_traverses_every_column(program: Any) -> None:
    task = _task(program, "1")
    statuses = set(task.history.values_list("status", flat=True))
    # The synthesizer must walk the task through IN_PROGRESS and REVIEW, never
    # NOT_STARTED -> COMPLETE (a hollow burndown — VoC/Alex).
    assert {
        TaskStatus.NOT_STARTED,
        TaskStatus.IN_PROGRESS,
        TaskStatus.REVIEW,
        TaskStatus.COMPLETE,
    } <= statuses
    assert task.status == TaskStatus.COMPLETE  # final live state matches the seed


def test_history_is_backdated_not_import_time(program: Any) -> None:
    task = _task(program, "1")
    dates = {h.history_date.date() for h in task.history.all()}
    assert len(dates) >= 2  # a progression over time, not one instant
    assert max(dates) <= date.fromisoformat(ANCHOR)  # all before "today" (the anchor)


def test_history_attributed_to_named_people(program: Any) -> None:
    task = _task(program, "1")
    # The assignee (priya) drives the synthesized progression; the authored
    # comment is by alex. At least one row is attributed to a real persona user.
    users = {h.history_user_id for h in task.history.all() if h.history_user_id}
    assert users  # not a single anonymous importer


def test_burndown_is_real_multi_day_history(program: Any) -> None:
    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    snaps = SprintBurnSnapshot.objects.filter(sprint=sprint)
    assert snaps.count() >= 2  # a curve, not a single fabricated point
    assert max(s.snapshot_date for s in snaps) <= date.fromisoformat(ANCHOR)


def test_no_today_dated_burndown_leak(program: Any) -> None:
    # If the live task_status_changed receiver were not suppressed during replay
    # it would stamp a snapshot dated today; assert none leaked.
    assert not SprintBurnSnapshot.objects.filter(snapshot_date=date.today()).exists()


def test_relative_dates_resolved_against_anchor(program: Any) -> None:
    project = Project.objects.get(program=program, name="Core")
    # A-25 from 2026-02-01 = 2026-01-07 (a Wednesday, working day, no snap).
    assert project.start_date == date(2026, 1, 7)


def test_risk_status_event_replayed(program: Any) -> None:
    risk = Risk.objects.get(project__program=program, title="Auth vendor risk")
    assert risk.status == "MITIGATING"
    assert "MITIGATING" in set(risk.history.values_list("status", flat=True))


def test_scope_injection_writes_audit_row(program: Any) -> None:
    task = _task(program, "3")
    assert SprintScopeChange.objects.filter(task=task).exists()
    assert task.sprint_pending is True


def test_completed_task_has_actuals_for_variance(program: Any) -> None:
    task = _task(program, "1")
    assert task.actual_start is not None
    assert task.actual_finish is not None


def test_comment_is_backdated(program: Any) -> None:
    task = _task(program, "1")
    comment = TaskComment.objects.get(task=task)
    assert comment.created_at.date() <= date.fromisoformat(ANCHOR)


def test_task_assign_event_replayed(program: Any) -> None:
    task = _task(program, "2")
    # The authored reassign moves the task from priya to alex.
    assert task.assignee is not None
    assert task.assignee.username == "demo-alex"


def test_task_estimate_event_replayed(program: Any) -> None:
    task = _task(program, "2")
    assert task.optimistic_duration == 2
    assert task.most_likely_duration == 3
    assert task.pessimistic_duration == 5
    # The estimate event marks the three-point estimate accepted.
    assert str(task.estimate_status) == str(EstimateStatus.ACCEPTED)


def test_task_points_event_replayed(program: Any) -> None:
    task = _task(program, "2")
    # task:core:2 stays IN_PROGRESS (never COMPLETE, which would zero this),
    # so the authored remaining_points survives to the end state.
    assert task.remaining_points == 2


def test_in_flight_task_keeps_authored_percent_after_replay(program: Any) -> None:
    """#3486: replay must not leave an IN_PROGRESS task at the 0% it was born at.

    The task is created at 0% so the timeline has room to walk it forward, and
    ``_apply_task_status`` writes only the column and the actual dates — so
    without the finalize restore the authored 40% is silently lost. This is the
    v2 replay path: the assertion is worthless on a v1 document, which never
    zeroes the field in the first place.
    """
    task = _task(program, "2")
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.percent_complete == 40.0


def test_in_flight_task_keeps_authored_remaining_points(program: Any) -> None:
    """#3486: an in-flight story reports its authored remaining points.

    Task 5 has no events at all, so the synthesizer alone walks it into
    IN_PROGRESS. Born with ``remaining_points = story_points`` (5), it must end
    at the authored 3 — the acceptance criterion that separates "some points
    burned" from "nothing started".
    """
    task = _task(program, "5")
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.percent_complete == 25.0
    assert task.remaining_points == 3
    assert task.story_points == 5


def test_authored_percent_restore_is_backdated_not_import_time(program: Any) -> None:
    """The restore writes history like every other replay write, not at import time."""
    task = _task(program, "5")
    dates = {h.history_date.date() for h in task.history.all()}
    assert max(dates) <= date.fromisoformat(ANCHOR)


def test_task_ac_met_sets_dor(program: Any) -> None:
    task = _task(program, "2")
    assert task.dor == "ready"


def test_authored_sprint_close_records_goal_outcome(program: Any) -> None:
    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    assert str(sprint.state) == str(SprintState.COMPLETED)
    assert sprint.goal_outcome == "PARTIAL"
    assert sprint.activated_at is not None
    assert sprint.closed_at is not None


def test_sprint_close_creates_outcome_row_per_member_task(program: Any) -> None:
    """#3488: the real close's SprintTaskOutcome snapshot now runs under replay.

    task4 was rejected out of the sprint by the scope_resolve beat *before*
    close, so it was never a member at close and correctly gets no row —
    contrasting with the three tasks that were still on the sprint.
    """
    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    task1, task2, task3, task5 = (
        _task(program, "1"),
        _task(program, "2"),
        _task(program, "3"),
        _task(program, "5"),
    )
    outcomes = {o.task_id: o for o in SprintTaskOutcome.objects.filter(sprint=sprint)}
    assert set(outcomes) == {task1.pk, task2.pk, task3.pk, task5.pk}
    assert str(outcomes[task1.pk].disposition) == str(SprintTaskDisposition.COMPLETED)
    # No later sprint exists in this fixture, so every incomplete member drops
    # to the backlog rather than carrying forward.
    for pk in (task2.pk, task3.pk, task5.pk):
        assert str(outcomes[pk].disposition) == str(SprintTaskDisposition.DROPPED)
        assert outcomes[pk].next_sprint_id is None
    # task3 was scope-injected (goal_impact beat above) and never resolved —
    # still pending at close (ADR-0102 §7).
    assert outcomes[task3.pk].was_pending is True
    assert outcomes[task2.pk].was_pending is False


def test_sprint_close_computes_velocity_suggestions_safely(program: Any) -> None:
    """#3488: the close now calls compute_velocity_suggestions; a single closed
    sprint has no history to calibrate from, so it must no-op rather than error."""
    from trueppm_api.apps.scheduling.models import VelocitySuggestion

    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    assert not VelocitySuggestion.objects.filter(sprint=sprint).exists()


def test_baseline_capture_creates_baseline_with_tasks(program: Any) -> None:
    project = Project.objects.get(program=program, name="Core")
    baseline = Baseline.objects.get(project=project, name="Sprint 1 commitment baseline")
    # The baseline snapshots the project's tasks at the beat time...
    assert BaselineTask.objects.filter(baseline=baseline).exists()
    # ...and its created_at is backdated, not stamped at import time.
    assert baseline.created_at.date() <= date.fromisoformat(ANCHOR)


def test_scope_resolve_reject_drops_task_from_sprint(program: Any) -> None:
    task = _task(program, "4")
    # A rejected injection removes the task from the sprint and clears pending.
    assert task.sprint is None
    assert task.sprint_pending is False
    change = SprintScopeChange.objects.get(task=task)
    assert str(change.status) == str(ScopeChangeStatus.REJECTED)


def test_replay_is_deterministic(owner: Any) -> None:
    p1 = import_seed(_v2_seed(), owner=owner, create_users=True)
    n1 = _task(p1, "1").history.count()
    # Re-import wipes and rebuilds; the seeded synthesizer must reproduce the
    # same number of history rows.
    p2 = import_seed(_v2_seed(), owner=owner, create_users=True, replace=True)
    n2 = _task(p2, "1").history.count()
    assert n1 == n2 >= 4


# --- retro.* replay (ADR-0114 §7a / #1109) ---------------------------------


def _retro_seed() -> dict[str, Any]:
    """One completed sprint with two retro action items, one promoted."""
    return {
        "schema_version": "2.0",
        "anchor": ANCHOR,
        "program": {"slug": "retro", "name": "Retro", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "retro-alex", "display_name": "Alex", "role": "OWNER"},
            {"slug": "priya", "username": "retro-priya", "display_name": "Priya", "role": "MEMBER"},
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "agile_features": True,
                "start_date": "A-25",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "COMPLETED",
                        "start_date": "A-20",
                        "finish_date": "A-6",
                        "committed_points": 5,
                        "completed_points": 5,
                    }
                ],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build auth",
                        "status": "COMPLETE",
                        "story_points": 5,
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    }
                ],
            }
        ],
        "events": [
            {
                "at": "A-6T17:30",
                "actor": "alex",
                "action": "retro.action",
                "target": "sprint:core:s1",
                "body": "Add integration tests",
                "assignee": "priya",
                "points": 3,
            },
            {
                "at": "A-6T17:35",
                "actor": "alex",
                "action": "retro.action",
                "target": "sprint:core:s1",
                "body": "Document the auth flow",
            },
            {
                "at": "A-5T09:00",
                "actor": "alex",
                "action": "retro.promote",
                "target": "sprint:core:s1",
                "body": "Add integration tests",
            },
        ],
    }


@pytest.fixture
def retro_program(owner: Any) -> Any:
    return import_seed(_retro_seed(), owner=owner, create_users=True)


def test_retro_action_creates_retro_and_items(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    retro = SprintRetro.objects.get(sprint=sprint)
    items = RetroActionItem.objects.filter(retro=retro).order_by("created_at")
    assert items.count() == 2
    first = items.first()
    assert first is not None
    assert first.text == "Add integration tests"
    assert first.assignee is not None and first.assignee.username == "retro-priya"
    assert first.story_points == 3


def test_retro_action_item_is_backdated(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    item = RetroActionItem.objects.filter(retro__sprint=sprint).order_by("created_at").first()
    assert item is not None
    assert item.created_at.date() <= date.fromisoformat(ANCHOR)


def test_retro_promote_creates_backlog_task(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    item = RetroActionItem.objects.get(retro__sprint=sprint, text="Add integration tests")
    # The promoted item links to a real project-backlog task (status BACKLOG,
    # sprint None) — the retro→task loop the demo shows closed.
    assert item.promoted_task_id is not None
    task = Task.objects.get(pk=item.promoted_task_id)
    assert task.status == TaskStatus.BACKLOG
    assert task.sprint_id is None
    assert task.name == "Add integration tests"
    assert task.project_id == sprint.project_id


def test_retro_promote_only_promotes_matching_item(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    other = RetroActionItem.objects.get(retro__sprint=sprint, text="Document the auth flow")
    assert other.promoted_task_id is None  # only the matched body was promoted


def test_v1_seed_has_no_replay(owner: Any) -> None:
    """A v1 document still materializes final state with a single creation row."""
    v1 = {
        "schema_version": "1.0",
        "program": {"slug": "v1demo", "name": "V1", "methodology": "AGILE"},
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "2026-01-05",
                "tasks": [{"wbs_path": "1", "name": "Done thing", "status": "COMPLETE"}],
            }
        ],
    }
    program = import_seed(v1, owner=owner, create_users=True)
    task = _task(program, "1")
    assert task.status == TaskStatus.COMPLETE
    assert task.history.count() == 1  # no backdated progression


# ---------------------------------------------------------------------------
# ADR-1153 (#3709) — defense-in-depth: a beat that would produce an invalid
# actual-date pair does not persist it. Real seed beats are deterministic,
# developer-authored data and should never trip this; this proves the guard
# directly against ``_apply_task_status`` rather than relying on a real seed
# document happening to exercise it.
# ---------------------------------------------------------------------------


def test_beat_producing_an_invalid_actual_pair_drops_the_bad_field() -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from trueppm_api.apps.projects.models import Calendar
    from trueppm_api.apps.projects.seed.replay import ReplayContext, _apply_task_status, _Beat

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Replay target", start_date=date(2026, 3, 2), calendar=calendar
    )
    task = Task.objects.create(
        project=project,
        name="T",
        duration=3,
        status=TaskStatus.IN_PROGRESS,
        # Later than the finish the COMPLETE beat below would stamp — an
        # inverted pair if both landed as written.
        actual_start=date(2026, 3, 20),
    )
    ctx = ReplayContext(
        anchor=date(2026, 3, 2),
        program_code="p",
        default_actor=None,
        users={},
        tasks={("p", "1"): task},
        sprints={},
        projects={"p": project},
        project_calendars={},
        risks={},
        final_status={},
        final_sprint={},
    )
    beat = _Beat(
        when=datetime(2026, 3, 10, 12, 0, tzinfo=ZoneInfo("UTC")),
        order=0,
        action="task.status",
        target="task:p:1",
        actor=None,
        data={"to": "COMPLETE"},
    )

    _apply_task_status(beat, ctx)

    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE
    # The beat would stamp actual_finish = 2026-03-10, which precedes the
    # pre-existing actual_start of 2026-03-20 — the order rule drops the
    # finish rather than persisting the inverted pair.
    assert task.actual_finish is None
    assert task.actual_start == date(2026, 3, 20)


# ---------------------------------------------------------------------------
# #3488 — sprint.close routes through the real close contract (ADR-0176):
# carried-over tasks get disposition=carried with next_sprint set, dropped
# tasks (incomplete, no carry target) get disposition=dropped, and a
# synthesized close derives a real goal_outcome instead of leaving it None.
# Exercised directly against ``_apply_sprint_close`` (like the ADR-1153 test
# above) rather than a full seed document, so the carry-over destination
# (a second, later-starting sprint that actually runs) is under precise
# control.
# ---------------------------------------------------------------------------


def test_sprint_close_carries_incomplete_tasks_to_the_next_running_sprint() -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from trueppm_api.apps.projects.models import Calendar
    from trueppm_api.apps.projects.seed.replay import ReplayContext, _apply_sprint_close, _Beat

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Carry-over target", start_date=date(2026, 1, 1), calendar=calendar
    )
    closing = Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
    )
    # The next sprint the project actually runs — the implied carry-over
    # destination, standing in for "the next sprint.activate beat implies".
    next_sprint = Sprint.objects.create(
        project=project,
        name="Sprint 2",
        start_date=date(2026, 1, 15),
        finish_date=date(2026, 1, 28),
        state=SprintState.PLANNED,
    )
    completed = Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        status=TaskStatus.COMPLETE,
        story_points=5,
        sprint=closing,
    )
    carried_not_started = Task.objects.create(
        project=project,
        name="Not started",
        duration=1,
        status=TaskStatus.NOT_STARTED,
        story_points=3,
        sprint=closing,
    )
    carried_in_progress = Task.objects.create(
        project=project,
        name="In flight",
        duration=1,
        status=TaskStatus.IN_PROGRESS,
        story_points=2,
        sprint=closing,
        sprint_pending=True,
    )
    dropped_on_hold = Task.objects.create(
        project=project,
        name="On hold",
        duration=1,
        status=TaskStatus.ON_HOLD,
        story_points=1,
        sprint=closing,
    )

    ctx = ReplayContext(
        anchor=date(2026, 2, 1),
        program_code="p",
        default_actor=None,
        users={},
        tasks={},
        sprints={("p", "s1"): closing, ("p", "s2"): next_sprint},
        projects={"p": project},
        project_calendars={},
        risks={},
        final_status={},
        # The next sprint actually runs (ACTIVE) in the seed's intent — it is
        # not merely PLANNED-and-never-touched, which would not qualify as a
        # carry-over destination.
        final_sprint={("p", "s2"): {"state": SprintState.ACTIVE}},
    )
    beat = _Beat(
        when=datetime(2026, 1, 14, 17, 0, tzinfo=ZoneInfo("UTC")),
        order=0,
        action="sprint.close",
        target="sprint:p:s1",
        actor=None,
        data={},  # synthesized close — no authored goal_outcome
    )

    _apply_sprint_close(beat, ctx)

    closing.refresh_from_db()
    assert closing.state == SprintState.COMPLETED
    assert closing.closed_at == beat.when  # backdated to the beat, not now()
    # completed=5 / committed=10 -> PARTIAL, derived rather than left None.
    assert closing.goal_outcome == "PARTIAL"

    outcomes = {o.task_id: o for o in SprintTaskOutcome.objects.filter(sprint=closing)}
    assert str(outcomes[completed.pk].disposition) == str(SprintTaskDisposition.COMPLETED)
    assert outcomes[completed.pk].next_sprint_id is None

    for task in (carried_not_started, carried_in_progress):
        assert str(outcomes[task.pk].disposition) == str(SprintTaskDisposition.CARRIED)
        assert outcomes[task.pk].next_sprint_id == next_sprint.pk

    assert outcomes[carried_in_progress.pk].was_pending is True
    assert outcomes[carried_not_started.pk].was_pending is False

    # ON_HOLD is outside apply_carry_over's move set — dropped, not carried.
    assert str(outcomes[dropped_on_hold.pk].disposition) == str(SprintTaskDisposition.DROPPED)
    assert outcomes[dropped_on_hold.pk].next_sprint_id is None

    # apply_carry_over physically moved the two carried tasks; a sprint-target
    # carry (unlike carry-to-backlog) reassigns the FK only, never the status.
    carried_not_started.refresh_from_db()
    carried_in_progress.refresh_from_db()
    dropped_on_hold.refresh_from_db()
    assert carried_not_started.sprint_id == next_sprint.pk
    assert carried_not_started.status == TaskStatus.NOT_STARTED
    assert carried_in_progress.sprint_id == next_sprint.pk
    assert carried_in_progress.status == TaskStatus.IN_PROGRESS
    assert dropped_on_hold.sprint_id == closing.pk  # never moved


def test_sprint_close_authored_goal_outcome_overrides_the_derived_default() -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from trueppm_api.apps.projects.models import Calendar
    from trueppm_api.apps.projects.seed.replay import ReplayContext, _apply_sprint_close, _Beat

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Override target", start_date=date(2026, 1, 1), calendar=calendar
    )
    sprint = Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
    )
    Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        status=TaskStatus.COMPLETE,
        story_points=10,
        sprint=sprint,
    )
    ctx = ReplayContext(
        anchor=date(2026, 2, 1),
        program_code="p",
        default_actor=None,
        users={},
        tasks={},
        sprints={("p", "s1"): sprint},
        projects={"p": project},
        project_calendars={},
        risks={},
        final_status={},
        final_sprint={},
    )
    beat = _Beat(
        when=datetime(2026, 1, 14, 17, 0, tzinfo=ZoneInfo("UTC")),
        order=0,
        action="sprint.close",
        target="sprint:p:s1",
        actor=None,
        # completed=10 / committed=10 would derive MET; the author's editorial
        # call (e.g. "hit the points but missed the actual goal") must win.
        data={"goal_outcome": "MISSED"},
    )

    _apply_sprint_close(beat, ctx)

    sprint.refresh_from_db()
    assert sprint.goal_outcome == "MISSED"


# ---------------------------------------------------------------------------
# #3488 — a document that describes a task the close already carried back to
# the backlog. That is what an *export* of such a program looks like (the
# exporter writes each task's current state), and it says two things no
# hand-authored seed ever said: the task holds no sprint, and its final column
# is BACKLOG — which is off the progression spine the synthesizer walks.
# ---------------------------------------------------------------------------


def _backlog_seed(*, moved_by_the_timeline: bool) -> dict[str, Any]:
    """A one-sprint seed whose only task ends at BACKLOG.

    ``moved_by_the_timeline`` picks which of the two kinds of BACKLOG task it
    is, and the two must import differently: a task the timeline *moves* there
    has to be born NOT_STARTED so the beat is a real transition, while an
    ordinary backlog item — which nothing would ever move — has to be born
    where it belongs, since the synthesizer refuses to walk anything to BACKLOG.
    """
    events: list[dict[str, Any]] = [
        {
            "at": "A-20T09:00",
            "actor": "alex",
            "action": "sprint.activate",
            "target": "sprint:core:s1",
        },
        {
            "at": "A-6T17:00",
            "actor": "alex",
            "action": "sprint.close",
            "target": "sprint:core:s1",
        },
    ]
    if moved_by_the_timeline:
        events.append(
            {
                "at": "A-6T17:00",
                "actor": "alex",
                "action": "task.status",
                "target": "task:core:1",
                "from": "NOT_STARTED",
                "to": "BACKLOG",
            }
        )
    return {
        "schema_version": "2.0",
        "anchor": ANCHOR,
        "program": {"slug": "carried", "name": "Carried", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "carried-alex", "display_name": "Alex", "role": "OWNER"}
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "A-25",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "COMPLETED",
                        "start_date": "A-20",
                        "finish_date": "A-6",
                        "committed_points": 2,
                    }
                ],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Rate limiting",
                        "status": "BACKLOG",
                        "story_points": 2,
                        "delivery_mode": "scrum",
                    }
                ],
            }
        ],
        "events": events,
    }


def test_a_task_the_timeline_moves_to_backlog_is_born_not_started(owner: Any) -> None:
    # Born already at BACKLOG the beat is a no-op, so no history row exists and
    # the re-export drops the event — the #616 round-trip break this fixes.
    program = import_seed(_backlog_seed(moved_by_the_timeline=True), owner=owner, create_users=True)
    task = _task(program, "1")
    assert task.status == TaskStatus.BACKLOG
    assert set(task.history.values_list("status", flat=True)) == {
        TaskStatus.NOT_STARTED,
        TaskStatus.BACKLOG,
    }


def test_a_plain_backlog_task_is_born_and_stays_at_backlog(owner: Any) -> None:
    # The other side of the same widening: nothing would ever move this one, so
    # birthing it NOT_STARTED would strand it there for good.
    program = import_seed(
        _backlog_seed(moved_by_the_timeline=False), owner=owner, create_users=True
    )
    task = _task(program, "1")
    assert task.status == TaskStatus.BACKLOG
    assert set(task.history.values_list("status", flat=True)) == {TaskStatus.BACKLOG}


def test_scope_injection_on_a_task_that_has_left_the_sprint_still_writes_its_row(
    owner: Any,
) -> None:
    """The injected sprint is derived from the beat's instant when the task has none.

    An exported program whose close carried the injected task to the backlog
    describes it as sprintless, so ``task.sprint`` can no longer name the sprint
    the still-PENDING audit row belongs to; the sprint running at the beat does.
    """
    doc = _backlog_seed(moved_by_the_timeline=True)
    doc["events"].append(
        {
            "at": "A-12T11:00",
            "actor": "alex",
            "action": "sprint.scope_inject",
            "target": "task:core:1",
            "goal_impact": True,
        }
    )
    program = import_seed(doc, owner=owner, create_users=True)
    task = _task(program, "1")
    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    scope = SprintScopeChange.objects.get(task=task)
    assert scope.sprint_id == sprint.pk
    assert scope.status == ScopeChangeStatus.PENDING
    assert scope.goal_impact is True
    assert task.sprint_id is None  # the row is filed without re-adding the task
