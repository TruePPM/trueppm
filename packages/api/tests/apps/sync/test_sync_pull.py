"""Tests for the project delta sync pull endpoint."""

from __future__ import annotations

import base64
import json
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
    task_a = Task.objects.create(project=project, name="A", duration=1)
    task_b = Task.objects.create(project=project, name="B", duration=1)

    # Checkpoint here: both tasks are now at or below the project's cursor.
    since = authed_client.get(_url(project), {"since": "0"}).data["timestamp"]

    task_a.name = "A-modified"
    task_a.save()

    # A client resuming from that checkpoint sees task_a and not task_b.
    resp = authed_client.get(_url(project), {"since": str(since)})
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert task_ids == [str(task_a.pk)]
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


def _seed_tasks(project: Project, count: int, *, sync_seq: int = 1) -> list[str]:
    """Bulk-insert ``count`` tasks at a fixed delta cursor; return their id strings.

    bulk_create bypasses ``VersionedModel.save``, which would set server_version=1,
    draw a ``sync_seq`` from the project sequence (ADR-0686), and allocate a
    short_id — so all three are set explicitly: ``sync_seq`` so the rows clear the
    ``sync_seq__gt=since`` floor, and a unique short_id so the per-project unique
    constraint is satisfied. ``server_version`` tracks ``sync_seq`` here only to
    keep the fixture coherent; nothing in the pull reads it.
    """
    tasks = [
        Task(
            project=project,
            name=f"T{n}",
            short_id=f"T{n}",
            duration=1,
            server_version=sync_seq,
            sync_seq=sync_seq,
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
    _seed_tasks(project, 500, sync_seq=1)  # baseline, already synced
    bumped = _seed_tasks(project, 300, sync_seq=2)  # edited since checkpoint

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
    """The opaque cursor token encodes and decodes losslessly (#1013, #2568)."""
    original = SyncCursor(
        index=3, version=7, row_id="a1b2c3d4-0000-0000-0000-000000000000", watermark=91
    )
    assert SyncCursor.decode(original.encode()) == original
    fresh = SyncCursor(index=2, version=0, row_id=None, watermark=0)
    assert SyncCursor.decode(fresh.encode()) == fresh


# ---------------------------------------------------------------------------
# Session-pinned watermark (#2568)
#
# The checkpoint belongs to the pull *session*, not the request. Recomputing it
# per page published a value above rows written mid-drain into a collection the
# pager had already passed; the client adopting the last page's `timestamp`
# filtered them out of every subsequent pull, losing the edit with no error and
# no retry path. These tests pin the behaviour at the protocol boundary.
# ---------------------------------------------------------------------------


def _decode_token(token: str) -> dict[str, object]:
    """Decode a cursor token back to its raw JSON payload (test-only introspection)."""
    return dict(json.loads(base64.urlsafe_b64decode(token.encode())))


def _encode_token(payload: dict[str, object]) -> str:
    """Encode a raw payload as a cursor token, bypassing SyncCursor's validation."""
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


@pytest.mark.django_db
def test_sync_mid_drain_write_to_drained_collection_is_not_skipped(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """A row written into an already-drained collection survives the drain (#2568).

    ``projects`` is collection index 0, so it is fully drained by page 1. Editing
    the project between page 1 and the last page writes a row the session can no
    longer reach. If the final page reported a freshly recomputed watermark, the
    client would adopt a checkpoint at or above that row's ``sync_seq`` and the
    edit would never be delivered again.
    """
    _seed_tasks(project, 40, sync_seq=1)

    # Page 1: drains `projects` (1 row) and starts on `tasks`.
    first = authed_client.get(_url(project), {"since": "0", "page_size": "5"})
    assert first.status_code == 200
    assert first.data["has_more"] is True
    pinned = first.data["timestamp"]
    delivered_projects = {r["id"] for r in first.data["changes"]["projects"]["updated"]}
    assert str(project.pk) in delivered_projects, "fixture assumption: projects drained on page 1"

    # Mid-drain write into the already-drained collection.
    project.name = "Renamed mid-drain"
    project.save()
    project.refresh_from_db()
    assert project.sync_seq > pinned, "fixture assumption: the edit lands above the pin"

    # Drain the rest of the session.
    cursor = first.data["next_cursor"]
    last_body = dict(first.data)
    while cursor is not None:
        resp = authed_client.get(_url(project), {"since": "0", "page_size": "5", "cursor": cursor})
        assert resp.status_code == 200, resp.data
        last_body = dict(resp.data)
        cursor = resp.data["next_cursor"]

    adopted = last_body["timestamp"]
    assert adopted == pinned, "the session published a checkpoint it never drained to"

    # The whole point: the next pull still delivers the mid-drain edit.
    nxt = authed_client.get(_url(project), {"since": str(adopted), "page_size": "500"})
    assert nxt.status_code == 200
    redelivered = {r["id"] for r in nxt.data["changes"]["projects"]["updated"]}
    assert str(project.pk) in redelivered, "mid-drain edit was lost — #2568 regression"


@pytest.mark.django_db
def test_sync_timestamp_is_identical_on_every_page_of_one_drain(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """`timestamp` never moves within a paging session, even under concurrent writes."""
    _seed_tasks(project, 60, sync_seq=1)

    pages: list[object] = []
    cursor: str | None = None
    while True:
        params = {"since": "0", "page_size": "7"}
        if cursor is not None:
            params["cursor"] = cursor
        resp = authed_client.get(_url(project), params)
        assert resp.status_code == 200, resp.data
        pages.append(resp.data["timestamp"])
        # Bump the project sequence between every pair of pages; a per-request
        # watermark would climb with it.
        project.name = f"Churn {len(pages)}"
        project.save()
        cursor = resp.data["next_cursor"]
        if not resp.data["has_more"]:
            break

    assert len(pages) > 1, "fixture assumption: the delta spans multiple pages"
    assert len(set(pages)) == 1, f"timestamp drifted across pages: {pages}"


@pytest.mark.django_db
def test_sync_cursor_pins_watermark_in_the_token(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """The emitted continuation token carries the session watermark as `w` (#2568)."""
    _seed_tasks(project, 20, sync_seq=1)
    resp = authed_client.get(_url(project), {"since": "0", "page_size": "3"})
    assert resp.data["has_more"] is True
    payload = _decode_token(resp.data["next_cursor"])
    assert payload["w"] == resp.data["timestamp"]


@pytest.mark.django_db
@pytest.mark.parametrize(
    "bad_w",
    [
        pytest.param(-1, id="negative"),
        pytest.param("not-an-int", id="non-numeric-string"),
        pytest.param(None, id="null"),
        pytest.param({"nested": 1}, id="object"),
        # Python's json emits/accepts these non-standard literals, and int()
        # rejects them with OverflowError — an ArithmeticError, not the
        # ValueError every other bad input raises. They reached an unhandled 500
        # until OverflowError was added to the decode's except tuple.
        pytest.param(float("inf"), id="infinity"),
        pytest.param(float("-inf"), id="negative-infinity"),
        pytest.param(float("nan"), id="nan"),
    ],
)
def test_sync_cursor_with_bad_watermark_returns_400(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
    bad_w: object,
) -> None:
    """A tampered `w` is rejected as malformed, not crashed on (#2568).

    ``w`` is echoed straight back as the checkpoint the client adopts, so an
    unvalidated value is a data-loss vector — it gets the same strict treatment
    as ``i`` and ``v``.
    """
    _seed_tasks(project, 20, sync_seq=1)
    first = authed_client.get(_url(project), {"since": "0", "page_size": "3"})
    payload = _decode_token(first.data["next_cursor"])
    payload["w"] = bad_w
    resp = authed_client.get(
        _url(project), {"since": "0", "page_size": "3", "cursor": _encode_token(payload)}
    )
    assert resp.status_code == 400, resp.data


@pytest.mark.django_db
def test_sync_cursor_without_watermark_field_returns_400(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """A truncated token missing `w` entirely is malformed — 400, never 500 (#2568).

    This is also the shape of a token minted by a pre-#2568 server, so a drain
    straddling the deploy restarts at its unchanged `since` rather than adopting
    an unpinned checkpoint.
    """
    _seed_tasks(project, 20, sync_seq=1)
    first = authed_client.get(_url(project), {"since": "0", "page_size": "3"})
    payload = _decode_token(first.data["next_cursor"])
    del payload["w"]
    resp = authed_client.get(
        _url(project), {"since": "0", "page_size": "3", "cursor": _encode_token(payload)}
    )
    assert resp.status_code == 400, resp.data


@pytest.mark.django_db
def test_sync_cursor_watermark_above_the_live_sequence_returns_400(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """`w` is ceiling-checked against the project sequence, not just floor-checked.

    The cursor is unsigned, and unlike ``i``/``v`` — stream positions the pager
    re-derives and bounds naturally — ``w`` is a checkpoint the client is told to
    persist and echo back as ``since`` indefinitely. An inflated value would be
    permanent for that device, so it is rejected rather than echoed. The sequence
    only ever increases, so this rejects nothing legitimate.
    """
    _seed_tasks(project, 20, sync_seq=1)
    first = authed_client.get(_url(project), {"since": "0", "page_size": "3"})
    payload = _decode_token(first.data["next_cursor"])
    payload["w"] = int(project.last_sync_version) + 10_000
    resp = authed_client.get(
        _url(project), {"since": "0", "page_size": "3", "cursor": _encode_token(payload)}
    )
    assert resp.status_code == 400, resp.data


@pytest.mark.django_db
def test_sync_unmodified_cursor_survives_the_ceiling_check(
    authed_client: APIClient,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """The ceiling check must not reject a legitimate drain (#2568 guard-rail).

    The pinned watermark is by construction at or below the live sequence, and the
    sequence only climbs, so every honest continuation page passes. Pinned here so
    a future tightening of the check cannot silently break paging.
    """
    _seed_tasks(project, 40, sync_seq=1)
    cursor: str | None = None
    pages = 0
    while True:
        params = {"since": "0", "page_size": "5"}
        if cursor is not None:
            params["cursor"] = cursor
        resp = authed_client.get(_url(project), params)
        assert resp.status_code == 200, resp.data
        pages += 1
        # Advance the live sequence between pages: the ceiling rises, the pin does
        # not, so the check must keep passing.
        project.name = f"Churn {pages}"
        project.save()
        cursor = resp.data["next_cursor"]
        if not resp.data["has_more"]:
            break
        assert pages < 100, "pager failed to terminate"
    assert pages > 1


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


# ---------------------------------------------------------------------------
# Delta-cursor correctness (#2491, ADR-0686)
#
# These drive the real endpoint end to end — `since` comes only from a prior
# response's `timestamp`, exactly as the docstring instructs a client to do it.
# Nothing here reads server_version: the point of the fix is that the cursor and
# the row version are different things.
# ---------------------------------------------------------------------------


def _pull(client: APIClient, project: Project, since: int) -> dict:
    resp = client.get(_url(project), {"since": str(since)})
    assert resp.status_code == 200
    return resp.data


def _names(body: dict, collection: str = "tasks") -> list[str]:
    return [row["name"] for row in body["changes"][collection]["updated"]]


@pytest.mark.django_db
def test_low_version_row_edit_survives_a_high_watermark(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """The #2491 repro: one edit to a cold row after many edits to a hot one.

    Under the old scheme `cold` never climbed past the watermark `hot` had
    dragged upward, so this pull returned an empty list and the client believed
    it was fully synced.
    """
    task_hot = Task.objects.create(project=project, name="hot", duration=1)
    task_cold = Task.objects.create(project=project, name="cold", duration=1)

    since = _pull(authed_client, project, 0)["timestamp"]

    for i in range(6):
        task_hot.name = f"hot-{i}"
        task_hot.save()
    since = _pull(authed_client, project, since)["timestamp"]

    task_cold.name = "cold-EDITED"
    task_cold.save()

    assert "cold-EDITED" in _names(_pull(authed_client, project, since))


@pytest.mark.django_db
def test_a_single_edit_survives_a_hundred_edits_to_another_row(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Acceptance criterion: 1 edit after 100 elsewhere is still delivered."""
    hot = Task.objects.create(project=project, name="hot", duration=1)
    cold = Task.objects.create(project=project, name="cold", duration=1)
    since = _pull(authed_client, project, 0)["timestamp"]

    for i in range(100):
        hot.name = f"hot-{i}"
        hot.save()
    since = _pull(authed_client, project, since)["timestamp"]

    cold.name = "cold-once"
    cold.save()

    assert _names(_pull(authed_client, project, since)) == ["cold-once"]


@pytest.mark.django_db
def test_a_hot_task_does_not_hide_edits_in_other_collections(
    authed_client: APIClient, project: Project, membership: ProjectMembership, user: object
) -> None:
    """Acceptance criterion: the defect spanned every synced table, not just tasks.

    The watermark unioned 15 sources, so a hot Task raised the bar for Risk,
    Sprint, Label, and ProjectMembership alike — and a membership row is what an
    offline client enforces RBAC from.
    """
    from datetime import date as _date

    from trueppm_api.apps.projects.models import Label, Sprint

    hot = Task.objects.create(project=project, name="hot", duration=1)
    risk = Risk.objects.create(project=project, title="R", probability=1, impact=1)
    sprint = Sprint.objects.create(
        project=project,
        name="S",
        start_date=_date(2026, 1, 1),
        finish_date=_date(2026, 1, 14),
    )
    label = Label.objects.create(project=project, name="lbl", color="amber")

    since = _pull(authed_client, project, 0)["timestamp"]
    for i in range(50):
        hot.name = f"hot-{i}"
        hot.save()
    since = _pull(authed_client, project, since)["timestamp"]

    risk.title = "R-EDITED"
    risk.save()
    sprint.name = "S-EDITED"
    sprint.save()
    label.name = "lbl-EDITED"
    label.save()
    membership.role = Role.ADMIN
    membership.save()

    body = _pull(authed_client, project, since)
    assert [r["title"] for r in body["changes"]["risks"]["updated"]] == ["R-EDITED"]
    assert _names(body, "sprints") == ["S-EDITED"]
    assert _names(body, "labels") == ["lbl-EDITED"]
    assert [m["role"] for m in body["changes"]["memberships"]["updated"]] == [Role.ADMIN]


@pytest.mark.django_db
def test_every_edit_is_delivered_exactly_once_under_arbitrary_interleaving(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Property test: N rows edited in an uneven, deterministic interleaving.

    Each round records what was edited, then pulls with the previous round's
    `timestamp` and asserts the delta is exactly that set — no omission (the
    #2491 defect) and no duplicate (which would mean the watermark lagged the
    rows it reported).

    The interleaving is deliberately lopsided — `i % (n + 1)` gives row 0 far
    more saves than row 9 — because an *even* edit distribution keeps every row's
    counter near the maximum and hides the bug entirely.
    """
    n = 10
    tasks = [Task.objects.create(project=project, name=f"t{i}", duration=1) for i in range(n)]
    since = _pull(authed_client, project, 0)["timestamp"]

    for round_no in range(20):
        touched = set()
        for i in range(round_no % (n + 1) + 1):
            task = tasks[(round_no * 7 + i * 3) % n]
            task.name = f"t{tasks.index(task)}-r{round_no}"
            task.save()
            touched.add(task.name)

        body = _pull(authed_client, project, since)
        delivered = _names(body)
        assert sorted(delivered) == sorted(touched), f"round {round_no}"
        assert len(delivered) == len(set(delivered)), f"round {round_no}: duplicate rows"
        since = body["timestamp"]

    # Steady state: with nothing edited, the delta is empty and the cursor holds.
    final = _pull(authed_client, project, since)
    assert final["changes"]["tasks"]["updated"] == []
    assert final["timestamp"] == since


@pytest.mark.django_db
def test_timestamp_is_a_stable_checkpoint_when_nothing_changes(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Adopting `timestamp` as the next `since` must converge, not oscillate."""
    Task.objects.create(project=project, name="T", duration=1)
    first = _pull(authed_client, project, 0)
    assert _names(first) == ["T"]

    second = _pull(authed_client, project, first["timestamp"])
    assert second["changes"]["tasks"]["updated"] == []
    assert second["timestamp"] == first["timestamp"]


@pytest.mark.django_db
def test_cold_start_delivers_every_collection_including_graph_edges(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """A `since=0` pull must hand back the graph, not just the task list.

    Guards the whole-collection failure mode that a per-collection delta test
    cannot see: a model that is filtered on `sync_seq` but never *allocates* one
    sits at 0 forever, and `sync_seq__gt=0` is already false — so it vanishes
    from every pull, including the cold start. Dependencies and task relations
    carry no project FK and so are the models most easily left out of the
    allocator; an offline client that got tasks with no edges could not run CPM
    at all.
    """
    from trueppm_api.apps.projects.models import Dependency, TaskRelation

    a = Task.objects.create(project=project, name="A", duration=1)
    b = Task.objects.create(project=project, name="B", duration=1)
    Dependency.objects.create(predecessor=a, successor=b)
    TaskRelation.objects.create(source=a, target=b, relation_type="relates_to")

    body = _pull(authed_client, project, 0)

    def delivered(collection: str) -> int:
        rows = body["changes"][collection]
        return len(rows["created"]) + len(rows["updated"])

    assert delivered("tasks") == 2
    assert delivered("dependencies") == 1, "cold start dropped the dependency graph"
    assert delivered("task_relations") == 1, "cold start dropped task relations"


@pytest.mark.django_db
def test_a_graph_edge_edit_is_delivered_on_the_next_delta(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """An edge-only change reaches the client without an accompanying task edit."""
    from trueppm_api.apps.projects.models import TaskRelation

    a = Task.objects.create(project=project, name="A", duration=1)
    b = Task.objects.create(project=project, name="B", duration=1)
    rel = TaskRelation.objects.create(source=a, target=b, relation_type="relates_to")

    since = _pull(authed_client, project, 0)["timestamp"]

    rel.note = "edge-only edit"
    rel.save()

    body = _pull(authed_client, project, since)
    notes = [r["note"] for r in body["changes"]["task_relations"]["updated"]]
    assert notes == ["edge-only edit"]


@pytest.mark.django_db
def test_project_delete_and_restore_cascades_are_delivered(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Trash and restore must reach an offline client as tombstones and revivals.

    The cascades write through bulk `.update()` rather than `save()`, so nothing
    allocates a cursor for them automatically. If they don't stamp one explicitly
    the rows keep a cursor at or below the client's checkpoint and the delete is
    never delivered — the client goes on showing tasks the server has trashed.
    """
    from trueppm_api.apps.projects.models import (
        Dependency,
        cascade_project_children_restore,
        cascade_project_children_soft_delete,
    )

    a = Task.objects.create(project=project, name="A", duration=1)
    b = Task.objects.create(project=project, name="B", duration=1)
    Dependency.objects.create(predecessor=a, successor=b)

    since = _pull(authed_client, project, 0)["timestamp"]

    cascade_project_children_soft_delete(project)

    body = _pull(authed_client, project, since)
    assert len(body["changes"]["tasks"]["deleted"]) == 2, "trash delivered no task tombstones"
    assert len(body["changes"]["dependencies"]["deleted"]) == 1

    since = body["timestamp"]
    cascade_project_children_restore(project)

    body = _pull(authed_client, project, since)
    revived = body["changes"]["tasks"]["created"] + body["changes"]["tasks"]["updated"]
    assert len(revived) == 2, "restore delivered no revived tasks"
