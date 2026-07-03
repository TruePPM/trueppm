"""Tests for the mobile sync upload (push) endpoint — ADR-0082 / issue #667.

Covers the acceptance criteria: batch atomicity (drop-mid-commit reruns cleanly),
idempotent retry (duplicate client_batch_id is a no-op), expired-batch re-run,
per-row RBAC parity with the REST path, LWW conflict handling, and the
unsupported-collection guard.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ScopeChangeStatus,
    Sprint,
    SprintScopeChange,
    SprintState,
    Task,
)
from trueppm_api.apps.sync.models import SyncBatch, SyncBatchStatus

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="up_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="UpProj", start_date=date(2026, 1, 1), calendar=calendar)


def _make_membership(project: Project, user: Any, role: int) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


@pytest.fixture
def admin_client(project: Project, user: Any) -> APIClient:
    """A Project Manager (ADMIN) — may edit any task. Used for golden paths."""
    _make_membership(project, user, Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sync/"


def _payload(client_batch_id: str | None = None, **collections: Any) -> dict[str, Any]:
    """Build a WatermelonDB-shaped upload envelope for the tasks collection."""
    tasks = {
        "created": collections.get("created", []),
        "updated": collections.get("updated", []),
        "deleted": collections.get("deleted", []),
    }
    return {
        "client_batch_id": client_batch_id or str(uuid.uuid4()),
        "changes": {"tasks": tasks},
    }


# ---------------------------------------------------------------------------
# Auth / RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_upload_requires_auth(project: Project) -> None:
    resp = APIClient().post(_url(project), _payload(), format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_upload_requires_membership(project: Project) -> None:
    outsider = User.objects.create_user(username="out", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    resp = c.post(_url(project), _payload(), format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_viewer_cannot_upload(project: Project) -> None:
    viewer = User.objects.create_user(username="viewer", password="pw")
    _make_membership(project, viewer, Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    resp = c.post(
        _url(project),
        _payload(created=[{"id": str(uuid.uuid4()), "name": "X"}]),
        format="json",
    )
    assert resp.status_code == 403
    assert not Task.objects.exists()


@pytest.mark.django_db
def test_upload_404_for_missing_project(admin_client: APIClient) -> None:
    resp = admin_client.post(f"/api/v1/projects/{uuid.uuid4()}/sync/", _payload(), format="json")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Golden paths: create / update / delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_task(admin_client: APIClient, project: Project) -> None:
    task_id = str(uuid.uuid4())
    resp = admin_client.post(
        _url(project),
        _payload(created=[{"id": task_id, "name": "Field note"}]),
        format="json",
    )
    assert resp.status_code == 200
    task = Task.objects.get(pk=task_id)
    assert task.name == "Field note"
    assert task.server_version == 1
    body = resp.json()
    assert body["applied"]["tasks"]["created"] == [{"id": task_id, "server_version": 1}]
    assert body["timestamp"] == 1


@pytest.mark.django_db
def test_update_task_lww(admin_client: APIClient, project: Project) -> None:
    task = Task.objects.create(project=project, name="Orig", notes="")
    start_version = task.server_version
    resp = admin_client.post(
        _url(project),
        # Send a deliberately stale server_version — LWW applies anyway (no 409).
        _payload(updated=[{"id": str(task.pk), "server_version": 0, "notes": "edited offline"}]),
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.notes == "edited offline"
    assert task.server_version > start_version
    assert resp.json()["applied"]["tasks"]["updated"][0]["id"] == str(task.pk)


@pytest.mark.django_db
def test_delete_task_tombstones(admin_client: APIClient, project: Project) -> None:
    task = Task.objects.create(project=project, name="Doomed")
    start_version = task.server_version
    resp = admin_client.post(_url(project), _payload(deleted=[str(task.pk)]), format="json")
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.is_deleted is True
    assert task.deleted_version == task.server_version
    assert task.server_version > start_version


# ---------------------------------------------------------------------------
# Idempotent retry (duplicate client_batch_id) — the lost-ACK case
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_duplicate_batch_is_noop(admin_client: APIClient, project: Project) -> None:
    task_id = str(uuid.uuid4())
    batch_id = str(uuid.uuid4())
    payload = _payload(client_batch_id=batch_id, created=[{"id": task_id, "name": "Once"}])

    first = admin_client.post(_url(project), payload, format="json")
    assert first.status_code == 200

    # Replay the identical batch — the lost-ACK retry.
    second = admin_client.post(_url(project), payload, format="json")
    assert second.status_code == 200
    # Identical stored response, and crucially no double-apply: still one task,
    # still at server_version 1 (a second create/update would have bumped it).
    assert second.json() == first.json()
    assert Task.objects.filter(pk=task_id).count() == 1
    assert Task.objects.get(pk=task_id).server_version == 1
    assert SyncBatch.objects.filter(client_batch_id=batch_id).count() == 1


@pytest.mark.django_db
def test_expired_batch_reruns(admin_client: APIClient, project: Project, user: Any) -> None:
    """A duplicate of an *expired* batch re-runs rather than replaying."""
    batch_id = uuid.uuid4()
    # Simulate a completed batch from >24h ago that has aged out of the dedup
    # window (and whose applied task was since removed). actor_user is set to the
    # same uploading user so the expired-row collision path is exercised (#894).
    stale = SyncBatch.objects.create(
        client_batch_id=batch_id,
        project=project,
        actor_user=user,
        status=SyncBatchStatus.COMPLETED,
        response_body={"stale": True},
    )
    SyncBatch.objects.filter(pk=stale.pk).update(created_at=timezone.now() - timedelta(hours=25))

    task_id = str(uuid.uuid4())
    resp = admin_client.post(
        _url(project),
        _payload(client_batch_id=str(batch_id), created=[{"id": task_id, "name": "Re-run"}]),
        format="json",
    )
    assert resp.status_code == 200
    # It re-ran (applied the create) instead of replaying the stale body.
    assert resp.json() != {"stale": True}
    assert Task.objects.filter(pk=task_id).exists()
    # The stale row was replaced by a fresh completed one.
    fresh = SyncBatch.objects.get(client_batch_id=batch_id)
    assert fresh.is_fresh()
    assert fresh.status == SyncBatchStatus.COMPLETED


# ---------------------------------------------------------------------------
# Atomicity — all-or-nothing per batch
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_forbidden_row_rolls_back_whole_batch(project: Project) -> None:
    """A batch with one forbidden op applies none of its rows (all-or-nothing)."""
    member = User.objects.create_user(username="member", password="pw")
    _make_membership(project, member, Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)

    # Row B is owned by someone else — a Member may not edit it.
    other = User.objects.create_user(username="other", password="pw")
    not_mine = Task.objects.create(project=project, name="Theirs", assignee=other)

    new_id = str(uuid.uuid4())
    resp = c.post(
        _url(project),
        _payload(
            created=[{"id": new_id, "name": "Mine"}],
            updated=[{"id": str(not_mine.pk), "notes": "sneaky edit"}],
        ),
        format="json",
    )
    assert resp.status_code == 403
    # The valid created row must NOT have been persisted — the forbidden row
    # rolled the whole batch back.
    assert not Task.objects.filter(pk=new_id).exists()
    not_mine.refresh_from_db()
    assert not_mine.notes == ""
    # And no SyncBatch row was left behind to block a corrected re-upload.
    assert not SyncBatch.objects.exists()


@pytest.mark.django_db
def test_apply_failure_rolls_back_and_reruns_cleanly(
    admin_client: APIClient, project: Project, user: Any
) -> None:
    """Drop-mid-commit: a failure leaves nothing committed and a retry succeeds."""
    task_id = str(uuid.uuid4())
    batch_id = str(uuid.uuid4())
    payload = _payload(client_batch_id=batch_id, created=[{"id": task_id, "name": "Resilient"}])

    # Simulate the connection dropping mid-commit by raising inside apply.
    crash_client = APIClient(raise_request_exception=False)
    crash_client.force_authenticate(user=user)
    with patch(
        "trueppm_api.apps.sync.upload.apply_task_changes",
        side_effect=RuntimeError("connection dropped"),
    ):
        crashed = crash_client.post(_url(project), payload, format="json")
    assert crashed.status_code == 500
    # Nothing committed — neither the task nor the batch envelope.
    assert not Task.objects.filter(pk=task_id).exists()
    assert not SyncBatch.objects.filter(client_batch_id=batch_id).exists()

    # The client retries the same batch id; this time it applies cleanly.
    retry = admin_client.post(_url(project), payload, format="json")
    assert retry.status_code == 200
    assert Task.objects.filter(pk=task_id).exists()


# ---------------------------------------------------------------------------
# Per-row RBAC parity with IsProjectMemberWriteOrOwn
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_can_edit_own_task(project: Project) -> None:
    member = User.objects.create_user(username="m2", password="pw")
    _make_membership(project, member, Role.MEMBER)
    mine = Task.objects.create(project=project, name="Mine", assignee=member)
    c = APIClient()
    c.force_authenticate(user=member)
    resp = c.post(
        _url(project),
        _payload(updated=[{"id": str(mine.pk), "notes": "my update"}]),
        format="json",
    )
    assert resp.status_code == 200
    mine.refresh_from_db()
    assert mine.notes == "my update"


@pytest.mark.django_db
def test_scheduler_cannot_edit_task_content(project: Project) -> None:
    sched = User.objects.create_user(username="sched", password="pw")
    _make_membership(project, sched, Role.SCHEDULER)
    task = Task.objects.create(project=project, name="T", assignee=sched)
    c = APIClient()
    c.force_authenticate(user=sched)
    resp = c.post(
        _url(project),
        _payload(updated=[{"id": str(task.pk), "notes": "nope"}]),
        format="json",
    )
    assert resp.status_code == 403
    task.refresh_from_db()
    assert task.notes == ""


@pytest.mark.django_db
def test_scheduler_cannot_delete_task(project: Project) -> None:
    sched = User.objects.create_user(username="sched2", password="pw")
    _make_membership(project, sched, Role.SCHEDULER)
    task = Task.objects.create(project=project, name="T", assignee=sched)
    c = APIClient()
    c.force_authenticate(user=sched)
    resp = c.post(_url(project), _payload(deleted=[str(task.pk)]), format="json")
    assert resp.status_code == 403
    task.refresh_from_db()
    assert task.is_deleted is False


# ---------------------------------------------------------------------------
# Validation guards
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unsupported_collection_rejected(admin_client: APIClient, project: Project) -> None:
    body = {
        "client_batch_id": str(uuid.uuid4()),
        "changes": {"dependencies": {"created": [{"id": str(uuid.uuid4())}]}},
    }
    resp = admin_client.post(_url(project), body, format="json")
    assert resp.status_code == 400
    assert not SyncBatch.objects.exists()


@pytest.mark.django_db
def test_missing_client_batch_id_rejected(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(_url(project), {"changes": {"tasks": {"created": []}}}, format="json")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Typed envelope shape (#786) — the changes map is a typed nested serializer
# (per-collection created/updated/deleted) instead of an opaque DictField. A
# well-formed batch is still accepted byte-identically; a malformed envelope is
# rejected at serializer validation with a 400 before any batch row is written.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_typed_envelope_accepts_well_formed(admin_client: APIClient, project: Project) -> None:
    """A valid WatermelonDB-shaped batch is still accepted under the typed envelope."""
    task_id = str(uuid.uuid4())
    resp = admin_client.post(
        _url(project),
        _payload(created=[{"id": task_id, "name": "Typed"}]),
        format="json",
    )
    assert resp.status_code == 200
    assert Task.objects.filter(pk=task_id).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "bad_changes",
    [
        pytest.param("not-an-object", id="changes-is-a-string"),
        pytest.param(["a", "list"], id="changes-is-a-list"),
        pytest.param({"tasks": {"deleted": "should-be-a-list"}}, id="deleted-not-a-list"),
        pytest.param(
            {"tasks": {"created": ["row-must-be-an-object"]}}, id="created-row-not-object"
        ),
    ],
)
def test_malformed_envelope_rejected(
    admin_client: APIClient, project: Project, bad_changes: Any
) -> None:
    """The typed nested serializer rejects a malformed changes envelope with a 400.

    Each case is shape-invalid at the envelope level (before per-row task
    validation), so it is caught by ``SyncUploadRequestSerializer`` and no
    ``SyncBatch`` row is written.
    """
    body = {"client_batch_id": str(uuid.uuid4()), "changes": bad_changes}
    resp = admin_client.post(_url(project), body, format="json")
    assert resp.status_code == 400
    assert not SyncBatch.objects.exists()
    assert not Task.objects.exists()


@pytest.mark.django_db
def test_cross_project_sprint_rejected(admin_client: APIClient, project: Project) -> None:
    """Assigning a sprint from another project is an IDOR — rejected at validate."""
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 1))
    foreign_sprint = Sprint.objects.create(
        project=other, name="S", start_date=date(2026, 1, 1), finish_date=date(2026, 1, 14)
    )
    task = Task.objects.create(project=project, name="T")
    resp = admin_client.post(
        _url(project),
        _payload(updated=[{"id": str(task.pk), "sprint": str(foreign_sprint.pk)}]),
        format="json",
    )
    assert resp.status_code == 400
    assert not SyncBatch.objects.exists()


@pytest.mark.django_db
def test_archived_project_rejects_upload(admin_client: APIClient, project: Project) -> None:
    """Archived projects are hard read-only — the upload must not bypass that (#530)."""
    project.is_archived = True
    project.save(update_fields=["is_archived"])
    resp = admin_client.post(
        _url(project),
        _payload(created=[{"id": str(uuid.uuid4()), "name": "X"}]),
        format="json",
    )
    assert resp.status_code == 403
    assert not Task.objects.exists()


@pytest.mark.django_db
def test_batch_too_large_rejected(admin_client: APIClient, project: Project, settings: Any) -> None:
    settings.TRUEPPM_SYNC_BATCH_MAX_ROWS = 2
    rows = [{"id": str(uuid.uuid4()), "name": f"T{i}"} for i in range(3)]
    resp = admin_client.post(_url(project), _payload(created=rows), format="json")
    assert resp.status_code == 400
    assert not Task.objects.exists()
    assert not SyncBatch.objects.exists()


@pytest.mark.django_db
def test_batch_id_isolated_per_project(
    admin_client: APIClient, project: Project, user: Any
) -> None:
    """The same client_batch_id in two projects does not cross-replay (IDOR guard)."""
    other = Project.objects.create(name="Other2", start_date=date(2026, 1, 1))
    _make_membership(other, user, Role.ADMIN)
    batch_id = str(uuid.uuid4())

    r1 = admin_client.post(
        _url(project),
        _payload(client_batch_id=batch_id, created=[{"id": str(uuid.uuid4()), "name": "InA"}]),
        format="json",
    )
    assert r1.status_code == 200
    # Same batch id, different project — must apply fresh, not replay project A's body.
    r2 = admin_client.post(
        _url(other),
        _payload(client_batch_id=batch_id, created=[{"id": str(uuid.uuid4()), "name": "InB"}]),
        format="json",
    )
    assert r2.status_code == 200
    assert r2.json() != r1.json()
    assert Task.objects.filter(project=other, name="InB").exists()
    assert SyncBatch.objects.filter(client_batch_id=batch_id).count() == 2


@pytest.mark.django_db
def test_wbs_path_not_writable_via_upload(admin_client: APIClient, project: Project) -> None:
    """wbs_path is server-managed and stripped from uploaded rows."""
    task = Task.objects.create(project=project, name="T")
    resp = admin_client.post(
        _url(project),
        _payload(updated=[{"id": str(task.pk), "notes": "ok", "wbs_path": "9.9.9"}]),
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.notes == "ok"
    assert str(task.wbs_path or "") != "9.9.9"


@pytest.mark.django_db
def test_update_of_deleted_task_is_skipped(admin_client: APIClient, project: Project) -> None:
    """A benign offline/online race: updating an already-tombstoned row is a no-op."""
    task = Task.objects.create(project=project, name="Gone")
    task.soft_delete()
    resp = admin_client.post(
        _url(project),
        _payload(updated=[{"id": str(task.pk), "notes": "late edit"}]),
        format="json",
    )
    assert resp.status_code == 200
    assert resp.json()["applied"]["tasks"]["updated"] == []


# ---------------------------------------------------------------------------
# Purge task
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Scaling: broadcast coalescing + bulk existing-row fetch (#809)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_bulk_upload_coalesces_into_single_broadcast(
    admin_client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: object,
) -> None:
    """A multi-row batch emits ONE tasks_bulk_mutated event, not one per row (#809).

    The previous behavior issued a separate broadcast_board_event per applied row,
    which under a reconnect storm overflowed the channel-layer inbox.
    """
    ids = [str(uuid.uuid4()) for _ in range(5)]
    with (
        # Both helpers are imported function-locally in sync.views, so they must be
        # patched at their source modules where the local import resolves them.
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
    ):
        with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
            resp = admin_client.post(
                _url(project),
                _payload(created=[{"id": tid, "name": f"T{n}"} for n, tid in enumerate(ids)]),
                format="json",
            )
        assert resp.status_code == 200

    assert mock_bcast.call_count == 1
    _project_id, event_type, payload = mock_bcast.call_args.args
    assert event_type == "tasks_bulk_mutated"
    assert sorted(payload["task_ids"]) == sorted(ids)


@pytest.mark.django_db
def test_existing_row_lookup_is_a_single_bulk_fetch(
    admin_client: APIClient, project: Project
) -> None:
    """The existing-row lookup is one IN query for the whole batch, not one per row.

    Before #809, apply_task_changes issued Task.objects.filter(pk=row).first() per
    row (N SELECT ... LIMIT 1). Now a single filter(pk__in=...) prefetch serves every
    bucket. Asserting exactly one `id IN (...)` query proves the per-row SELECT is gone.
    """
    tasks = [Task.objects.create(project=project, name=f"T{i}") for i in range(10)]
    payload = _payload(
        updated=[{"id": str(t.pk), "notes": f"note {i}"} for i, t in enumerate(tasks)]
    )
    with CaptureQueriesContext(connection) as ctx:
        resp = admin_client.post(_url(project), payload, format="json")
    assert resp.status_code == 200

    bulk_fetches = [q for q in ctx.captured_queries if '"projects_task"."id" IN (' in q["sql"]]
    assert len(bulk_fetches) == 1


# ---------------------------------------------------------------------------
# Write-amplification regression (#1527)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_bulk_upload_watermark_updates_project_once(
    admin_client: APIClient, project: Project
) -> None:
    """A multi-row batch issues ONE watermark UPDATE, not one per row (#1527).

    The per-row ``post_save`` watermark receiver used to UPDATE projects_project
    once per saved task, re-locking the same project row N times inside the batch
    transaction. ``coalesce_watermark_bumps`` now folds them into a single
    ``Greatest`` UPDATE. Ten updated rows must produce exactly one watermark write.
    """
    tasks = [Task.objects.create(project=project, name=f"T{i}") for i in range(10)]
    payload = _payload(
        updated=[{"id": str(t.pk), "notes": f"note {i}"} for i, t in enumerate(tasks)]
    )
    with CaptureQueriesContext(connection) as ctx:
        resp = admin_client.post(_url(project), payload, format="json")
    assert resp.status_code == 200

    watermark_updates = [
        q
        for q in ctx.captured_queries
        if 'UPDATE "projects_project"' in q["sql"] and "last_sync_version" in q["sql"]
    ]
    assert len(watermark_updates) == 1


@pytest.mark.django_db
def test_bulk_upload_server_version_increment_uses_returning(
    admin_client: APIClient, project: Project
) -> None:
    """Each row's server_version bump is one ``UPDATE ... RETURNING`` (#1527).

    Previously VersionedModel.save() did ``update(server_version=F(...) + 1)`` then a
    separate ``values_list(...).get()`` refetch — two queries per row. It is now a
    single statement, so a five-row update batch produces five RETURNING updates and
    no separate server_version refetch.
    """
    tasks = [Task.objects.create(project=project, name=f"T{i}") for i in range(5)]
    payload = _payload(
        updated=[{"id": str(t.pk), "notes": f"note {i}"} for i, t in enumerate(tasks)]
    )
    with CaptureQueriesContext(connection) as ctx:
        resp = admin_client.post(_url(project), payload, format="json")
    assert resp.status_code == 200

    returning_bumps = [
        q
        for q in ctx.captured_queries
        if 'UPDATE "projects_task"' in q["sql"]
        and "server_version" in q["sql"]
        and "RETURNING" in q["sql"]
    ]
    assert len(returning_bumps) == 5


@pytest.mark.django_db
def test_bulk_batch_versions_and_watermark_are_correct(
    admin_client: APIClient, project: Project
) -> None:
    """A 50-row mixed batch yields the same versions + watermark as the per-row path.

    #1527 must not change any observable value. Created rows land at
    server_version 1; updated rows (created at 1) advance to 2; the denormalized
    ``Project.last_sync_version`` must equal both the batch max and the
    authoritative union snapshot.
    """
    from trueppm_api.apps.sync.views import ProjectSyncView

    existing = [Task.objects.create(project=project, name=f"E{i}") for i in range(25)]
    created_ids = [str(uuid.uuid4()) for _ in range(25)]
    payload = _payload(
        created=[{"id": cid, "name": f"C{i}"} for i, cid in enumerate(created_ids)],
        updated=[{"id": str(t.pk), "notes": f"u{i}"} for i, t in enumerate(existing)],
    )
    resp = admin_client.post(_url(project), payload, format="json")
    assert resp.status_code == 200

    for cid in created_ids:
        assert Task.objects.get(pk=cid).server_version == 1
    for t in existing:
        t.refresh_from_db()
        assert t.server_version == 2

    project.refresh_from_db()
    assert project.last_sync_version == 2
    assert project.last_sync_version == ProjectSyncView._snapshot_max_version(project)
    assert resp.json()["timestamp"] == 2


@pytest.mark.django_db
def test_versioned_save_default_path_still_probes_existence() -> None:
    """Outside a sync batch, save() still runs the exists() probe (unchanged path).

    #1527 only skips the probe when the caller passes ``known_exists`` (or Django's
    ``force_insert``). The default path must be byte-for-byte identical for every
    other caller, so an update of a loaded row still issues the disambiguating
    ``SELECT ... LIMIT 1`` probe. Uses Calendar — a VersionedModel that does not
    override save() — to isolate the base behavior from Task's own probes.
    """
    cal = Calendar.objects.create(name="Cal")
    cal.name = "Cal2"
    with CaptureQueriesContext(connection) as ctx:
        cal.save()
    sqls = [q["sql"] for q in ctx.captured_queries]
    assert any(s.lstrip().startswith("SELECT") and " LIMIT 1" in s for s in sqls)
    assert any("RETURNING" in s and "server_version" in s for s in sqls)


@pytest.mark.django_db
def test_versioned_save_known_exists_skips_probe() -> None:
    """``save(known_exists=True)`` skips the exists() probe but still increments (#1527)."""
    cal = Calendar.objects.create(name="Cal")
    start = cal.server_version
    cal.name = "Cal2"
    with CaptureQueriesContext(connection) as ctx:
        cal.save(known_exists=True)
    sqls = [q["sql"] for q in ctx.captured_queries]
    assert not any(s.lstrip().startswith("SELECT") and " LIMIT 1" in s for s in sqls)
    assert any("RETURNING" in s and "server_version" in s for s in sqls)
    cal.refresh_from_db()
    assert cal.name == "Cal2"
    assert cal.server_version == start + 1


# ---------------------------------------------------------------------------
# Cross-project IDOR in the created (upsert) bucket (#887)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_created_bucket_cross_project_collision_is_409(
    admin_client: APIClient, project: Project, user: Any
) -> None:
    """A created-row id colliding with a task in another project is a 409, not a write.

    Regression for #887: the created-bucket upsert used to bulk-fetch existing
    rows unscoped by project, so a user who is ADMIN on project A but a
    non-member of project B could push created:[{id: <task in B>}] to A and have
    its content applied to B's task under A's role. The lookup is now scoped to
    the URL project; a foreign id collision forces a 409 (regenerate the id).
    """
    # A second project the uploading user has NO membership on.
    other = Project.objects.create(name="Foreign", start_date=date(2026, 1, 1))
    victim = Task.objects.create(project=other, name="Untouched", notes="original")

    resp = admin_client.post(
        _url(project),
        _payload(created=[{"id": str(victim.pk), "name": "hijacked", "notes": "pwned"}]),
        format="json",
    )

    assert resp.status_code == 409
    # The foreign task must be completely unchanged.
    victim.refresh_from_db()
    assert victim.name == "Untouched"
    assert victim.notes == "original"
    assert victim.project_id == other.pk
    # And no batch envelope committed (the whole transaction rolled back).
    assert not SyncBatch.objects.exists()


