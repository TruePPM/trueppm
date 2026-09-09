"""Tests for the project burn chart endpoint (issue #239 / ADR-0022).

`GET /api/v1/projects/{id}/burn/` reconstructs daily burn data from
HistoricalTask snapshots and overlays a planned series when an active
baseline exists. These tests cover the response shape, the burndown vs
burnup math, scope-change tracking, and the baseline overlay.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import (
    MAX_BURN_HORIZON_DAYS,
    MAX_BURN_WINDOW_DAYS,
)
from trueppm_api.apps.projects.views import ProjectBurnView

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def viewer(project: Project) -> object:
    u = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.VIEWER)
    return u


@pytest.fixture
def outsider() -> object:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _create_tasks(project: Project, count: int, points: int | None = None) -> list[Task]:
    tasks = []
    for i in range(count):
        tasks.append(
            Task.objects.create(
                project=project,
                name=f"T{i}",
                duration=1,
                story_points=points,
            )
        )
    return tasks


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_endpoint_returns_burndown_shape(project: Project, member: object) -> None:
    _create_tasks(project, 3)
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "2026-04-01", "until": "2026-04-03"},
    )
    assert resp.status_code == 200
    assert resp.data["chart_type"] == "burndown"
    assert resp.data["metric"] == "tasks"
    assert resp.data["since"] == "2026-04-01"
    assert resp.data["until"] == "2026-04-03"
    assert len(resp.data["series"]) == 3
    point = resp.data["series"][0]
    assert {"date", "actual", "ideal", "scope"} <= set(point.keys())


@pytest.mark.django_db
def test_default_window_is_project_start_to_today(project: Project, member: object) -> None:
    """No since/until → uses project.start_date through today."""
    # Anchored to today rather than the fixture's fixed 2026-04-01 start: once the
    # wall clock passes that date by MAX_BURN_WINDOW_DAYS the defaulted window is
    # clamped (#3566) and this assertion would start failing on a calendar date
    # rather than on a code change.
    Project.objects.filter(pk=project.pk).update(start_date=date.today() - timedelta(days=30))
    project.refresh_from_db()
    _create_tasks(project, 1)
    c = _client(member)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 200
    assert resp.data["since"] == project.start_date.isoformat()


# ---------------------------------------------------------------------------
# Burndown vs burnup
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_burndown_actual_is_remaining(project: Project, member: object) -> None:
    tasks = _create_tasks(project, 4)
    # Mark two as complete — remaining should drop.
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    tasks[1].status = TaskStatus.COMPLETE
    tasks[1].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burndown", "since": today, "until": today},
    )
    assert resp.status_code == 200
    point = resp.data["series"][-1]
    assert point["scope"] == 4
    assert point["actual"] == 2  # remaining


@pytest.mark.django_db
def test_burnup_actual_is_completed(project: Project, member: object) -> None:
    tasks = _create_tasks(project, 4)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burnup", "since": today, "until": today},
    )
    assert resp.status_code == 200
    point = resp.data["series"][-1]
    assert point["scope"] == 4
    assert point["actual"] == 1  # completed


# ---------------------------------------------------------------------------
# Ideal curve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_burndown_ideal_starts_at_scope_ends_at_zero(project: Project, member: object) -> None:
    _create_tasks(project, 10)
    c = _client(member)
    today = date.today()
    since = (today - timedelta(days=4)).isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burndown", "since": since, "until": today.isoformat()},
    )
    series = resp.data["series"]
    assert series[0]["ideal"] == series[0]["scope"]
    assert series[-1]["ideal"] == 0


@pytest.mark.django_db
def test_burnup_ideal_starts_at_zero_ends_at_scope(project: Project, member: object) -> None:
    _create_tasks(project, 10)
    c = _client(member)
    today = date.today()
    since = (today - timedelta(days=4)).isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burnup", "since": since, "until": today.isoformat()},
    )
    series = resp.data["series"]
    assert series[0]["ideal"] == 0
    assert series[-1]["ideal"] == series[-1]["scope"]


# ---------------------------------------------------------------------------
# Metric: points
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_metric_points_sums_story_points(project: Project, member: object) -> None:
    tasks = _create_tasks(project, 2, points=5)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"metric": "points", "since": today, "until": today},
    )
    point = resp.data["series"][-1]
    assert point["scope"] == 10  # 2 tasks × 5 points
    assert point["actual"] == 5  # 1 remaining × 5


# ---------------------------------------------------------------------------
# Baseline overlay
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_baseline_series_present_only_when_active_baseline(
    project: Project, member: object
) -> None:
    _create_tasks(project, 2)
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/", {"since": today, "until": today})
    assert "baseline_series" not in resp.data

    # Activate a baseline; baseline_series should appear.
    baseline = Baseline.objects.create(
        project=project, name="B1", is_active=True, has_cpm_dates=True
    )
    BaselineTask.objects.create(
        baseline=baseline,
        task_id=Task.objects.first().pk,
        task_name="T0",
        finish=date.today() + timedelta(days=2),
        duration=1,
    )
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/", {"since": today, "until": today})
    assert "baseline_series" in resp.data
    assert len(resp.data["baseline_series"]) == 1


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_invalid_chart_type_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "spaghetti", "since": today, "until": today},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_invalid_metric_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"metric": "biscuits", "since": today, "until": today},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_until_before_since_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "2026-04-10", "until": "2026-04-01"},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_malformed_date_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "yesterday", "until": "today"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Window bounds (#3566)
#
# The replay costs O(days × tasks × history rows) and returns a row per day, so
# an uncapped window is an unbounded read for any project member — and a
# max-date `until` used to step past `date.max` inside `_date_range_inclusive`
# and 500 with an OverflowError.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_far_future_until_returns_400_naming_the_bound(project: Project, member: object) -> None:
    """`until=9999-12-31` is a 400 naming the horizon, not an OverflowError 500."""
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": date.today().isoformat(), "until": "9999-12-31"},
    )
    assert resp.status_code == 400
    detail = resp.data["detail"]
    assert str(MAX_BURN_HORIZON_DAYS) in detail
    latest_allowed = (date.today() + timedelta(days=MAX_BURN_HORIZON_DAYS)).isoformat()
    assert latest_allowed in detail


@pytest.mark.django_db
def test_far_future_since_and_until_returns_400(project: Project, member: object) -> None:
    """A zero-day span at the max date is still refused — the span cap alone misses it."""
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "9999-12-31", "until": "9999-12-31"},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_span_over_limit_returns_400_naming_the_limit(project: Project, member: object) -> None:
    until = date.today()
    since = until - timedelta(days=MAX_BURN_WINDOW_DAYS + 1)
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": since.isoformat(), "until": until.isoformat()},
    )
    assert resp.status_code == 400
    assert str(MAX_BURN_WINDOW_DAYS) in resp.data["detail"]


@pytest.mark.django_db
def test_span_exactly_at_limit_returns_200(project: Project, member: object) -> None:
    until = date.today()
    since = until - timedelta(days=MAX_BURN_WINDOW_DAYS)
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": since.isoformat(), "until": until.isoformat()},
    )
    assert resp.status_code == 200
    assert len(resp.data["series"]) == MAX_BURN_WINDOW_DAYS + 1


@pytest.mark.django_db
def test_defaulted_window_is_clamped_not_rejected(project: Project, member: object) -> None:
    """A no-parameter read of a long-running project stays a 200 with a clamped window.

    The caller asked for nothing, so refusing them would be a regression; the
    response echoes the window it actually used.
    """
    # .update() rather than .save() so no project-edit side effects fire here.
    Project.objects.filter(pk=project.pk).update(start_date=date.today() - timedelta(days=900))
    c = _client(member)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 200
    until = date.fromisoformat(resp.data["until"])
    since = date.fromisoformat(resp.data["since"])
    assert (until - since).days == MAX_BURN_WINDOW_DAYS


@pytest.mark.django_db
def test_empty_since_is_clamped_not_rejected(project: Project, member: object) -> None:
    """`?since=` supplies no date, so it must clamp like an absent one, not 400.

    The default is chosen on truthiness; a guard keyed on `is not None` instead
    would refuse a window the caller never asked for. Not reachable from the web
    UI, which drops the empty value — but a client serializing an empty date
    field sends exactly this.
    """
    Project.objects.filter(pk=project.pk).update(start_date=date.today() - timedelta(days=900))
    c = _client(member)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/?since=")
    assert resp.status_code == 200
    until = date.fromisoformat(resp.data["until"])
    since = date.fromisoformat(resp.data["since"])
    assert (until - since).days == MAX_BURN_WINDOW_DAYS


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_can_read(project: Project, viewer: object) -> None:
    _create_tasks(project, 1)
    c = _client(viewer)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_outsider_gets_403(project: Project, outsider: object) -> None:
    c = _client(outsider)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_unauthenticated_gets_401(project: Project) -> None:
    c = APIClient()
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_unknown_project_returns_404(member: object) -> None:
    c = _client(member)
    resp = c.get("/api/v1/projects/00000000-0000-0000-0000-000000000000/burn/")
    # Membership check resolves before object lookup; outsider would see 403,
    # but a known member querying a non-existent project gets 404.
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Combined chart type (issue #53 / ADR-0062)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_combined_returns_correct_shape(project: Project, member: object) -> None:
    """chart_type=combined returns {remaining, completed, total, ideal} per point."""
    tasks = _create_tasks(project, 4)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "since": today, "until": today},
    )
    assert resp.status_code == 200
    assert resp.data["chart_type"] == "combined"
    assert resp.data["metric"] == "tasks"
    point = resp.data["series"][0]
    assert {"date", "remaining", "completed", "total", "ideal"} <= set(point.keys())


@pytest.mark.django_db
def test_combined_remaining_plus_completed_equals_total(project: Project, member: object) -> None:
    """For each point: remaining + completed should equal total (scope)."""
    tasks = _create_tasks(project, 6)
    for t in tasks[:2]:
        t.status = TaskStatus.COMPLETE
        t.save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "since": today, "until": today},
    )
    assert resp.status_code == 200
    for point in resp.data["series"]:
        assert point["remaining"] + point["completed"] == point["total"]


@pytest.mark.django_db
def test_combined_invalid_metric_returns_400(project: Project, member: object) -> None:
    """Invalid metric with combined chart_type must return 400, not 500 (security-review fix)."""
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "metric": "biscuits", "since": today, "until": today},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_combined_metric_points(project: Project, member: object) -> None:
    """combined chart_type respects metric=points."""
    tasks = _create_tasks(project, 4, points=3)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "metric": "points", "since": today, "until": today},
    )
    assert resp.status_code == 200
    assert resp.data["metric"] == "points"
    point = resp.data["series"][0]
    assert point["total"] == 12  # 4 tasks × 3 pts
    assert point["completed"] == 3  # 1 completed × 3 pts
    assert point["remaining"] == 9  # 3 remaining × 3 pts


@pytest.mark.django_db
def test_combined_replays_history_once(project: Project, member: object) -> None:
    """combined derives both curves from ONE history query (#3566).

    It used to call `burn_series` twice — one query and one full replay per
    curve — for the variant the Reports page defaults to. Counting only the
    HistoricalTask reads keeps the assertion about the replay rather than about
    the unrelated auth/permission queries around it.
    """
    _create_tasks(project, 3)
    c = _client(member)
    since = (date.today() - timedelta(days=5)).isoformat()
    until = date.today().isoformat()
    with CaptureQueriesContext(connection) as ctx:
        resp = c.get(
            f"/api/v1/projects/{project.pk}/burn/",
            {"chart_type": "combined", "since": since, "until": until},
        )
    assert resp.status_code == 200
    history_queries = [q for q in ctx.captured_queries if "historicaltask" in q["sql"].lower()]
    assert len(history_queries) == 1, history_queries


@pytest.mark.django_db
def test_baseline_series_uses_story_points_when_metric_is_points(
    project: Project, member: object
) -> None:
    """Baseline overlay must sum story_points, not task count, when metric=points (#395)."""
    tasks = _create_tasks(project, 3, points=5)
    today = date.today()
    baseline = Baseline.objects.create(
        project=project, name="B", is_active=True, has_cpm_dates=True
    )
    # All 3 tasks planned to finish by today.
    for t in tasks:
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=t.pk,
            task_name=t.name,
            finish=today,
            duration=1,
        )
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"metric": "points", "since": today.isoformat(), "until": today.isoformat()},
    )
    assert resp.status_code == 200
    assert "baseline_series" in resp.data
    point = resp.data["baseline_series"][0]
    # Burndown: planned = total_points - done_points = 15 - 15 = 0
    # (all tasks planned to finish by today → all counted as done).
    # The key assertion is that planned is NOT 3 (the task count).
    assert point["planned"] != 3, "baseline overlay must use story_points, not task count"
    assert point["planned"] == 0  # 3 tasks × 5 pts all finish ≤ today


