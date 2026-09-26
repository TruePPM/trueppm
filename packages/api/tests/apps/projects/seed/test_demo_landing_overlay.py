"""The demo-only landing overlay, run against the real imported Atlas seed (#4050 B).

Run against the **actual fixture**, not a hand-built project, and that is the whole
point of the file. The overlay is fixture-coupled by construction — it names rows in
``atlas-platform-launch.json`` — so a test over a synthetic project would prove the
functions work and nothing about whether they still find anything. If somebody renames
"Performance tuning" in the seed, this file is what says so.

#3095's coverage tests (``test_atlas_full_model_coverage.py``) pin the fixture's
``AT_RISK`` override and its baseline, and must stay green **unchanged** — which is
the reason the overlay exists as an overlay rather than as an edit to the JSON. Nothing
here touches that file.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Health, Project, Task, TaskStatus
from trueppm_api.apps.projects.seed.demo_landing_overlay import (
    BEHIND_PLAN_GAP_POINTS,
    BEHIND_PLAN_TASK_NAME,
    CONFIRMED_MILESTONE_NAME,
    LANDING_PROJECT_NAME,
    MAX_UNSCHEDULED,
    DemoOverlayRefused,
    apply_demo_landing_overlay,
    landing_project_for_demo_visitor,
)
from trueppm_api.apps.projects.seed.samples import load_sample
from trueppm_api.apps.scheduling.models import MonteCarloRun

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="overlay-owner", email="o@example.com")


@pytest.fixture
def demo_mode(settings: Any) -> None:
    """Arm the deployment mode the overlay requires."""
    settings.DEMO_READ_ONLY = True


@pytest.fixture
def program(owner: Any) -> Any:
    return load_sample("atlas-platform-launch", owner=owner, create_users=True)


def _landing(program: Any) -> Project:
    return Project.objects.get(program=program, name=LANDING_PROJECT_NAME)


def _expected_percent(task: Task, today: dt.date) -> float | None:
    # The SPAN, not the remaining-work window — see `_expected_percent`'s docstring.
    start, finish = (task.scheduled_start or task.early_start), task.early_finish
    if start is None or finish is None or finish <= start:
        return None
    if today <= start:
        return 0.0
    if today >= finish:
        return 100.0
    return (today - start).days / (finish - start).days * 100.0


def _behind_plan(project: Project, today: dt.date) -> list[Task]:
    """Every live leaf row whose progress trails its straight-line plan.

    Re-derived here rather than imported from the overlay module on purpose: an
    assertion that calls the same private helper the code under test calls proves the
    two agree with each other, which is not the claim. This is the rule stated
    independently, in the same shape the web's hint-target picker uses.
    """
    tasks = list(Task.objects.filter(project=project, is_deleted=False))
    paths = [str(t.wbs_path) for t in tasks if t.wbs_path]
    behind = []
    for task in tasks:
        path = str(task.wbs_path) if task.wbs_path else ""
        is_summary = any(p.startswith(path + ".") for p in paths if p != path)
        if is_summary or task.is_milestone:
            continue
        expected = _expected_percent(task, today)
        if expected is None:
            continue
        # A whole percentage point of tolerance: the overlay writes rounded values,
        # and a row that is 0.04 points "behind" is behind of nothing.
        if expected - (task.percent_complete or 0.0) > 1.0:
            behind.append(task)
    return behind


# ---------------------------------------------------------------------------
# The acceptance list
# ---------------------------------------------------------------------------


def test_overlay_clears_the_health_override_so_the_project_reads_on_track(
    demo_mode: None, program: Any
) -> None:
    project = _landing(program)
    # The premise: the fixture ships this project AT_RISK, and #3095 pins that.
    assert project.health == Health.AT_RISK

    apply_demo_landing_overlay(program)

    project.refresh_from_db()
    # AUTO, not ON_TRACK — "override cleared" is the act. A PM override asserts a
    # human judgment and there is no human here.
    assert project.health == Health.AUTO


def test_overlay_confirms_the_closing_milestone(demo_mode: None, program: Any) -> None:
    project = _landing(program)
    milestone = Task.objects.get(project=project, name=CONFIRMED_MILESTONE_NAME)
    # "Unconfirmed" is `untouched_seeded`: seeded and never touched by a person.
    assert milestone.edited_at is None
    assert milestone in set(Task.objects.untouched_seeded(project, within=None))

    apply_demo_landing_overlay(program)

    milestone.refresh_from_db()
    assert milestone.edited_at is not None
    assert milestone not in set(Task.objects.untouched_seeded(project, within=None))


def test_the_monte_carlo_run_is_newer_than_every_edit(demo_mode: None, program: Any) -> None:
    project = _landing(program)
    result = apply_demo_landing_overlay(program)

    run = MonteCarloRun.objects.get(pk=result.monte_carlo_run_id)
    latest_edit = (
        Task.objects.filter(project=project, is_deleted=False, edited_at__isnull=False)
        .order_by("-edited_at")
        .first()
    )
    assert latest_edit is not None, "the overlay edits rows; one of them must carry edited_at"
    assert run.taken_at > latest_edit.edited_at

    # …and it is the newest run on the project, so the surface that reads "latest"
    # reads this one.
    assert MonteCarloRun.objects.filter(project=project).order_by("-taken_at").first() == run

    # The staleness verdict is `plan_version < plan_version_current`, so the run has
    # to carry the version as of AFTER the edits, not before them.
    project.refresh_from_db()
    assert run.plan_version == project.last_sync_version


def test_the_forecast_lands_ahead_of_the_commitment(demo_mode: None, program: Any) -> None:
    # The fixture's own history walks P80 to A+86 against a commitment of A+67 — the
    # "already blown" reading this overlay removes.
    result = apply_demo_landing_overlay(program)
    assert result.p80 < result.commitment_finish
    run = MonteCarloRun.objects.get(pk=result.monte_carlo_run_id)
    assert run.p50 is not None and run.p80 is not None and run.p95 is not None
    assert run.p50 <= run.p80 <= run.p95


def test_exactly_one_task_is_left_behind_plan(demo_mode: None, program: Any) -> None:
    from django.utils import timezone

    project = _landing(program)
    result = apply_demo_landing_overlay(program)

    behind = _behind_plan(project, timezone.localdate())
    assert [t.name for t in behind] == [BEHIND_PLAN_TASK_NAME], (
        "the landing is meant to carry exactly ONE realistic signal — a plan with "
        "nothing wrong on it is a screenshot, and a plan with four things wrong is "
        "the defect #4050 is about"
    )
    assert str(behind[0].pk) == result.behind_plan_task_id
    assert result.behind_plan_task_wbs_path == str(behind[0].wbs_path)
    # The hint promises "watch the finish date move", so the row it names must be one
    # where a drag actually moves the project finish.
    assert behind[0].status == TaskStatus.IN_PROGRESS
    # …and behind by the gap the design names, not by an accident of the reset date.
    expected = _expected_percent(behind[0], timezone.localdate())
    assert expected is not None
    assert expected - (behind[0].percent_complete or 0.0) == pytest.approx(
        BEHIND_PLAN_GAP_POINTS, abs=0.2
    )


def test_the_unscheduled_pile_is_trimmed(demo_mode: None, program: Any) -> None:
    project = _landing(program)
    apply_demo_landing_overlay(program)

    remaining = [
        t
        for t in Task.objects.filter(project=project, is_deleted=False)
        if t.planned_start is None and t.early_start is None and not t.is_milestone
    ]
    assert len(remaining) <= MAX_UNSCHEDULED


def test_the_overlay_is_idempotent_across_nightly_resets(demo_mode: None, program: Any) -> None:
    from django.utils import timezone

    project = _landing(program)
    first = apply_demo_landing_overlay(program)
    assert first.was_noop is False

    second = apply_demo_landing_overlay(program)
    # Every seed indicator was already dealt with. The kept signal's window and the
    # forecast row are re-asserted regardless — the CPM pass re-derives the first on
    # every run, and the second must stay newer than it.
    assert second.was_noop is True
    assert second.behind_plan_task_id == first.behind_plan_task_id
    assert second.unscheduled_removed == 0
    assert second.monte_carlo_run_id != first.monte_carlo_run_id
    # The dates do not walk: a reset that moved the landing bar a little every night
    # would be "idempotent" by the return value and drifting on screen.
    assert second.commitment_finish == first.commitment_finish
    assert second.p80 == first.p80

    # Every acceptance property still holds after the second pass — an idempotence
    # test that only compares the two return values would pass on an overlay that
    # had quietly undone itself.
    project.refresh_from_db()
    assert project.health == Health.AUTO
    assert [t.name for t in _behind_plan(project, timezone.localdate())] == [BEHIND_PLAN_TASK_NAME]
    assert Task.objects.get(project=project, name=CONFIRMED_MILESTONE_NAME).edited_at is not None


def test_the_overlay_refuses_outside_a_demo_deployment(program: Any, settings: Any) -> None:
    settings.DEMO_READ_ONLY = False
    with pytest.raises(DemoOverlayRefused):
        apply_demo_landing_overlay(program)

    # Nothing was written on the way to the refusal — the guard is the first thing
    # the function does, ahead of the atomic block's first write.
    project = _landing(program)
    assert project.health == Health.AT_RISK
    assert Task.objects.get(project=project, name=CONFIRMED_MILESTONE_NAME).edited_at is None
    assert not MonteCarloRun.objects.filter(project=project, plan_version__isnull=False).exists()


def test_the_overlay_does_not_touch_the_other_sample_projects(
    demo_mode: None, program: Any
) -> None:
    others = list(Project.objects.filter(program=program).exclude(name=LANDING_PROJECT_NAME))
    before = {p.pk: (p.health, p.last_sync_version) for p in others}
    assert len(before) == 2

    apply_demo_landing_overlay(program)

    for project in Project.objects.filter(pk__in=before):
        assert (project.health, project.last_sync_version) == before[project.pk]


# ---------------------------------------------------------------------------
# landing_project_for_demo_visitor (#4151)
# ---------------------------------------------------------------------------


def test_landing_project_for_demo_visitor_finds_it_when_readable(program: Any) -> None:
    visitor = User.objects.create_user(username="atlas-visitor-lp", email="v@example.com")
    project = _landing(program)
    ProjectMembership.objects.create(project=project, user=visitor, role=Role.MEMBER)

    assert landing_project_for_demo_visitor(visitor) == project


def test_landing_project_for_demo_visitor_none_without_membership(program: Any) -> None:
    """The project exists, but this visitor has no membership on it — must not leak."""
    visitor = User.objects.create_user(username="atlas-visitor-unreadable", email="u@example.com")

    assert landing_project_for_demo_visitor(visitor) is None


def test_landing_project_for_demo_visitor_none_when_archived(program: Any) -> None:
    visitor = User.objects.create_user(username="atlas-visitor-archived", email="a@example.com")
    project = _landing(program)
    ProjectMembership.objects.create(project=project, user=visitor, role=Role.MEMBER)
    project.is_archived = True
    project.save(update_fields=["is_archived"])

    assert landing_project_for_demo_visitor(visitor) is None