@pytest.mark.django_db
def test_created_bucket_same_project_recreate_still_idempotent(
    admin_client: APIClient, project: Project
) -> None:
    """A created-row id that already exists *in the same project* still upserts.

    Guards that the #887 fix did not break the legitimate idempotent re-create
    path (a row that landed in a prior batch and is re-pushed on reconnect).
    """
    task = Task.objects.create(project=project, name="Orig", notes="")
    resp = admin_client.post(
        _url(project),
        _payload(created=[{"id": str(task.pk), "name": "Orig", "notes": "re-created"}]),
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.notes == "re-created"


# ---------------------------------------------------------------------------
# Cross-actor SyncBatch replay leak (#894)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_batch_replay_is_isolated_per_actor(project: Project) -> None:
    """One user cannot replay another user's batch response by reusing its id.

    Regression for #894: SyncBatch was keyed by (project, client_batch_id) only,
    so a second member reusing the same client_batch_id received the first user's
    stored response body (task ids, server_versions, watermark) — an information
    leak across actors. Dedup is now scoped to (project, actor_user,
    client_batch_id): the reused id is a distinct batch and applies fresh.
    """
    admin = User.objects.create_user(username="actor_admin", password="pw")
    _make_membership(project, admin, Role.ADMIN)
    member = User.objects.create_user(username="actor_member", password="pw")
    _make_membership(project, member, Role.MEMBER)

    batch_id = str(uuid.uuid4())

    admin_c = APIClient()
    admin_c.force_authenticate(user=admin)
    admin_task = str(uuid.uuid4())
    r_admin = admin_c.post(
        _url(project),
        _payload(client_batch_id=batch_id, created=[{"id": admin_task, "name": "AdminRow"}]),
        format="json",
    )
    assert r_admin.status_code == 200

    # The member reuses the *same* client_batch_id. It must NOT replay the
    # admin's stored body — it applies the member's own batch.
    member_c = APIClient()
    member_c.force_authenticate(user=member)
    member_task = str(uuid.uuid4())
    r_member = member_c.post(
        _url(project),
        _payload(client_batch_id=batch_id, created=[{"id": member_task, "name": "MemberRow"}]),
        format="json",
    )
    assert r_member.status_code == 200
    # Crucially, the member did not receive the admin's response body.
    assert r_member.json() != r_admin.json()
    assert r_member.json()["applied"]["tasks"]["created"][0]["id"] == member_task
    # Two distinct batch rows, one per actor.
    assert SyncBatch.objects.filter(client_batch_id=batch_id).count() == 2
    assert SyncBatch.objects.filter(client_batch_id=batch_id, actor_user=admin).count() == 1
    assert SyncBatch.objects.filter(client_batch_id=batch_id, actor_user=member).count() == 1


@pytest.mark.django_db
def test_same_actor_replay_still_idempotent(
    admin_client: APIClient, project: Project, user: Any
) -> None:
    """The same user replaying their own batch id still gets the stored response.

    Guards that actor-scoping (#894) did not break the legitimate lost-ACK retry.
    """
    batch_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())
    payload = _payload(client_batch_id=batch_id, created=[{"id": task_id, "name": "Once"}])

    first = admin_client.post(_url(project), payload, format="json")
    assert first.status_code == 200
    second = admin_client.post(_url(project), payload, format="json")
    assert second.status_code == 200
    assert second.json() == first.json()
    assert Task.objects.filter(pk=task_id).count() == 1
    assert SyncBatch.objects.filter(client_batch_id=batch_id, actor_user=user).count() == 1


