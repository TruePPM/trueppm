"""Tests for the `status_date` provenance field on Monte Carlo forecasts (#2638).

`Project.status_date` is nullable, and Monte Carlo floors a null value at
`timezone.localdate()` (ADR-0132) so it never forecasts remaining work in the
past. Before #2638 that substitution happened only in memory: `MonteCarloRun`
had no `status_date` field, so a persisted run — and every read of it — could
not say which "today" produced its P50/P80/P95. Two runs of an unchanged
project on different days therefore returned different percentiles with
nothing in either response explaining why.

Covers: the resolved date is persisted on a real run and echoed on the fresh
response, cache reads, and the from-history fallback; two runs taken on
different simulated "todays" are distinguishable by the recorded date; the
field round-trips through `MonteCarloRunSerializer`; and the non-persisting
what-if endpoint reports both `cpm_status_date` (raw, may be null) and
`mc_status_date` (always resolved) so an AI/MCP or human caller still gets
provenance for a computation that leaves no row behind.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone as dj_timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.serializers import MonteCarloRunSerializer

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    """Ensure no stale MC cache entries bleed between tests, and the what-if
    throttle history (also LocMem) never leaves a later test pre-throttled."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="mc_sd_admin", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MC Status Date Project", start_date=date(2026, 1, 5), calendar=calendar
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
def admin_client(admin: object, project: Project) -> APIClient:
    # Persistence (`_persist_mc_run_if_authorized`) requires Scheduler+; Admin
    # clears that bar and also lets the client read `run_id` from the response.
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


def run_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/"


def latest_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/latest/"


def whatif_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/whatif/"


def history_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/history/"


def _pin_today(monkeypatch: pytest.MonkeyPatch, today: date) -> None:
    """Freeze `timezone.localdate()` for every caller (views.py imports the module
    and calls `timezone.localdate()`, so patching the attribute on the shared
    module object affects all of them) — same pattern as test_monte_carlo_latest.py.
    """
    monkeypatch.setattr(dj_timezone, "localdate", lambda *a, **kw: today)


