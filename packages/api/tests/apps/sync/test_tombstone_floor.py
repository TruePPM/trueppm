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
- Only rows the project's own pull delivers count: a cascaded cross-project edge
  does not inflate the floor.
- One project's reap failing (a deadlock) does not abort the others.
- The program pull carries the same guard, raised by ``hard_delete_program`` and
  ``purge_workspace``.
- The upgrade backfill makes every held cursor re-sync exactly once.
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
from trueppm_api.apps.scheduling.models import MonteCarloRun
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
    dep.is_deleted = True
    dep.deleted_at = timezone.now() + timedelta(days=1)  # still inside its window
    dep.save()
    dep.refresh_from_db()
    assert dep.sync_seq > pred.sync_seq
    head = _head(project)

    # Only Task is age-eligible; the Dependency tombstone goes by cascade.
    _do_reap(override_days=0)

    assert not Dependency.objects.filter(pk=dep.pk).exists()
    assert _floor(project) == dep.sync_seq
    # A cascaded tombstone does not draw a fresh head (only a live row does).
    assert _head(project) == head


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

    def flaky(qs: Any, project_id: Any) -> tuple[int, int, bool]:
        calls["n"] += 1
        result = real(qs, project_id)
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


@pytest.mark.django_db
def test_purge_workspace_raises_program_floor(
    program_client: tuple[APIClient, Program],
) -> None:
    """``purge_workspace`` hard-deletes every program and program membership (G4)."""
    from trueppm_api.apps.workspace.services import purge_workspace

    c, program = program_client
    since = c.get(PROGRAM_URL).json()["timestamp"]  # this client now holds `program`

    purge_workspace()

    assert not Program.objects.filter(pk=program.pk).exists()
    assert _program_floor() > since
    assert c.get(PROGRAM_URL, {"since": since}).json() == RESYNC_ENVELOPE


# ---------------------------------------------------------------------------
# Reap robustness and floor scoping
# ---------------------------------------------------------------------------


def _other_project(name: str) -> Project:
    cal = Calendar.objects.create(name=f"Cal {name}")
    return Project.objects.create(name=name, start_date=date(2026, 1, 1), calendar=cal)


@pytest.mark.django_db
def test_reap_failure_in_one_project_does_not_abort_the_rest(project: Project) -> None:
    """A deadlock in one project's reap rolls that project back and moves on (G1)."""
    from django.db import OperationalError

    other = _other_project("Other")
    doomed_here = _tombstone(project, "here")
    doomed_there = _tombstone(other, "there")
    real = reap_tasks._delete_tracking_sync_seq

    def _flaky(qs: Any, project_id: Any) -> tuple[int, int, bool]:
        if project_id == project.pk:
            raise OperationalError("deadlock detected")
        return real(qs, project_id)

    with patch.object(reap_tasks, "_delete_tracking_sync_seq", side_effect=_flaky):
        _do_reap(override_days=0)

    # The failing project is rolled back as a unit: tombstone kept, floor untouched.
    assert Task.objects.filter(pk=doomed_here.pk).exists()
    assert _floor(project) == 0
    # The other project was still reaped, and its floor raised.
    assert not Task.objects.filter(pk=doomed_there.pk).exists()
    assert _floor(other) == doomed_there.sync_seq


@pytest.mark.django_db
def test_cross_project_edge_does_not_inflate_floor(project: Project) -> None:
    """A cascaded cross-project edge is in neither pull's delta (G2, G3).

    The edge drew its ``sync_seq`` from the predecessor's project, whose head is far
    above this one's. Counting it would push this project's floor to its head (via
    the clamp) and send every client into a spurious re-sync.
    """
    upstream = _other_project("Upstream")
    Project.objects.filter(pk=upstream.pk).update(last_sync_version=10_000)
    pred = Task.objects.create(project=upstream, name="pred", duration=1)
    succ = Task.objects.create(project=project, name="succ", duration=1)
    dep = Dependency.objects.create(predecessor=pred, successor=succ)
    dep.refresh_from_db()
    succ.is_deleted = True
    succ.deleted_at = timezone.now()
    succ.save()
    succ.refresh_from_db()
    # Later activity in this project puts its head above the reaped task's cursor.
    Task.objects.create(project=project, name="later", duration=1)
    assert dep.sync_seq > _head(project) > succ.sync_seq

    _do_reap(override_days=0)

    assert not Dependency.objects.filter(pk=dep.pk).exists()
    assert _floor(project) == succ.sync_seq
    assert _floor(project) <= _head(project)
    # The edge was cascaded under this project's reap, never under upstream's.
    assert _floor(upstream) == 0


@pytest.mark.django_db
def test_reap_floor_is_clamped_to_head(project: Project) -> None:
    """A counted cursor above the head is clamped, so a full re-sync terminates (G3)."""
    _tombstone(project)
    real = reap_tasks._delete_tracking_sync_seq

    def _inflated(qs: Any, project_id: Any) -> tuple[int, int, bool]:
        deleted, top, live = real(qs, project_id)
        return deleted, (top + 1_000_000 if deleted else top), live

    with patch.object(reap_tasks, "_delete_tracking_sync_seq", side_effect=_inflated):
        _do_reap(override_days=0)

    assert _floor(project) == _head(project)