@pytest.mark.django_db
def test_purge_deletes_expired_batches(project: Project) -> None:
    from trueppm_api.apps.sync.tasks import _do_purge

    fresh = SyncBatch.objects.create(client_batch_id=uuid.uuid4(), project=project)
    old = SyncBatch.objects.create(client_batch_id=uuid.uuid4(), project=project)
    SyncBatch.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(hours=48))

    _do_purge()

    assert SyncBatch.objects.filter(pk=fresh.pk).exists()
    assert not SyncBatch.objects.filter(pk=old.pk).exists()


@pytest.mark.django_db
def test_sync_link_to_active_sprint_enters_pending_acceptance(
    admin_client: APIClient, project: Project
) -> None:
    """ADR-0102 §4: a task linked to an ACTIVE sprint via the sync upload enters
    pending-acceptance (sprint_pending=True + a PENDING SprintScopeChange) — it
    does NOT land straight in the commitment. Closes the bypass where the gate
    lived only in TaskViewSet.perform_update and the sync path skipped it.
    """
    sprint = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 1, 3),
        finish_date=date(2026, 1, 17),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(project=project, name="Injected via sync", duration=1)
    resp = admin_client.post(
        _url(project),
        _payload(updated=[{"id": str(task.pk), "sprint": str(sprint.pk)}]),
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.sprint_id == sprint.pk
    assert task.sprint_pending is True
    assert SprintScopeChange.objects.filter(
        sprint=sprint, task=task, status=ScopeChangeStatus.PENDING
    ).exists()
