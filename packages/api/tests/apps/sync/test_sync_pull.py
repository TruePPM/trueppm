"""Tests for the project delta sync pull endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk, Task
from trueppm_api.apps.sync.serializers import SyncTaskSerializer

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="sync_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="SyncProj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)


@pytest.fixture
def authed_client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sync/"


# ---------------------------------------------------------------------------
# Auth / permission
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_requires_auth(project: Project, membership: ProjectMembership) -> None:
    resp = APIClient().get(_url(project))
    assert resp.status_code == 401


@pytest.mark.django_db
def test_sync_requires_membership(project: Project) -> None:
    outsider = User.objects.create_user(username="out", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    resp = c.get(_url(project))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_sync_404_for_missing_project(authed_client: APIClient) -> None:
    import uuid

    resp = authed_client.get(f"/api/v1/projects/{uuid.uuid4()}/sync/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Response structure
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_response_shape(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    assert "changes" in resp.data
    assert "timestamp" in resp.data
    for key in ("projects", "tasks", "dependencies", "calendars", "memberships", "risks"):
        assert key in resp.data["changes"]
        bucket = resp.data["changes"][key]
        assert "created" in bucket
        assert "updated" in bucket
        assert "deleted" in bucket
        assert bucket["created"] == []  # always empty — upsert semantics


@pytest.mark.django_db
def test_sync_since_zero_returns_all_live_rows(
    authed_client: APIClient, project: Project, calendar: Calendar, membership: ProjectMembership
) -> None:
    task = Task.objects.create(project=project, name="T1", duration=2)
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=10,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert str(task.pk) in task_ids
    project_ids = [p["id"] for p in resp.data["changes"]["projects"]["updated"]]
    assert str(project.pk) in project_ids


@pytest.mark.django_db
def test_sync_soft_deleted_task_appears_in_deleted_list(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task = Task.objects.create(project=project, name="T2", duration=1)
    task.soft_delete()
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert str(task.pk) in resp.data["changes"]["tasks"]["deleted"]
    task_updated_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert str(task.pk) not in task_updated_ids


@pytest.mark.django_db
def test_sync_calendar_carries_nested_exceptions(
    authed_client: APIClient,
    project: Project,
    calendar: Calendar,
    membership: ProjectMembership,
) -> None:
    """Exceptions ride the calendar aggregate root inline on the sync delta (ADR-0194)."""
    from trueppm_api.apps.projects.models import CalendarException

    CalendarException.objects.create(
        calendar=calendar,
        exc_start=date(2026, 12, 25),
        exc_end=date(2026, 12, 26),
        description="Xmas",
    )
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=10,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    cals = resp.data["changes"]["calendars"]["updated"]
    assert len(cals) == 1
    exceptions = cals[0]["exceptions"]
    assert len(exceptions) == 1
    assert exceptions[0]["description"] == "Xmas"
    assert exceptions[0]["exc_start"] == "2026-12-25"
    assert exceptions[0]["exc_end"] == "2026-12-26"


@pytest.mark.django_db
def test_sync_invalid_since_returns_400(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    resp = authed_client.get(_url(project), {"since": "not-a-number"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_sync_delta_respects_since(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    # Both tasks start at server_version=1 on INSERT.
    task_a = Task.objects.create(project=project, name="A", duration=1)
    task_b = Task.objects.create(project=project, name="B", duration=1)
    assert task_a.server_version == 1
    assert task_b.server_version == 1

    # Update task_a only — it now has server_version=2.
    task_a.name = "A-modified"
    task_a.save()
    task_a.refresh_from_db()
    assert task_a.server_version == 2

    # A client that last synced at version=1 should see task_a (modified to v=2)
    # but not task_b (still at v=1, unchanged since the checkpoint).
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "1"})
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert str(task_a.pk) in task_ids
    assert str(task_b.pk) not in task_ids


# ---------------------------------------------------------------------------
# Risks in sync payload
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_includes_risks_bucket(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    assert "risks" in resp.data["changes"]
    bucket = resp.data["changes"]["risks"]
    assert "created" in bucket
    assert "updated" in bucket
    assert "deleted" in bucket
    assert bucket["created"] == []


@pytest.mark.django_db
def test_sync_returns_live_risks(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    risk = Risk.objects.create(project=project, title="Budget overrun", probability=3, impact=4)
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    risk_ids = [r["id"] for r in resp.data["changes"]["risks"]["updated"]]
    assert str(risk.pk) in risk_ids


@pytest.mark.django_db
def test_sync_risk_payload_includes_task_ids(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task = Task.objects.create(project=project, name="T1", duration=2)
    risk = Risk.objects.create(project=project, title="Schedule slip", probability=2, impact=5)
    risk.tasks.set([task])
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    risk_data = next(r for r in resp.data["changes"]["risks"]["updated"] if r["id"] == str(risk.pk))
    assert str(task.pk) in risk_data["task_ids"]


# ---------------------------------------------------------------------------
# SyncTaskSerializer field contract
#
# Regression guard: #80 added actual_start/actual_finish to TaskSerializer but
# missed SyncTaskSerializer (fixed in #90). These assertions ensure future
# refactors cannot silently drop mobile-visible fields.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_task_payload_includes_actual_and_milestone_fields(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task = Task.objects.create(
        project=project,
        name="Done task",
        duration=2,
        actual_start=date(2026, 2, 1),
        actual_finish=date(2026, 2, 3),
        is_milestone=False,
    )
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    payload = next(t for t in resp.data["changes"]["tasks"]["updated"] if t["id"] == str(task.pk))
    assert payload["actual_start"] == "2026-02-01"
    assert payload["actual_finish"] == "2026-02-03"
    assert payload["is_milestone"] is False


def test_sync_task_serializer_declares_required_mobile_fields() -> None:
    """Schema guard: if a field here is dropped, this test fails immediately
    instead of silently breaking the mobile pull."""
    declared = set(SyncTaskSerializer.Meta.fields)
    required = {
        "id",
        "server_version",
        "actual_start",
        "actual_finish",
        "is_milestone",
        "planned_start",
        "early_start",
        "early_finish",
        "status",
        "percent_complete",
    }
    missing = required - declared
    assert not missing, f"SyncTaskSerializer is missing mobile-critical fields: {missing}"


# ---------------------------------------------------------------------------
# Cursor pagination (#1013)
#
# server_version is a PER-ROW edit counter, not a global sequence: on cold start
# every freshly created row shares server_version=1. The pager therefore keysets
# on (collection_index, server_version, id) so a page boundary can fall between
# two rows of the same version without skipping or duplicating any. These tests
# prove: pages are bounded by page_size, contiguous, non-overlapping, and
# reassemble to the full delta — and that an incremental (since>0) pull still
# paginates correctly.
# ---------------------------------------------------------------------------

from itertools import count as _count  # noqa: E402

from trueppm_api.apps.sync.pagination import SyncCursor  # noqa: E402

# Monotonic short_id source so repeated _seed_tasks calls in one test never
# collide on the per-project (project_id, short_id) unique constraint.
_short_id_seq = _count(1)


def _seed_tasks(project: Project, count: int, *, server_version: int = 1) -> list[str]:
    """Bulk-insert ``count`` tasks at a fixed server_version; return their id strings.

    bulk_create bypasses ``VersionedModel.save`` (which would set server_version=1
    and allocate short_id), so both are set explicitly: server_version so the rows
    clear the ``server_version__gt=since`` floor, and a unique short_id so the
    per-project unique constraint is satisfied.
    """
    tasks = [
        Task(
            project=project,
            name=f"T{n}",
            short_id=f"T{n}",
            duration=1,
            server_version=server_version,
        )
        for n in (next(_short_id_seq) for _ in range(count))
    ]
    Task.objects.bulk_create(tasks)
    return [str(t.pk) for t in tasks]


def _drain(
    client: APIClient, project: Project, *, since: str, page_size: int
) -> tuple[list[tuple[str, str]], int]:
    """Loop the paginated pull to exhaustion.

    Returns ``(emitted, page_count)`` where ``emitted`` is every
    ``(collection, id)`` pair delivered across all pages (updated + deleted), in
    delivery order. Asserts each page is bounded by ``page_size``.
    """
    emitted: list[tuple[str, str]] = []
    cursor: str | None = None
    pages = 0
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=1,
    ):
        while True:
            params = {"since": since, "page_size": str(page_size)}
            if cursor is not None:
                params["cursor"] = cursor
            resp = client.get(_url(project), params)
            assert resp.status_code == 200, resp.data
            page_rows = 0
            for collection, bucket in resp.data["changes"].items():
                for row in bucket["updated"]:
                    emitted.append((collection, row["id"]))
                    page_rows += 1
                for row_id in bucket["deleted"]:
                    emitted.append((collection, row_id))
                    page_rows += 1
            assert page_rows <= page_size, f"page exceeded page_size: {page_rows} > {page_size}"
            pages += 1
            cursor = resp.data["next_cursor"]
            if not resp.data["has_more"]:
                assert cursor is None
                break
            assert cursor is not None
            assert pages < 10_000, "pager failed to terminate"
    return emitted, pages


@pytest.mark.django_db
def test_sync_cold_start_paginates_contiguous_non_overlapping(
    authed_client: APIClient,
    project: Project,
    calendar: Calendar,
    membership: ProjectMembership,
) -> None:
    task_ids = _seed_tasks(project, 2000)
    page_size = 137  # deliberately not a divisor — forces an uneven final page

    emitted, pages = _drain(authed_client, project, since="0", page_size=page_size)

    # Paginated: 2000 tasks + project + calendar + membership at page_size 137
    # cannot fit in one page.
    assert pages > 1

    # Non-overlapping: no (collection, id) pair is delivered twice.
    assert len(emitted) == len(set(emitted))

    # Contiguous + reassembles to the full set: every seeded task appears exactly
    # once, and the union across pages equals the whole cold-start delta.
    emitted_tasks = [row_id for coll, row_id in emitted if coll == "tasks"]
    assert set(emitted_tasks) == set(task_ids)
    assert len(emitted_tasks) == len(task_ids)  # no duplicates

    emitted_ids = {row_id for _coll, row_id in emitted}
    assert str(project.pk) in emitted_ids
    assert str(calendar.pk) in emitted_ids
    assert str(membership.pk) in emitted_ids


@pytest.mark.django_db
def test_sync_cold_start_page_size_clamped_to_max(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """A page_size above the configured max is clamped, not honored (#1013)."""
    from django.test import override_settings

    _seed_tasks(project, 30)
    with override_settings(TRUEPPM_SYNC_PULL_MAX_PAGE_SIZE=10):
        _emitted, pages = _drain(authed_client, project, since="0", page_size=9999)
    # 30 tasks + project + membership across pages capped at 10 rows each.
    assert pages >= 3


@pytest.mark.django_db
def test_sync_incremental_pull_paginates(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """An incremental (since>0) pull returns only bumped rows, and still pages."""
    _seed_tasks(project, 500, server_version=1)  # baseline, already synced
    bumped = _seed_tasks(project, 300, server_version=2)  # edited since checkpoint

    emitted, pages = _drain(authed_client, project, since="1", page_size=50)

    emitted_tasks = [row_id for coll, row_id in emitted if coll == "tasks"]
    # Only the version-2 rows come back; the 500 version-1 rows are excluded.
    assert set(emitted_tasks) == set(bumped)
    assert len(emitted_tasks) == len(bumped)
    assert pages > 1


@pytest.mark.django_db
def test_sync_single_page_is_backward_compatible(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """A small project drains in one page: has_more False, next_cursor None (#1013)."""
    _seed_tasks(project, 5)
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=1,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    assert resp.data["has_more"] is False
    assert resp.data["next_cursor"] is None
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert len(task_ids) == 5


@pytest.mark.django_db
def test_sync_malformed_cursor_returns_400(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    resp = authed_client.get(_url(project), {"since": "0", "cursor": "!!!not-base64!!!"})
    assert resp.status_code == 400


def test_sync_cursor_round_trips() -> None:
    """The opaque cursor token encodes and decodes losslessly (#1013)."""
    original = SyncCursor(index=3, version=7, row_id="a1b2c3d4-0000-0000-0000-000000000000")
    assert SyncCursor.decode(original.encode()) == original
    fresh = SyncCursor(index=2, version=0, row_id=None)
    assert SyncCursor.decode(fresh.encode()) == fresh


@pytest.mark.django_db
def test_sync_soft_deleted_risk_appears_in_deleted_list(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    risk = Risk.objects.create(project=project, title="Obsolete risk", probability=1, impact=1)
    risk.soft_delete()
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert str(risk.pk) in resp.data["changes"]["risks"]["deleted"]
    risk_updated_ids = [r["id"] for r in resp.data["changes"]["risks"]["updated"]]
    assert str(risk.pk) not in risk_updated_ids
