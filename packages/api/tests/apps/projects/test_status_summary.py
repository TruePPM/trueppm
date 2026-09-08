"""Tests for GET /api/v1/projects/<pk>/status-summary/ (issue #205).

The recency/forecast half of this suite guards #2903: ``monte_carlo_p80``,
``last_saved`` and ``recalculated_at`` were returned as unconditional nulls behind a
comment whose stated reason was wrong, while all three underlying values existed.
"""

from __future__ import annotations

import datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Health, Project, Task, TaskStatus
from trueppm_api.apps.scheduling.models import MonteCarloRun

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(user: object, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Test Project",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def tasks(project: Project) -> list[Task]:
    today = datetime.date(2026, 4, 27)
    return [
        Task.objects.create(
            project=project,
            name="Critical A",
            wbs_path="1",
            duration=5,
            is_critical=True,
            total_float=0,
            status=TaskStatus.IN_PROGRESS,
            early_start=today - datetime.timedelta(days=3),
            early_finish=today + datetime.timedelta(days=2),
        ),
        Task.objects.create(
            project=project,
            name="At Risk B",
            wbs_path="2",
            duration=5,
            is_critical=False,
            total_float=3,
            status=TaskStatus.IN_PROGRESS,
            early_start=today,
            early_finish=today + datetime.timedelta(days=5),
        ),
        Task.objects.create(
            project=project,
            name="Safe C",
            wbs_path="3",
            duration=10,
            is_critical=False,
            total_float=20,
            status=TaskStatus.NOT_STARTED,
            early_start=today + datetime.timedelta(days=5),
            early_finish=today + datetime.timedelta(days=15),
        ),
        Task.objects.create(
            project=project,
            name="Done D",
            wbs_path="4",
            duration=3,
            is_critical=True,
            total_float=0,
            status=TaskStatus.COMPLETE,
        ),
    ]


class TestStatusSummary:
    def test_returns_correct_counts(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_count"] == 4
        # critical_count excludes the COMPLETE task
        assert data["critical_count"] == 1
        # at_risk_count: total_float <= 5 and not COMPLETE (A + B)
        assert data["at_risk_count"] == 2

    def test_at_risk_tasks_list(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        assert resp.status_code == 200
        wbs_list = [t["wbs"] for t in resp.json()["at_risk_tasks"]]
        assert "1" in wbs_list
        assert "2" in wbs_list
        assert "3" not in wbs_list

    def test_critical_tasks_list(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        data = resp.json()
        wbs_list = [t["wbs"] for t in data["critical_tasks"]]
        # Only the non-COMPLETE critical task
        assert "1" in wbs_list
        assert "4" not in wbs_list

    # -----------------------------------------------------------------------
    # #2903 — the three fields that were hard-coded to null
    #
    # A hard null is worse than a missing key for an API or MCP consumer: it is
    # indistinguishable from "no data yet", so automation keyed on that distinction
    # was silently wrong for every project that HAD run a forecast. Each field below
    # is asserted twice — once for the real value, once for the null that now means
    # something.
    # -----------------------------------------------------------------------

    def test_p80_is_the_latest_monte_carlo_runs_p80(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        MonteCarloRun.objects.create(
            project=project, p80=datetime.date(2026, 10, 1), n_simulations=500
        )
        newest = MonteCarloRun.objects.create(
            project=project, p80=datetime.date(2026, 11, 3), n_simulations=500
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["monte_carlo_p80"] == "2026-11-03"
        assert newest.p80 == datetime.date(2026, 11, 3)

    def test_p80_is_null_only_when_no_run_exists(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """Null now carries a fact — "no forecast" — rather than "not implemented"."""
        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["monte_carlo_p80"] is None

    def test_p80_ignores_another_projects_run(
        self, client: APIClient, project: Project, calendar: Calendar, tasks: list[Task]
    ) -> None:
        other = Project.objects.create(
            name="Other", start_date=datetime.date(2026, 1, 1), calendar=calendar
        )
        MonteCarloRun.objects.create(
            project=other, p80=datetime.date(2026, 12, 25), n_simulations=500
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["monte_carlo_p80"] is None

    def test_recalculated_at_is_the_projects_last_cpm_pass(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The stale comment blamed the *Task* model; ``recalculated_at`` is on Project
        and has been written on every CPM pass since ADR-0114."""
        stamp = datetime.datetime(2026, 4, 27, 9, 30, tzinfo=datetime.UTC)
        Project.objects.filter(pk=project.pk).update(recalculated_at=stamp)

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["recalculated_at"] == "2026-04-27T09:30:00Z"

    def test_recalculated_at_is_null_before_the_first_pass(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        assert project.recalculated_at is None

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["recalculated_at"] is None

    def test_last_saved_is_the_newest_human_edit_across_live_tasks(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        # Every fixture row is stamped first: Task.save() treats a write as human
        # unless it opts out (ADR-0786 §4), so creating the fixture already set
        # edited_at on all four, and a partial override would leave `now` as the max.
        Task.objects.filter(project=project).update(
            edited_at=datetime.datetime(2026, 5, 1, 14, 0, tzinfo=datetime.UTC)
        )
        Task.objects.filter(pk=tasks[0].pk).update(
            edited_at=datetime.datetime(2026, 5, 2, 14, 0, tzinfo=datetime.UTC)
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["last_saved"] == "2026-05-02T14:00:00Z"

    def test_last_saved_ignores_a_deleted_task(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The live-task queryset is the one the counts use — recency must agree with it."""
        Task.objects.filter(project=project).update(
            edited_at=datetime.datetime(2026, 5, 1, 14, 0, tzinfo=datetime.UTC)
        )
        Task.objects.filter(pk=tasks[1].pk).update(
            edited_at=datetime.datetime(2026, 9, 9, 14, 0, tzinfo=datetime.UTC),
            is_deleted=True,
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["last_saved"] == "2026-05-01T14:00:00Z"

    def test_last_saved_is_null_when_no_task_has_been_touched(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """A freshly seeded or imported project: a machine wrote every row (ADR-0786 §4)."""
        Task.objects.filter(project=project).update(edited_at=None)

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["last_saved"] is None

    def test_requires_authentication(self, anon_client: APIClient, project: Project) -> None:
        resp = anon_client.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (401, 403)

    def test_non_member_forbidden(self, other_user: object, project: Project) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (403, 404)


class TestStatusSummaryHealthBand:
    """``health_band`` on the status summary (#3501).

    The shell health chip fetches this endpoint and nothing else, so before the
    field existed it could only re-derive a band from ``at_risk_count`` /
    ``critical_count`` — which cannot see the manual ``Project.health`` report.
    Every case below therefore pins the band against the counts on the same
    project: a server that dropped the override would return the opposite value.
    """

    URL = "/api/v1/projects/{pk}/status-summary/"

    # ── The AUTO branch: no report, so the counts decide ──────────────────────

    def test_auto_with_no_signals_is_on_track(self, client: APIClient, project: Project) -> None:
        assert project.health == Health.AUTO
        resp = client.get(self.URL.format(pk=project.pk))
        assert resp.json()["health_band"] == "on_track"

    def test_auto_with_an_at_risk_task_is_at_risk(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        # Drop the one critical task so at-risk is the worst signal present.
        Task.objects.filter(project=project, is_critical=True).update(is_critical=False)
        data = client.get(self.URL.format(pk=project.pk)).json()
        assert (data["critical_count"], data["at_risk_count"]) == (0, 2)
        assert data["health_band"] == "at_risk"

    def test_auto_with_a_critical_task_is_critical(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        data = client.get(self.URL.format(pk=project.pk)).json()
        assert data["critical_count"] == 1
        assert data["health_band"] == "critical"

    def test_auto_lets_critical_win_over_at_risk(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        # Both signals present at once. Worst state wins — reversing the two
        # tests in ``compute_health_band`` is the mutation this case catches, and
        # no single-signal case above can.
        data = client.get(self.URL.format(pk=project.pk)).json()
        assert data["at_risk_count"] > 0 and data["critical_count"] > 0
        assert data["health_band"] == "critical"

    # ── The override branch: the PM's report beats the counts ─────────────────

    def test_manual_critical_wins_over_a_clean_plan(
        self, client: APIClient, project: Project
    ) -> None:
        """The #3501 case: reported Critical, zero at-risk and zero critical tasks."""
        project.health = Health.CRITICAL
        project.save(update_fields=["health"])

        data = client.get(self.URL.format(pk=project.pk)).json()

        assert (data["at_risk_count"], data["critical_count"]) == (0, 0)
        assert data["health_band"] == "critical"

    def test_manual_on_track_wins_over_a_real_critical_task(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The inverse: reported On track over a plan the counts call critical."""
        project.health = Health.ON_TRACK
        project.save(update_fields=["health"])

        data = client.get(self.URL.format(pk=project.pk)).json()

        assert data["critical_count"] == 1
        assert data["health_band"] == "on_track"

    def test_manual_at_risk_wins_over_a_clean_plan(
        self, client: APIClient, project: Project
    ) -> None:
        project.health = Health.AT_RISK
        project.save(update_fields=["health"])

        assert client.get(self.URL.format(pk=project.pk)).json()["health_band"] == "at_risk"

    # ── One rule, called twice (ADR-0133) ─────────────────────────────────────

    def test_band_matches_my_projects_health_for_the_same_project(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The two surfaces that print a band must never disagree about one project.

        This is the assertion that would catch a second copy of the rule being
        introduced next to the first — the divergence #3501 was filed for was
        exactly one surface computing what the other read.
        """
        project.health = Health.CRITICAL
        project.save(update_fields=["health"])

        summary = client.get(self.URL.format(pk=project.pk)).json()
        rows = client.get("/api/v1/projects/health-summary/").json()
        row = next(r for r in rows if r["id"] == str(project.pk))

        assert summary["health_band"] == row["health_band"] == "critical"

    def test_the_band_costs_no_extra_query(
        self,
        client: APIClient,
        project: Project,
        tasks: list[Task],
        django_assert_num_queries: object,
    ) -> None:
        """Reading the override must not refetch the project row.

        ``health`` is a plain column on the instance ``get_object()`` already
        loaded, so folding it into the band is free. Pinning the *absolute*
        query count here would red on any unrelated auth or queryset change, so
        this asserts the invariant that actually belongs to #3501: setting the
        override does not change how many queries the endpoint runs.
        """
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        url = self.URL.format(pk=project.pk)
        client.get(url)  # warm any per-connection setup out of the measurement

        with CaptureQueriesContext(connection) as auto:
            assert client.get(url).json()["health_band"] == "critical"

        project.health = Health.ON_TRACK
        project.save(update_fields=["health"])

        with CaptureQueriesContext(connection) as overridden:
            assert client.get(url).json()["health_band"] == "on_track"

        assert len(overridden.captured_queries) == len(auto.captured_queries)

    def test_a_viewer_sees_the_same_band_as_the_owner(
        self, client: APIClient, other_user: object, project: Project, tasks: list[Task]
    ) -> None:
        """Every project member reads health, so every member reads the band.

        Enforcement is inherited from the endpoint gate rather than added here
        (``test_non_member_forbidden`` covers the refusal), but the band is a new
        field on that payload and the lowest read role is the one a future
        special-case would break first.
        """
        ProjectMembership.objects.create(project=project, user=other_user, role=Role.VIEWER)
        project.health = Health.CRITICAL
        project.save(update_fields=["health"])

        viewer = APIClient()
        viewer.force_authenticate(user=other_user)

        owner_band = client.get(self.URL.format(pk=project.pk)).json()["health_band"]
        viewer_resp = viewer.get(self.URL.format(pk=project.pk))

        assert viewer_resp.status_code == 200
        assert viewer_resp.json()["health_band"] == owner_band == "critical"

    def test_band_is_one_of_the_three_vocabulary_values(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        # AUTO is a "no report" value, never a fourth band on the wire.
        assert client.get(self.URL.format(pk=project.pk)).json()["health_band"] in {
            "on_track",
            "at_risk",
            "critical",
        }


class TestStatusSummaryHealthBandSource:
    """``health_band_source`` on the status summary (#3525).

    ``health_band`` alone cannot be explained by the payload that carries it: the
    shell chip's popover lists the at-risk and critical tasks, so a band the PM
    reported by hand renders a red header above two "0 tasks" rows. This field is
    the discriminator that lets a client say *where* the band came from.

    It must be a SERVER fact rather than something the client compares its way to,
    and the two cases that prove it are ``test_a_report_agreeing_with_the_counts_
    is_still_reported`` and ``test_a_report_disagreeing_...``: a comparison of band
    against counts returns the same answer for a reported band that happens to
    match, so a client-side inference is silently wrong on exactly the projects
    where nothing looks wrong.
    """

    URL = "/api/v1/projects/{pk}/status-summary/"

    def test_auto_with_no_report_is_derived(self, client: APIClient, project: Project) -> None:
        assert project.health == Health.AUTO
        data = client.get(self.URL.format(pk=project.pk)).json()
        assert data["health_band_source"] == "derived"

    def test_auto_with_signals_is_still_derived(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """AUTO is "no report filed", which is the derived case — never a third value."""
        data = client.get(self.URL.format(pk=project.pk)).json()
        assert data["critical_count"] > 0
        assert (data["health_band"], data["health_band_source"]) == ("critical", "derived")

    @pytest.mark.parametrize(
        ("health", "band"),
        [
            (Health.ON_TRACK, "on_track"),
            (Health.AT_RISK, "at_risk"),
            (Health.CRITICAL, "critical"),
        ],
    )
    def test_every_manual_report_is_reported(
        self, client: APIClient, project: Project, health: Health, band: str
    ) -> None:
        project.health = health
        project.save(update_fields=["health"])

        data = client.get(self.URL.format(pk=project.pk)).json()

        assert (data["health_band"], data["health_band_source"]) == (band, "reported")

    def test_a_report_disagreeing_with_the_counts_is_reported(
        self, client: APIClient, project: Project
    ) -> None:
        """The headline case: reported Critical over a plan with nothing wrong in it."""
        project.health = Health.CRITICAL
        project.save(update_fields=["health"])

        data = client.get(self.URL.format(pk=project.pk)).json()

        assert (data["at_risk_count"], data["critical_count"]) == (0, 0)
        assert (data["health_band"], data["health_band_source"]) == ("critical", "reported")

    def test_a_report_agreeing_with_the_counts_is_still_reported(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The case a client-side comparison cannot see, and the reason this field exists.

        The PM reported Critical on a plan the counts *also* call critical. Band
        and counts agree, so a client comparing the two concludes "derived" and
        never names the report. Only the server knows, because only the server
        saw which branch ran.
        """
        project.health = Health.CRITICAL
        project.save(update_fields=["health"])

        data = client.get(self.URL.format(pk=project.pk)).json()

        assert data["critical_count"] > 0
        assert data["health_band"] == "critical"  # what the counts would say too
        assert data["health_band_source"] == "reported"

    def test_source_is_one_of_exactly_two_values(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        assert client.get(self.URL.format(pk=project.pk)).json()["health_band_source"] in {
            "reported",
            "derived",
        }

    def test_health_summary_carries_the_same_source_for_the_same_project(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """Published on both endpoints or on neither (ADR-0133 — one rule, called twice).

        Shipping provenance on the single-project summary alone would reintroduce
        one level up exactly the disagreement #3501 fixed: the top bar would know
        a band was a person's call and the my-projects triage list would not.
        """
        project.health = Health.ON_TRACK
        project.save(update_fields=["health"])

        summary = client.get(self.URL.format(pk=project.pk)).json()
        rows = client.get("/api/v1/projects/health-summary/").json()
        row = next(r for r in rows if r["id"] == str(project.pk))

        assert summary["health_band"] == row["health_band"] == "on_track"
        assert summary["health_band_source"] == row["health_band_source"] == "reported"

    def test_the_source_costs_no_extra_query(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """It comes off the same call and the same already-loaded column as the band.

        The absolute count is deliberately not pinned (any unrelated auth change
        would red it); the invariant is that adding provenance did not add a read.
        """
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        url = self.URL.format(pk=project.pk)
        client.get(url)  # warm any per-connection setup out of the measurement

        with CaptureQueriesContext(connection) as auto:
            assert client.get(url).json()["health_band_source"] == "derived"

        project.health = Health.ON_TRACK
        project.save(update_fields=["health"])

        with CaptureQueriesContext(connection) as reported:
            assert client.get(url).json()["health_band_source"] == "reported"

        assert len(reported.captured_queries) == len(auto.captured_queries)

    def test_a_viewer_reads_the_same_source_as_the_owner(
        self, client: APIClient, other_user: object, project: Project
    ) -> None:
        """Provenance is not a privileged read — it reveals nothing the band does not.

        A Viewer already reads ``health_band``; being told that band came from a
        person rather than from float arithmetic adds no fact about the project
        that the band itself did not already carry.
        """
        ProjectMembership.objects.create(project=project, user=other_user, role=Role.VIEWER)
        project.health = Health.CRITICAL
        project.save(update_fields=["health"])

        viewer = APIClient()
        viewer.force_authenticate(user=other_user)
        resp = viewer.get(self.URL.format(pk=project.pk))

        assert resp.status_code == 200
        assert resp.json()["health_band_source"] == "reported"