# ---------------------------------------------------------------------------
# Persistence: the resolved date is recorded on the run
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestStatusDatePersistsOnRun:
    def test_run_persists_the_projects_explicit_status_date(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """When the PM has set an explicit data date, MC uses and records it
        verbatim — no substitution happens."""
        project.status_date = date(2026, 3, 1)
        project.save(update_fields=["status_date"])

        res = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert res.data["status_date"] == "2026-03-01"

        run = MonteCarloRun.objects.filter(project=project).first()
        assert run is not None
        assert run.status_date == date(2026, 3, 1)

    def test_run_persists_todays_date_when_status_date_is_null(
        self,
        admin_client: APIClient,
        project: Project,
        pert_task: Task,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A null status_date is floored at today (ADR-0132) — and that
        substitution is now recorded, not silently lost."""
        assert project.status_date is None
        frozen_today = date(2026, 4, 15)
        _pin_today(monkeypatch, frozen_today)

        res = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert res.data["status_date"] == "2026-04-15"

        run = MonteCarloRun.objects.filter(project=project).first()
        assert run is not None
        assert run.status_date == frozen_today

    def test_two_runs_on_different_days_are_distinguishable_by_status_date(
        self,
        admin_client: APIClient,
        project: Project,
        pert_task: Task,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """This is the defect from #2638 directly: an unchanged project, run on
        two different days, used to return different percentiles with no field
        anywhere explaining why. The recorded status_date is that explanation."""
        assert project.status_date is None

        _pin_today(monkeypatch, date(2026, 5, 1))
        first = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        cache.clear()  # force a real second simulation rather than a cached read

        _pin_today(monkeypatch, date(2026, 6, 1))
        second = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")

        assert first.data["status_date"] == "2026-05-01"
        assert second.data["status_date"] == "2026-06-01"

        runs = list(MonteCarloRun.objects.filter(project=project).order_by("taken_at"))
        assert len(runs) == 2
        assert runs[0].status_date == date(2026, 5, 1)
        assert runs[1].status_date == date(2026, 6, 1)


# ---------------------------------------------------------------------------
# Response echoes: fresh run, cached read, from-history fallback
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResponseEchoesStatusDate:
    def test_cached_read_echoes_the_same_status_date_as_the_run_that_wrote_it(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        project.status_date = date(2026, 7, 4)
        project.save(update_fields=["status_date"])

        posted = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert posted.data["status_date"] == "2026-07-04"

        cached = admin_client.get(latest_url(project.pk))
        assert cached.data["status_date"] == "2026-07-04"

    def test_latest_returns_persisted_status_date_after_cache_miss(
        self, admin_client: APIClient, project: Project
    ) -> None:
        MonteCarloRun.objects.create(
            project=project,
            p50=date(2026, 8, 20),
            p80=date(2026, 9, 1),
            p95=date(2026, 9, 12),
            n_simulations=250,
            status_date=date(2026, 8, 1),
        )
        cache.clear()  # simulate TTL expiry
        data = admin_client.get(latest_url(project.pk)).json()
        assert data["from_history"] is True
        assert data["status_date"] == "2026-08-01"

    def test_latest_legacy_run_without_status_date_falls_back_null(
        self, admin_client: APIClient, project: Project
    ) -> None:
        """A run persisted before #2638 has no stored status_date — it reads back
        as null (same no-backfill pattern as `distribution`/`diagnostic`), never a
        guessed value."""
        MonteCarloRun.objects.create(
            project=project, p80=date(2026, 9, 1), n_simulations=100, status_date=None
        )
        cache.clear()
        data = admin_client.get(latest_url(project.pk)).json()
        assert data["from_history"] is True
        assert data["status_date"] is None


# ---------------------------------------------------------------------------
# History endpoint: each row echoes its own status_date over HTTP
# ---------------------------------------------------------------------------
#
# The MonteCarloRunSerializer round-trip tests below exercise the serializer
# directly (`MonteCarloRunSerializer(run, context={}).data`), which bypasses
# MonteCarloHistoryView's queryset entirely — including its `.defer("distribution")`
# and `select_related("triggered_by")` construction. MonteCarloHistoryView's own
# `extend_schema` description was edited for #2638 to document that every history
# row carries `status_date`, so that claim needs an HTTP-level assertion against
# the live endpoint, not just the serializer in isolation.


@pytest.mark.django_db
class TestHistoryEndpointReportsStatusDate:
    def test_history_results_echo_each_runs_status_date(
        self, admin_client: APIClient, project: Project
    ) -> None:
        """One run with an explicit status_date and one legacy run with none —
        both must round-trip through the live GET .../history/ endpoint, not
        just the serializer called directly."""
        MonteCarloRun.objects.create(
            project=project,
            p80=date(2026, 9, 1),
            n_simulations=100,
            status_date=date(2026, 8, 15),
        )
        MonteCarloRun.objects.create(
            project=project, p80=date(2026, 9, 20), n_simulations=100, status_date=None
        )

        res = admin_client.get(history_url(project.pk))
        assert res.status_code == 200
        results = res.json()["results"]
        assert len(results) == 2
        by_p80 = {r["p80"]: r["status_date"] for r in results}
        assert by_p80["2026-09-01"] == "2026-08-15"
        assert by_p80["2026-09-20"] is None


# ---------------------------------------------------------------------------
# Serializer round-trip
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSerializerRoundTrip:
    def test_status_date_round_trips_through_the_serializer(self, project: Project) -> None:
        run = MonteCarloRun.objects.create(
            project=project,
            p80=date(2026, 9, 1),
            n_simulations=100,
            status_date=date(2026, 8, 15),
        )
        data = MonteCarloRunSerializer(run, context={}).data
        assert data["status_date"] == "2026-08-15"

    def test_legacy_run_serializes_null_status_date(self, project: Project) -> None:
        run = MonteCarloRun.objects.create(project=project, p80=date(2026, 9, 1), n_simulations=100)
        data = MonteCarloRunSerializer(run, context={}).data
        assert data["status_date"] is None


# ---------------------------------------------------------------------------
# What-if: never persists, but still reports its provenance
# ---------------------------------------------------------------------------


@pytest.fixture
def member_client(admin: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=admin, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.mark.django_db
class TestWhatIfReportsStatusDates:
    def test_null_project_status_date_reports_raw_none_and_resolved_today(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """cpm_status_date mirrors the deterministic pass (raw, null when unset);
        mc_status_date mirrors the Monte Carlo pass (always resolved) — the same
        split ADR-0132 defines for the persisted endpoints, surfaced here because
        this view never persists a row to carry it."""
        assert project.status_date is None
        frozen_today = date(2026, 4, 20)
        _pin_today(monkeypatch, frozen_today)

        res = member_client.get(
            whatif_url(project.pk),
            {"task_id": str(pert_task.pk), "duration_delta": 2, "n_simulations": 100},
        )
        assert res.status_code == 200, res.data
        assert res.data["cpm_status_date"] is None
        assert res.data["mc_status_date"] == "2026-04-20"

    def test_explicit_project_status_date_reports_the_same_value_for_both(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        project.status_date = date(2026, 3, 10)
        project.save(update_fields=["status_date"])

        res = member_client.get(
            whatif_url(project.pk),
            {"task_id": str(pert_task.pk), "duration_delta": 2, "n_simulations": 100},
        )
        assert res.status_code == 200, res.data
        assert res.data["cpm_status_date"] == "2026-03-10"
        assert res.data["mc_status_date"] == "2026-03-10"

    def test_whatif_never_persists_a_montecarlorun_row(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """Guards the non-persistence guarantee this view's docstring already
        claims — status_date reporting must not have added a write."""
        member_client.get(
            whatif_url(project.pk),
            {"task_id": str(pert_task.pk), "duration_delta": 2, "n_simulations": 100},
        )
        assert not MonteCarloRun.objects.filter(project=project).exists()
