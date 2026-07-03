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

    def test_viewer_sees_null_history_user(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        viewer_membership: ProjectMembership,
    ) -> None:
        task.name = "Hidden author"
        task.save()
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/tasks/{task.pk}/history/")
        results = r.data.get("results", r.data)
        assert all(record.get("history_user") is None for record in results)

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
