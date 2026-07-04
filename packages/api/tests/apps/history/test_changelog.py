"""Tests for the unified project changelog endpoint (ADR-0201, #371).

Covers:
- Aggregation ordering across object types (newest-first).
- Keyset cursor pagination: stability, no dup/skip across pages, cross-table ties.
- Permission filtering: non-members get no rows; membership gates the whole feed.
- Each filter param (object_type, change_type, user, since).
- history_user redaction + user-filter gating for non-Admin callers.
- Malformed cursor -> 400; empty state.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.history.changelog import ChangelogCursor
from trueppm_api.apps.projects.models import Calendar, Project, Risk, Sprint, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw", first_name="Owen")


@pytest.fixture
def viewer(db: object) -> Any:
    return User.objects.create_user(username="viewer", password="pw", first_name="Vera")


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def owner_client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def viewer_client(viewer: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def outsider_client(outsider: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=outsider)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def owner_membership(owner: Any, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)


@pytest.fixture
def viewer_membership(viewer: Any, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


def _url(project: Project) -> str:
    return reverse("project-changelog", args=[str(project.pk)])


def _stamp(record: Any, when: Any) -> None:
    """Force a historical row's history_date so ordering is deterministic in tests."""
    record.history_date = when
    record.save()


# ---------------------------------------------------------------------------
# Aggregation ordering across object types
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAggregationOrdering:
    def test_merges_task_sprint_risk_newest_first(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        owner: Any,
        project: Project,
    ) -> None:
        base = timezone.now() - timedelta(hours=1)
        _stamp(project.history.latest(), base - timedelta(minutes=1))  # type: ignore[attr-defined]
        task = Task.objects.create(project=project, name="Design", duration=5)
        _stamp(task.history.latest(), base)  # type: ignore[attr-defined]
        sprint = Sprint.objects.create(
            project=project, name="S1", start_date=date(2026, 1, 1), finish_date=date(2026, 1, 14)
        )
        _stamp(sprint.history.latest(), base + timedelta(minutes=1))  # type: ignore[attr-defined]
        risk = Risk.objects.create(
            project=project, title="R1", probability=3, impact=4, created_by=owner
        )
        _stamp(risk.history.latest(), base + timedelta(minutes=2))  # type: ignore[attr-defined]

        resp = owner_client.get(_url(project))
        assert resp.status_code == 200
        rows = resp.json()["results"]
        # Newest-first: risk (created last) -> sprint -> task -> project (created first).
        types = [r["object_type"] for r in rows]
        assert types[0] == "risk"
        assert types[1] == "sprint"
        assert types[2] == "task"
        assert "project" in types  # the project's own create row is present

    def test_change_type_maps_history_type(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        task = Task.objects.create(project=project, name="Design", duration=5)
        task.name = "Design v2"
        task.save()
        resp = owner_client.get(_url(project), {"object_type": "task"})
        rows = resp.json()["results"]
        change_types = {r["change_type"] for r in rows}
        assert "created" in change_types
        assert "updated" in change_types
        updated = next(r for r in rows if r["change_type"] == "updated")
        fields = {c["field"] for c in updated["changes"]}
        assert "name" in fields

    def test_object_label_and_click_through_id(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        task = Task.objects.create(project=project, name="Design", duration=5)
        resp = owner_client.get(_url(project), {"object_type": "task"})
        row = resp.json()["results"][0]
        assert row["object_label"] == "Design"
        assert row["object_id"] == str(task.pk)
        assert row["id"] == f"task:{task.history.latest().history_id}"  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Cursor pagination
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCursorPagination:
    def test_pages_cover_all_rows_without_dup_or_skip(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        # 25 tasks -> 25 create rows + 1 project create row = 26 entries.
        for i in range(25):
            Task.objects.create(project=project, name=f"T{i}", duration=1)

        seen: list[str] = []
        cursor: str | None = None
        pages = 0
        while True:
            params = {"page_size": "10"}
            if cursor:
                params["cursor"] = cursor
            resp = owner_client.get(_url(project), params)
            assert resp.status_code == 200
            body = resp.json()
            seen.extend(r["id"] for r in body["results"])
            cursor = body["next_cursor"]
            pages += 1
            assert pages <= 10  # guard against an infinite loop
            if cursor is None:
                break

        assert len(seen) == len(set(seen)), "a row appeared on two pages (duplicate)"
        assert len(seen) == 26, f"expected 26 unique rows across pages, got {len(seen)}"

    def test_ordering_is_monotonic_across_pages(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        for i in range(15):
            Task.objects.create(project=project, name=f"T{i}", duration=1)

        dates: list[str] = []
        cursor: str | None = None
        while True:
            params = {"page_size": "5"}
            if cursor:
                params["cursor"] = cursor
            body = owner_client.get(_url(project), params).json()
            dates.extend(r["history_date"] for r in body["results"])
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert dates == sorted(dates, reverse=True), "stream is not globally newest-first"

    def test_cross_table_same_timestamp_tie_is_stable(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        owner: Any,
        project: Project,
    ) -> None:
        # Two rows in DIFFERENT tables with the EXACT same history_date — the case a
        # timestamp-only cursor loses. The (date, table_rank, history_id) key must
        # still partition them across a page boundary with no dup/skip.
        ts = timezone.now()
        task = Task.objects.create(project=project, name="T", duration=1)
        _stamp(task.history.latest(), ts)  # type: ignore[attr-defined]
        risk = Risk.objects.create(
            project=project, title="R", probability=3, impact=4, created_by=owner
        )
        _stamp(risk.history.latest(), ts)  # type: ignore[attr-defined]

        seen: list[str] = []
        cursor: str | None = None
        while True:
            params = {"page_size": "1", "object_type": "task,risk"}
            if cursor:
                params["cursor"] = cursor
            body = owner_client.get(_url(project), params).json()
            seen.extend(r["id"] for r in body["results"])
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert sorted(seen) == sorted(
            [f"task:{task.history.latest().history_id}", f"risk:{risk.history.latest().history_id}"]  # type: ignore[attr-defined]
        )
        assert len(seen) == len(set(seen))

    def test_malformed_cursor_returns_400(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        resp = owner_client.get(_url(project), {"cursor": "not-a-real-cursor!!"})
        assert resp.status_code == 400
        assert "cursor" in resp.json()

    def test_cursor_roundtrip_encoding(self) -> None:
        now = timezone.now()
        c = ChangelogCursor(history_date=now, rank=3, history_id=42)
        decoded = ChangelogCursor.decode(c.encode())
        assert decoded.rank == 3
        assert decoded.history_id == 42
        assert abs((decoded.history_date - now).total_seconds()) < 1


# ---------------------------------------------------------------------------
# Permission filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPermissions:
    def test_non_member_is_forbidden(
        self,
        outsider_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        Task.objects.create(project=project, name="Secret", duration=1)
        resp = outsider_client.get(_url(project))
        assert resp.status_code in (403, 404)

    def test_member_of_other_project_sees_none_of_this_project(
        self,
        owner_membership: ProjectMembership,
        calendar: Calendar,
        project: Project,
    ) -> None:
        # A user who is a member of a DIFFERENT project must not read this one.
        other_user = User.objects.create_user(username="other", password="pw")
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        ProjectMembership.objects.create(project=other_project, user=other_user, role=Role.OWNER)
        Task.objects.create(project=project, name="Secret", duration=1)

        client = APIClient()
        client.force_authenticate(user=other_user)
        resp = client.get(_url(project))
        assert resp.status_code in (403, 404)

    def test_anonymous_is_rejected(self, project: Project) -> None:
        resp = APIClient().get(_url(project))
        assert resp.status_code in (401, 403)

    def test_rows_scoped_to_project(
        self,
        owner_client: APIClient,
        owner: Any,
        owner_membership: ProjectMembership,
        calendar: Calendar,
        project: Project,
    ) -> None:
        # A task in another project must never leak into this project's changelog.
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        ProjectMembership.objects.create(project=other_project, user=owner, role=Role.OWNER)
        Task.objects.create(project=other_project, name="Foreign", duration=1)
        Task.objects.create(project=project, name="Mine", duration=1)

        rows = owner_client.get(_url(project), {"object_type": "task"}).json()["results"]
        labels = {r["object_label"] for r in rows}
        assert "Mine" in labels
        assert "Foreign" not in labels


# ---------------------------------------------------------------------------
# history_user redaction + user filter gating
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUserVisibility:
    def test_admin_sees_history_user(
        self,
        owner_client: APIClient,
        owner: Any,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        client = owner_client
        client.post  # noqa: B018 — keep the fixture referenced
        # Create a task through the API so history_user is stamped to the owner.
        task = Task.objects.create(project=project, name="Design", duration=5)
        rec = task.history.latest()  # type: ignore[attr-defined]
        rec.history_user = owner
        rec.save()
        rows = client.get(_url(project), {"object_type": "task"}).json()["results"]
        row = next(r for r in rows if r["object_label"] == "Design")
        assert row["user"] is not None
        assert row["user"]["display_name"] == "Owen"

    def test_viewer_cannot_see_history_user(
        self,
        viewer_client: APIClient,
        owner: Any,
        viewer_membership: ProjectMembership,
        project: Project,
    ) -> None:
        task = Task.objects.create(project=project, name="Design", duration=5)
        rec = task.history.latest()  # type: ignore[attr-defined]
        rec.history_user = owner
        rec.save()
        rows = viewer_client.get(_url(project), {"object_type": "task"}).json()["results"]
        row = next(r for r in rows if r["object_label"] == "Design")
        assert row["user"] is None

    def test_user_filter_ignored_for_viewer(
        self,
        viewer_client: APIClient,
        owner: Any,
        viewer: Any,
        viewer_membership: ProjectMembership,
        project: Project,
    ) -> None:
        # A row authored by `owner`; the viewer must not be able to slice the feed
        # by user (surveillance guard — the filter is ignored for non-Admins).
        task = Task.objects.create(project=project, name="Design", duration=5)
        rec = task.history.latest()  # type: ignore[attr-defined]
        rec.history_user = owner
        rec.save()
        rows = viewer_client.get(
            _url(project), {"object_type": "task", "user": str(owner.pk)}
        ).json()["results"]
        # The filter was ignored, so the owner-authored row is still returned.
        assert any(r["object_label"] == "Design" for r in rows)

    def test_user_filter_applies_for_admin(
        self,
        owner_client: APIClient,
        owner: Any,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        other = User.objects.create_user(username="stamp", password="pw")
        t1 = Task.objects.create(project=project, name="ByOwner", duration=1)
        r1 = t1.history.latest()  # type: ignore[attr-defined]
        r1.history_user = owner
        r1.save()
        t2 = Task.objects.create(project=project, name="ByOther", duration=1)
        r2 = t2.history.latest()  # type: ignore[attr-defined]
        r2.history_user = other
        r2.save()
        rows = owner_client.get(
            _url(project), {"object_type": "task", "user": str(owner.pk)}
        ).json()["results"]
        labels = {r["object_label"] for r in rows}
        assert "ByOwner" in labels
        assert "ByOther" not in labels


# ---------------------------------------------------------------------------
# Filter params
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestFilters:
    def test_object_type_filter(
        self,
        owner_client: APIClient,
        owner: Any,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        Task.objects.create(project=project, name="T", duration=1)
        Risk.objects.create(project=project, title="R", probability=3, impact=4, created_by=owner)
        rows = owner_client.get(_url(project), {"object_type": "risk"}).json()["results"]
        assert rows
        assert {r["object_type"] for r in rows} == {"risk"}

    def test_change_type_filter(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        task.name = "T2"
        task.save()
        rows = owner_client.get(
            _url(project), {"object_type": "task", "change_type": "updated"}
        ).json()["results"]
        assert rows
        assert {r["change_type"] for r in rows} == {"updated"}

    def test_since_filter(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        old = Task.objects.create(project=project, name="Old", duration=1)
        _stamp(old.history.latest(), timezone.now() - timedelta(days=30))  # type: ignore[attr-defined]
        Task.objects.create(project=project, name="New", duration=1)

        cutoff = (timezone.now() - timedelta(days=1)).isoformat()
        rows = owner_client.get(_url(project), {"object_type": "task", "since": cutoff}).json()[
            "results"
        ]
        labels = {r["object_label"] for r in rows}
        assert "New" in labels
        assert "Old" not in labels

    def test_unknown_object_type_returns_400(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        resp = owner_client.get(_url(project), {"object_type": "banana"})
        assert resp.status_code == 400
        assert "object_type" in resp.json()

    def test_unknown_change_type_returns_400(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        resp = owner_client.get(_url(project), {"change_type": "exploded"})
        assert resp.status_code == 400
        assert "change_type" in resp.json()

    def test_bad_since_returns_400(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        resp = owner_client.get(_url(project), {"since": "not-a-date"})
        assert resp.status_code == 400
        assert "since" in resp.json()

    def test_non_integer_user_returns_400_for_admin(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        # The user PK is an integer; a garbage value must 400, not 500 at query time.
        resp = owner_client.get(_url(project), {"user": "not-an-int"})
        assert resp.status_code == 400
        assert "user" in resp.json()


# ---------------------------------------------------------------------------
# Empty / edge states
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEmptyState:
    def test_project_with_only_its_own_create_row(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        body = owner_client.get(_url(project)).json()
        # The project's own create row is the single entry; nothing else, no cursor.
        assert body["next_cursor"] is None
        assert [r["object_type"] for r in body["results"]] == ["project"]

    def test_filtering_to_empty_object_type_returns_no_rows(
        self,
        owner_client: APIClient,
        owner_membership: ProjectMembership,
        project: Project,
    ) -> None:
        body = owner_client.get(_url(project), {"object_type": "sprint"}).json()
        assert body["results"] == []
        assert body["next_cursor"] is None
