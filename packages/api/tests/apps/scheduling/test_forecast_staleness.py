"""Tests for the server-declared forecast-staleness discriminant (#3140).

Before this, "is the forecast still about the current plan?" was answered in the
browser by a ``useState(0)`` counter bumped from exactly one mutation path. It
missed inline edits, dependency changes, three-point estimate edits (the actual
Monte Carlo inputs) and every collaborator write, and it reset to zero on reload.
Once #3132 gated the *Rerun action* on it, a genuinely stale forecast could offer
no recompute at all.

The classification is now server-computed (ADR-0599) from two facts that already
existed: ``Project.last_sync_version`` (ADR-0686) and ``Project.recalculated_at``
(ADR-0114). These tests pin the parts a client cannot check for itself:

* the pure classifier's decision order, especially that ``current`` is
  **unreachable** without a recorded ``plan_version`` — every run in every install
  is version-less on the day this ships, and an order that let a young version-less
  run read ``current`` would hide Rerun fleet-wide;
* that a run records the version it was computed against, on the persisted row and
  on the cache entry (a Member-triggered run persists no row, so the cache is the
  only place that observation exists);
* the fresh → stale transition for each mutating path the issue names;
* the CPM-recalc false-fresh path the version counter alone cannot see;
* every read branch — live run, cache hit, from-history — plus the permission gate.
"""

from __future__ import annotations

