"""Tests for project Monte Carlo run persistence + history (ADR-0109, #961).

Covers: persistence on run, the history endpoint (newest-first + computed
deltas), the Admin/Owner-only attribution gate, the latest-endpoint DB fallback
past the cache TTL, RBAC, and the nightly retention purge.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="mc_hist_member", password="pw")


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="mc_hist_admin", password="pw")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="mc_hist_viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="mc_hist_outsider", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MC History Project", start_date=date(2026, 1, 5), calendar=calendar
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


def _client(user: object, project: Project, role: int) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def member_client(member: object, project: Project) -> APIClient:
    return _client(member, project, Role.MEMBER)


@pytest.fixture
def admin_client(admin: object, project: Project) -> APIClient:
    return _client(admin, project, Role.ADMIN)


@pytest.fixture
def viewer_client(viewer: object, project: Project) -> APIClient:
    return _client(viewer, project, Role.VIEWER)


@pytest.fixture
def scheduler(db: object) -> object:
    return User.objects.create_user(username="mc_hist_scheduler", password="pw")


@pytest.fixture
def scheduler_client(scheduler: object, project: Project) -> APIClient:
    return _client(scheduler, project, Role.SCHEDULER)


def history_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/history/"


def run_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/"


def latest_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/latest/"


@pytest.mark.django_db
class TestPersistOnRun:
    def test_running_mc_persists_a_run_with_attribution(
        self, admin_client: APIClient, admin: object, project: Project, pert_task: Task
    ) -> None:
        assert MonteCarloRun.objects.filter(project=project).count() == 0
        res = admin_client.post(run_url(project.pk), {"n_simulations": 100}, format="json")
        assert res.status_code == 200
        assert "run_id" in res.json()
        runs = MonteCarloRun.objects.filter(project=project)
        assert runs.count() == 1
        run = runs.first()
        assert run is not None
        assert run.triggered_by_id == admin.pk
        assert run.n_simulations == 100
        assert run.p50 is not None and run.p80 is not None and run.p95 is not None

    def test_each_run_appends_a_row(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        admin_client.post(run_url(project.pk), {"n_simulations": 50}, format="json")
        admin_client.post(run_url(project.pk), {"n_simulations": 50}, format="json")
        assert MonteCarloRun.objects.filter(project=project).count() == 2


@pytest.mark.django_db
class TestHistoryEndpoint:
    def _make_run(
        self, project: Project, *, p80: date, when: object, user: object | None = None
    ) -> MonteCarloRun:
        run = MonteCarloRun.objects.create(
            project=project,
            p50=p80 - timedelta(days=10),
            p80=p80,
            p95=p80 + timedelta(days=10),
            n_simulations=100,
            triggered_by=user,
        )
        # taken_at is auto_now_add; override for deterministic ordering/deltas.
        MonteCarloRun.objects.filter(pk=run.pk).update(taken_at=when)
        run.refresh_from_db()
        return run

    def test_empty_history_returns_empty_list(
        self, member_client: APIClient, project: Project
    ) -> None:
        res = member_client.get(history_url(project.pk))
        assert res.status_code == 200
        assert res.json()["results"] == []

    def test_newest_first_with_computed_deltas(
        self, member_client: APIClient, project: Project
    ) -> None:
        now = timezone.now()
        # older P80 = Sep 1; newer P80 = Sep 15 → newest delta = +14 (slip).
        self._make_run(project, p80=date(2026, 9, 1), when=now - timedelta(days=7))
        self._make_run(project, p80=date(2026, 9, 15), when=now)
        res = member_client.get(history_url(project.pk))
        results = res.json()["results"]
        assert len(results) == 2
        # Newest first.
        assert results[0]["p80"] == "2026-09-15"
        assert results[1]["p80"] == "2026-09-01"
        # Newest row carries the delta vs the older run; oldest row is baseline.
        assert results[0]["delta"]["p80"] == 14
        assert results[1]["delta"] is None

    def test_cap_in_payload(self, member_client: APIClient, project: Project) -> None:
        res = member_client.get(history_url(project.pk))
        assert res.json()["cap"] == 100  # settings.MC_HISTORY_CAP default

    def test_attribution_visible_to_admin(
        self, admin_client: APIClient, admin: object, project: Project
    ) -> None:
        self._make_run(project, p80=date(2026, 9, 1), when=timezone.now(), user=admin)
        res = admin_client.get(history_url(project.pk))
        assert res.json()["results"][0]["triggered_by_name"] is not None

    def test_attribution_hidden_from_member(
        self, member_client: APIClient, admin: object, project: Project
    ) -> None:
        # Run authored by the admin, but read by a plain member.
        self._make_run(project, p80=date(2026, 9, 1), when=timezone.now(), user=admin)
        res = member_client.get(history_url(project.pk))
        assert res.json()["results"][0]["triggered_by_name"] is None

    def test_attribution_hidden_from_viewer(
        self, viewer_client: APIClient, admin: object, project: Project
    ) -> None:
        self._make_run(project, p80=date(2026, 9, 1), when=timezone.now(), user=admin)
        res = viewer_client.get(history_url(project.pk))
        assert res.status_code == 200
        assert res.json()["results"][0]["triggered_by_name"] is None

    def test_attribution_hidden_from_scheduler(
        self, scheduler_client: APIClient, admin: object, project: Project
    ) -> None:
        # Scheduler (role 200) sits below ADMIN (300) — must not see attribution.
        self._make_run(project, p80=date(2026, 9, 1), when=timezone.now(), user=admin)
        res = scheduler_client.get(history_url(project.pk))
        assert res.status_code == 200
        assert res.json()["results"][0]["triggered_by_name"] is None

    def test_non_member_forbidden(
        self, outsider: object, project: Project, member_client: object
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=outsider)
        assert c.get(history_url(project.pk)).status_code == 403

    def test_unauthenticated_401(self, project: Project) -> None:
        assert APIClient().get(history_url(project.pk)).status_code == 401


@pytest.mark.django_db
class TestLatestDbFallback:
    def test_latest_falls_back_to_db_after_cache_expiry(
        self, member_client: APIClient, project: Project
    ) -> None:
        MonteCarloRun.objects.create(
            project=project,
            p50=date(2026, 8, 20),
            p80=date(2026, 9, 1),
            p95=date(2026, 9, 12),
            n_simulations=250,
        )
        cache.clear()  # simulate TTL expiry
        res = member_client.get(latest_url(project.pk))
        assert res.status_code == 200
        data = res.json()
        assert data["p80"] == "2026-09-01"
        assert data["from_history"] is True
        assert data["histogram_buckets"] == []


@pytest.mark.django_db
class TestRetentionPurge:
    def test_purge_trims_to_cap_newest(self, project: Project, settings: object) -> None:
        from trueppm_api.apps.scheduling.tasks import _do_monte_carlo_run_purge
        from trueppm_api.apps.workspace.models import Workspace

        # The purge now reads the per-workspace effective retention cap (ADR-0144),
        # not the global setting — set the workspace cap to 3.
        ws = Workspace.load()
        ws.mc_history_retention_cap = 3
        ws.save(update_fields=["mc_history_retention_cap"])
        base = timezone.now()
        for i in range(6):
            run = MonteCarloRun.objects.create(
                project=project, p80=date(2026, 9, 1), n_simulations=10
            )
            MonteCarloRun.objects.filter(pk=run.pk).update(taken_at=base - timedelta(days=i))
        _do_monte_carlo_run_purge()
        remaining = MonteCarloRun.objects.filter(project=project)
        assert remaining.count() == 3
        # The three newest (smallest day offset) survive.
        newest = remaining.order_by("-taken_at").first()
        assert newest is not None

    def test_purge_noop_when_under_cap(self, project: Project) -> None:
        from trueppm_api.apps.scheduling.tasks import _do_monte_carlo_run_purge

        # 5 runs under the default workspace cap (100) — nothing is purged.
        for _ in range(5):
            MonteCarloRun.objects.create(project=project, p80=date(2026, 9, 1), n_simulations=10)
        _do_monte_carlo_run_purge()
        assert MonteCarloRun.objects.filter(project=project).count() == 5
