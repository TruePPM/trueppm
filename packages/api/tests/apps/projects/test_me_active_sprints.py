"""Tests for the multi-team Sprints lens endpoint (issue #230 / ADR-0036).

`GET /api/v1/me/active-sprints/` returns one summary entry per project
where the requesting user has a non-complete task assignment in that
project's currently-ACTIVE sprint.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import signal_privacy_services
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import (
    capacity_summaries_for_sprints,
    capacity_summary,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


def _project(calendar: Calendar, name: str) -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)


def _active_sprint(project: Project, name: str = "S1") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=40,
        committed_task_count=10,
    )


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_returns_one_entry_per_active_sprint_with_assignment(
    calendar: Calendar, alice: object
) -> None:
    p1 = _project(calendar, "Alpha")
    p2 = _project(calendar, "Beta")
    _membership(p1, alice)
    _membership(p2, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    s2 = _active_sprint(p2, "Beta S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)
    Task.objects.create(project=p2, name="T2", duration=1, sprint=s2, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert len(resp.data) == 2
    project_names = {row["project_name"] for row in resp.data}
    assert project_names == {"Alpha", "Beta"}


@pytest.mark.django_db
def test_excludes_projects_without_user_assignments(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    p2 = _project(calendar, "Beta")
    _membership(p1, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    s2 = _active_sprint(p2, "Beta S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)
    # Beta has an active sprint but Alice has no task there.
    Task.objects.create(project=p2, name="T2", duration=1, sprint=s2)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["project_name"] == "Alpha"


@pytest.mark.django_db
def test_excludes_completed_task_assignments(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(
        project=p1,
        name="T1",
        duration=1,
        sprint=s1,
        assignee=alice,
        status=TaskStatus.COMPLETE,
    )
    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_excludes_planned_and_completed_sprints(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    planned = Sprint.objects.create(
        project=p1,
        name="Planned",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.create(project=p1, name="T1", duration=1, sprint=planned, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_summary_payload_shape(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    entry = resp.data[0]
    assert {
        "project_id",
        "project_name",
        "sprint",
        "capacity_ratio",
        "capacity_label",
        "velocity",
    } <= set(entry.keys())
    sprint_data = entry["sprint"]
    assert {
        "id",
        "name",
        "short_id_display",
        "start_date",
        "finish_date",
        "day",
        "total",
        "remaining_points",
        "committed_points",
        "trend_pts",
    } <= set(sprint_data.keys())
    assert sprint_data["total"] == 14
    assert sprint_data["committed_points"] == 40


@pytest.mark.django_db
def test_sprint_short_id_display_decodes_the_hex_sequence(
    calendar: Calendar, alice: object
) -> None:
    """This card hand-built its own ``f"SP-{sprint.short_id}"`` (#2671) — a second,
    independent call site of the exact bug #2430 fixed for Task. Ten sprints are
    created so the tenth's raw short_id is the zero-padded hex ``0000000A``; the
    naive format would render ``SP-0000000A`` instead of ``SP-10``.
    """
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    for i in range(9):
        Sprint.objects.create(
            project=p1,
            name=f"Filler {i}",
            start_date=date(2026, 1, 1),
            finish_date=date(2026, 1, 14),
            state=SprintState.COMPLETED,
        )
    s10 = _active_sprint(p1, "Alpha S10")
    assert s10.short_id == "0000000A"
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s10, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data[0]["sprint"]["short_id_display"] == "SP-10"


@pytest.mark.django_db
def test_results_sorted_by_trend_most_behind_first(calendar: Calendar, alice: object) -> None:
    """Sprint with negative trend (behind ideal) sorts before sprints ahead.

    The task_status_changed signal drives the burn snapshot from task state,
    so we set up realistic task states (NOT_STARTED for behind, COMPLETE
    for ahead) rather than hand-injecting snapshot rows that the signal
    would immediately overwrite.
    """
    today = date.today()
    p1 = _project(calendar, "Behind")
    p2 = _project(calendar, "Ahead")
    _membership(p1, alice)
    _membership(p2, alice)

    # Behind: one not-started task at full point value → remaining ≈ committed.
    behind = Sprint.objects.create(
        project=p1,
        name="Behind S1",
        start_date=today - timedelta(days=7),
        finish_date=today + timedelta(days=7),
        state=SprintState.ACTIVE,
        committed_points=40,
    )
    Task.objects.create(
        project=p1,
        name="T1",
        duration=1,
        sprint=behind,
        assignee=alice,
        story_points=40,
        status=TaskStatus.NOT_STARTED,
    )

    # Ahead: most points already complete → low remaining. One in-progress
    # task (also assigned to Alice) keeps the sprint visible in the lens.
    ahead = Sprint.objects.create(
        project=p2,
        name="Ahead S1",
        start_date=today - timedelta(days=7),
        finish_date=today + timedelta(days=7),
        state=SprintState.ACTIVE,
        committed_points=40,
    )
    Task.objects.create(
        project=p2,
        name="T-done",
        duration=1,
        sprint=ahead,
        assignee=alice,
        story_points=35,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=p2,
        name="T-wip",
        duration=1,
        sprint=ahead,
        assignee=alice,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data[0]["project_name"] == "Behind"
    assert resp.data[1]["project_name"] == "Ahead"


@pytest.mark.django_db
def test_active_sprints_query_count_constant_in_sprint_count(
    calendar: Calendar, alice: object
) -> None:
    """#1012: /me/active-sprints/ must not issue a query per active sprint.

    Capacity is batch-fetched (one ``TaskResource`` query for every sprint) and
    velocity is cached per project, so a project carrying several active sprints
    issues the same number of queries as one carrying a single sprint. A distinct
    reader per measurement keeps each request scoped to its own project so the
    counts are comparable.
    """
    res = Resource.objects.create(name="Dev", max_units=1.0)

    def _measure(n: int, uname: str) -> int:
        user = User.objects.create_user(username=uname, password="pw")
        project = _project(calendar, f"P-{uname}")
        _membership(project, user)
        for i in range(n):
            sprint = _active_sprint(project, f"S{i}")
            task = Task.objects.create(
                project=project,
                name=f"T{i}",
                duration=1,
                sprint=sprint,
                assignee=user,
                story_points=5,
                status=TaskStatus.NOT_STARTED,
                early_start=sprint.start_date,
                early_finish=sprint.finish_date,
            )
            TaskResource.objects.create(task=task, resource=res, units=1.0)
        client = _client(user)
        with CaptureQueriesContext(connection) as ctx:
            resp = client.get("/api/v1/me/active-sprints/")
            assert resp.status_code == 200
            assert len(resp.data) == n
        return len(ctx.captured_queries)

    one = _measure(1, "solo")
    many = _measure(4, "multi")
    assert many == one, f"N+1 in /me/active-sprints/: {one} queries for 1 sprint, {many} for 4"


@pytest.mark.django_db
def test_capacity_summaries_for_sprints_matches_per_sprint(
    calendar: Calendar, alice: object
) -> None:
    """The batched capacity helper returns totals byte-identical to the per-sprint
    ``capacity_summary`` for every sprint, including a sprint with no assignments
    (#1012 — only the query count changes, never the numbers)."""
    project = _project(calendar, "Alpha")
    res = Resource.objects.create(name="Dev", max_units=1.0)
    sprints = []
    for i in range(3):
        sprint = _active_sprint(project, f"S{i}")
        task = Task.objects.create(
            project=project,
            name=f"T{i}",
            duration=10,
            sprint=sprint,
            early_start=sprint.start_date,
            early_finish=sprint.finish_date,
        )
        TaskResource.objects.create(task=task, resource=res, units=1.0)
        sprints.append(sprint)
    # A sprint with no assignments exercises the empty-rows branch.
    sprints.append(_active_sprint(project, "Empty"))

    batched = capacity_summaries_for_sprints(sprints)
    for sprint in sprints:
        assert batched[sprint.pk] == capacity_summary(sprint)


@pytest.mark.django_db
def test_capacity_summaries_for_sprints_empty_input() -> None:
    """No sprints → no query, empty map (guards the ``pks`` short-circuit, #1012)."""
    with CaptureQueriesContext(connection) as ctx:
        assert capacity_summaries_for_sprints([]) == {}
    assert len(ctx.captured_queries) == 0


@pytest.mark.django_db
def test_unauthenticated_gets_401() -> None:
    c = APIClient()
    resp = c.get("/api/v1/me/active-sprints/")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_user_with_no_active_assignments_gets_empty_list(calendar: Calendar, alice: object) -> None:
    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []


# --------------------------------------------------------------------------- #
# #2895 — the velocity gate and the membership re-check
# --------------------------------------------------------------------------- #


def _closed_sprints(project: Project, n: int = 2) -> None:
    """``n`` closed sprints so ``velocity_summary`` returns a real, non-null band.

    Without these the point figures are null for *everyone*, and a suppression
    assertion would pass vacuously against absent data rather than a fired gate.
    """
    base = date(2026, 1, 6)
    for i in range(n):
        Sprint.objects.create(
            project=project,
            name=f"Closed {i + 1}",
            start_date=base + timedelta(days=14 * i),
            finish_date=base + timedelta(days=14 * i + 10),
            state=SprintState.COMPLETED,
            completed_points=20 + i,
            completed_task_count=5 + i,
            closed_at=timezone.now() - timedelta(days=14 * (n - i)),
        )


@pytest.mark.django_db
def test_member_reads_the_full_velocity_band_at_the_default_audience(
    calendar: Calendar, alice: object
) -> None:
    """The regression guard for the gate below: at the default TEAM audience an
    ordinary member's card is byte-for-byte what it was before #2895 — the gate
    only ever fires for a reader *above* the audience."""
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    vel = resp.data[0]["velocity"]
    assert vel["velocity_suppressed"] is False
    assert vel["rolling_avg_points"] is not None
    assert vel["forecast_range_low"] is not None
    assert vel["forecast_range_high"] is not None


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.ADMIN, Role.OWNER])
def test_admin_gets_the_velocity_band_suppressed_at_the_default_audience(
    calendar: Calendar, role: int
) -> None:
    """🔴 #2895: an ADMIN/OWNER resolves to the TEAM_SM_PM band, which is above
    velocity's TEAM default — so this lens must strip the point figures exactly as
    ``/velocity/`` and ``/forecast/`` do. Before the fix this endpoint was the
    management bypass around ADR-0104's team-privacy inversion.

    Both roles are pinned: ``requester_signal_tier`` branches on ``role >= ADMIN``,
    so OWNER rides the same path and a future split of that comparison would
    otherwise reopen the bypass for the higher role only."""
    pm = User.objects.create_user(username="pm", password="pw")
    p1 = _project(calendar, "Alpha")
    ProjectMembership.objects.create(project=p1, user=pm, role=role)
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=pm)

    resp = _client(pm).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert len(resp.data) == 1, "the card itself is suppressed, not withheld"
    vel = resp.data[0]["velocity"]
    assert vel["velocity_suppressed"] is True
    assert vel["rolling_avg_points"] is None
    assert vel["forecast_range_low"] is None
    assert vel["forecast_range_high"] is None
    # The rest of the card is untouched — suppression is scoped to the band.
    assert resp.data[0]["sprint"]["committed_points"] == 40
    assert resp.data[0]["capacity_label"] is not None


