"""Tests for object change history (issue #51).

Covers:
- Model history created on .save()
- CPM/excluded fields do NOT appear in history records
- Purge task boundary conditions
- Task history API: permissions, diff correctness, CPM fields absent, empty-diff omission
- Project history API
- Summary API: window validation, permission, cache bust
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.history.tasks import purge_old_history_records
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw", first_name="Owen")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def viewer_client(viewer: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def outsider_client(outsider: object) -> APIClient:
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
def owner_membership(owner: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)


@pytest.fixture
def viewer_membership(viewer: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Design", duration=5)


@pytest.fixture
def task2(project: Project) -> Task:
    return Task.objects.create(project=project, name="Build", duration=10)


@pytest.fixture
def dep(task: Task, task2: Task) -> Dependency:
    return Dependency.objects.create(predecessor=task, successor=task2, dep_type="FS")


# ---------------------------------------------------------------------------
# Model-level history creation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestModelHistory:
    def test_task_save_creates_history(self, task: Task) -> None:
        task.name = "Design Phase"
        task.save()
        assert task.history.count() == 2  # create + update  # type: ignore[attr-defined]

    def test_project_save_creates_history(self, project: Project) -> None:
        project.name = "Proj Updated"
        project.save()
        assert project.history.count() == 2  # type: ignore[attr-defined]

    def test_dependency_save_creates_history(self, dep: Dependency) -> None:
        dep.lag = 2
        dep.save()
        assert dep.history.count() == 2  # type: ignore[attr-defined]

    def test_cpm_fields_not_in_history(self, task: Task) -> None:
        """CPM write via bulk_update produces no history rows at all."""
        history_before = task.history.count()  # type: ignore[attr-defined]
        Task.objects.filter(pk=task.pk).update(early_start=date(2026, 2, 1))
        assert task.history.count() == history_before  # type: ignore[attr-defined]

    def test_excluded_fields_absent_from_historical_model(self, task: Task) -> None:
        """Excluded fields must not exist as columns on the HistoricalTask model."""
        historical_model = Task.history.model  # type: ignore[attr-defined]
        field_names = {f.name for f in historical_model._meta.fields}
        excluded = {
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
        }
        assert not excluded & field_names, (
            f"Excluded fields found in HistoricalTask: {excluded & field_names}"
        )


# ---------------------------------------------------------------------------
# Purge task
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPurgeTask:
    def test_purges_records_older_than_retention(self, task: Task) -> None:
        # Manually backdate a history record to 91 days ago.
        task.name = "Old name"
        task.save()
        old_record = task.history.latest()  # type: ignore[attr-defined]
        old_record.history_date = timezone.now() - timedelta(days=91)
        old_record.save()

        with patch("django.conf.settings.HISTORY_RETENTION_DAYS", 90):
            result = purge_old_history_records()

        assert result["status"] == "ok"
        assert result["deleted"]["Task"] >= 1

    def test_does_not_purge_records_within_retention(self, task: Task) -> None:
        task.name = "Recent name"
        task.save()
        count_before = task.history.count()  # type: ignore[attr-defined]

        with patch("django.conf.settings.HISTORY_RETENTION_DAYS", 90):
            purge_old_history_records()

        assert task.history.count() == count_before  # type: ignore[attr-defined]

    def test_skips_when_retention_is_none(self, task: Task) -> None:
        task.name = "Keep forever"
        task.save()
        count_before = task.history.count()  # type: ignore[attr-defined]

        with patch("django.conf.settings.HISTORY_RETENTION_DAYS", None):
            result = purge_old_history_records()

        assert result["status"] == "skipped"
        assert task.history.count() == count_before  # type: ignore[attr-defined]

    def test_purges_task_activity_events_older_than_retention(self, task: Task) -> None:
        """TaskActivityEvent (ADR-0207) ages out on the same HISTORY window."""
        from trueppm_api.apps.projects.models import TaskActivityEvent

        old = TaskActivityEvent.objects.create(task=task, event_type="cpm_recalculated")
        recent = TaskActivityEvent.objects.create(task=task, event_type="risk_linked")
        # created_at is auto_now_add — backdate the first past the window via update().
        TaskActivityEvent.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - timedelta(days=91)
        )

        with patch("django.conf.settings.HISTORY_RETENTION_DAYS", 90):
            result = purge_old_history_records()

        assert result["status"] == "ok"
        assert result["deleted"]["TaskActivityEvent"] >= 1
        assert not TaskActivityEvent.objects.filter(pk=old.pk).exists()
        assert TaskActivityEvent.objects.filter(pk=recent.pk).exists()


# ---------------------------------------------------------------------------
# Task history API
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskHistoryAPI:
    def test_owner_can_read_history(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        task.name = "Updated"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200

    def test_viewer_can_read_history(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        viewer_membership: ProjectMembership,
    ) -> None:
        task.name = "Updated by someone"
        task.save()
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200

    def test_non_member_gets_403(
        self,
        outsider_client: APIClient,
        project: Project,
        task: Task,
    ) -> None:
        r = outsider_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 403

    def test_member_can_read_history_on_archived_project(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """History stays readable after archiving — IsProjectNotArchived is deliberately
        omitted so the audit trail survives the project's archived (read-only) state (#1006)."""
        task.name = "Updated before archive"
        task.save()
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200

    def test_unauthenticated_gets_401(
        self,
        project: Project,
        task: Task,
    ) -> None:
        r = APIClient().get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 401

    def test_diff_contains_changed_field(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        task.duration = 99
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200
        results = r.data.get("results", r.data)
        # Most recent record should contain the duration change.
        assert any(
            d["field"] == "duration" and d["new"] == "99"
            for record in results
            for d in record["diff"]
        )

    def test_owner_sees_history_user(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        task._history_user = owner  # type: ignore[attr-defined]
        task.name = "Name change"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        # At least one record should have history_user populated.
        assert any(record.get("history_user") is not None for record in results)

    def test_viewer_sees_null_history_user_for_programmatic_write(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        viewer_membership: ProjectMembership,
    ) -> None:
        """A write with no ``_history_user`` records a null author, so the feed shows null.

        This is authorless-write behavior, NOT a role gate — the actor is null because
        the write had no request user, not because the viewer's role hid it. The
        populated-author case (a Viewer DOES see the actor) is asserted below; the two
        together pin down ADR-0394/#1881 policy (a): actors are visible to all members.
        """
        task.name = "No author set"
        task.save()
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        assert all(record.get("history_user") is None for record in results)

    def test_viewer_sees_populated_history_user(
        self,
        viewer_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        viewer_membership: ProjectMembership,
    ) -> None:
        """ADR-0394/#1881 policy (a): a Viewer sees the actor of a populated-author write.

        The prior ``..._for_programmatic_write`` test only exercised a null author and so
        gave false confidence that an Admin+ gate existed on this endpoint. It does not:
        the per-task activity feed aligns with the board feed (ADR-0160) and shows the
        actor to every member.
        """
        task._history_user = owner  # type: ignore[attr-defined]
        task.name = "Authored change"
        task.save()
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        assert any(record.get("history_user") is not None for record in results)
        # history_user_display resolves to the actor's full name for the viewer too.
        assert any(record.get("history_user_display") == "Owen" for record in results)

    def test_cpm_fields_absent_from_diff(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """CPM field updates via bulk_update must not appear in the diff."""
        Task.objects.filter(pk=task.pk).update(early_start=date(2026, 3, 1))
        task.name = "Trigger a save"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        cpm_fields = {
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
        }
        for record in results:
            diff_fields = {d["field"] for d in record["diff"]}
            assert not cpm_fields & diff_fields, (
                f"CPM field(s) {cpm_fields & diff_fields} appeared in diff"
            )

    def test_diff_surfaces_previously_unlisted_tracked_field(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """Allow-by-exclusion (ADR-0096 Part 1): a tracked field outside the old
        11-field allow-list (here ``story_points``) now renders a real diff
        instead of a bare 'Updated' pill with no rows."""
        task.story_points = 8
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        assert any(
            d["field"] == "story_points" and d["new"] == "8"
            for record in results
            for d in record["diff"]
        )

    def test_diff_resolves_fk_to_human_label(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner: object,
        owner_membership: ProjectMembership,
    ) -> None:
        """FK diff values resolve to a human-readable label, never a raw id."""
        task.assignee = owner  # type: ignore[assignment]
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        expected = owner.get_full_name() or owner.get_username()  # type: ignore[attr-defined]
        assignee_diffs = [
            d for record in results for d in record["diff"] if d["field"] == "assignee"
        ]
        assert assignee_diffs, "assignee change missing from history diff"
        assert assignee_diffs[0]["new"] == expected
        assert assignee_diffs[0]["new"] != str(owner.pk)  # type: ignore[attr-defined]

    def test_empty_change_record_is_stripped(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """A '~' record whose only change is a display-excluded field (here the
        transient ``sprint_pending`` flag) is omitted — the bare 'Updated' pill
        never reaches the client. Creation (+) records are always kept."""
        task.sprint_pending = True
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        assert all(record["history_type"] != "~" for record in results)
        assert not any(d["field"] == "sprint_pending" for record in results for d in record["diff"])

    def test_blocked_reason_never_leaks_into_diff(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """blocked_reason is contributor-private (read-gated to the assignee +
        @-mentioned users in the serializer — the Morgan surveillance boundary).
        Widening the history diff must NOT leak it to other members; the owner
        here is neither the assignee nor mentioned."""
        task.blocked_reason = "Waiting on the vendor — internal note"
        task.name = "Renamed too"  # a non-excluded change keeps the record present
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        all_fields = {d["field"] for record in results for d in record["diff"]}
        assert "blocked_reason" not in all_fields
        assert "name" in all_fields  # the record itself survived (only the field is gated)
        assert not any(
            "vendor" in (d.get("new") or "") for record in results for d in record["diff"]
        )

    def test_history_user_display_prefers_full_name(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """history_user_display carries the full name (#1878) while history_user
        stays the bare username (backward compat)."""
        task._history_user = owner  # type: ignore[attr-defined]
        task.name = "Named change"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data["results"]
        attributed = [rec for rec in results if rec["history_user"] is not None]
        assert attributed, "expected an attributed history record"
        assert attributed[0]["history_user"] == "owner"
        assert attributed[0]["history_user_display"] == "Owen"

    def test_history_user_display_falls_back_to_username(
        self,
        owner_client: APIClient,
        viewer: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """A user with no name set falls back to the username in the display field."""
        task._history_user = viewer  # type: ignore[attr-defined]
        task.name = "Anon-named change"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data["results"]
        attributed = [rec for rec in results if rec["history_user"] is not None]
        assert attributed, "expected an attributed history record"
        assert attributed[0]["history_user_display"] == "viewer"

    def test_history_user_display_null_for_programmatic_writes(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """No _history_user on the save => both identity fields are null."""
        task.name = "Programmatic change"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        for rec in r.data["results"]:
            assert rec["history_user"] is None
            assert rec["history_user_display"] is None

    def test_sprint_rank_change_produces_no_diff_row(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """sprint_rank is sprint-backlog reorder bookkeeping (#1885): a rank-only
        change record is dropped entirely — no bare 'Updated' pill, no diff row."""
        task.sprint_rank = 3
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data["results"]
        assert all(record["history_type"] != "~" for record in results)
        assert not any(d["field"] == "sprint_rank" for record in results for d in record["diff"])


# ---------------------------------------------------------------------------
# Project history API
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectHistoryAPI:
    def test_returns_project_level_changes(
        self,
        owner_client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        project.description = "Updated description"
        project.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/history/")
        assert r.status_code == 200
        results = r.data.get("results", r.data)
        assert any(d["field"] == "description" for record in results for d in record["diff"])

    def test_non_member_gets_403(self, outsider_client: APIClient, project: Project) -> None:
        r = outsider_client.get(f"/api/v1/projects/{project.pk}/history/")
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# History summary API
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHistorySummaryAPI:
    def test_returns_summary(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        task.name = "Changed"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/history/summary/?window=7d")
        assert r.status_code == 200
        assert "total_mutations" in r.data
        assert "by_object_type" in r.data
        assert "generated_at" in r.data
        # History rows are capped per object type (#821); the flag tells the client
        # whether the summary is complete. A handful of rows is well under the cap.
        assert r.data["count_truncated"] is False

    def test_invalid_window_returns_400(
        self,
        owner_client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        r = owner_client.get(f"/api/v1/projects/{project.pk}/history/summary/?window=bad")
        assert r.status_code == 400

    def test_non_member_gets_403(self, outsider_client: APIClient, project: Project) -> None:
        r = outsider_client.get(f"/api/v1/projects/{project.pk}/history/summary/?window=7d")
        assert r.status_code == 403

    def test_cache_bust_with_refresh_param(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """?refresh=1 should bypass cache and return a fresh generated_at."""
        r1 = owner_client.get(f"/api/v1/projects/{project.pk}/history/summary/?window=7d")
        task.name = "Another change"
        task.save()
        r2 = owner_client.get(f"/api/v1/projects/{project.pk}/history/summary/?window=7d&refresh=1")
        assert r2.status_code == 200
        # ?refresh=1 must recompute, not serve the cached payload. A regressed
        # refresh returns the *identical* cached response, whose generated_at equals
        # r1's — so `>=` would silently pass. Assert a strictly newer timestamp AND
        # that total_mutations grew by the interleaved task.save (the cached copy
        # was computed before it), which proves the recompute actually happened.
        assert r2.data["generated_at"] > r1.data["generated_at"]
        assert r2.data["total_mutations"] > r1.data["total_mutations"]


# ---------------------------------------------------------------------------
# History cap (perf-check finding #1318)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHistoryCap:
    """Verify _MAX_HISTORY_ROWS cap behaviour for TaskHistoryListView and
    ProjectHistoryListView (perf-check finding #1318)."""

    def test_task_history_cap_not_triggered_on_small_set(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """With fewer rows than the cap, count_truncated is False."""
        task.name = "Pass 1"
        task.save()
        task.name = "Pass 2"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200
        assert r.data.get("count_truncated") is False

    def test_project_history_cap_not_triggered_on_small_set(
        self,
        owner_client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        """With fewer rows than the cap, count_truncated is False."""
        project.description = "First update"
        project.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/history/")
        assert r.status_code == 200
        assert r.data.get("count_truncated") is False

    def test_task_history_cap_activates_when_exceeded(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """When the cap is artificially set to 1 and 2 records exist,
        count_truncated must be True and only 1 row is returned."""
        from unittest.mock import patch

        # Generate 2 records (create + one update).
        task.name = "Updated name"
        task.save()

        with patch("trueppm_api.apps.projects.views._MAX_HISTORY_ROWS", 1):
            r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200
        assert r.data.get("count_truncated") is True

    def test_task_history_oldest_kept_record_still_renders_diff_when_truncated(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """Cap-boundary regression (#1889): the one-past-the-cap row is kept as a
        diff seed, so the oldest kept '~' record still gets a real diff instead of
        an empty one (which the bare-'Updated' filter would silently drop)."""
        task.name = "Rev 1"
        task.save()
        task.name = "Rev 2"
        task.save()
        task.name = "Rev 3"
        task.save()  # 4 records total: create + 3 updates

        with patch("trueppm_api.apps.projects.views._MAX_HISTORY_ROWS", 2):
            r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200
        assert r.data["count_truncated"] is True
        results = r.data["results"]
        # Both kept records (Rev 3 and Rev 2) must survive with a rendered diff —
        # before the fix, Rev 2 (the cap-boundary record) had no older row, produced
        # an empty diff, and vanished from the feed.
        assert len(results) == 2
        name_news = [d["new"] for record in results for d in record["diff"] if d["field"] == "name"]
        assert name_news == ["Rev 3", "Rev 2"]

    def test_project_history_oldest_kept_record_still_renders_diff_when_truncated(
        self,
        owner_client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        """Same cap-boundary seed fix (#1889) for the history app's
        ProjectHistoryListView (_compute_diffs receives the untrimmed batch)."""
        project.description = "Rev 1"
        project.save()
        project.description = "Rev 2"
        project.save()
        project.description = "Rev 3"
        project.save()  # 4 records total: create + 3 updates

        with patch("trueppm_api.apps.history.views._MAX_HISTORY_ROWS", 2):
            r = owner_client.get(f"/api/v1/projects/{project.pk}/history/")
        assert r.status_code == 200
        assert r.data["count_truncated"] is True
        results = r.data["results"]
        desc_news = [
            d["new"] for record in results for d in record["diff"] if d["field"] == "description"
        ]
        assert desc_news == ["Rev 3", "Rev 2"]


# ---------------------------------------------------------------------------
# Task activity feed — opt-in ?include= sources (issue #413)
# ---------------------------------------------------------------------------


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw", first_name="Mia")


@pytest.fixture
def member_membership(member: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)


@pytest.mark.django_db
class TestTaskActivityInclude:
    """The ?include= param merges comments / time / attachments into the feed.

    Backward compatibility is the load-bearing invariant: without ?include the
    response is byte-identical to the legacy field-diff feed.
    """

    def test_include_absent_is_backward_compatible(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """No include => legacy shape only, no unified fields leak in."""
        from trueppm_api.apps.projects.models import TaskComment

        TaskComment.objects.create(task=task, author=None, body="hi")
        task.name = "Updated"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert r.status_code == 200
        results = r.data["results"]
        # Comments must NOT appear, and no unified keys are present.
        for rec in results:
            assert "event_type" not in rec
            assert set(rec.keys()) == {
                "id",
                "history_date",
                "history_type",
                "history_user",
                "history_user_display",
                "diff",
            }

    def test_invalid_include_returns_400(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=bogus"
        )
        assert r.status_code == 400
        assert "bogus" in r.data["detail"]

    def test_diff_events_retain_legacy_keys_with_include(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """A field-diff entry keeps its legacy keys AND gains the unified shape."""
        task._history_user = owner  # type: ignore[attr-defined]
        task.duration = 42
        task.save()
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=comments"
        )
        assert r.status_code == 200
        diff_events = [e for e in r.data["results"] if e.get("event_type") == "fields_changed"]
        assert diff_events, "expected a fields_changed diff entry"
        e = diff_events[0]
        # Legacy keys unchanged.
        assert e["history_type"] == "~"
        assert any(d["field"] == "duration" for d in e["diff"])
        # Unified shape present.
        assert e["actor"]["display_name"] == "Owen"
        assert e["detail"]["diff"] == e["diff"]
        assert e["timestamp"] == e["history_date"]

    def test_comment_added_edited_deleted_events(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        from trueppm_api.apps.projects.models import TaskComment

        added = TaskComment.objects.create(task=task, author=owner, body="first comment")
        edited = TaskComment.objects.create(task=task, author=owner, body="edited comment")
        edited.edited_at = timezone.now()
        edited.save(update_fields=["edited_at"])
        deleted = TaskComment.objects.create(task=task, author=owner, body="secret body")
        deleted.soft_delete(actor=owner)

        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=comments"
        )
        assert r.status_code == 200
        by_type: dict[str, list] = {}
        for e in r.data["results"]:
            by_type.setdefault(e.get("event_type", ""), []).append(e)

        assert any(e["detail"]["comment_id"] == str(added.id) for e in by_type["comment_added"])
        assert any(e["detail"]["comment_id"] == str(edited.id) for e in by_type["comment_edited"])
        assert any(e["detail"]["comment_id"] == str(deleted.id) for e in by_type["comment_deleted"])
        # Actor is resolved.
        assert by_type["comment_added"][0]["actor"]["display_name"] == "Owen"
        # A deleted comment must not resurface its body as a preview.
        del_event = next(
            e for e in by_type["comment_deleted"] if e["detail"]["comment_id"] == str(deleted.id)
        )
        assert "preview" not in del_event["detail"]

    def test_time_logged_scoped_to_requesting_user(
        self,
        owner_client: APIClient,
        owner: object,
        member: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
        member_membership: ProjectMembership,
    ) -> None:
        """Time entries are private to their logger — the feed never leaks another
        member's hours (security: TaskTimeEntryView filters user=request.user)."""
        from trueppm_api.apps.timetracking.models import TimeEntry

        mine = TimeEntry.objects.create(task=task, user=owner, minutes=30, note="mine")
        theirs = TimeEntry.objects.create(task=task, user=member, minutes=90, note="theirs")

        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=time")
        assert r.status_code == 200
        time_events = [e for e in r.data["results"] if e.get("event_type") == "time_logged"]
        ids = {e["detail"]["time_entry_id"] for e in time_events}
        assert str(mine.id) in ids
        assert str(theirs.id) not in ids
        assert time_events[0]["detail"]["minutes"] == 30

    def test_time_soft_delete_keeps_logged_and_adds_deleted_event(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """A soft-deleted time entry keeps its time_logged event and gains a
        time_deleted event from deleted_at (#1888) — logged hours must leave a
        trace when revised or removed (EVM/billing integrity). Legacy rows with no
        deleted_at contribute only the retained log event, mirroring attachments."""
        from trueppm_api.apps.timetracking.models import TimeEntry

        deleted = TimeEntry.objects.create(task=task, user=owner, minutes=45, note="scrapped")
        deleted.soft_delete(actor=owner)
        # Legacy soft-delete (before deleted_at existed): flag only, no timestamp.
        legacy = TimeEntry.objects.create(task=task, user=owner, minutes=15, note="old")
        legacy.is_deleted = True
        legacy.save(update_fields=["is_deleted"])
        live = TimeEntry.objects.create(task=task, user=owner, minutes=60, note="kept")

        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=time")
        assert r.status_code == 200
        results = r.data["results"]
        logged_ids = {
            e["detail"]["time_entry_id"] for e in results if e.get("event_type") == "time_logged"
        }
        # Every entry — deleted, legacy, live — keeps its time_logged event.
        assert {str(deleted.id), str(legacy.id), str(live.id)} <= logged_ids

        deleted_events = [e for e in results if e.get("event_type") == "time_deleted"]
        assert len(deleted_events) == 1  # legacy row has no deleted_at to anchor one
        ev = deleted_events[0]
        assert ev["detail"]["time_entry_id"] == str(deleted.id)
        assert ev["detail"]["minutes"] == 45
        assert ev["actor"]["display_name"] == "Owen"
        # The note is intentionally omitted — the entry is gone, don't resurface it.
        assert "note" not in ev["detail"]

    def test_time_deleted_stays_scoped_to_requesting_user(
        self,
        owner_client: APIClient,
        owner: object,
        member: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
        member_membership: ProjectMembership,
    ) -> None:
        """Including soft-deleted entries must not widen the privacy boundary:
        another member's deleted entry yields no time_deleted event in my feed."""
        from trueppm_api.apps.timetracking.models import TimeEntry

        theirs = TimeEntry.objects.create(task=task, user=member, minutes=90, note="theirs")
        theirs.soft_delete(actor=member)

        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=time")
        assert r.status_code == 200
        deleted_ids = {
            e["detail"]["time_entry_id"]
            for e in r.data["results"]
            if e.get("event_type") == "time_deleted"
        }
        assert str(theirs.id) not in deleted_ids

    def test_attachment_uploaded_and_null_actor(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        from trueppm_api.apps.projects.models import TaskAttachment

        with_actor = TaskAttachment.objects.create(
            task=task,
            external_url="https://example.com/doc",
            external_title="Spec",
            uploaded_by=owner,
        )
        # uploaded_by NULL exercises the authorless/system actor=null contract.
        authorless = TaskAttachment.objects.create(
            task=task,
            external_url="https://example.com/auto",
            external_title="Auto",
            uploaded_by=None,
        )
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=attachments"
        )
        assert r.status_code == 200
        events = {
            e["detail"]["attachment_id"]: e
            for e in r.data["results"]
            if e.get("event_type") == "attachment_uploaded"
        }
        assert events[str(with_actor.id)]["actor"]["display_name"] == "Owen"
        assert events[str(with_actor.id)]["detail"]["label"] == "Spec"
        assert events[str(authorless.id)]["actor"] is None

    def test_attachment_soft_delete_keeps_upload_and_adds_deleted_event(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """The feed is append-only (#1879): a soft-deleted attachment keeps its
        attachment_uploaded event and gains an attachment_deleted event; legacy
        rows with no deleted_at contribute only the retained upload event."""
        from trueppm_api.apps.projects.models import TaskAttachment

        deleted = TaskAttachment.objects.create(
            task=task,
            external_url="https://example.com/gone",
            external_title="Gone doc",
            uploaded_by=owner,
        )
        deleted.soft_delete(actor=owner)
        # Legacy soft-delete (before deleted_at existed): flag only, no timestamp.
        legacy = TaskAttachment.objects.create(
            task=task,
            external_url="https://example.com/old",
            external_title="Old doc",
            uploaded_by=owner,
        )
        legacy.is_deleted = True
        legacy.save(update_fields=["is_deleted"])

        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=attachments"
        )
        assert r.status_code == 200
        results = r.data["results"]
        uploaded_ids = {
            e["detail"]["attachment_id"]
            for e in results
            if e.get("event_type") == "attachment_uploaded"
        }
        # Both soft-deleted rows keep their upload event.
        assert str(deleted.id) in uploaded_ids
        assert str(legacy.id) in uploaded_ids

        deleted_events = [e for e in results if e.get("event_type") == "attachment_deleted"]
        assert len(deleted_events) == 1  # legacy row has no deleted_at to anchor one
        ev = deleted_events[0]
        assert ev["detail"]["attachment_id"] == str(deleted.id)
        assert ev["detail"]["kind"] == "url"
        assert ev["detail"]["label"] == "Gone doc"
        assert ev["actor"]["display_name"] == "Owen"

    def test_merged_feed_sorted_newest_first(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        from trueppm_api.apps.projects.models import TaskComment

        task.name = "Renamed early"
        task.save()
        # Comment happens after the task edit, so it must sort first.
        TaskComment.objects.create(task=task, author=owner, body="latest event")

        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=all")
        assert r.status_code == 200
        results = r.data["results"]
        timestamps = [e["timestamp"] for e in results]
        assert timestamps == sorted(timestamps, reverse=True)
        assert results[0]["event_type"] == "comment_added"

    def test_include_all_empty_sources_returns_only_diffs(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """No comments/time/attachments => feed is just the diff events, still unified."""
        task.name = "Only a diff"
        task.save()
        r = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=all")
        assert r.status_code == 200
        results = r.data["results"]
        assert all(e["event_type"] in {"task_created", "fields_changed"} for e in results)
        assert all("event_type" in e and "actor" in e for e in results)

    # --- schedule + risks tokens (ADR-0207, #1604) ---

    def test_schedule_token_surfaces_system_events_with_null_actor(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """?include=schedule surfaces cpm_recalculated + baseline_drift_detected, actor null."""
        from trueppm_api.apps.projects.models import TaskActivityEvent

        TaskActivityEvent.objects.create(
            task=task,
            actor=None,
            event_type="cpm_recalculated",
            detail={"early_finish": {"from": "2026-01-01", "to": "2026-01-05"}},
        )
        TaskActivityEvent.objects.create(
            task=task,
            actor=None,
            event_type="baseline_drift_detected",
            detail={"drift_days": 4, "baseline_finish": "2026-01-01"},
        )
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=schedule"
        )
        assert r.status_code == 200
        by_type = {e.get("event_type"): e for e in r.data["results"]}
        assert "cpm_recalculated" in by_type
        assert "baseline_drift_detected" in by_type
        # System events carry a null actor and pass detail through verbatim.
        assert by_type["cpm_recalculated"]["actor"] is None
        assert by_type["cpm_recalculated"]["detail"]["early_finish"]["to"] == "2026-01-05"
        assert by_type["baseline_drift_detected"]["detail"]["drift_days"] == 4

    def test_risks_token_surfaces_link_events_with_actor(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """?include=risks surfaces risk_linked / risk_unlinked with the acting member."""
        from trueppm_api.apps.projects.models import TaskActivityEvent

        TaskActivityEvent.objects.create(
            task=task,
            actor=owner,
            event_type="risk_linked",
            detail={"risk_id": "r1", "risk_short_id": "R-1", "risk_title": "Vendor slip"},
        )
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=risks"
        )
        assert r.status_code == 200
        linked = [e for e in r.data["results"] if e.get("event_type") == "risk_linked"]
        assert linked
        assert linked[0]["actor"]["display_name"] == "Owen"
        assert linked[0]["detail"]["risk_short_id"] == "R-1"

    def test_schedule_token_excludes_risk_events(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """Each token selects only its own event_type subset (no cross-leak)."""
        from trueppm_api.apps.projects.models import TaskActivityEvent

        TaskActivityEvent.objects.create(task=task, actor=None, event_type="cpm_recalculated")
        TaskActivityEvent.objects.create(task=task, actor=owner, event_type="risk_linked")
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=schedule"
        )
        assert r.status_code == 200
        types = {e.get("event_type") for e in r.data["results"]}
        assert "cpm_recalculated" in types
        assert "risk_linked" not in types

    def test_new_tokens_are_valid_and_backward_compatible(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """schedule/risks tokens validate; absent-include stays byte-identical."""
        from trueppm_api.apps.projects.models import TaskActivityEvent

        TaskActivityEvent.objects.create(task=task, actor=None, event_type="cpm_recalculated")
        combined = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=schedule,risks"
        )
        assert combined.status_code == 200
        # Without include, the new rows never leak into the legacy diff feed.
        legacy = owner_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        assert legacy.status_code == 200
        assert all("event_type" not in rec for rec in legacy.data["results"])


@pytest.mark.django_db
class TestTaskActivityKeyset:
    """Keyset pagination (`until` / `page_size`) on the include= merged feed (#1882).

    The bare no-include feed must stay byte-identical (offset envelope, no new
    keys); the keyset params are only valid together with `include`.
    """

    def _url(self, project: Project, task: Task) -> str:
        return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/"

    def _seed_mixed_feed(self, owner: object, task: Task) -> int:
        """Seed a mixed feed (history + comments + attachment) with distinct,
        interleaved timestamps. Returns the expected event count (6)."""
        from trueppm_api.apps.projects.models import TaskAttachment, TaskComment

        task.name = "Rename one"
        task.save()
        task.name = "Rename two"
        task.save()
        c1 = TaskComment.objects.create(task=task, author=owner, body="first")
        c2 = TaskComment.objects.create(task=task, author=owner, body="second")
        att = TaskAttachment.objects.create(
            task=task,
            external_url="https://example.com/doc",
            external_title="Spec",
            uploaded_by=owner,
        )

        # Deterministically space + interleave the timestamps across the sources so
        # the keyset walk exercises real cross-source page boundaries (auto_now_add
        # stamps are bypassed via .update() / direct save on the historical rows).
        base = timezone.now() - timedelta(hours=1)
        history_rows = list(task.history.order_by("history_date"))  # type: ignore[attr-defined]
        assert len(history_rows) == 3  # create + two renames
        for i, row in enumerate(history_rows):
            row.history_date = base + timedelta(minutes=2 * i)  # minutes 0, 2, 4
            row.save(update_fields=["history_date"])
        TaskComment.objects.filter(pk=c1.pk).update(created_at=base + timedelta(minutes=1))
        TaskComment.objects.filter(pk=c2.pk).update(created_at=base + timedelta(minutes=5))
        TaskAttachment.objects.filter(pk=att.pk).update(created_at=base + timedelta(minutes=3))
        return 6

    def test_keyset_walk_returns_every_event_exactly_once(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """Walking next_until over a mixed feed yields each event exactly once
        (distinct timestamps), newest-first, and null next_until on exhaustion."""
        expected = self._seed_mixed_feed(owner, task)

        until: str | None = (timezone.now() + timedelta(days=1)).isoformat()
        seen: list[tuple[str, str]] = []
        pages = 0
        while until is not None:
            r = owner_client.get(
                self._url(project, task),
                {"include": "all", "page_size": 2, "until": until},
            )
            assert r.status_code == 200
            # Keyset envelope: no offset concepts (count/next/previous).
            assert set(r.data.keys()) == {"results", "next_until", "count_truncated"}
            assert len(r.data["results"]) <= 2
            seen.extend((e["event_type"], e["timestamp"]) for e in r.data["results"])
            until = r.data["next_until"]
            pages += 1
            assert pages <= expected  # safety against a cursor loop

        assert len(seen) == expected
        assert len(set(seen)) == expected  # exactly once, no repeats
        timestamps = [ts for _, ts in seen]
        assert timestamps == sorted(timestamps, reverse=True)
        from collections import Counter

        assert Counter(t for t, _ in seen) == Counter(
            {
                "fields_changed": 2,
                "comment_added": 2,
                "task_created": 1,
                "attachment_uploaded": 1,
            }
        )

    def test_next_until_null_when_window_exhausted(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """Fewer than page_size+1 events older than until => next_until is null."""
        until = (timezone.now() + timedelta(days=1)).isoformat()
        r = owner_client.get(self._url(project, task), {"include": "all", "until": until})
        assert r.status_code == 200
        # Only the task_created history row exists — well under the default 20.
        assert r.data["next_until"] is None
        assert r.data["count_truncated"] is False

    def test_until_without_include_returns_400(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        r = owner_client.get(self._url(project, task), {"until": timezone.now().isoformat()})
        assert r.status_code == 400
        assert "include" in r.data["detail"]

    def test_page_size_without_include_returns_400(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        r = owner_client.get(self._url(project, task), {"page_size": "10"})
        assert r.status_code == 400
        assert "include" in r.data["detail"]

    def test_invalid_until_datetime_returns_400(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        r = owner_client.get(
            self._url(project, task), {"include": "all", "until": "not-a-datetime"}
        )
        assert r.status_code == 400
        assert "until" in r.data["detail"]

    def test_until_mode_ignores_page_param(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """`page` is an offset concept — in keyset mode it must be ignored (the
        offset paginator would 404 on an out-of-range page)."""
        until = (timezone.now() + timedelta(days=1)).isoformat()
        r = owner_client.get(
            self._url(project, task), {"include": "all", "until": until, "page": "99"}
        )
        assert r.status_code == 200
        assert r.data["results"]  # task_created is returned despite page=99
        assert "count" not in r.data

    def test_no_include_envelope_unchanged(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """The bare feed keeps the exact offset envelope — no next_until leak."""
        r = owner_client.get(self._url(project, task))
        assert r.status_code == 200
        assert set(r.data.keys()) == {"count", "next", "previous", "results", "count_truncated"}

    def test_include_offset_mode_carries_next_until(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        """Offset mode with include stays offset-shaped but additively exposes
        next_until, so a client can hop to keyset paging mid-stream."""
        self._seed_mixed_feed(owner, task)

        r = owner_client.get(self._url(project, task), {"include": "all", "page_size": 2})
        assert r.status_code == 200
        # Offset envelope retained, plus the additive keyset resume point.
        assert {"count", "next", "previous", "results", "count_truncated"} <= set(r.data.keys())
        assert r.data["next"] is not None
        assert r.data["next_until"] == r.data["results"][-1]["timestamp"]

        # Resuming via keyset from the offset page returns strictly older events.
        r2 = owner_client.get(
            self._url(project, task),
            {"include": "all", "page_size": 2, "until": r.data["next_until"]},
        )
        assert r2.status_code == 200
        assert all(e["timestamp"] < r.data["next_until"] for e in r2.data["results"])

        # The last offset page reports next_until null (nothing older).
        last = owner_client.get(
            self._url(project, task), {"include": "all", "page_size": 2, "page": "3"}
        )
        assert last.status_code == 200
        assert last.data["next"] is None
        assert last.data["next_until"] is None


@pytest.mark.django_db
class TestDependencyActivityStream:
    """?include=dependencies surfaces dependency add/remove for edges touching a task.

    Dependency IS history-tracked, so events are read from HistoricalDependency:
    a `+` create row → dependency_added; a `~` row where is_deleted flips True →
    dependency_removed (soft_delete writes `~`, never `-`). See ADR-0394 / #1887.
    """

    def _url(self, project: Project, task: Task) -> str:
        return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=dependencies"

    def test_added_event_surfaces_with_direction_and_label(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        task2: Task,
        dep: Dependency,
        owner_membership: ProjectMembership,
    ) -> None:
        # task is the predecessor of the FS edge, so the OTHER task (task2) is downstream.
        r = owner_client.get(self._url(project, task))
        assert r.status_code == 200
        added = [e for e in r.data["results"] if e.get("event_type") == "dependency_added"]
        assert added, "dependency_added missing from the feed"
        detail = added[0]["detail"]
        assert detail["dep_type"] == "FS"
        assert detail["direction"] == "successor"  # other task is downstream of this one
        assert detail["other_task_id"] == str(task2.pk)
        assert detail["other_task_name"] == "Build"
        assert detail["dependency_id"] == str(dep.pk)

    def test_direction_is_predecessor_from_the_successor_side(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        task2: Task,
        dep: Dependency,
        owner_membership: ProjectMembership,
    ) -> None:
        # Reading task2's feed: task2 is the successor, so the other task is upstream.
        r = owner_client.get(self._url(project, task2))
        assert r.status_code == 200
        added = [e for e in r.data["results"] if e.get("event_type") == "dependency_added"]
        assert added
        assert added[0]["detail"]["direction"] == "predecessor"
        assert added[0]["detail"]["other_task_name"] == "Design"

    def test_soft_delete_emits_dependency_removed(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        dep: Dependency,
        owner_membership: ProjectMembership,
    ) -> None:
        dep._history_user = owner  # type: ignore[attr-defined]
        dep.soft_delete()
        r = owner_client.get(self._url(project, task))
        assert r.status_code == 200
        types = [e.get("event_type") for e in r.data["results"]]
        assert "dependency_removed" in types
        assert "dependency_added" in types  # the original create still shows
        removed = next(e for e in r.data["results"] if e["event_type"] == "dependency_removed")
        assert removed["actor"] is not None
        assert removed["actor"]["display_name"] == "Owen"

    def test_plain_field_edit_emits_no_dependency_event(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        dep: Dependency,
        owner_membership: ProjectMembership,
    ) -> None:
        # A lag edit is a `~` row with is_deleted unchanged (False) — not a transition.
        dep.lag = 3
        dep.save()
        r = owner_client.get(self._url(project, task))
        assert r.status_code == 200
        # Exactly one dependency_added (the create); the lag edit adds no event.
        added = [e for e in r.data["results"] if e.get("event_type") == "dependency_added"]
        removed = [e for e in r.data["results"] if e.get("event_type") == "dependency_removed"]
        assert len(added) == 1
        assert len(removed) == 0

    def test_cross_project_far_task_name_is_redacted(
        self,
        viewer_client: APIClient,
        viewer: object,
        calendar: Calendar,
        project: Project,
        task: Task,
        viewer_membership: ProjectMembership,
    ) -> None:
        """ADR-0120 guard: the far endpoint's name is hidden when the caller cannot
        access its project — direction + dep_type are still shown."""
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        far_task = Task.objects.create(project=other_project, name="Secret Task", duration=1)
        # Edge from task (viewer's project) to far_task (a project viewer can't see).
        Dependency.objects.create(predecessor=task, successor=far_task, dep_type="FS")
        r = viewer_client.get(self._url(project, task))
        assert r.status_code == 200
        added = [e for e in r.data["results"] if e.get("event_type") == "dependency_added"]
        assert added
        detail = added[0]["detail"]
        assert detail["other_task_id"] == str(far_task.pk)
        assert detail["other_task_name"] is None  # name redacted across the boundary
        assert detail["direction"] == "successor"

    def test_far_task_name_shown_only_for_active_membership(
        self,
        viewer_client: APIClient,
        viewer: object,
        calendar: Calendar,
        project: Project,
        task: Task,
        viewer_membership: ProjectMembership,
    ) -> None:
        """A REVOKED (soft-deleted) far-project membership must not re-expose the name.

        Regression for the M1 revocation-bypass class: the membership guard filters
        is_deleted=False, so once the far-project membership is soft-deleted the name
        is redacted again even though the row persists.
        """
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        far_task = Task.objects.create(project=other_project, name="Secret Task", duration=1)
        Dependency.objects.create(predecessor=task, successor=far_task, dep_type="FS")

        far_membership = ProjectMembership.objects.create(
            project=other_project, user=viewer, role=Role.VIEWER
        )
        # Active membership → name is visible.
        r = viewer_client.get(self._url(project, task))
        added = [e for e in r.data["results"] if e.get("event_type") == "dependency_added"]
        assert added[0]["detail"]["other_task_name"] == "Secret Task"

        # Revoke (soft-delete) the membership → name is redacted again.
        far_membership.soft_delete()
        r = viewer_client.get(self._url(project, task))
        added = [e for e in r.data["results"] if e.get("event_type") == "dependency_added"]
        assert added[0]["detail"]["other_task_name"] is None


@pytest.mark.django_db
class TestResourceActivityStream:
    """?include=resources surfaces assignment add/remove/re-allocation events.

    TaskResource has no history (like RiskTask), so the events are read from
    TaskActivityEvent rows written by TaskResourceViewSet. See ADR-0394 / #1886.
    """

    def test_resources_token_surfaces_assignment_events(
        self,
        owner_client: APIClient,
        owner: object,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        from trueppm_api.apps.projects.models import TaskActivityEvent

        TaskActivityEvent.objects.create(
            task=task,
            actor=owner,
            event_type="assignee_added",
            detail={"resource_id": "r1", "resource_name": "Ada", "units": "1.00"},
        )
        TaskActivityEvent.objects.create(
            task=task,
            actor=owner,
            event_type="assignee_units_changed",
            detail={
                "resource_id": "r1",
                "resource_name": "Ada",
                "units": {"from": "1.00", "to": "0.50"},
            },
        )
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=resources"
        )
        assert r.status_code == 200
        types = {e.get("event_type") for e in r.data["results"]}
        assert "assignee_added" in types
        assert "assignee_units_changed" in types
        added = next(e for e in r.data["results"] if e["event_type"] == "assignee_added")
        assert added["detail"]["resource_name"] == "Ada"
        assert added["actor"]["display_name"] == "Owen"

    def test_resources_token_excludes_other_event_types(
        self,
        owner_client: APIClient,
        project: Project,
        task: Task,
        owner_membership: ProjectMembership,
    ) -> None:
        from trueppm_api.apps.projects.models import TaskActivityEvent

        TaskActivityEvent.objects.create(
            task=task, actor=None, event_type="cpm_recalculated", detail={}
        )
        r = owner_client.get(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/?include=resources"
        )
        assert r.status_code == 200
        assert all(e.get("event_type") != "cpm_recalculated" for e in r.data["results"])
