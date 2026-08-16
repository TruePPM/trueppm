"""Tests for GET /api/v1/projects/<pk>/monte-carlo/latest/ (issue #172)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.views import mc_latest_cache_key

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    """Ensure no stale MC cache entries bleed between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="mc_latest_user", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="mc_latest_other", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MC Latest Project", start_date=date(2026, 1, 5), calendar=calendar
    )


@pytest.fixture
def pert_task(project: Project) -> Task:
    return Task.objects.create(
        project=project,
        name="T1",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=10,
    )


@pytest.fixture
def member_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def scheduler_client(project: Project) -> APIClient:
    scheduler = User.objects.create_user(username="mc_latest_scheduler", password="pw")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=scheduler)
    return c


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


# ---------------------------------------------------------------------------
# GET /api/v1/projects/<pk>/monte-carlo/latest/
# ---------------------------------------------------------------------------


# The eight flat keys "added time" rides on (#2531, ADR-0698). Identical to the set
# `GET /projects/<pk>/overview/` emits, deliberately — one wire shape means the card
# and the forecast surfaces share a contract rather than two that can drift.
PREMIUM_KEYS = frozenset(
    {
        "risk_premium_state",
        "risk_premium_days",
        "risk_premium_ratio",
        "risk_premium_band",
        "risk_premium_as_of",
        "risk_premium_reason",
        "risk_premium_cpm_finish",
        "risk_premium_p80",
    }
)