@pytest.mark.django_db
def test_viewer_reads_the_band_like_any_other_team_insider(calendar: Calendar) -> None:
    """A VIEWER resolves to the TEAM band, not below it — the ladder measures
    management distance, not role power, so the lowest-privilege team member
    reads the team's own signal. Guards against "fix" the gate by ranking on the
    role ordinal, which would deny the team and keep admitting the PM."""
    viewer = User.objects.create_user(username="viewer", password="pw")
    p1 = _project(calendar, "Alpha")
    ProjectMembership.objects.create(project=p1, user=viewer, role=Role.VIEWER)
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=viewer)

    resp = _client(viewer).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    vel = resp.data[0]["velocity"]
    assert vel["velocity_suppressed"] is False
    assert vel["rolling_avg_points"] is not None


@pytest.mark.django_db
def test_gate_falls_back_to_the_coded_default_when_the_policy_omits_velocity(
    calendar: Calendar,
) -> None:
    """A policy row exists but carries no ``velocity`` entry — the signal must
    resolve to its coded TEAM default and still suppress the PM. Pins the
    SIGNAL_DEFAULTS branch of can_read_signal, which a partially-written policy
    (any signal configured but not this one) reaches in production."""
    pm = User.objects.create_user(username="pm", password="pw")
    p1 = _project(calendar, "Alpha")
    ProjectMembership.objects.create(project=p1, user=pm, role=Role.ADMIN)
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=pm)

    # A row that configures a different signal entirely, leaving velocity absent.
    ProjectSignalPrivacyPolicy.objects.create(
        project=p1, signal_visibility={"pulse": {"audience": SignalAudience.TEAM_SM_PM}}
    )

    resp = _client(pm).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data[0]["velocity"]["velocity_suppressed"] is True
    assert resp.data[0]["velocity"]["rolling_avg_points"] is None