# ---------------------------------------------------------------------------
# Upgrade backfill (sync.0008) — exercised through the function it calls
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_upgrade_backfill_makes_every_held_cursor_resync_once(
    client: APIClient, project: Project, program_client: tuple[APIClient, Program]
) -> None:
    from trueppm_api.apps.sync.sequence import backfill_tombstone_floors

    Task.objects.create(project=project, name="t", duration=1)
    since = client.get(_url(project)).json()["timestamp"]
    pc, _ = program_client
    program_since = pc.get(PROGRAM_URL).json()["timestamp"]
    assert since > 0 and program_since > 0
    empty = _other_project("Empty")
    Project.objects.filter(pk=empty.pk).update(last_sync_version=0)

    backfill_tombstone_floors(Project, ProgramSyncSequence, MonteCarloRun)

    # A client sitting exactly on the old head is still asked to re-sync.
    assert client.get(_url(project), {"since": since}).json() == RESYNC_ENVELOPE
    full = client.get(_url(project), {"since": 0}).json()
    assert full["timestamp"] >= _floor(project) == _head(project)
    after = client.get(_url(project), {"since": full["timestamp"]}).json()
    assert after["resync_required"] is False

    assert pc.get(PROGRAM_URL, {"since": program_since}).json() == RESYNC_ENVELOPE
    pfull = pc.get(PROGRAM_URL, {"since": 0}).json()
    assert pfull["timestamp"] >= _program_floor()
    assert pc.get(PROGRAM_URL, {"since": pfull["timestamp"]}).json()["resync_required"] is False

    # A sequence that never handed out a cursor is left alone.
    assert _floor(empty) == 0 and _head(empty) == 0


@pytest.mark.django_db
def test_reap_cascading_a_live_row_raises_floor_to_head(
    client: APIClient, project: Project
) -> None:
    """A live row cascaded by the reap was delivered to clients AT its own cursor.

    A client whose ``since`` equals that row's ``sync_seq`` already holds it; a floor
    set to the row's own cursor does not sit above that ``since`` (the comparison is
    strict), so the client would keep the hard-deleted row forever. A live cascade
    therefore raises the floor to the project head, like a program hard delete.
    """
    pred = _tombstone(project, "pred")
    succ = Task.objects.create(project=project, name="succ", duration=1)
    dep = Dependency.objects.create(predecessor=pred, successor=succ)
    dep.refresh_from_db()
    assert dep.is_deleted is False

    body = client.get(_url(project), {"since": 0}).json()
    since = body["timestamp"]
    assert since == dep.sync_seq  # this client holds the live dependency

    _do_reap(override_days=0)

    assert not Dependency.objects.filter(pk=dep.pk).exists()
    assert client.get(_url(project), {"since": since}).json() == RESYNC_ENVELOPE
    assert _floor(project) == _head(project)


@pytest.mark.django_db
def test_upgrade_backfill_keeps_a_current_forecast_current(project: Project) -> None:
    """The backfill's head bump is not a plan change (G3).

    ``Project.last_sync_version`` doubles as the Monte Carlo plan version, so a run
    recorded at the pre-upgrade head must move with the bump or every current
    forecast reads ``project_changed`` after the upgrade.
    """
    from trueppm_api.apps.scheduling.forecast_staleness import forecast_staleness_from_run
    from trueppm_api.apps.sync.sequence import backfill_tombstone_floors

    Task.objects.create(project=project, name="t", duration=1)
    head = _head(project)
    current = MonteCarloRun.objects.create(project=project, n_simulations=10, plan_version=head)
    older = MonteCarloRun.objects.create(project=project, n_simulations=10, plan_version=head - 1)
    legacy = MonteCarloRun.objects.create(project=project, n_simulations=10, plan_version=None)

    backfill_tombstone_floors(Project, ProgramSyncSequence, MonteCarloRun)

    project.refresh_from_db()
    assert project.last_sync_version == head + 1
    current.refresh_from_db()
    facts = forecast_staleness_from_run(
        current,
        plan_version_current=project.last_sync_version,
        recalculated_at=project.recalculated_at,
        today=timezone.now().date(),
    )
    assert facts["forecast_staleness"] == "current"
    older.refresh_from_db()
    legacy.refresh_from_db()
    assert older.plan_version == head - 1  # it was already behind; it stays behind
    assert legacy.plan_version is None


@pytest.mark.django_db
def test_upgrade_backfill_moves_a_cached_forecast_at_the_old_head(project: Project) -> None:
    """A Member-triggered run lives only in the cache entry; it moves with the bump too."""
    from django.core.cache import cache

    from trueppm_api.apps.scheduling.views import mc_latest_cache_key
    from trueppm_api.apps.sync.sequence import (
        backfill_tombstone_floors,
        bump_cached_forecast_plan_versions,
    )

    Task.objects.create(project=project, name="t", duration=1)
    head = _head(project)
    stale = _other_project("Stale")
    Task.objects.create(project=stale, name="s", duration=1)
    stale_head = _head(stale)
    cache.set(mc_latest_cache_key(project.pk), {"plan_version": head, "p80": "x"}, 60)
    cache.set(mc_latest_cache_key(stale.pk), {"plan_version": stale_head - 1}, 60)
    try:
        backfill_tombstone_floors(Project, ProgramSyncSequence, MonteCarloRun)
        assert bump_cached_forecast_plan_versions(Project) == 1

        assert cache.get(mc_latest_cache_key(project.pk)) == {"plan_version": head + 1, "p80": "x"}
        assert cache.get(mc_latest_cache_key(stale.pk)) == {"plan_version": stale_head - 1}
    finally:
        cache.delete_many([mc_latest_cache_key(project.pk), mc_latest_cache_key(stale.pk)])