@pytest.mark.django_db
class TestMonteCarloLatest:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/monte-carlo/latest/"

    def mc_url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/monte-carlo/"

    def test_returns_404_when_no_cache(self, member_client: APIClient, project: Project) -> None:
        res = member_client.get(self.url(project.pk))
        assert res.status_code == 404
        assert "detail" in res.json()

    def test_unauthenticated_returns_401(
        self, anon_client: APIClient, project: Project, member_client: object
    ) -> None:
        res = anon_client.get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_403(
        self, other_user: object, project: Project, member_client: object
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 403

    def test_returns_result_after_simulation_run(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        # Run the simulation so the cache is populated
        run_res = member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        assert run_res.status_code == 200

        latest_res = member_client.get(self.url(project.pk))
        assert latest_res.status_code == 200
        data = latest_res.json()
        assert "p50" in data
        assert "p80" in data
        assert "p95" in data
        assert "histogram_buckets" in data
        assert isinstance(data["histogram_buckets"], list)

    def test_histogram_buckets_have_date_and_count(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        data = member_client.get(self.url(project.pk)).json()
        for bucket in data["histogram_buckets"]:
            assert "date" in bucket
            assert "count" in bucket
            assert isinstance(bucket["count"], int)

    def test_unknown_project_returns_404(
        self, member_client: APIClient, member_client_fixture: None = None
    ) -> None:
        import uuid

        res = member_client.get(self.url(uuid.uuid4()))
        assert res.status_code == 404

    def test_response_includes_last_run_at_iso_timestamp(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """Issue #335 — surfaces forecast freshness on Overview / Schedule.

        Captured at cache-write time so the timestamp always reflects the most
        recent successful simulation, not the cache read.
        """
        from datetime import datetime

        member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        data = member_client.get(self.url(project.pk)).json()
        assert "last_run_at" in data
        # ISO 8601 — fromisoformat tolerates both naive and tz-aware strings.
        parsed = datetime.fromisoformat(data["last_run_at"])
        assert parsed is not None

    # ── #987 — cpm_finish + delta_vs_cpm + confidence_curve ──────────────────

    def _scheduled_task(self, project: Project) -> Task:
        """A committed PERT task with a CPM finish so cpm_finish is non-null."""
        return Task.objects.create(
            project=project,
            name="Scheduled",
            duration=5,
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=10,
            early_start=date(2026, 1, 5),
            early_finish=date(2026, 1, 9),
        )

    def test_latest_includes_cpm_finish_and_delta_vs_cpm(
        self, member_client: APIClient, project: Project
    ) -> None:
        """cpm_finish (the deterministic spine) and the per-percentile premium
        over it are server-owned on the latest payload (#987), so a headless
        client reads the risk delta instead of subtracting dates."""
        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        data = member_client.get(self.url(project.pk)).json()

        assert data["cpm_finish"] == "2026-01-09"
        delta = data["delta_vs_cpm"]
        assert set(delta) == {"p50", "p80", "p95"}
        # All deltas are integer calendar-day offsets vs the CPM finish, and the
        # band widens monotonically (p95 finishes no earlier than p50).
        for key in ("p50", "p80", "p95"):
            assert isinstance(delta[key], int)
            # The SIGN is the contract, not just the type (#2833). A negative delta
            # is a probabilistic finish EARLIER than the deterministic spine — the
            # forecast claiming a date CPM has already ruled out, which is the one
            # direction a risk premium can never legitimately take. This assertion
            # was missing while the field was exercised, so the API layer stayed
            # green through a scheduler bug that made every percentile negative.
            assert delta[key] >= 0, f"delta_vs_cpm[{key}] = {delta[key]} precedes the CPM finish"
        assert delta["p50"] <= delta["p95"]

    def test_delta_vs_cpm_stays_non_negative_for_in_progress_work(
        self, member_client: APIClient, project: Project
    ) -> None:
        """Regression (#2833): in-progress work floors the forecast at its actual start.

        ``monte_carlo()`` never received the ``actual_start`` early-start floor the
        deterministic pass has applied since #2621, so a task that actually started
        *after* the data date was simulated from the data date instead — and every
        percentile came back earlier than the CPM finish the very same API had just
        persisted. Driving both passes through their own endpoints keeps this an
        independent check of the API layer rather than a restatement of the
        scheduler's own suite: the two regress separately.
        """
        project.status_date = date(2026, 1, 30)  # Friday — the last status report
        project.save(update_fields=["status_date"])
        Task.objects.create(
            project=project,
            name="Underway",
            duration=20,
            percent_complete=50,
            # Work began more than a week after the data date, so nothing but the
            # actual-start floor can place it correctly.
            actual_start=date(2026, 2, 9),  # Monday
            # The CPM spine the deterministic pass persists for exactly this input:
            # 10 remaining working days laid forward from 9-Feb. `cpm_finish` is the
            # max persisted early_finish, so this is what the delta is measured
            # against; `test_simulation_honors_actual_start_floor` pins the same
            # date straight off the engine, so a drift breaks that test, not this
            # one's premise.
            early_start=date(2026, 2, 9),
            early_finish=date(2026, 2, 20),
        )

        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        data = member_client.get(self.url(project.pk)).json()

        assert data["cpm_finish"] == "2026-02-20"
        for key in ("p50", "p80", "p95"):
            assert data["delta_vs_cpm"][key] >= 0, (
                f"{key} finishes {-data['delta_vs_cpm'][key]} days before the CPM spine "
                f"{data['cpm_finish']} — the forecast under-reports risk"
            )

    def test_confidence_curve_is_cumulative_and_tops_out_at_100(
        self, member_client: APIClient, project: Project
    ) -> None:
        """confidence_curve is a cumulative P(finish ≤ date) S-curve derived from
        the histogram buckets — non-decreasing, ending at 100% (#987)."""
        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        curve = member_client.get(self.url(project.pk)).json()["confidence_curve"]

        assert isinstance(curve, list) and len(curve) >= 1
        prev = -1.0
        for point in curve:
            assert set(point) == {"date", "pct"}
            assert point["pct"] >= prev  # cumulative ⇒ never decreases
            prev = point["pct"]
        assert curve[-1]["pct"] == pytest.approx(100.0)

    def test_history_fallback_keeps_cpm_delta_and_persisted_curve(
        self, member_client: APIClient, scheduler_client: APIClient, project: Project
    ) -> None:
        """After the cache TTL expires the persisted run carries cpm_finish +
        delta_vs_cpm, and — as of #1231 — the persisted distribution too, so the
        confidence_curve + histogram survive cache expiry instead of falling back
        to empty (ADR-0144). The run is posted by a Scheduler because only
        Scheduler+ persists a history row (#1502); the fallback read stays open
        to every member."""
        self._scheduled_task(project)
        scheduler_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        cache.clear()  # simulate TTL expiry → history fallback path

        data = member_client.get(self.url(project.pk)).json()
        assert data["from_history"] is True
        assert data["cpm_finish"] == "2026-01-09"
        assert set(data["delta_vs_cpm"]) == {"p50", "p80", "p95"}
        # The distribution is now persisted on the run, so the curve + histogram
        # survive the TTL (the headline #1231 fix).
        assert data["confidence_curve"] != []
        assert data["histogram_buckets"] != []

    # ── #2531 / ADR-0698 — added time rides the forecast payload ─────────────

    def test_live_run_response_carries_the_premium(
        self, member_client: APIClient, project: Project
    ) -> None:
        """Every forecast surface reads one server-owned state, not a raw day count.

        Schedule, Board, Table and the mobile card all consume this payload; without
        the discriminant they would have to decide for themselves what a premium of
        `0` means, which is the false all-clear the metric exists to prevent (#2531).
        """
        self._scheduled_task(project)
        data = member_client.post(
            self.mc_url(project.pk), {"n_simulations": 200}, format="json"
        ).json()

        assert set(data) >= PREMIUM_KEYS
        assert data["risk_premium_state"] in {
            "not_run",
            "unmeasurable",
            "stale",
            "zero",
            "premium",
            "negative",
        }
        assert data["risk_premium_cpm_finish"] == "2026-01-09"

    def test_cached_read_carries_the_premium(
        self, member_client: APIClient, project: Project
    ) -> None:
        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")

        data = member_client.get(self.url(project.pk)).json()
        assert set(data) >= PREMIUM_KEYS
        assert data["risk_premium_state"] is not None

    def test_history_fallback_carries_the_premium(
        self, member_client: APIClient, scheduler_client: APIClient, project: Project
    ) -> None:
        self._scheduled_task(project)
        scheduler_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        cache.clear()  # simulate TTL expiry → history fallback path

        data = member_client.get(self.url(project.pk)).json()
        assert data["from_history"] is True
        assert set(data) >= PREMIUM_KEYS

    def test_the_404_body_carries_no_premium(
        self, member_client: APIClient, project: Project
    ) -> None:
        """A project with no forecast at all says so with a 404, not a null premium."""
        res = member_client.get(self.url(project.pk))
        assert res.status_code == 404
        assert PREMIUM_KEYS.isdisjoint(res.json())

    def test_the_premium_is_never_written_into_the_cache_entry(
        self, member_client: APIClient, project: Project
    ) -> None:
        """The freeze guard (ADR-0698 §2).

        `risk_premium_ratio` is a share of the duration remaining *today* and
        `risk_premium_state` ages into `stale`, so both are wrong the moment they are
        stored. The entry must hold only the run's own facts; the premium is layered
        on at read time.
        """
        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")

        entry = cache.get(mc_latest_cache_key(project.pk))
        assert entry is not None
        assert PREMIUM_KEYS.isdisjoint(entry)

    def test_the_ratio_recomputes_as_today_advances_over_one_cache_entry(
        self, member_client: APIClient, project: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The same cached forecast, read twice, reports the ratio it should each time.

        This is what read-time derivation buys: once the computed finish has passed
        there is no remaining duration to take a share of, and a frozen percentage
        would keep describing a window that has already closed.
        """
        import datetime as _dt

        from django.utils import timezone as dj_timezone

        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        cpm_finish = _dt.date.fromisoformat(
            cache.get(mc_latest_cache_key(project.pk))["cpm_finish"]
        )

        monkeypatch.setattr(
            dj_timezone, "localdate", lambda *a, **kw: cpm_finish - _dt.timedelta(days=30)
        )
        before = member_client.get(self.url(project.pk)).json()

        monkeypatch.setattr(
            dj_timezone, "localdate", lambda *a, **kw: cpm_finish + _dt.timedelta(days=1)
        )
        after = member_client.get(self.url(project.pk)).json()

        assert before["risk_premium_ratio"] is not None
        assert after["risk_premium_ratio"] is None
        # The gap itself is time-invariant — only its normalization is not.
        assert before["risk_premium_days"] == after["risk_premium_days"]

    def test_a_viewer_reads_the_premium(self, project: Project, pert_task: Task) -> None:
        """Same role floor as the payload it rides on — no new disclosure (#2531).

        The premium is derived entirely from `p80`, `cpm_finish` and
        `forecast_diagnostic`, all of which this caller already receives here.
        """
        scheduler = User.objects.create_user(username="mc_premium_scheduler", password="pw")
        ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)
        sc = APIClient()
        sc.force_authenticate(user=scheduler)
        sc.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")

        viewer = User.objects.create_user(username="mc_premium_viewer", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        vc = APIClient()
        vc.force_authenticate(user=viewer)

        res = vc.get(self.url(project.pk))
        assert res.status_code == 200
        assert set(res.json()) >= PREMIUM_KEYS

    def test_an_unestimated_project_is_unmeasurable_not_a_calm_zero(
        self, member_client: APIClient, project: Project
    ) -> None:
        """The headline safety property, end-to-end through the forecast payload.

        A project with no three-point estimates simulates flat, so its premium is
        exactly 0 days. If the payload reported that as a measured zero the strip
        would tell the least-known project on the board that it carries no schedule
        risk — the inverse of the truth, not a weaker version of it.
        """
        Task.objects.create(
            project=project,
            name="No estimates",
            duration=5,
            early_start=date(2026, 1, 5),
            early_finish=date(2026, 1, 9),
        )
        data = member_client.post(
            self.mc_url(project.pk), {"n_simulations": 100}, format="json"
        ).json()

        assert data["risk_premium_state"] == "unmeasurable"
        # No commitment date to act on: a flat run's "P80" is the CPM date under
        # another name.
        assert data["risk_premium_p80"] is None