@pytest.mark.django_db
def test_admin_reads_the_band_once_the_team_shares_velocity_upward(
    calendar: Calendar,
) -> None:
    """The gate is an audience check, not a role ban: once the team raises
    velocity's audience to TEAM_SM_PM the same ADMIN reads the full band."""
    pm = User.objects.create_user(username="pm", password="pw")
    p1 = _project(calendar, "Alpha")
    ProjectMembership.objects.create(project=p1, user=pm, role=Role.ADMIN)
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=pm)

    # Raise the ceiling then the audience through the services — the model exposes
    # no bare field write, and the ``audience <= ceiling`` invariant lives there.
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=p1)
    signal_privacy_services.raise_signal_ceiling(policy, "velocity", SignalAudience.TEAM_SM_PM)
    signal_privacy_services.set_signal_audience(policy, "velocity", SignalAudience.TEAM_SM_PM)

    resp = _client(pm).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    vel = resp.data[0]["velocity"]
    assert vel["velocity_suppressed"] is False
    assert vel["rolling_avg_points"] is not None


@pytest.mark.django_db
def test_revoked_member_with_a_stale_assignment_gets_no_card(
    calendar: Calendar, alice: object
) -> None:
    """🔴 #2895: ProjectMembership is *soft*-deleted, so revoking a member leaves
    their ``Task.assignee`` rows intact. The docstring used to call membership
    "implicit" from the assignment — under soft delete that inference is false, and
    it let a removed member keep reading the project's velocity band through this
    lens while every other endpoint denied them."""
    p1 = _project(calendar, "Alpha")
    membership = _membership(p1, alice)
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)

    # Sanity: the card is there while the membership is live.
    assert len(_client(alice).get("/api/v1/me/active-sprints/").data) == 1

    membership.is_deleted = True
    membership.save()

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == [], "a revoked member must not read the project at all"


