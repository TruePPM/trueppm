"""A person's load across projects: one owner, scoped to the viewer (#4777, ADR-1314).

The bug class is the one ADR-1314 names: one engineer's load read 128/80, 24/80,
40% and "100% available" on four surfaces because each computed its own. These
tests pin the cross-project owner, ``GET /me/people-load/``:

- it sums bookings across projects on the person's own capacity, and agrees with
  the per-project owner for a single project;
- it never counts a project the viewer cannot already read per-person load on
  (non-member, below Scheduler, outside the capacity signal audience);
- a figure that cannot be computed is null with a reason, never a fabricated 0%;
- the sprint capacity panel and the My Work utilization signal are named as
  sprint-scoped figures, so neither reads as this one.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.metric_provenance import (
    METRIC_DEFINITIONS,
    PEOPLE_LOAD_DEFINED,
    SPRINT_CAPACITY_DEFINED,
    definitions_by_field,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Program,
    Project,
    Sprint,
    Task,
)
from trueppm_api.apps.projects.utilization import (
    aggregate_utilization_weekly,
    compute_people_load,
)
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()

MONDAY = date(2026, 3, 2)
URL = "/api/v1/me/people-load/"


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="rm", password="pw")


@pytest.fixture
def client(viewer: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


def _project(
    name: str, cal: Calendar, viewer: object | None, role: int = Role.SCHEDULER, **kw: object
) -> Project:
    project = Project.objects.create(name=name, start_date=MONDAY, calendar=cal, **kw)
    if viewer is not None:
        ProjectMembership.objects.create(project=project, user=viewer, role=role)
    return project


def _book(project: Project, resource: Resource, units: str, start: date, finish: date) -> Task:
    task = Task.objects.create(
        project=project, name="T", duration=5, early_start=start, early_finish=finish
    )
    TaskResource.objects.create(task=task, resource=resource, units=units)
    return task


def _week(body: dict, name: str) -> list[dict]:
    return next(p for p in body["people"] if p["name"] == name)["cells"]


@pytest.mark.django_db
class TestCrossProjectSum:
    def test_two_projects_sum_on_the_persons_own_capacity(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        alice = Resource.objects.create(name="Alice", max_units="1.0", calendar=cal)
        a = _project("A", cal, viewer)
        b = _project("B", cal, viewer)
        _book(a, alice, "0.6", MONDAY, MONDAY + timedelta(days=4))
        _book(b, alice, "0.6", MONDAY, MONDAY + timedelta(days=4))

        body = client.get(URL, {"week_start": "2026-03-04", "weeks": 2}).json()

        assert body["weeks"] == ["2026-03-02", "2026-03-09"]  # snapped to Monday
        cells = _week(body, "Alice")
        assert cells[0] == {
            "week_start": "2026-03-02",
            "load_pct": 120,
            "overallocated": True,
            "reason": None,
        }
        assert cells[1]["load_pct"] == 0
        alice_row = next(p for p in body["people"] if p["name"] == "Alice")
        assert alice_row["project_count"] == 2
        assert alice_row["peak_load_pct"] == 120
        assert body["over_allocated_count"] == 1
        assert body["scope"] == {
            "project_count": 2,
            "withheld_project_count": 0,
            "capacity_withheld_project_count": 0,
            "program_id": None,
        }
        assert body["reason"] is None
        assert body["as_of"]
        assert body["definitions"] == definitions_by_field(PEOPLE_LOAD_DEFINED)

    def test_one_project_agrees_with_the_per_project_owner(
        self, viewer: object, cal: Calendar
    ) -> None:
        """Reconciliation: for one project the two owners give one number."""
        bob = Resource.objects.create(name="Bob", max_units="0.5", calendar=cal)
        p = _project("Solo", cal, viewer)
        ProjectResource.objects.create(project=p, resource=bob)
        _book(p, bob, "0.4", MONDAY, MONDAY + timedelta(days=9))

        cross = compute_people_load([p.pk], MONDAY, 3)
        per_project = aggregate_utilization_weekly(p, MONDAY, 3)

        assert [c["load_pct"] for c in cross["people"][0]["cells"]] == per_project["resources"][0][
            "util"
        ]

    def test_a_ten_hour_project_calendar_counts_full_time_as_one_unit(
        self, viewer: object, cal: Calendar
    ) -> None:
        """Unit-days, not hours: a full-time booking on a 10 h calendar is 100%, not 125%."""
        long_days = Calendar.objects.create(name="Long", working_days=31, hours_per_day=10.0)
        carol = Resource.objects.create(name="Carol", max_units="1.0")
        p = _project("Long", long_days, viewer)
        _book(p, carol, "1.0", MONDAY, MONDAY + timedelta(days=4))

        cells = compute_people_load([p.pk], MONDAY, 1)["people"][0]["cells"]
        assert cells[0]["load_pct"] == 100

    def test_time_off_removes_capacity_and_a_week_off_is_not_computable(
        self, viewer: object
    ) -> None:
        own = Calendar.objects.create(name="Dee", working_days=31, hours_per_day=8.0)
        CalendarException.objects.create(
            calendar=own, exc_start=MONDAY, exc_end=MONDAY + timedelta(days=6)
        )
        dee = Resource.objects.create(name="Dee", max_units="1.0", calendar=own)
        p = _project("P", own, viewer)
        ProjectResource.objects.create(project=p, resource=dee)

        cells = compute_people_load([p.pk], MONDAY, 2)["people"][0]["cells"]
        assert cells[0] == {
            "week_start": MONDAY.isoformat(),
            "load_pct": None,
            "overallocated": False,
            "reason": "no_capacity",
        }
        assert cells[1]["load_pct"] == 0 and cells[1]["reason"] is None

    def test_idle_roster_member_appears_and_deactivated_people_do_not(
        self, viewer: object, cal: Calendar
    ) -> None:
        idle = Resource.objects.create(name="Idle", max_units="1.0")
        gone = Resource.objects.create(name="Gone", max_units="1.0", is_deleted=True)
        p = _project("P", cal, viewer)
        ProjectResource.objects.create(project=p, resource=idle)
        ProjectResource.objects.create(project=p, resource=gone)

        names = [row["name"] for row in compute_people_load([p.pk], MONDAY, 1)["people"]]
        assert names == ["Idle"]

    def test_most_loaded_first(self, viewer: object, cal: Calendar) -> None:
        p = _project("P", cal, viewer)
        light = Resource.objects.create(name="Aaron", max_units="1.0")
        heavy = Resource.objects.create(name="Zed", max_units="1.0")
        _book(p, light, "0.2", MONDAY, MONDAY + timedelta(days=4))
        _book(p, heavy, "0.9", MONDAY, MONDAY + timedelta(days=4))

        names = [row["name"] for row in compute_people_load([p.pk], MONDAY, 1)["people"]]
        assert names == ["Zed", "Aaron"]


@pytest.mark.django_db
class TestScope:
    def test_projects_the_viewer_cannot_read_load_on_are_not_counted(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        erin = Resource.objects.create(name="Erin", max_units="1.0", calendar=cal)
        mine = _project("Mine", cal, viewer)
        as_member = _project("Member only", cal, viewer, role=Role.MEMBER)
        not_mine = _project("Not mine", cal, None)
        draft = _project("Draft", cal, viewer, lifecycle="draft")
        for p in (mine, as_member, not_mine, draft):
            _book(p, erin, "0.5", MONDAY, MONDAY + timedelta(days=4))

        body = client.get(URL, {"week_start": MONDAY.isoformat(), "weeks": 1}).json()

        assert _week(body, "Erin")[0]["load_pct"] == 50
        assert body["scope"]["project_count"] == 1
        # The Member-role project is one the viewer has a role in but cannot read
        # per-person load on; a non-member project and a draft are not in scope.
        assert body["scope"]["withheld_project_count"] == 1
        assert body["scope"]["capacity_withheld_project_count"] == 0

    def test_a_project_whose_capacity_signal_audience_excludes_the_viewer_is_withheld(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        """Gate 2 (ADR-0104): the Scheduler+ role gate passes, the ``capacity`` audience does not.

        A project Admin reads as the PM band (TEAM_SM_PM) on the signal ladder; the
        capacity signal defaults to a TEAM-only audience, so per-person load on that
        project must not leak through this cross-project lens. The Scheduler role
        reads as the team band and always passes, so the excluded viewer is an Admin.
        """
        from trueppm_api.apps.projects import signal_privacy_services as svc
        from trueppm_api.apps.projects.models import SignalAudience

        erin = Resource.objects.create(name="Erin", max_units="1.0", calendar=cal)
        open_project = _project("Open", cal, viewer)  # Scheduler: team band, reads
        gated = _project("Gated", cal, viewer, role=Role.ADMIN)
        policy = svc.get_or_create_policy(gated)
        assert policy.audience_of("capacity") == SignalAudience.TEAM
        for p in (open_project, gated):
            _book(p, erin, "0.5", MONDAY, MONDAY + timedelta(days=4))

        body = client.get(URL, {"week_start": MONDAY.isoformat(), "weeks": 1}).json()

        assert _week(body, "Erin")[0]["load_pct"] == 50  # only the readable project
        assert body["scope"]["project_count"] == 1
        assert body["scope"]["withheld_project_count"] == 1
        assert body["scope"]["capacity_withheld_project_count"] == 1

    def test_role_withheld_and_capacity_withheld_are_counted_separately(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        """Owner on two gated projects plus Member on a third: 3 withheld, 2 by capacity."""
        erin = Resource.objects.create(name="Erin", max_units="1.0", calendar=cal)
        for name in ("Gated A", "Gated B"):
            p = _project(name, cal, viewer, role=Role.OWNER)
            _book(p, erin, "0.5", MONDAY, MONDAY + timedelta(days=4))
        _project("Member only", cal, viewer, role=Role.MEMBER)

        body = client.get(URL, {"week_start": MONDAY.isoformat(), "weeks": 1}).json()

        assert body["reason"] == "all_withheld"
        assert body["scope"]["withheld_project_count"] == 3
        assert body["scope"]["capacity_withheld_project_count"] == 2

    def test_every_schedulable_project_withheld_is_all_withheld_not_no_projects(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        """An Owner/Admin whose projects all withhold the capacity signal holds the role.

        ``no_projects`` would tell them to ask for a role they already have, so the
        payload carries ``all_withheld`` and the count of what was withheld.
        """
        erin = Resource.objects.create(name="Erin", max_units="1.0", calendar=cal)
        for name in ("Gated A", "Gated B"):
            p = _project(name, cal, viewer, role=Role.OWNER)
            _book(p, erin, "0.5", MONDAY, MONDAY + timedelta(days=4))

        body = client.get(URL, {"week_start": MONDAY.isoformat(), "weeks": 1}).json()

        assert body["people"] == []
        assert body["reason"] == "all_withheld"
        assert body["scope"]["project_count"] == 0
        assert body["scope"]["withheld_project_count"] == 2
        assert body["scope"]["capacity_withheld_project_count"] == 2

    def test_only_member_role_projects_stays_no_projects(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        """Below Scheduler the role copy is true, so the reason stays ``no_projects``."""
        _project("Member only", cal, viewer, role=Role.MEMBER)
        body = client.get(URL, {"week_start": MONDAY.isoformat()}).json()
        assert body["reason"] == "no_projects"
        assert body["scope"]["withheld_project_count"] == 1
        assert body["scope"]["capacity_withheld_project_count"] == 0

    def test_a_person_booked_only_outside_scope_is_not_listed(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        _project("Mine", cal, viewer)
        hidden = Resource.objects.create(name="Hidden", max_units="1.0")
        _book(_project("Theirs", cal, None), hidden, "1.0", MONDAY, MONDAY + timedelta(days=4))

        body = client.get(URL, {"week_start": MONDAY.isoformat()}).json()
        assert body["people"] == []
        assert body["reason"] == "no_people"

    def test_no_projects_reason(self, client: APIClient) -> None:
        body = client.get(URL).json()
        assert body["people"] == [] and body["reason"] == "no_projects"
        assert len(body["weeks"]) == 8

    def test_program_filter_narrows_to_that_programs_projects(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        program = Program.objects.create(name="Prog")
        fay = Resource.objects.create(name="Fay", max_units="1.0", calendar=cal)
        inside = _project("In", cal, viewer, program=program)
        outside = _project("Out", cal, viewer)
        _book(inside, fay, "0.3", MONDAY, MONDAY + timedelta(days=4))
        _book(outside, fay, "0.3", MONDAY, MONDAY + timedelta(days=4))

        body = client.get(
            URL, {"week_start": MONDAY.isoformat(), "weeks": 1, "program": str(program.pk)}
        ).json()
        assert _week(body, "Fay")[0]["load_pct"] == 30
        assert body["scope"]["program_id"] == str(program.pk)

    def test_anonymous_is_refused(self, db: object) -> None:
        assert APIClient().get(URL).status_code in (401, 403)

    @pytest.mark.parametrize(
        ("params", "field"),
        [
            ({"week_start": "not-a-date"}, "week_start"),
            ({"weeks": "0"}, "weeks"),
            ({"weeks": "27"}, "weeks"),
            ({"weeks": "x"}, "weeks"),
            ({"program": "nope"}, "program"),
        ],
    )
    def test_bad_params_are_400(self, client: APIClient, params: dict, field: str) -> None:
        resp = client.get(URL, params)
        assert resp.status_code == 400
        assert field in resp.json()


@pytest.mark.django_db
def test_query_count_does_not_grow_with_projects(
    client: APIClient, viewer: object, cal: Calendar
) -> None:
    def run() -> int:
        with CaptureQueriesContext(connection) as ctx:
            assert (
                client.get(URL, {"week_start": MONDAY.isoformat(), "weeks": 2}).status_code == 200
            )
        return len(ctx.captured_queries)

    r = Resource.objects.create(name="R0", max_units="1.0", calendar=cal)
    _book(_project("P0", cal, viewer), r, "0.5", MONDAY, MONDAY + timedelta(days=4))
    baseline = run()
    for i in range(1, 5):
        res = Resource.objects.create(name=f"R{i}", max_units="1.0", calendar=cal)
        _book(_project(f"P{i}", cal, viewer), res, "0.5", MONDAY, MONDAY + timedelta(days=4))
    assert run() == baseline


@pytest.mark.django_db
class TestSprintScopedFiguresAreNamed:
    def test_sprint_capacity_carries_definition_and_as_of(
        self, client: APIClient, viewer: object, cal: Calendar
    ) -> None:
        p = _project("P", cal, viewer)
        sprint = Sprint.objects.create(
            project=p, name="S1", start_date=MONDAY, finish_date=MONDAY + timedelta(days=13)
        )
        body = client.get(f"/api/v1/sprints/{sprint.pk}/capacity/").json()
        assert body["as_of"]
        assert body["definitions"] == definitions_by_field(SPRINT_CAPACITY_DEFINED)
        assert "not a person's load across projects" in body["definitions"]["ratio"]

    def test_definitions_are_distinct_sentences(self) -> None:
        sentences = [
            METRIC_DEFINITIONS[k]
            for k in (
                "people_load.load_pct",
                "load_pct",
                "sprint_capacity.ratio",
                "my_work_utilization.ratio",
            )
        ]
        assert len(set(sentences)) == 4
