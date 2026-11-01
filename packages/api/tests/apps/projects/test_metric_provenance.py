"""Metric provenance: one owner per metric, with a definition and an as_of (ADR-1314, #4760).

The bug class: one metric read differently on different screens because each surface
computed or labeled its own number. These tests pin the server half of the fix —
every owning endpoint states what its figures mean (``definitions``) and when they
were true (``as_of``, or ``last_run_at`` for the forecast) — plus the one new figure,
the P80 delta against the commitment, including the rule-119 "not computable" case
where the figure is returned null *with a reason* rather than omitted.
"""

from __future__ import annotations

import datetime
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.metric_provenance import (
    BURN_DEFINED,
    FORECAST_DEFINED,
    METRIC_DEFINITIONS,
    OVERVIEW_DEFINED,
    STATUS_SUMMARY_DEFINED,
    UTILIZATION_DEFINED,
)
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Program,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.views import mc_latest_cache_key

User = get_user_model()

REPO_ROOT = Path(__file__).resolve().parents[5]
VOCAB_PAGE = (
    REPO_ROOT
    / "packages"
    / "website"
    / "src"
    / "content"
    / "docs"
    / "features"
    / "metric-vocabulary.md"
)


@pytest.fixture(autouse=True)
def _clear_cache() -> object:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="prov-pm", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def stranger_client(db: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=User.objects.create_user(username="prov-stranger", password="pw"))
    return c


@pytest.fixture
def project(user: object) -> Project:
    p = Project.objects.create(
        name="Provenance",
        start_date=datetime.date(2026, 1, 5),
        calendar=Calendar.objects.create(name="Standard"),
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


def _task(project: Project, name: str, **kw: object) -> Task:
    return Task.objects.create(project=project, name=name, duration=5, **kw)


def _baseline(project: Project, user: object, finishes: list[datetime.date]) -> Baseline:
    baseline = Baseline.objects.create(
        project=project, name="B1", created_by=user, is_active=True, has_cpm_dates=True
    )
    for i, finish in enumerate(finishes):
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=_task(project, f"BT{i}").pk,
            task_name=f"BT{i}",
            finish=finish,
            duration=5,
            finish_at_day_start=False,
        )
    return baseline


# ── status-summary ──────────────────────────────────────────────────────────


class TestStatusSummaryProvenance:
    def test_carries_as_of_and_one_definition_per_figure(
        self, client: APIClient, project: Project
    ) -> None:
        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.status_code == 200
        body = resp.json()
        assert body["as_of"]
        assert body["definitions"] == {k: METRIC_DEFINITIONS[k] for k in STATUS_SUMMARY_DEFINED}

    def test_blocked_count_counts_every_live_blocked_task(
        self, client: APIClient, project: Project
    ) -> None:
        _task(project, "Blocked open", blocked_reason="vendor")
        _task(project, "Blocked done", blocked_reason="vendor", status=TaskStatus.COMPLETE)
        _task(project, "Blocked deleted", blocked_reason="vendor", is_deleted=True)
        _task(project, "Not blocked")

        body = client.get(f"/api/v1/projects/{project.pk}/status-summary/").json()

        # The blocked list's own rule — non-empty reason on a live row — counted in full.
        assert body["blocked_count"] == 2

    def test_p80_echo_matches_the_forecast_owner_on_a_cache_only_run(
        self, client: APIClient, project: Project
    ) -> None:
        # A Member-triggered run refreshes the cache and persists no row (#1502); the
        # echo used to read the persisted row only, so it lagged the owner for a day.
        MonteCarloRun.objects.create(
            project=project, p80=datetime.date(2026, 6, 1), n_simulations=500
        )
        cache.set(mc_latest_cache_key(project.pk), {"p80": "2026-07-15"}, timeout=60)

        body = client.get(f"/api/v1/projects/{project.pk}/status-summary/").json()

        assert body["monte_carlo_p80"] == "2026-07-15"

    def test_non_member_is_refused(self, stranger_client: APIClient, project: Project) -> None:
        resp = stranger_client.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (403, 404)

    def test_anonymous_is_refused(self, project: Project) -> None:
        resp = APIClient().get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code == 401


# ── monte-carlo/latest: commitment and delta ────────────────────────────────