@pytest.mark.django_db
def test_assignment_without_any_membership_gets_no_card(calendar: Calendar, alice: object) -> None:
    """The same hole reached the other way: a task assigned to a user who was never
    a member of the project (a stale import, a cross-project reassignment) is not a
    grant of read access either."""
    p1 = _project(calendar, "Alpha")
    _closed_sprints(p1)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_gate_is_resolved_per_project_not_per_request(calendar: Calendar) -> None:
    """This lens spans teams, so one caller can be a plain member of one project and
    the PM of the next. Each project's own audience decides its own card."""
    user = User.objects.create_user(username="both", password="pw")
    as_member = _project(calendar, "AsMember")
    as_pm = _project(calendar, "AsPM")
    ProjectMembership.objects.create(project=as_member, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=as_pm, user=user, role=Role.ADMIN)
    for project in (as_member, as_pm):
        _closed_sprints(project)
        sprint = _active_sprint(project, f"{project.name} S1")
        Task.objects.create(project=project, name="T1", duration=1, sprint=sprint, assignee=user)

    resp = _client(user).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    by_name = {row["project_name"]: row["velocity"] for row in resp.data}
    assert by_name["AsMember"]["velocity_suppressed"] is False
    assert by_name["AsMember"]["rolling_avg_points"] is not None
    assert by_name["AsPM"]["velocity_suppressed"] is True
    assert by_name["AsPM"]["rolling_avg_points"] is None
