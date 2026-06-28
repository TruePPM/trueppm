"""Tests for project-grain forecast snapshot capture (ADR-0154, #388).

Covers: the model, the capture service (Task aggregates + best-effort MonteCarloRun
join + dedup), the best-effort wrapper, the daily floor backstop, the tiered
retention prune, the read endpoint (RBAC, since/until, pagination, IDOR, archived
gate), and the management command.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.scheduling.models import (
    ForecastSnapshotTrigger,
    MonteCarloRun,
    ProjectForecastSnapshot,
)
from trueppm_api.apps.scheduling.services import (
    capture_forecast_snapshot,
    safe_capture_forecast_snapshot,
)
from trueppm_api.apps.scheduling.tasks import (
    _do_daily_forecast_floor,
    _do_prune_forecast_snapshots,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Forecast Project", start_date=date(2026, 1, 5), calendar=calendar
    )


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="fc_member", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="fc_outsider", password="pw")


def _client(user: object, project: Project, role: int) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def member_client(member: object, project: Project) -> APIClient:
    return _client(member, project, Role.MEMBER)


def url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/forecast-snapshots/"


def _backdate(snap: ProjectForecastSnapshot, when: datetime) -> ProjectForecastSnapshot:
    """captured_at is auto_now_add; override it for deterministic tiering."""
    ProjectForecastSnapshot.objects.filter(pk=snap.pk).update(captured_at=when)
    snap.refresh_from_db()
    return snap


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestModel:
    def test_defaults_and_str(self, project: Project) -> None:
        snap = ProjectForecastSnapshot.objects.create(project=project)
        assert snap.triggered_by == ForecastSnapshotTrigger.RECOMPUTE
        assert snap.task_count == 0
        assert snap.completed_task_count == 0
        assert snap.captured_at is not None
        assert str(project.pk) in str(snap)

    def test_ordering_is_newest_first(self, project: Project) -> None:
        old = _backdate(
            ProjectForecastSnapshot.objects.create(project=project),
            timezone.now() - timedelta(days=2),
        )
        new = ProjectForecastSnapshot.objects.create(project=project)
        ids = list(ProjectForecastSnapshot.objects.values_list("id", flat=True))
        assert ids == [new.id, old.id]


# ---------------------------------------------------------------------------
# Capture service
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCapture:
    def test_captures_cpm_aggregates_from_tasks(self, project: Project) -> None:
        Task.objects.create(
            project=project,
            name="A",
            duration=5,
            early_finish=date(2026, 3, 1),
            total_float=4,
            status=TaskStatus.COMPLETE,
        )
        Task.objects.create(
            project=project,
            name="B",
            duration=5,
            early_finish=date(2026, 6, 30),
            total_float=2,
            status=TaskStatus.NOT_STARTED,
        )
        snap = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert snap is not None
        assert snap.cpm_finish == date(2026, 6, 30)  # max early_finish
        assert snap.total_float_days == 2  # min total_float
        assert snap.task_count == 2
        assert snap.completed_task_count == 1

    def test_no_monte_carlo_leaves_mc_fields_null(self, project: Project) -> None:
        Task.objects.create(project=project, name="A", duration=5, early_finish=date(2026, 3, 1))
        snap = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert snap is not None
        assert snap.mc_p50_finish is None
        assert snap.mc_p80_finish is None
        assert snap.mc_iterations is None

    def test_joins_latest_monte_carlo_run(self, project: Project) -> None:
        # Older run, then a newer one — the newest must win.
        old = MonteCarloRun.objects.create(
            project=project, p50=date(2026, 5, 1), p80=date(2026, 5, 20), n_simulations=100
        )
        MonteCarloRun.objects.filter(pk=old.pk).update(taken_at=timezone.now() - timedelta(days=3))
        MonteCarloRun.objects.create(
            project=project,
            p50=date(2026, 6, 1),
            p80=date(2026, 6, 20),
            p95=date(2026, 7, 10),
            n_simulations=500,
        )
        snap = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert snap is not None
        assert snap.mc_p50_finish == date(2026, 6, 1)
        assert snap.mc_p80_finish == date(2026, 6, 20)
        assert snap.mc_p95_finish == date(2026, 7, 10)
        assert snap.mc_iterations == 500

    def test_dedup_within_window_and_unchanged_is_noop(self, project: Project) -> None:
        Task.objects.create(project=project, name="A", duration=5, early_finish=date(2026, 3, 1))
        first = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert first is not None
        # Same forecast, immediately again → deduped.
        second = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert second is None
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 1

    def test_changed_forecast_within_window_captures(self, project: Project) -> None:
        t = Task.objects.create(
            project=project, name="A", duration=5, early_finish=date(2026, 3, 1)
        )
        capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        # The CPM finish slips — a new snapshot must be captured even within the window.
        Task.objects.filter(pk=t.pk).update(early_finish=date(2026, 5, 1))
        snap = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert snap is not None
        assert snap.cpm_finish == date(2026, 5, 1)
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 2

    def test_unchanged_outside_window_captures(self, project: Project) -> None:
        Task.objects.create(project=project, name="A", duration=5, early_finish=date(2026, 3, 1))
        first = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert first is not None
        # Age the existing snapshot past the dedup window → next capture is allowed.
        _backdate(first, timezone.now() - timedelta(hours=2))
        second = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.SCHEDULED)
        assert second is not None
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 2

    def test_safe_capture_swallows_errors(
        self, project: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def boom(*_a: object, **_k: object) -> None:
            raise RuntimeError("db gone")

        monkeypatch.setattr("trueppm_api.apps.scheduling.services.capture_forecast_snapshot", boom)
        # Must not raise — recompute on_commit relies on this being non-fatal.
        safe_capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Daily floor backstop
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDailyFloor:
    def test_captures_for_uncovered_active_project(self, project: Project) -> None:
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 0
        _do_daily_forecast_floor()
        snaps = ProjectForecastSnapshot.objects.filter(project=project)
        assert snaps.count() == 1
        assert snaps.first().triggered_by == ForecastSnapshotTrigger.SCHEDULED

    def test_skips_project_covered_within_window(self, project: Project) -> None:
        _backdate(
            ProjectForecastSnapshot.objects.create(project=project),
            timezone.now() - timedelta(hours=2),
        )
        _do_daily_forecast_floor()
        # Already covered in the last 24 h → no second row.
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 1

    def test_skips_archived_and_deleted_projects(self, calendar: Calendar) -> None:
        archived = Project.objects.create(
            name="Archived", start_date=date(2026, 1, 5), calendar=calendar, is_archived=True
        )
        deleted = Project.objects.create(
            name="Deleted", start_date=date(2026, 1, 5), calendar=calendar, is_deleted=True
        )
        _do_daily_forecast_floor()
        assert ProjectForecastSnapshot.objects.filter(project=archived).count() == 0
        assert ProjectForecastSnapshot.objects.filter(project=deleted).count() == 0


# ---------------------------------------------------------------------------
# Tiered retention prune
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPrune:
    def _seed_tiers(self, project: Project) -> None:
        now = timezone.now()
        # Daily tier (<90 d): three rows, all kept.
        for d in (1, 2, 3):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                now - timedelta(days=d),
            )
        # Weekly tier (90–365 d): two rows in the SAME ISO week → keep newest only.
        wk_anchor = now - timedelta(days=120)
        wk_monday = wk_anchor - timedelta(days=wk_anchor.weekday())
        for offset in (1, 2):  # Tue, Wed — same ISO week
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                wk_monday + timedelta(days=offset),
            )
        # Monthly tier (>365 d): two rows in the SAME calendar month → keep newest only.
        mo_anchor = now - timedelta(days=400)
        for day in (10, 20):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                mo_anchor.replace(day=day),
            )

    def test_tiered_prune_keeps_one_per_bucket(self, project: Project) -> None:
        self._seed_tiers(project)
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 7
        deleted = _do_prune_forecast_snapshots()
        # 3 daily kept; weekly 2→1 (−1); monthly 2→1 (−1) ⇒ 2 deleted, 5 remain.
        assert deleted == 2
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 5

    def test_prune_is_idempotent(self, project: Project) -> None:
        self._seed_tiers(project)
        _do_prune_forecast_snapshots()
        assert _do_prune_forecast_snapshots() == 0

    def test_prune_noop_when_all_recent(self, project: Project) -> None:
        for d in (1, 2, 3, 4):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                timezone.now() - timedelta(days=d),
            )
        assert _do_prune_forecast_snapshots() == 0
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 4


# ---------------------------------------------------------------------------
# Read endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEndpoint:
    def test_member_reads_newest_first(self, member_client: APIClient, project: Project) -> None:
        old = _backdate(
            ProjectForecastSnapshot.objects.create(project=project, cpm_finish=date(2026, 6, 1)),
            timezone.now() - timedelta(days=5),
        )
        new = ProjectForecastSnapshot.objects.create(project=project, cpm_finish=date(2026, 8, 1))
        res = member_client.get(url(project.pk))
        assert res.status_code == 200
        body = res.json()
        assert body["count"] == 2
        results = body["results"]
        assert results[0]["id"] == str(new.id)
        assert results[1]["id"] == str(old.id)
        assert results[0]["cpm_finish"] == "2026-08-01"

    def test_empty_returns_empty_results(self, member_client: APIClient, project: Project) -> None:
        res = member_client.get(url(project.pk))
        assert res.status_code == 200
        assert res.json()["results"] == []

    def test_since_until_filtering(self, member_client: APIClient, project: Project) -> None:
        now = timezone.now()
        for d in (1, 5, 10):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                now - timedelta(days=d),
            )
        since = (now - timedelta(days=6)).isoformat()
        res = member_client.get(url(project.pk), {"since": since})
        # Only the rows at −1 d and −5 d are at/after the bound.
        assert res.json()["count"] == 2

        until = (now - timedelta(days=3)).isoformat()
        res = member_client.get(url(project.pk), {"until": until})
        # Only the rows at −5 d and −10 d are at/before the bound.
        assert res.json()["count"] == 2

    def test_since_until_accept_bare_date(self, member_client: APIClient, project: Project) -> None:
        """A bare ISO date (YYYY-MM-DD) is the documented since/until format (#1378).

        A bare date is interpreted as midnight UTC, so a row captured on day D is
        at/after ``since=D`` and at/before ``until=D+1``."""
        for d in (date(2026, 6, 1), date(2026, 6, 10), date(2026, 6, 20)):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                timezone.make_aware(datetime(d.year, d.month, d.day, 12, 0)),
            )
        # since 2026-06-10 (midnight) excludes the 2026-06-01 row.
        res = member_client.get(url(project.pk), {"since": "2026-06-10"})
        assert res.status_code == 200
        assert res.json()["count"] == 2

        # until 2026-06-10 (midnight) is before the 2026-06-10 noon row, leaving
        # only the 2026-06-01 row.
        res = member_client.get(url(project.pk), {"until": "2026-06-10"})
        assert res.json()["count"] == 1

    def test_non_member_forbidden_idor(self, outsider: object, project: Project) -> None:
        ProjectForecastSnapshot.objects.create(project=project)
        c = APIClient()
        c.force_authenticate(user=outsider)
        assert c.get(url(project.pk)).status_code == 403

    def test_unauthenticated_401(self, project: Project) -> None:
        assert APIClient().get(url(project.pk)).status_code == 401

    def test_archived_project_still_readable(self, member: object, calendar: Calendar) -> None:
        # Archived projects are hard read-only, not hidden — forecast history must
        # stay visible (IsProjectNotArchived passes SAFE_METHODS). A member can read
        # the captured drift even after the project is archived.
        archived = Project.objects.create(
            name="Archived", start_date=date(2026, 1, 5), calendar=calendar, is_archived=True
        )
        ProjectForecastSnapshot.objects.create(project=archived)
        client = _client(member, archived, Role.MEMBER)
        res = client.get(url(archived.pk))
        assert res.status_code == 200
        assert res.json()["count"] == 1


# ---------------------------------------------------------------------------
# Management command
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestManagementCommand:
    def test_command_prunes(self, project: Project) -> None:
        now = timezone.now()
        # Two same-month rows >365 d old → one is pruned.
        for day in (10, 20):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                (now - timedelta(days=400)).replace(day=day),
            )
        call_command("prune_forecast_snapshots")
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 1

    def test_dry_run_deletes_nothing(self, project: Project) -> None:
        now = timezone.now()
        for day in (10, 20):
            _backdate(
                ProjectForecastSnapshot.objects.create(project=project),
                (now - timedelta(days=400)).replace(day=day),
            )
        call_command("prune_forecast_snapshots", "--dry-run")
        assert ProjectForecastSnapshot.objects.filter(project=project).count() == 2
