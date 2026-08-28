"""Aurora's pivot: the sprint history has to show work being abandoned and recovered.

These assert the *shape of the history*, not that fields are populated. A test
that checked "some sprint has goal_outcome MISSED" would pass against a sample
whose velocity never moved — the failure #3096 filed was precisely a pack where
every sprint marched forward at constant capacity and landed.
"""

import json
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Baseline, Project, Sprint, Task
from trueppm_api.apps.projects.seed.importer import import_seed

FIXTURE = (
    Path(__file__).resolve().parents[4]
    / "src/trueppm_api/apps/projects/fixtures/seeds/aurora-mobile-app.json"
)
DESCOPED = {"Receipt export", "Activity feed", "Bookmark sync"}


@pytest.fixture
def aurora(db):
    owner = get_user_model().objects.create_user(
        username="aurora-pivot-owner", email="pivot@example.com", password="pw"
    )
    program = import_seed(
        json.loads(FIXTURE.read_text()), owner=owner, create_users=True, replace=True
    )
    return Project.objects.get(program=program)


def _sprints(project):
    return list(Sprint.objects.filter(project=project).order_by("start_date"))


def test_velocity_dips_and_then_recovers(aurora):
    closed = [s for s in _sprints(aurora) if s.state == "COMPLETED"]
    assert len(closed) >= 4, (
        "a dip and a recovery cannot both be read off fewer than four closed "
        f"sprints; found {len(closed)}"
    )
    velocity = [s.completed_points for s in closed]

    trough = min(range(len(velocity)), key=lambda i: velocity[i])
    assert 0 < trough < len(velocity) - 1, (
        f"the low sprint is at the edge of the series {velocity} — a dip at the "
        "start or end has no recovery after it"
    )
    # The dip has to be a real collapse, not noise, and the sprint after it has
    # to climb back — that second half is what makes it a pivot and not a decline.
    assert velocity[trough] < velocity[trough - 1] / 2
    assert velocity[trough + 1] > velocity[trough] * 1.5, (
        f"velocity {velocity} never recovers after the dip"
    )


def test_the_dip_sprint_missed_its_goal_and_the_recovery_met_one(aurora):
    outcomes = [s.goal_outcome for s in _sprints(aurora) if s.state == "COMPLETED"]
    assert "MISSED" in outcomes, f"no sprint ever missed its goal: {outcomes}"
    assert "MET" in outcomes
    # A pack where every closed sprint reports the same verdict is not recording
    # a judgment, it is recording a default.
    assert len(set(outcomes)) >= 3, f"only {set(outcomes)} across the history"


def test_the_descoped_stories_left_their_sprint_for_the_backlog(aurora):
    """Returned to the backlog, not merely relabelled.

    A story that keeps its `sprint` while flipping to BACKLOG still counts in
    that sprint's membership, so the velocity dip the pivot caused would not
    appear in the aggregate at all.
    """
    for name in DESCOPED:
        task = Task.objects.get(project=aurora, name=name)
        assert task.status == "BACKLOG", f"{name} is {task.status}"
        assert task.sprint_id is None, f"{name} is still in a sprint"


def test_the_pivot_is_visible_in_the_aggregate_not_just_the_prose(aurora):
    """The dip has to be caused by the descoped stories, not typed in beside them."""
    dip = min(
        (s for s in _sprints(aurora) if s.state == "COMPLETED"),
        key=lambda s: s.completed_points,
    )
    shortfall = dip.committed_points - dip.completed_points
    descoped_points = sum(
        Task.objects.get(project=aurora, name=n).story_points or 0 for n in DESCOPED
    )
    assert shortfall == descoped_points, (
        f"{dip.name} is short {shortfall} points but the descoped stories are "
        f"worth {descoped_points} — the commitment and the pivot disagree"
    )


def test_a_cancelled_sprint_is_on_the_board_with_its_reason(aurora):
    cancelled = [s for s in _sprints(aurora) if s.state == "CANCELLED"]
    assert len(cancelled) == 1, "no cancelled sprint"
    sprint = cancelled[0]
    assert sprint.notes, "the sprint was cancelled with no recorded reason"
    # It kept the goal it had. Overwriting the goal with "cancelled" loses what
    # the team had actually planned to do.
    assert "cancel" not in (sprint.goal or "").lower()
    # ...and its scope went somewhere rather than evaporating.
    later = [s for s in _sprints(aurora) if s.start_date > sprint.start_date]
    assert later and Task.objects.filter(project=aurora, sprint=later[0]).exists(), (
        "the sprint after the cancelled one is empty, so nothing was folded forward"
    )


def test_capacity_moves_with_the_team(aurora):
    capacities = [s.capacity_points for s in _sprints(aurora)]
    assert len(set(capacities)) >= 4, (
        f"capacity is effectively constant across the history: {capacities}"
    )
    # The holiday week is the reason one sprint was cancelled rather than run,
    # so it has to be dramatically smaller, not just a little smaller.
    assert min(capacities) < max(capacities) / 2


def test_every_sprint_states_a_real_goal(aurora):
    goals = [(s.name, s.goal or "") for s in _sprints(aurora)]
    for name, goal in goals:
        assert len(goal) > 25, f"{name} has a placeholder goal: {goal!r}"
    assert len({g for _n, g in goals}) == len(goals), "sprint goals repeat"


def test_the_sprint_zero_baseline_records_the_plan_before_it_changed(aurora):
    baseline = Baseline.objects.get(project=aurora, is_active=True)
    rows = list(baseline.tasks.all())
    assert len(rows) >= 25, f"the baseline covers only {len(rows)} stories"

    # The descoped work has to be *in* the baseline — that is what makes the
    # pivot legible as variance rather than as a plan that was always smaller.
    names = {r.task_name for r in rows}
    assert names >= DESCOPED, f"descoped stories missing from the baseline: {DESCOPED - names}"

    repointed = [
        r.task_name
        for r in rows
        if (t := Task.objects.filter(project=aurora, name=r.task_name).first())
        and t.story_points != r.story_points
    ]
    assert repointed, "every baseline row matches today's points — no variance to see"


def test_the_retro_that_caused_the_pivot_became_a_task(aurora):
    promoted = Task.objects.filter(
        project=aurora, name__icontains="Validate demand with the beta cohort"
    )
    assert promoted.exists(), "the pivot retro action was never promoted to a task"
    assert promoted.get().sprint_id is None, (
        "the promoted action landed in a sprint rather than the backlog"
    )
