"""Conformance tests for the denormalized sync watermark (ADR-0142, #822).

The whole point of ``Project.last_sync_version`` is that it equals what the
12-table ``UNION ALL`` (``ProjectSyncView._snapshot_max_version``) would return.
These tests are the drift guard: they touch each union-participating model and
assert the column tracks the union exactly. If the union gains a table without a
matching receiver in ``apps/sync/receivers.py``, the relevant assertion fails.
"""

from __future__ import annotations

from datetime import date, time

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.models import TaskLink
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Label,
    Project,
    RetroActionItem,
    Risk,
    Sprint,
    SprintRetro,
    Task,
    TaskRecurrenceRule,
    TaskRelation,
    TaskSuggestedAssignee,
)
from trueppm_api.apps.sync.views import ProjectSyncView
from trueppm_api.apps.timetracking.models import TimeEntry

User = get_user_model()


def _column(project: Project) -> int:
    project.refresh_from_db(fields=["last_sync_version"])
    return int(project.last_sync_version)


def _union(project: Project) -> int:
    return ProjectSyncView._snapshot_max_version(project)


def _assert_in_sync(project: Project) -> None:
    assert _column(project) == _union(project)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WM", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="wm_user", password="pw")


@pytest.mark.django_db
def test_column_tracks_union_across_every_synced_model(
    project: Project, calendar: Calendar, user: object
) -> None:
    """Creating and updating one of each union model keeps column == union."""
    # The project's own save (the fixture create) already bumped it.
    _assert_in_sync(project)

    task = Task.objects.create(project=project, name="T1", duration=3)
    _assert_in_sync(project)

    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    _assert_in_sync(project)

    Risk.objects.create(project=project, title="R1", probability=3, impact=3)
    _assert_in_sync(project)

    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
    )
    _assert_in_sync(project)

    retro = SprintRetro.objects.create(sprint=sprint, notes="went well")
    _assert_in_sync(project)

    RetroActionItem.objects.create(retro=retro, text="do better")
    _assert_in_sync(project)

    TaskSuggestedAssignee.objects.create(task=task, suggested_user=user)
    _assert_in_sync(project)

    TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    _assert_in_sync(project)

    TaskRecurrenceRule.objects.create(
        task=task, frequency="daily", interval=1, time_of_day=time(9, 0)
    )
    _assert_in_sync(project)

    # Time entry — reached through its task's project (ADR-0185 §6).
    TimeEntry.objects.create(task=task, user=user, minutes=30)
    _assert_in_sync(project)

    # Label catalog (ADR-0400) — direct project FK; the receiver + union must agree.
    Label.objects.create(project=project, name="tech-debt", color="amber")
    _assert_in_sync(project)

    # A calendar change bumps every project using it.
    calendar.name = "Std (edited)"
    calendar.save()
    _assert_in_sync(project)

    # Updates (not just inserts) keep tracking.
    task.name = "T1 renamed"
    task.save()
    _assert_in_sync(project)

    # Soft-delete bumps server_version → watermark follows.
    task.soft_delete()
    _assert_in_sync(project)


@pytest.mark.django_db
def test_dependency_change_does_not_move_watermark(project: Project) -> None:
    """The union tracks dependencies via the predecessor task's version, so a
    dependency-only change must not move the watermark — there is no receiver."""
    a = Task.objects.create(project=project, name="A", duration=1)
    Task.objects.create(project=project, name="B", duration=1)
    before = _column(project)

    Dependency.objects.create(predecessor=a, successor=Task.objects.get(name="B"))

    # Column unchanged, and still equal to the union (which also ignores the
    # dependency's own server_version).
    assert _column(project) == before
    _assert_in_sync(project)


@pytest.mark.django_db
def test_task_relation_change_does_not_move_watermark(project: Project) -> None:
    """The union tracks relations via the SOURCE task's version (ADR-0455, mirroring
    Dependency: ``MAX(t.server_version)``, never ``taskrelation.server_version``), so a
    relation-only change must not move the watermark — there is no receiver. The
    accepted quirk: a relation-only edit re-delivers under upsert until an
    accompanying task edit advances the watermark."""
    a = Task.objects.create(project=project, name="A", duration=1)
    b = Task.objects.create(project=project, name="B", duration=1)
    before = _column(project)

    rel = TaskRelation.objects.create(source=a, target=b, relation_type="relates_to")
    # Even repeated relation-only edits (its own server_version climbs) must not
    # move the watermark, since the union keys off the source task's version.
    for i in range(4):
        rel.note = f"n{i}"
        rel.save()

    assert _column(project) == before
    _assert_in_sync(project)


@pytest.mark.django_db
def test_watermark_monotonic_and_matches_union_after_many_writes(project: Project) -> None:
    task = Task.objects.create(project=project, name="T", duration=1)
    seen = _column(project)
    for i in range(5):
        task.name = f"rename-{i}"
        task.save()
        now = _column(project)
        assert now >= seen  # monotonic
        seen = now
        _assert_in_sync(project)


@pytest.mark.django_db
def test_fallback_flag_uses_union(project: Project, settings: object) -> None:
    """With SYNC_WATERMARK_USE_COLUMN off the view falls back to the union."""
    Task.objects.create(project=project, name="T", duration=1)
    # The view always re-fetches the project before reading the watermark; mirror
    # that so we read the maintained column value, not the stale fixture instance.
    project.refresh_from_db(fields=["last_sync_version"])

    settings.SYNC_WATERMARK_USE_COLUMN = False  # type: ignore[attr-defined]
    assert ProjectSyncView._watermark(project) == _union(project)
    settings.SYNC_WATERMARK_USE_COLUMN = True  # type: ignore[attr-defined]
    assert ProjectSyncView._watermark(project) == _column(project)


@pytest.mark.django_db
def test_coalesced_bumps_match_union(project: Project) -> None:
    """A batch inside ``coalesce_watermark_bumps`` still leaves column == union (#1527).

    The batch context defers each row's per-row watermark UPDATE and flushes a
    single ``Greatest`` UPDATE on exit. Because ``Greatest`` is monotonic, the
    coalesced result must equal the authoritative union — the amplification is
    removed without changing the observable watermark. Creating then updating rows
    inside the context drives server_version past the pre-context value, so the
    assertion fails if the deferred flush never ran.
    """
    from django.db import transaction

    from trueppm_api.apps.sync.receivers import coalesce_watermark_bumps

    with transaction.atomic(), coalesce_watermark_bumps():
        tasks = [Task.objects.create(project=project, name=f"BT{i}", duration=1) for i in range(3)]
        for t in tasks:
            t.name = f"{t.name}-x"
            t.save(known_exists=True)

    # Flush ran on context exit (inside the transaction); the max server_version
    # across the three tasks is 2 (create=1, then one update=2).
    assert _column(project) == 2
    _assert_in_sync(project)
