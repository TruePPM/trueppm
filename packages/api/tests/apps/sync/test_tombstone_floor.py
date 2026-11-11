"""Tombstone-retention floor on the delta pulls (#2474).

Once ``sync.reap_domain_tombstones`` hard-deletes a tombstone, no delta can tell a
client the row was deleted. A client whose ``since`` predates that tombstone must
be told to re-sync rather than handed a delta that silently omits the deletion.

Verified here:
- The reap raises ``Project.tombstone_floor`` to the highest reaped ``sync_seq``,
  cascades included, clamped to the project's sequence head, atomically with the
  delete.
- ``since >= floor`` (and ``since == 0``) get a normal delta; ``0 < since < floor``
  gets the ``resync_required`` envelope with no changes.
- A reap that commits between the pull's pre-check and its delta queries is
  still caught (the post-query re-read).
- The program pull carries the same guard, raised by ``hard_delete_program``.
- A full re-sync after a floor raise terminates (no resync loop).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.sync import tasks as reap_tasks
from trueppm_api.apps.sync import views as sync_views
from trueppm_api.apps.sync.models import ProgramSyncSequence
from trueppm_api.apps.sync.tasks import _do_reap

User = get_user_model()

RESYNC_ENVELOPE = {
    "changes": {},
    "timestamp": 0,
    "next_cursor": None,
    "has_more": False,
    "resync_required": True,
}


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="floor_user", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="FloorProj", start_date=date(2026, 1, 1), calendar=cal)


@pytest.fixture
def client(user: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sync/"


def _tombstone(project: Project, name: str = "T") -> Task:
    """A task soft-deleted through save(), so its tombstone draws a fresh sync_seq."""
    task = Task.objects.create(project=project, name=name, duration=1)
    task.is_deleted = True
    task.deleted_at = timezone.now()
    task.save()
    task.refresh_from_db()
    return task


def _head(project: Project) -> int:
    return int(Project.objects.values_list("last_sync_version", flat=True).get(pk=project.pk))


def _floor(project: Project) -> int:
    return int(Project.objects.values_list("tombstone_floor", flat=True).get(pk=project.pk))


# ---------------------------------------------------------------------------
# Reap side
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_raises_floor_to_highest_reaped_sync_seq(project: Project) -> None:
    first = _tombstone(project, "a")
    second = _tombstone(project, "b")
    Task.objects.create(project=project, name="live", duration=1)
    assert _floor(project) == 0

    _do_reap(override_days=0)

    assert not Task.objects.filter(pk__in=[first.pk, second.pk]).exists()
    assert _floor(project) == second.sync_seq
    assert _floor(project) <= _head(project)


@pytest.mark.django_db
def test_reap_floor_counts_cascaded_rows(project: Project) -> None:
    """A Dependency tombstone still inside its window is cascaded by its reaped task.

    It vanishes without a deliverable tombstone just like the task, so the floor
    must cover its cursor too, even though the Dependency itself was not eligible.
    """
    pred = _tombstone(project, "pred")
    succ = Task.objects.create(project=project, name="succ", duration=1)
    # Created after the task was tombstoned, so its sync_seq is above the task's.
    dep = Dependency.objects.create(predecessor=pred, successor=succ)
    dep.refresh_from_db()
    assert dep.sync_seq > pred.sync_seq

    # Only Task is age-eligible for Dependency's deleted_at filter (dep is live).
    _do_reap(override_days=0)

    assert not Dependency.objects.filter(pk=dep.pk).exists()
    assert _floor(project) == dep.sync_seq


@pytest.mark.django_db
def test_reap_floor_never_lowers(project: Project) -> None:
    tomb = _tombstone(project)
    high = tomb.sync_seq + 1_000
    Project.objects.filter(pk=project.pk).update(tombstone_floor=high, last_sync_version=high)
    _do_reap(override_days=0)
    assert _floor(project) == high


@pytest.mark.django_db
def test_reap_delete_and_floor_are_one_transaction(project: Project) -> None:
    """If anything in a project's reap fails, neither the delete nor the floor lands."""
    task = _tombstone(project)
    real = reap_tasks._delete_tracking_sync_seq
    calls = {"n": 0}

    def flaky(qs: Any) -> tuple[int, int]:
        calls["n"] += 1
        result = real(qs)
        if calls["n"] == 1:
            # Task is the first registry entry: its delete has run. Fail now.
            raise RuntimeError("boom")
        return result

    with (
        patch.object(reap_tasks, "_delete_tracking_sync_seq", side_effect=flaky),
        pytest.raises(RuntimeError),
    ):
        _do_reap(override_days=0)

    assert Task.objects.filter(pk=task.pk).exists()
    assert _floor(project) == 0


@pytest.mark.django_db
def test_reap_skips_archived_project_floor(project: Project) -> None:
    _tombstone(project)
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    _do_reap(override_days=0)
    assert _floor(project) == 0


@pytest.mark.django_db
def test_save_of_stale_project_instance_cannot_lower_floor(project: Project) -> None:
    stale = Project.objects.get(pk=project.pk)
    _tombstone(project)
    _do_reap(override_days=0)
    raised = _floor(project)
    assert raised > 0

    stale.name = "renamed"
    stale.save()

    assert _floor(project) == raised


# ---------------------------------------------------------------------------
# Project pull
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_since_at_or_above_floor_gets_normal_delta(client: APIClient, project: Project) -> None:
    tomb = _tombstone(project)
    since = _head(project)  # this client already received the tombstone
    _do_reap(override_days=0)
    assert _floor(project) == tomb.sync_seq <= since

    later = Task.objects.create(project=project, name="later", duration=1)
    body = client.get(_url(project), {"since": since}).json()

    assert body["resync_required"] is False
    assert [r["id"] for r in body["changes"]["tasks"]["updated"]] == [str(later.pk)]