import datetime
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone as dj_timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.forecast_staleness import (
    classify_forecast_staleness,
    forecast_staleness_facts,
    forecast_staleness_for_payload,
    forecast_staleness_from_run,
)
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.risk_premium import STALE_AFTER_DAYS

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    """No stale `mc_latest` entry may bleed between tests — the cache is a read
    branch under test here, not incidental infrastructure."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="fs_admin", password="pw")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="fs_viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="fs_outsider", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Forecast Staleness Project", start_date=date(2026, 1, 5), calendar=calendar
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
    # Scheduler+ is what `_persist_mc_run_if_authorized` requires; Admin clears it.
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.fixture
def viewer_client(viewer: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


def run_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/"


def latest_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/latest/"


def derivation_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/schedule/derivation/?quantity=p80"


def _aware(y: int, m: int, d: int, hour: int = 12) -> datetime.datetime:
    return datetime.datetime(y, m, d, hour, tzinfo=datetime.UTC)


# ---------------------------------------------------------------------------
# The pure classifier — decision order is the safety property
# ---------------------------------------------------------------------------


class TestClassifier:
    def test_matching_version_and_fresh_age_is_current(self) -> None:
        assert (
            classify_forecast_staleness(plan_version=7, plan_version_current=7, age_days=0)
            == "current"
        )

    def test_moved_version_is_project_changed(self) -> None:
        assert (
            classify_forecast_staleness(plan_version=7, plan_version_current=8, age_days=0)
            == "project_changed"
        )

    def test_version_moving_BACKWARDS_is_not_current(self) -> None:
        """A restored or rolled-back database is exactly as unplaceable as one that
        moved forward. `<` would have called this `current`; `!=` does not."""
        assert (
            classify_forecast_staleness(plan_version=9, plan_version_current=4, age_days=0)
            == "project_changed"
        )

    def test_unchanged_but_old_is_aged(self) -> None:
        assert (
            classify_forecast_staleness(
                plan_version=7, plan_version_current=7, age_days=STALE_AFTER_DAYS + 1
            )
            == "aged"
        )

    def test_exactly_at_the_threshold_is_still_current(self) -> None:
        """Shares `risk_premium`'s strict `>` so `aged` and `risk_premium_state ==
        'stale'` can never disagree about the same run's age."""
        assert (
            classify_forecast_staleness(
                plan_version=7, plan_version_current=7, age_days=STALE_AFTER_DAYS
            )
            == "current"
        )

    @pytest.mark.parametrize("age", [0, 1, STALE_AFTER_DAYS])
    def test_missing_plan_version_is_NEVER_current(self, age: int) -> None:
        """The load-bearing case. Every run in every install is version-less on the
        day this ships, so an order that let a *young* version-less run fall through
        to `current` would hide the Rerun button across the whole fleet — the defect
        reintroduced by its own fix. Reorder the branches and this fails."""
        assert (
            classify_forecast_staleness(plan_version=None, plan_version_current=7, age_days=age)
            == "unknown"
        )

    def test_missing_plan_version_still_reports_a_provable_age(self) -> None:
        """`aged` is strictly more useful than `unknown` and the timestamp alone
        supports it, so a version-less run past the threshold says so."""
        assert (
            classify_forecast_staleness(
                plan_version=None, plan_version_current=7, age_days=STALE_AFTER_DAYS + 1
            )
            == "aged"
        )

    def test_missing_current_version_is_unknown(self) -> None:
        """The project row vanished mid-request; inventing a comparison is worse
        than admitting there isn't one."""
        assert (
            classify_forecast_staleness(plan_version=7, plan_version_current=None, age_days=0)
            == "unknown"
        )

    def test_recalc_after_the_run_beats_a_matching_version(self) -> None:
        """The false-fresh path the counter cannot see: CPM output is written with
        `bulk_update`, which allocates no sync sequence, so the version matches while
        the run's `cpm_finish` describes a schedule that no longer exists."""
        assert (
            classify_forecast_staleness(
                plan_version=7,
                plan_version_current=7,
                age_days=0,
                recalculated_after_run=True,
            )
            == "project_changed"
        )

    def test_recalc_after_the_run_also_lifts_an_unplaceable_run(self) -> None:
        assert (
            classify_forecast_staleness(
                plan_version=None,
                plan_version_current=7,
                age_days=0,
                recalculated_after_run=True,
            )
            == "project_changed"
        )


class TestFactsBuilder:
    def test_recalc_before_the_run_is_not_staleness(self) -> None:
        """A recalc that landed *before* the run is exactly what the run measured."""
        facts = forecast_staleness_facts(
            plan_version=3,
            plan_version_current=3,
            taken_at=_aware(2026, 5, 10),
            recalculated_at=_aware(2026, 5, 9),
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "current"

    def test_recalc_after_the_run_is(self) -> None:
        facts = forecast_staleness_facts(
            plan_version=3,
            plan_version_current=3,
            taken_at=_aware(2026, 5, 10, hour=9),
            recalculated_at=_aware(2026, 5, 10, hour=11),
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "project_changed"

    def test_a_naive_timestamp_cannot_500_a_read_path(self) -> None:
        """A legacy cache entry can carry a naive datetime; comparing it to an aware
        one raises TypeError. An unusable pair decides nothing rather than crashing."""
        facts = forecast_staleness_facts(
            plan_version=3,
            plan_version_current=3,
            taken_at=datetime.datetime(2026, 5, 10, 9),
            recalculated_at=_aware(2026, 5, 10, hour=11),
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "current"

    def test_both_versions_are_carried_for_explainability(self) -> None:
        """A reader — including an MCP client — must be able to state the finding
        ("computed against 412, plan is at 419"), not only the verdict."""
        facts = forecast_staleness_facts(
            plan_version=412,
            plan_version_current=419,
            taken_at=_aware(2026, 5, 10),
            recalculated_at=None,
            today=date(2026, 5, 10),
        )
        assert facts["plan_version"] == 412
        assert facts["plan_version_current"] == 419


class TestPayloadAdapter:
    def test_a_non_int_plan_version_is_not_trusted(self) -> None:
        facts = forecast_staleness_for_payload(
            {"plan_version": "412", "last_run_at": "2026-05-10T09:00:00+00:00"},
            plan_version_current=412,
            recalculated_at=None,
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "unknown"

    def test_a_bool_plan_version_is_rejected_rather_than_read_as_one(self) -> None:
        """`bool` is an `int` subclass — `True` would otherwise compare as version 1."""
        facts = forecast_staleness_for_payload(
            {"plan_version": True, "last_run_at": "2026-05-10T09:00:00+00:00"},
            plan_version_current=1,
            recalculated_at=None,
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "unknown"

    def test_a_legacy_entry_with_no_plan_version_key_is_unknown(self) -> None:
        facts = forecast_staleness_for_payload(
            {"last_run_at": "2026-05-10T09:00:00+00:00"},
            plan_version_current=412,
            recalculated_at=None,
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "unknown"
        assert facts["plan_version"] is None


@pytest.mark.django_db
class TestRunAdapter:
    def test_a_never_simulated_project_is_unknown_not_current(self, project: Project) -> None:
        facts = forecast_staleness_from_run(
            None,
            plan_version_current=project.last_sync_version,
            recalculated_at=None,
            today=date(2026, 5, 10),
        )
        assert facts["forecast_staleness"] == "unknown"


# ---------------------------------------------------------------------------
# The run records the version it was computed against
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPlanVersionIsRecorded:
    def test_run_persists_the_projects_plan_version(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        project.refresh_from_db()
        expected = project.last_sync_version

        res = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert res.data["plan_version"] == expected

        run = MonteCarloRun.objects.filter(project=project).first()
        assert run is not None
        assert run.plan_version == expected

    def test_a_fresh_run_reports_current(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        res = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert res.data["forecast_staleness"] == "current"
        assert res.data["plan_version"] == res.data["plan_version_current"]

    def test_the_cache_entry_carries_the_plan_version_for_member_triggered_runs(
        self, viewer_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """A Viewer/Member run refreshes the cache but persists no attributed row
        (#1502), so the cache entry is the ONLY place that run's plan version lives.
        If `plan_version` were derived per response rather than carried, every
        Member-driven project would read `unknown` forever."""
        res = viewer_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert MonteCarloRun.objects.filter(project=project).count() == 0

        latest = viewer_client.get(latest_url(project.pk))
        assert latest.status_code == 200
        assert latest.data["plan_version"] is not None
        assert latest.data["forecast_staleness"] == "current"


# ---------------------------------------------------------------------------
# fresh → stale, per mutating path the issue names
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTransitionsToStale:
    def _run(self, client: APIClient, project: Project) -> None:
        res = client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert res.data["forecast_staleness"] == "current"

    def test_an_inline_task_edit_makes_the_forecast_stale(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """The path the old session counter missed entirely — it only saw the
        Gantt drag commit."""
        self._run(admin_client, project)

        pert_task.name = "Renamed inline"
        pert_task.save()

        res = admin_client.get(latest_url(project.pk))
        assert res.status_code == 200
        assert res.data["forecast_staleness"] == "project_changed"
        assert res.data["plan_version"] < res.data["plan_version_current"]

    def test_a_three_point_estimate_edit_makes_the_forecast_stale(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """The single most important case: these ARE the Monte Carlo inputs, and
        editing them is the most likely reason anyone wants a rerun."""
        self._run(admin_client, project)

        pert_task.pessimistic_duration = 30
        pert_task.save()

        res = admin_client.get(latest_url(project.pk))
        assert res.data["forecast_staleness"] == "project_changed"

    def test_adding_a_task_makes_the_forecast_stale(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        self._run(admin_client, project)

        Task.objects.create(project=project, name="T2", duration=3)

        res = admin_client.get(latest_url(project.pk))
        assert res.data["forecast_staleness"] == "project_changed"

    def test_a_dependency_change_makes_the_forecast_stale(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        other = Task.objects.create(project=project, name="T2", duration=3)
        self._run(admin_client, project)

        Dependency.objects.create(predecessor=pert_task, successor=other)

        res = admin_client.get(latest_url(project.pk))
        assert res.data["forecast_staleness"] == "project_changed"

    def test_deleting_a_task_makes_the_forecast_stale(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        doomed = Task.objects.create(project=project, name="T2", duration=3)
        self._run(admin_client, project)

        doomed.soft_delete()

        res = admin_client.get(latest_url(project.pk))
        assert res.data["forecast_staleness"] == "project_changed"

    def test_a_later_recalc_makes_the_forecast_stale_even_with_an_unmoved_version(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """The false-fresh path the version counter alone cannot close. CPM writes
        its output with `bulk_update` (ADR-0091), which allocates no sync sequence,
        so a recalc landing after the run leaves the version equal while the run's
        `cpm_finish` — and its whole risk-premium family — describe a superseded
        schedule. Remove the `recalculated_at` term and this reads `current`."""
        self._run(admin_client, project)
        project.refresh_from_db()
        version_before = project.last_sync_version

        # Exactly how the recalc task stamps it: a bulk .update(), no save(), so the
        # sync sequence is deliberately untouched.
        Project.objects.filter(pk=project.pk).update(
            recalculated_at=dj_timezone.now() + datetime.timedelta(minutes=5)
        )
        project.refresh_from_db()
        assert project.last_sync_version == version_before

        res = admin_client.get(latest_url(project.pk))
        assert res.data["forecast_staleness"] == "project_changed"
        assert res.data["plan_version"] == res.data["plan_version_current"]

    def test_rerunning_clears_the_stale_state(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        self._run(admin_client, project)
        pert_task.most_likely_duration = 9
        pert_task.save()
        assert (
            admin_client.get(latest_url(project.pk)).data["forecast_staleness"] == "project_changed"
        )

        res = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.data["forecast_staleness"] == "current"
        assert admin_client.get(latest_url(project.pk)).data["forecast_staleness"] == "current"


# ---------------------------------------------------------------------------
# Every read branch reports the family
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestReadBranches:
    def test_from_history_branch_reports_staleness(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """Past the 24h TTL the read falls back to the persisted row, which carries
        its own `plan_version` — the discriminant survives cache expiry."""
        admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        cache.clear()

        pert_task.duration = 8
        pert_task.save()

        res = admin_client.get(latest_url(project.pk))
        assert res.status_code == 200
        assert res.data["from_history"] is True
        assert res.data["forecast_staleness"] == "project_changed"
        assert res.data["plan_version"] is not None

    def test_a_legacy_row_with_no_plan_version_reads_unknown_not_current(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """Nullable with no backfill: a run recorded before #3140 must classify as
        `unknown`, so the client keeps Rerun reachable rather than being told a run
        it cannot place is fine."""
        admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        cache.clear()
        MonteCarloRun.objects.filter(project=project).update(plan_version=None)

        res = admin_client.get(latest_url(project.pk))
        assert res.status_code == 200
        assert res.data["forecast_staleness"] == "unknown"
        assert res.data["plan_version"] is None

    def test_the_derivation_endpoint_carries_the_discriminant(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """ADR-0218's provenance surface. A percentile cited with full derivation
        confidence but no freshness signal is a stale citation, and it would
        contradict what `/monte-carlo/latest/` says about the same run."""
        admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        pert_task.duration = 11
        pert_task.save()

        res = admin_client.get(derivation_url(project.pk))
        assert res.status_code == 200
        assert res.data["forecast_staleness"] == "project_changed"

    def test_the_project_overview_agrees_with_the_forecast_payload(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """Two tools, one run, opposite trustworthiness is worse than either answer
        alone — an agent reading `get_project` must not be told a forecast is sound
        while `get_monte_carlo_forecast` reports the same run as stale."""
        admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        pert_task.duration = 12
        pert_task.save()

        overview = admin_client.get(f"/api/v1/projects/{project.pk}/overview/")
        latest = admin_client.get(latest_url(project.pk))
        assert overview.status_code == 200
        assert overview.data["forecast_staleness"] == latest.data["forecast_staleness"]
        assert overview.data["forecast_staleness"] == "project_changed"


# ---------------------------------------------------------------------------
# Permissions — the new keys inherit the endpoints' existing gates
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPermissions:
    def test_a_viewer_may_read_the_discriminant(
        self,
        admin_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        pert_task: Task,
    ) -> None:
        """The forecast read is deliberately Member-level (a Viewer may pull the
        band), and the staleness family rides that same read."""
        admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")

        res = viewer_client.get(latest_url(project.pk))
        assert res.status_code == 200
        assert res.data["forecast_staleness"] == "current"

    def test_a_non_member_gets_no_forecast_and_therefore_no_plan_version(
        self,
        admin_client: APIClient,
        outsider: object,
        project: Project,
        pert_task: Task,
    ) -> None:
        """`plan_version_current` exposes the project's sync counter, so the gate on
        it must be the endpoint's own membership check — not incidental."""
        admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")

        c = APIClient()
        c.force_authenticate(user=outsider)
        res = c.get(latest_url(project.pk))
        assert res.status_code == 403

    def test_anonymous_is_rejected(self, project: Project) -> None:
        res = APIClient().get(latest_url(project.pk))
        assert res.status_code in (401, 403)