class TestForecastCommitment:
    URL = "/api/v1/projects/{}/monte-carlo/latest/"

    def _run(self, project: Project, p80: datetime.date | None) -> MonteCarloRun:
        return MonteCarloRun.objects.create(
            project=project,
            p50=p80,
            p80=p80,
            p95=p80,
            n_simulations=500,
            p80_at_day_start=False,
        )

    def test_commitment_is_the_active_baseline_finish(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        _baseline(project, user, [datetime.date(2026, 5, 1), datetime.date(2026, 5, 29)])
        self._run(project, datetime.date(2026, 6, 5))

        body = client.get(self.URL.format(project.pk)).json()

        assert body["commitment_source"] == "baseline"
        assert body["commitment_date"] == "2026-05-29"
        # Friday end-of-day to Friday end-of-day, one week later.
        assert body["p80_delta_vs_commitment_days"] == 7
        assert body["p80_delta_vs_commitment_reason"] is None
        assert (
            body["definitions"]["commitment_date"] == METRIC_DEFINITIONS["commitment_date.baseline"]
        )
        assert set(body["definitions"]) == set(FORECAST_DEFINED)
        # last_run_at is this endpoint's as_of (ADR-1314).
        assert body["last_run_at"]

    def test_falls_back_to_the_program_target_date(
        self, client: APIClient, project: Project
    ) -> None:
        program = Program.objects.create(name="Prog", target_date=datetime.date(2026, 6, 12))
        project.program = program
        project.save(update_fields=["program"])
        self._run(project, datetime.date(2026, 6, 5))

        body = client.get(self.URL.format(project.pk)).json()

        assert body["commitment_source"] == "program_target"
        assert body["commitment_date"] == "2026-06-12"
        assert body["p80_delta_vs_commitment_days"] == -7
        assert (
            body["definitions"]["commitment_date"]
            == METRIC_DEFINITIONS["commitment_date.program_target"]
        )

    def test_pre_cpm_baseline_is_not_a_commitment(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        baseline = _baseline(project, user, [datetime.date(2026, 5, 29)])
        baseline.has_cpm_dates = False
        baseline.save(update_fields=["has_cpm_dates"])
        self._run(project, datetime.date(2026, 6, 5))

        body = client.get(self.URL.format(project.pk)).json()

        assert body["commitment_source"] == "none"

    def test_no_commitment_is_returned_with_a_reason_not_omitted(
        self, client: APIClient, project: Project
    ) -> None:
        self._run(project, datetime.date(2026, 6, 5))

        body = client.get(self.URL.format(project.pk)).json()

        assert "p80_delta_vs_commitment_days" in body
        assert body["p80_delta_vs_commitment_days"] is None
        assert body["p80_delta_vs_commitment_reason"] == "no_commitment"
        assert body["commitment_source"] == "none"
        assert body["commitment_date"] is None
        assert body["definitions"]["commitment_date"] == METRIC_DEFINITIONS["commitment_date.none"]

    def test_no_p80_is_returned_with_a_reason(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        _baseline(project, user, [datetime.date(2026, 5, 29)])
        self._run(project, None)

        body = client.get(self.URL.format(project.pk)).json()

        assert body["p80_delta_vs_commitment_days"] is None
        assert body["p80_delta_vs_commitment_reason"] == "no_forecast"
        assert body["commitment_date"] == "2026-05-29"

    def test_cache_hit_branch_carries_the_same_facts(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        _baseline(project, user, [datetime.date(2026, 5, 29)])
        cache.set(
            mc_latest_cache_key(project.pk),
            {
                "project_id": str(project.pk),
                "p80": "2026-06-05",
                "p80_at_day_start": False,
                "last_run_at": "2026-05-01T00:00:00+00:00",
            },
            timeout=60,
        )

        body = client.get(self.URL.format(project.pk)).json()

        assert body["p80_delta_vs_commitment_days"] == 7
        assert body["commitment_source"] == "baseline"

    def test_non_member_is_refused(self, stranger_client: APIClient, project: Project) -> None:
        self._run(project, datetime.date(2026, 6, 5))
        resp = stranger_client.get(self.URL.format(project.pk))
        assert resp.status_code in (403, 404)


# ── commitment precedence, working-time delta, baseline reading ─────────────


def _baseline_with_readings(
    project: Project, user: object, rows: list[tuple[datetime.date, bool | None]]
) -> Baseline:
    baseline = Baseline.objects.create(
        project=project, name="BR", created_by=user, is_active=True, has_cpm_dates=True
    )
    for i, (finish, at_start) in enumerate(rows):
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=_task(project, f"R{i}").pk,
            task_name=f"R{i}",
            finish=finish,
            duration=5,
            finish_at_day_start=at_start,
        )
    return baseline


class TestCommitmentRules:
    URL = "/api/v1/projects/{}/monte-carlo/latest/"

    def test_active_baseline_outranks_the_program_target(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        program = Program.objects.create(name="Prog", target_date=datetime.date(2026, 6, 12))
        project.program = program
        project.save(update_fields=["program"])
        _baseline(project, user, [datetime.date(2026, 5, 29)])
        MonteCarloRun.objects.create(
            project=project,
            p80=datetime.date(2026, 6, 5),
            n_simulations=500,
            p80_at_day_start=False,
        )

        body = client.get(self.URL.format(project.pk)).json()

        assert body["commitment_source"] == "baseline"
        assert body["commitment_date"] == "2026-05-29"

    def test_start_of_monday_commitment_vs_end_of_friday_p80_is_zero(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        # 2026-06-01 is a Monday. The start of Monday and the end of the Friday
        # before it are the same point in the working week (#4197), so the delta
        # is 0, not -3 — only the calendar path through lazy_finish_shift_days
        # gets this right.
        _baseline_with_readings(project, user, [(datetime.date(2026, 6, 1), True)])
        MonteCarloRun.objects.create(
            project=project,
            p80=datetime.date(2026, 5, 29),
            n_simulations=500,
            p80_at_day_start=False,
        )

        body = client.get(self.URL.format(project.pk)).json()

        assert body["commitment_date"] == "2026-06-01"
        assert body["p80_delta_vs_commitment_days"] == 0

    @pytest.mark.parametrize(
        ("readings", "expected"),
        [
            ([True, True], True),
            ([True, False], False),
            ([True, None], None),
        ],
    )
    def test_baseline_reading_on_the_finish_day(
        self,
        project: Project,
        user: object,
        readings: list[bool | None],
        expected: bool | None,
    ) -> None:
        from trueppm_api.apps.projects.metric_provenance import _active_baseline_commitment

        day = datetime.date(2026, 6, 1)
        _baseline_with_readings(
            project,
            user,
            [(datetime.date(2026, 5, 1), False)] + [(day, r) for r in readings],
        )

        result = _active_baseline_commitment(project.pk)

        # Only rows on the latest day decide the reading: all start-of-day gives
        # start-of-day, any end-of-day gives end-of-day, any unknown gives unknown.
        assert result == (day, expected)


class TestOverviewEchoesTheForecastOwner:
    def test_overview_reads_the_cached_run_like_monte_carlo_latest(
        self, client: APIClient, project: Project
    ) -> None:
        # A Member-triggered run refreshes the cache and persists no row (#1502).
        MonteCarloRun.objects.create(
            project=project,
            p80=datetime.date(2026, 6, 1),
            cpm_finish=datetime.date(2026, 5, 1),
            n_simulations=500,
        )
        cache.set(
            mc_latest_cache_key(project.pk),
            {
                "project_id": str(project.pk),
                "p80": "2026-07-15",
                "cpm_finish": "2026-07-01",
                "p80_at_day_start": False,
                "cpm_finish_at_day_start": False,
                "last_run_at": "2026-06-20T00:00:00+00:00",
                "plan_version": project.last_sync_version,
            },
            timeout=60,
        )

        overview = client.get(f"/api/v1/projects/{project.pk}/overview/").json()
        latest = client.get(f"/api/v1/projects/{project.pk}/monte-carlo/latest/").json()

        assert overview["risk_premium_p80"] == latest["risk_premium_p80"] == "2026-07-15"
        assert overview["forecast_staleness"] == latest["forecast_staleness"]


# ── program target date: who sees it (accepted exposure, ADR-1314) ──────────


class TestProgramTargetExposure:
    URL = "/api/v1/projects/{}/monte-carlo/latest/"

    def _program_project(self, project: Project, **program_kw: object) -> Program:
        program = Program.objects.create(
            name="Prog", target_date=datetime.date(2026, 6, 12), **program_kw
        )
        project.program = program
        project.save(update_fields=["program"])
        MonteCarloRun.objects.create(
            project=project,
            p80=datetime.date(2026, 6, 5),
            n_simulations=500,
            p80_at_day_start=False,
        )
        return program

    def test_project_viewer_who_is_not_a_program_member_sees_the_commitment(
        self, project: Project
    ) -> None:
        # Program membership is independent of project membership (ADR-0070). The
        # commitment is the project's own; ADR-1314 accepts showing this one date to
        # every forecast reader so two readers never see two different deltas.
        from trueppm_api.apps.access.models import ProgramMembership

        program = self._program_project(project)
        viewer = User.objects.create_user(username="prov-viewer", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        assert not ProgramMembership.objects.filter(program=program, user=viewer).exists()
        c = APIClient()
        c.force_authenticate(user=viewer)

        body = c.get(self.URL.format(project.pk)).json()

        assert body["commitment_source"] == "program_target"
        assert body["commitment_date"] == "2026-06-12"
        # Nothing else about the program rides along.
        assert not any(k.startswith("program") for k in body)

    def test_a_soft_deleted_programs_target_date_is_ignored(
        self, client: APIClient, project: Project
    ) -> None:
        self._program_project(project, is_deleted=True)

        body = client.get(self.URL.format(project.pk)).json()

        assert body["commitment_source"] == "none"
        assert body["p80_delta_vs_commitment_reason"] == "no_commitment"


# ── the live run (POST) spreads the same facts ──────────────────────────────


def test_live_run_carries_commitment_and_definitions(
    client: APIClient, project: Project, user: object
) -> None:
    Task.objects.create(
        project=project,
        name="Work",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=10,
    )
    _baseline(project, user, [datetime.date(2026, 1, 9)])

    resp = client.post(
        f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 100}, format="json"
    )

    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["commitment_source"] == "baseline"
    assert body["commitment_date"] == "2026-01-09"
    assert isinstance(body["p80_delta_vs_commitment_days"], int)
    assert body["p80_delta_vs_commitment_reason"] is None
    assert set(body["definitions"]) == set(FORECAST_DEFINED)


# ── task slip: the single-task comparison carries its own provenance ────────


class TestTaskSlipProvenance:
    def _url(self, project: Project, task: Task) -> str:
        return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/baseline/"

    def test_no_baseline_still_carries_definition_and_as_of(
        self, client: APIClient, project: Project
    ) -> None:
        task = _task(project, "Lonely")

        body = client.get(self._url(project, task)).json()

        assert body["has_baseline"] is False
        assert body["as_of"]
        assert body["definitions"] == {
            "finish_delta_days": METRIC_DEFINITIONS["baseline_finish_variance_days"]
        }

    def test_slip_matches_the_task_row_figure(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        task = _task(
            project,
            "Slipping",
            early_start=datetime.date(2026, 6, 1),
            early_finish=datetime.date(2026, 6, 12),
        )
        baseline = Baseline.objects.create(
            project=project, name="B1", created_by=user, is_active=True, has_cpm_dates=True
        )
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=task.pk,
            task_name=task.name,
            start=datetime.date(2026, 6, 1),
            finish=datetime.date(2026, 6, 5),
            duration=5,
            finish_at_day_start=False,
        )

        body = client.get(self._url(project, task)).json()
        listing = client.get(f"/api/v1/tasks/?project={project.pk}").json()
        rows = listing["results"] if isinstance(listing, dict) else listing
        row = next(r for r in rows if r["id"] == str(task.pk))

        assert body["finish_delta_days"] == 7
        assert body["as_of"]
        assert set(body["definitions"]) == {"finish_delta_days"}
        # One computation, two field names: the row and the comparison agree.
        assert row["baseline_finish_variance_days"] == body["finish_delta_days"]

    def test_non_member_is_refused(self, stranger_client: APIClient, project: Project) -> None:
        task = _task(project, "Hidden")
        resp = stranger_client.get(self._url(project, task))
        assert resp.status_code in (403, 404)


# ── the other owners ────────────────────────────────────────────────────────


class TestOtherOwners:
    def test_overview(self, client: APIClient, project: Project) -> None:
        body = client.get(f"/api/v1/projects/{project.pk}/overview/").json()
        assert body["as_of"]
        assert body["definitions"] == {k: METRIC_DEFINITIONS[k] for k in OVERVIEW_DEFINED}

    def test_burn(self, client: APIClient, project: Project) -> None:
        body = client.get(f"/api/v1/projects/{project.pk}/burn/?chart_type=burnup").json()
        assert body["as_of"]
        assert body["definitions"] == {k: METRIC_DEFINITIONS[k] for k in BURN_DEFINED}

    def test_burn_combined(self, client: APIClient, project: Project) -> None:
        body = client.get(f"/api/v1/projects/{project.pk}/burn/?chart_type=combined").json()
        assert body["as_of"]
        assert set(body["definitions"]) == {"burn_series"}

    def test_utilization(self, client: APIClient, project: Project) -> None:
        _task(
            project,
            "Scheduled",
            early_start=datetime.date(2026, 1, 5),
            early_finish=datetime.date(2026, 1, 9),
        )
        resp = client.get(f"/api/v1/projects/{project.pk}/utilization/")
        assert resp.status_code == 200, resp.content
        body = resp.json()
        assert body["as_of"]
        assert body["definitions"] == {k: METRIC_DEFINITIONS[k] for k in UTILIZATION_DEFINED}

    @pytest.mark.parametrize("suffix", ["overview/", "burn/", "utilization/"])
    def test_non_member_is_refused(
        self, stranger_client: APIClient, project: Project, suffix: str
    ) -> None:
        resp = stranger_client.get(f"/api/v1/projects/{project.pk}/{suffix}")
        assert resp.status_code in (403, 404)


# ── the published vocabulary states each definition exactly once ───────────


def test_vocabulary_page_states_every_definition_once() -> None:
    page = VOCAB_PAGE.read_text(encoding="utf-8")
    missing = [k for k, sentence in METRIC_DEFINITIONS.items() if page.count(sentence) != 1]
    assert missing == [], (
        f"metric-vocabulary.md must state each METRIC_DEFINITIONS sentence verbatim, "
        f"exactly once; out of step: {missing}"
    )