@pytest.mark.django_db
def test_since_below_floor_gets_resync_and_no_partial_delta(
    client: APIClient, project: Project
) -> None:
    since = _head(project)  # taken BEFORE the delete: this client holds the live row
    tomb = _tombstone(project)
    other = _tombstone(project, "other-recent")  # a surviving-tombstone candidate
    Task.objects.create(project=project, name="live-after", duration=1)
    # Reap only the first: backdate the second out of eligibility.
    Task.objects.filter(pk=other.pk).update(deleted_at=timezone.now() + timedelta(days=1))
    _do_reap(override_days=0)
    assert not Task.objects.filter(pk=tomb.pk).exists()
    assert since < _floor(project)

    resp = client.get(_url(project), {"since": since})

    assert resp.status_code == 200
    assert resp.json() == RESYNC_ENVELOPE


@pytest.mark.django_db
def test_since_zero_is_always_served_and_recovery_terminates(
    client: APIClient, project: Project
) -> None:
    _tombstone(project)
    Task.objects.create(project=project, name="live", duration=1)
    _do_reap(override_days=0)
    assert _floor(project) > 0

    full = client.get(_url(project), {"since": 0}).json()
    assert full["resync_required"] is False
    assert full["timestamp"] >= _floor(project)

    # The checkpoint the re-sync adopted must not itself be below the floor.
    again = client.get(_url(project), {"since": full["timestamp"]}).json()
    assert again["resync_required"] is False


@pytest.mark.django_db
def test_reap_racing_the_pull_is_caught_by_the_post_query_reread(
    client: APIClient, project: Project
) -> None:
    """Interleaving: pre-check reads floor 0, the reap commits, then the delta runs.

    The delta queries no longer see the reaped tombstone. Without the re-read the
    response would be a normal-looking delta with that deletion missing; the
    re-read after the delta queries observes the floor the reap raised in the same
    transaction as its delete, and answers resync_required instead.
    """
    since = _head(project)
    _tombstone(project)
    real = sync_views.paginate_changes

    def reap_then_page(*args: Any, **kwargs: Any) -> Any:
        _do_reap(override_days=0)
        return real(*args, **kwargs)

    with patch.object(sync_views, "paginate_changes", side_effect=reap_then_page):
        body = client.get(_url(project), {"since": since}).json()

    assert body == RESYNC_ENVELOPE


@pytest.mark.django_db
def test_floor_post_check_is_one_primary_key_read(client: APIClient, project: Project) -> None:
    Task.objects.create(project=project, name="live", duration=1)
    with CaptureQueriesContext(connection) as ctx:
        client.get(_url(project), {"since": 1})
    floor_reads = [q["sql"] for q in ctx.captured_queries if '"tombstone_floor"' in q["sql"]]
    # The project fetch selects every column (incl. tombstone_floor); the post-check
    # selects only it. Exactly one dedicated read, keyed by primary key.
    dedicated = [
        sql for sql in floor_reads if sql.startswith('SELECT "projects_project"."tombstone_floor"')
    ]
    assert len(dedicated) == 1, floor_reads
    assert '"projects_project"."id" =' in dedicated[0]


@pytest.mark.django_db
def test_normal_response_carries_resync_false(client: APIClient, project: Project) -> None:
    body = client.get(_url(project)).json()
    assert body["resync_required"] is False


# ---------------------------------------------------------------------------
# Program pull
# ---------------------------------------------------------------------------

PROGRAM_URL = "/api/v1/sync/user/programs/"


@pytest.fixture
def program_client(user: Any) -> tuple[APIClient, Program]:
    ProgramSyncSequence.objects.get_or_create(pk=ProgramSyncSequence.SINGLETON_PK)
    program = Program.objects.create(name="P", description="")
    ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c, program


def _program_floor() -> int:
    return int(
        ProgramSyncSequence.objects.values_list("tombstone_floor", flat=True).get(
            pk=ProgramSyncSequence.SINGLETON_PK
        )
    )


@pytest.mark.django_db
def test_program_pull_below_floor_gets_resync(program_client: tuple[APIClient, Program]) -> None:
    c, _ = program_client
    since = c.get(PROGRAM_URL).json()["timestamp"]
    ProgramSyncSequence.objects.filter(pk=ProgramSyncSequence.SINGLETON_PK).update(
        tombstone_floor=since + 1, value=since + 1
    )

    assert c.get(PROGRAM_URL, {"since": since}).json() == RESYNC_ENVELOPE
    assert c.get(PROGRAM_URL, {"since": since + 1}).json()["resync_required"] is False
    assert c.get(PROGRAM_URL, {"since": 0}).json()["resync_required"] is False


@pytest.mark.django_db
def test_hard_delete_program_raises_program_floor(
    program_client: tuple[APIClient, Program], user: Any
) -> None:
    from trueppm_api.apps.access.services import hard_delete_program

    c, _ = program_client
    doomed = Program.objects.create(name="Sample", description="")
    ProgramMembership.objects.create(program=doomed, user=user, role=Role.ADMIN)
    since = c.get(PROGRAM_URL).json()["timestamp"]  # this client now holds `doomed`

    hard_delete_program(doomed.pk)

    assert _program_floor() > since
    assert c.get(PROGRAM_URL, {"since": since}).json() == RESYNC_ENVELOPE
    full = c.get(PROGRAM_URL, {"since": 0}).json()
    assert full["timestamp"] >= _program_floor()
    assert str(doomed.pk) not in {r["id"] for r in full["changes"]["programs"]["updated"]}
    assert c.get(PROGRAM_URL, {"since": full["timestamp"]}).json()["resync_required"] is False
