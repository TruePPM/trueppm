"""Monte Carlo percentile deltas are measured in working time (#4204).

Follow-up to #4178/#4197 (``test_finish_reading.py``, ``test_baseline_finish_reading.py``).
A percentile and the CPM finish are *shown* days. When the finish is a start-of-day
milestone (``A(5d, Mon..Fri) -FS+1d-> M`` puts M at the start of Monday) the end of
the Friday before it is the same position in working time, so every delta the API
reports between two of them — ``delta_vs_cpm``, ``risk_premium_days``, the history
endpoint's run-to-run ``delta`` and the what-if ``delta_vs_current`` — must read that
weekend hop as no change, and still report a real one-working-day move.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient
from trueppm_scheduler.models import Calendar as SchedCalendar

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.risk_premium import (
    build_risk_premium,
    delta_vs_cpm_days,
    risk_premium_for_forecast_payload,
)
from trueppm_api.apps.scheduling.tasks import _run_schedule
from trueppm_api.apps.scheduling.views import _annotate_run_deltas

User = get_user_model()

MON_FRI = SchedCalendar(working_days=31)
FRI = date(2026, 8, 7)
MON = date(2026, 8, 10)
TUE = date(2026, 8, 11)
TODAY = date(2026, 8, 3)


def _no_calendar() -> Any:
    raise AssertionError("the calendar must not be composed for end-of-day readings")


# ---------------------------------------------------------------------------
# Unit: the derivation
# ---------------------------------------------------------------------------


class TestDeltaVsCpmDays:
    def test_start_of_monday_percentile_vs_end_of_friday_cpm_is_zero(self) -> None:
        assert (
            delta_vs_cpm_days(
                MON,
                FRI,
                percentile_at_day_start=True,
                cpm_finish_at_day_start=False,
                calendar_for=lambda: MON_FRI,
            )
            == 0
        )

    def test_end_of_friday_percentile_vs_start_of_monday_cpm_is_zero(self) -> None:
        assert (
            delta_vs_cpm_days(
                FRI,
                MON,
                percentile_at_day_start=False,
                cpm_finish_at_day_start=True,
                calendar_for=lambda: MON_FRI,
            )
            == 0
        )

    def test_a_real_working_day_is_still_reported(self) -> None:
        # The end of Monday is one working day after the start of Monday.
        assert (
            delta_vs_cpm_days(
                MON,
                MON,
                percentile_at_day_start=False,
                cpm_finish_at_day_start=True,
                calendar_for=lambda: MON_FRI,
            )
            == 3
        )

    def test_end_of_day_readings_diff_as_shown_days_without_a_calendar(self) -> None:
        assert (
            delta_vs_cpm_days(
                TUE,
                FRI,
                percentile_at_day_start=False,
                cpm_finish_at_day_start=False,
                calendar_for=_no_calendar,
            )
            == 4
        )

    def test_legacy_unknown_readings_keep_the_shown_day_difference(self) -> None:
        # A run persisted before #4204: read as the end of its day (as #4197 reads a
        # legacy baseline), and the calendar is never needed.
        assert delta_vs_cpm_days(MON, FRI, calendar_for=_no_calendar) == 3
        assert delta_vs_cpm_days(MON, MON, calendar_for=_no_calendar) == 0

    def test_missing_date_is_none(self) -> None:
        assert delta_vs_cpm_days(None, FRI) is None


class TestRiskPremium:
    def _run(self, **kw: Any) -> SimpleNamespace:
        base = {
            "p80": MON,
            "cpm_finish": FRI,
            "taken_at": None,
            "diagnostic": None,
            "p80_at_day_start": True,
            "cpm_finish_at_day_start": False,
        }
        base.update(kw)
        return SimpleNamespace(**base)

    def test_a_weekend_hop_is_zero_added_time(self) -> None:
        premium = build_risk_premium(self._run(), today=TODAY, calendar_for=lambda: MON_FRI)
        assert premium["risk_premium_days"] == 0
        assert premium["risk_premium_state"] == "zero"

    def test_a_legacy_run_reads_as_before(self) -> None:
        run = self._run(p80_at_day_start=None, cpm_finish_at_day_start=None)
        premium = build_risk_premium(run, today=TODAY, calendar_for=_no_calendar)
        assert premium["risk_premium_days"] == 3

    def test_cached_payload_uses_its_readings(self) -> None:
        payload = {
            "p80": MON.isoformat(),
            "cpm_finish": FRI.isoformat(),
            "p80_at_day_start": True,
            "cpm_finish_at_day_start": False,
        }
        premium = risk_premium_for_forecast_payload(
            payload, today=TODAY, calendar_for=lambda: MON_FRI
        )
        assert premium["risk_premium_days"] == 0

    def test_a_non_bool_cached_reading_is_unknown(self) -> None:
        payload = {"p80": MON.isoformat(), "cpm_finish": FRI.isoformat(), "p80_at_day_start": 1}
        premium = risk_premium_for_forecast_payload(payload, today=TODAY, calendar_for=_no_calendar)
        assert premium["risk_premium_days"] == 3


class TestHistoryDeltas:
    def _run(self, day: date, at_start: bool | None) -> MonteCarloRun:
        return MonteCarloRun(
            p50=day,
            p80=day,
            p95=day,
            p50_at_day_start=at_start,
            p80_at_day_start=at_start,
            p95_at_day_start=at_start,
            n_simulations=1,
        )

    def test_run_to_run_weekend_hop_is_zero(self) -> None:
        newer, older = self._run(MON, True), self._run(FRI, False)
        _annotate_run_deltas([newer, older], lambda: MON_FRI)
        assert newer._delta == {"p50": 0, "p80": 0, "p95": 0}  # type: ignore[attr-defined]
        assert older._delta is None  # type: ignore[attr-defined]

    def test_run_to_run_real_slip_is_reported(self) -> None:
        newer, older = self._run(TUE, False), self._run(MON, True)
        _annotate_run_deltas([newer, older], lambda: MON_FRI)
        # End of Tuesday vs start of Monday (= end of Friday): 4 calendar days.
        assert newer._delta == {"p50": 4, "p80": 4, "p95": 4}  # type: ignore[attr-defined]

    def test_legacy_runs_need_no_calendar(self) -> None:
        newer, older = self._run(MON, None), self._run(FRI, None)
        _annotate_run_deltas([newer, older], _no_calendar)
        assert newer._delta == {"p50": 3, "p80": 3, "p95": 3}  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# End to end: a start-of-day milestone finish across a weekend
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Mon-Fri")
    return Project.objects.create(
        name="McHop",
        start_date=date(2026, 8, 3),  # Monday
        status_date=date(2026, 8, 3),
        calendar=cal,
    )


@pytest.fixture
def client(project: Project) -> APIClient:
    user = User.objects.create_user(username="mc_hop_scheduler", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def network(project: Project) -> tuple[Task, Task]:
    """``A(5d, Mon..Fri) -FS+1d-> M``: M is the project finish, at the start of Monday."""
    a = Task.objects.create(project=project, name="A", duration=5)
    m = Task.objects.create(project=project, name="M", duration=0, is_milestone=True)
    Dependency.objects.create(predecessor=a, successor=m, dep_type="FS", lag=1)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, False)
    return a, m


def _recompute(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


@pytest.fixture
def straddling_network(project: Project) -> Task:
    """CPM finishes at the END of Friday; the simulated P80 at the START of Monday.

    ``W`` (5d) ends Friday. ``A`` is planned at 4 days, so on the plan ``A -FS+1d-> M``
    lands ``M`` at the end of Friday too. ``A``'s estimate band is 4..5 and mostly
    samples 5, which ends ``A`` on Friday and lands ``M`` on Sunday, shown at the start
    of Monday. The two finishes straddle a weekend at the same working-time position,
    so a shown-day subtraction reports +3 and a working-time one 0.
    """
    Task.objects.create(project=project, name="W", duration=5)
    a = Task.objects.create(
        project=project,
        name="A",
        duration=4,
        optimistic_duration=4,
        most_likely_duration=5,
        pessimistic_duration=5,
    )
    m = Task.objects.create(project=project, name="M", duration=0, is_milestone=True)
    Dependency.objects.create(predecessor=a, successor=m, dep_type="FS", lag=1)
    _recompute(project)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (FRI, True)
    return m


def _mc(client: APIClient, project: Project) -> dict[str, Any]:
    res = client.post(
        f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 50}, format="json"
    )
    assert res.status_code == 200, res.content
    return dict(res.json())


@pytest.mark.django_db
class TestEndToEnd:
    def test_live_run_reports_readings_and_zero_deltas(
        self, client: APIClient, project: Project, straddling_network: Task
    ) -> None:
        data = _mc(client, project)
        assert (data["cpm_finish"], data["cpm_finish_at_day_start"]) == (FRI.isoformat(), False)
        assert (data["p80"], data["p80_at_day_start"]) == (MON.isoformat(), True)
        # A shown-day subtraction would report +3 here.
        assert data["delta_vs_cpm"]["p80"] == 0
        assert data["risk_premium_days"] == 0

        run = MonteCarloRun.objects.get(project=project)
        assert (run.p80_at_day_start, run.cpm_finish_at_day_start) == (True, False)

        # The cached read serves the same working-time numbers.
        cached = client.get(f"/api/v1/projects/{project.pk}/monte-carlo/latest/").json()
        assert "from_history" not in cached
        assert cached["delta_vs_cpm"]["p80"] == 0
        assert cached["risk_premium_days"] == 0

    def test_whatif_percentile_deltas_are_measured_in_working_time(
        self, client: APIClient, project: Project
    ) -> None:
        """``A(5d) -FS-> M`` and ``B(4d) -FS+1d-> M``; lengthening B by a day moves M
        from the end of Friday to the start of Monday — no working-time move."""
        a = Task.objects.create(project=project, name="A", duration=5)
        b = Task.objects.create(project=project, name="B", duration=4)
        m = Task.objects.create(project=project, name="M", duration=0, is_milestone=True)
        Dependency.objects.create(predecessor=a, successor=m, dep_type="FS", lag=0)
        Dependency.objects.create(predecessor=b, successor=m, dep_type="FS", lag=1)
        _recompute(project)
        res = client.get(
            f"/api/v1/projects/{project.pk}/monte-carlo/whatif/",
            {"task_id": str(b.pk), "duration_delta": 1, "n_simulations": 20},
        )
        assert res.status_code == 200, res.content
        data = res.json()
        assert (data["current"]["p50"], data["current"]["p50_at_day_start"]) == (
            FRI.isoformat(),
            False,
        )
        assert (data["whatif"]["p50"], data["whatif"]["p50_at_day_start"]) == (
            MON.isoformat(),
            True,
        )
        assert data["delta_vs_current"] == {"p50": 0, "p80": 0, "p95": 0, "cpm_finish": 0}

    def test_history_fallback_and_derivation_read_the_persisted_readings(
        self, client: APIClient, project: Project, network: tuple[Task, Task]
    ) -> None:
        _mc(client, project)
        # A start-of-day P80 against an end-of-Friday CPM finish: the stored CPM
        # reading is what must make this zero, not a coincidence of equal days.
        MonteCarloRun.objects.filter(project=project).update(
            cpm_finish=FRI, cpm_finish_at_day_start=False
        )
        cache.clear()
        latest = client.get(f"/api/v1/projects/{project.pk}/monte-carlo/latest/").json()
        assert latest["from_history"] is True
        assert latest["p80_at_day_start"] is True
        assert latest["delta_vs_cpm"] == {"p50": 0, "p80": 0, "p95": 0}
        assert latest["risk_premium_days"] == 0

        overview = client.get(f"/api/v1/projects/{project.pk}/overview/").json()
        assert overview["risk_premium_days"] == 0

        derivation = client.get(
            f"/api/v1/projects/{project.pk}/schedule/derivation/", {"quantity": "p80"}
        )
        assert derivation.status_code == 200, derivation.content
        body = derivation.json()
        assert body["delta_vs_cpm_days"] == 0
        assert body["value_at_day_start"] is True
        assert body["cpm_finish_at_day_start"] is False

    def test_history_run_to_run_weekend_hop_is_zero(
        self, client: APIClient, project: Project, network: tuple[Task, Task]
    ) -> None:
        _mc(client, project)
        _mc(client, project)
        older = MonteCarloRun.objects.filter(project=project).order_by("taken_at").first()
        assert older is not None
        MonteCarloRun.objects.filter(pk=older.pk).update(
            p50=FRI,
            p80=FRI,
            p95=FRI,
            p50_at_day_start=False,
            p80_at_day_start=False,
            p95_at_day_start=False,
        )
        rows = client.get(f"/api/v1/projects/{project.pk}/monte-carlo/history/").json()["results"]
        assert rows[0]["delta"] == {"p50": 0, "p80": 0, "p95": 0}
        assert rows[0]["p80_at_day_start"] is True