# ---------------------------------------------------------------------------
# Throttle (#3581)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBurnThrottle:
    """Scoped rate limit on ``GET /api/v1/projects/<pk>/burn/`` (#3581).

    ``ProjectBurnView`` previously declared no ``throttle_classes`` and fell
    through to the general "user" default of 1000/min. The read reconstructs its
    series from ``HistoricalTask`` snapshots — #3566 bounds the *window* per
    request, but the floor cost still scales with project history (#3579) — and
    any project member, including a Viewer, can issue it. These tests drive real
    requests through the API client and assert on the resulting ``429``;
    asserting ``throttle_scope`` alone would pass even if ``ScopedRateThrottle``
    silently no-ops when the view carries no ``throttle_scope`` attribute — the
    exact failure mode tracked as #3598, live on another branch at the time this
    was written.
    """

    @pytest.fixture(autouse=True)
    def _clear_throttle_cache(self) -> object:
        """The ``burn`` scope's rate-limit history lives in the LocMem cache;
        clear it around each test so a drained bucket never leaves a later test
        pre-throttled."""
        cache.clear()
        yield
        cache.clear()

    def test_exceeding_rate_returns_429(
        self, project: Project, member: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Patch the rate on the shared ``ScopedRateThrottle`` class — DRF binds
        ``THROTTLE_RATES`` at import, so a plain settings override never reaches
        the already-bound throttle (same idiom as ``TestWhatIfThrottle``)."""
        monkeypatch.setattr(
            ScopedRateThrottle,
            "THROTTLE_RATES",
            {**ScopedRateThrottle.THROTTLE_RATES, "burn": "2/min"},
        )
        _create_tasks(project, 1)
        c = _client(member)
        statuses = [c.get(f"/api/v1/projects/{project.pk}/burn/").status_code for _ in range(3)]
        assert statuses == [200, 200, 429]

    def test_throttle_is_per_account_not_global(
        self, project: Project, member: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """One member exhausting the bucket must not lock out a second account —
        the scope keys on the user, so a fresh account gets its own allowance."""
        monkeypatch.setattr(
            ScopedRateThrottle,
            "THROTTLE_RATES",
            {**ScopedRateThrottle.THROTTLE_RATES, "burn": "1/min"},
        )
        _create_tasks(project, 1)
        c = _client(member)
        assert c.get(f"/api/v1/projects/{project.pk}/burn/").status_code == 200
        assert c.get(f"/api/v1/projects/{project.pk}/burn/").status_code == 429

        other_user = User.objects.create_user(username="member2", password="pw")
        ProjectMembership.objects.create(project=project, user=other_user, role=Role.VIEWER)
        other = _client(other_user)
        assert other.get(f"/api/v1/projects/{project.pk}/burn/").status_code == 200

    def test_throttle_scope_is_declared_on_the_view(self) -> None:
        """``ScopedRateThrottle`` resolves its scope from ``view.throttle_scope``
        at request time — a bare ``scope`` class attribute set on the throttle
        (the pattern used by the FBV-only ``MonteCarloRunThrottle`` /
        ``TelemetryTestThrottle`` subclasses) is NOT read for a CBV, since
        ``allow_request`` re-reads ``getattr(view, 'throttle_scope', None)``.
        Missing it makes the check return ``True`` unconditionally — no
        throttling at all (#3598's failure mode). This pins the attribute so a
        future refactor cannot silently drop it; it is a *supplement* to the two
        429 tests above, not a replacement, since a passing attribute check alone
        proves nothing about the rate actually being enforced."""
        assert ProjectBurnView.throttle_classes == [ScopedRateThrottle]
        assert ProjectBurnView.throttle_scope == "burn"
