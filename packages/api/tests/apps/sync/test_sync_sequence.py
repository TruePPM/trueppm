"""Invariants of the per-project sync sequence (ADR-0686, #2491).

``Project.last_sync_version`` allocates every synced row's ``sync_seq``. Two
properties are what make the delta pull correct, and every test here asserts one
of them:

* **Delivery** — after a write, the row's ``sync_seq`` is strictly greater than
  the watermark a client could have been holding a moment earlier, so the row is
  returned by ``sync_seq__gt=since``. This is what the old ``server_version``
  scheme could not guarantee: a per-row save counter compared against a
  project-wide maximum meant a cold row's version stayed *below* the checkpoint
  and it was never delivered again.
* **Termination** — the row's ``sync_seq`` never exceeds the watermark, so it is
  not redelivered on every subsequent pull.

These replace the ADR-0142 column-vs-union conformance tests. There is no union
left to conform to: the column is authoritative rather than a cache, which is
precisely the maintenance burden ADR-0686 retired.
"""

from __future__ import annotations

from datetime import date, time
from typing import Any

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
from trueppm_api.apps.timetracking.models import TimeEntry

User = get_user_model()


def _watermark(project: Project) -> int:
    project.refresh_from_db(fields=["last_sync_version"])
    return int(project.last_sync_version)


def _seq(row: Any) -> int:
    row.refresh_from_db(fields=["sync_seq"])
    return int(row.sync_seq)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WM", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="wm_user", password="pw")


@pytest.mark.django_db
def test_every_synced_write_is_deliverable_and_terminates(
    project: Project, calendar: Calendar, user: Any
) -> None:
    """One write of each synced model lands strictly inside (prior, watermark].

    Parameterizing would hide the setup chain (a retro needs a sprint, a link
    needs a task), so this walks the models in dependency order and asserts the
    same two properties after each write.
    """

    def check(row: Any, prior: int) -> int:
        seq = _seq(row)
        mark = _watermark(project)
        # Delivered: a client holding `prior` gets this row on its next pull.
        assert seq > prior, f"{type(row).__name__} is invisible to a since={prior} pull"
        # Terminates: the checkpoint covers it, so the pull after that does not
        # hand it back forever.
        assert seq <= mark, f"{type(row).__name__} sits above the watermark"
        return mark

    mark = _watermark(project)
    task = Task.objects.create(project=project, name="T1", duration=3)
    mark = check(task, mark)

    membership = ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    mark = check(membership, mark)

    risk = Risk.objects.create(project=project, title="R1", probability=3, impact=3)
    mark = check(risk, mark)

    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
    )
    mark = check(sprint, mark)

    retro = SprintRetro.objects.create(sprint=sprint, notes="went well")
    mark = check(retro, mark)

    action = RetroActionItem.objects.create(retro=retro, text="do better")
    mark = check(action, mark)

    suggested = TaskSuggestedAssignee.objects.create(task=task, suggested_user=user)
    mark = check(suggested, mark)

    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    mark = check(link, mark)

    rule = TaskRecurrenceRule.objects.create(
        task=task, frequency="daily", interval=1, time_of_day=time(9, 0)
    )
    mark = check(rule, mark)

    # Time entry — reached through its task's project (ADR-0185 §6).
    entry = TimeEntry.objects.create(task=task, user=user, minutes=30)
    mark = check(entry, mark)

    # Label catalog (ADR-0400) — direct project FK.
    label = Label.objects.create(project=project, name="tech-debt", color="amber")
    mark = check(label, mark)

    calendar.name = "Std (edited)"
    calendar.save()
    mark = check(calendar, mark)

    # Updates, not just inserts.
    task.name = "T1 renamed"
    task.save()
    mark = check(task, mark)

    # Soft-delete is a write like any other: the tombstone must be delivered.
    task.soft_delete()
    mark = check(task, mark)

    # The project row is itself a synced source.
    project.name = "WM renamed"
    project.save()
    check(project, mark)


@pytest.mark.django_db
def test_dependency_allocates_and_is_delivered(project: Project) -> None:
    """A dependency is its own sync collection, so it needs its own cursor.

    The delta filters ``dependencies`` on ``Dependency.sync_seq``. An edge that
    never allocated would sit at 0 forever and ``sync_seq__gt=since`` would never
    return it — not even on a cold start, which would hand an offline client a
    task list with no graph to recompute from.
    """
    a = Task.objects.create(project=project, name="A", duration=1)
    b = Task.objects.create(project=project, name="B", duration=1)
    before = _watermark(project)

    dep = Dependency.objects.create(predecessor=a, successor=b)

    assert _seq(dep) > before
    assert _seq(dep) <= _watermark(project)
    assert list(Dependency.objects.filter(sync_seq__gt=before)) == [dep]


@pytest.mark.django_db
def test_task_relation_allocates_on_every_edit(project: Project) -> None:
    """Relations (ADR-0455) are their own collection too, and mirror Dependency.

    A relation-only edit must reach the client on the next pull — under the old
    scheme its own ``server_version`` bumped and carried it, so riding a task's
    cursor instead would have silently dropped relation-only edits.
    """
    a = Task.objects.create(project=project, name="A", duration=1)
    b = Task.objects.create(project=project, name="B", duration=1)

    rel = TaskRelation.objects.create(source=a, target=b, relation_type="relates_to")
    seen = _seq(rel)
    for i in range(4):
        before = _watermark(project)
        rel.note = f"n{i}"
        rel.save()
        now = _seq(rel)
        assert now > seen, "a relation-only edit must advance its own cursor"
        assert now > before
        assert now <= _watermark(project)
        seen = now


@pytest.mark.django_db
def test_cursor_is_strictly_increasing_across_repeated_writes(project: Project) -> None:
    """Each save draws a fresh value — the cursor never stalls or moves backwards."""
    task = Task.objects.create(project=project, name="T", duration=1)
    seen = _seq(task)
    for i in range(5):
        task.name = f"rename-{i}"
        task.save()
        now = _seq(task)
        assert now > seen
        seen = now
        assert _watermark(project) >= now


@pytest.mark.django_db
def test_a_cold_row_is_not_buried_by_a_hot_one(project: Project) -> None:
    """The defect in one assertion: an unevenly-edited project must still deliver.

    Under the old scheme ``cold`` sat at ``server_version=2`` while the watermark
    had been dragged to 100+ by ``hot``, so ``server_version__gt=<watermark>``
    never returned it again.
    """
    hot = Task.objects.create(project=project, name="hot", duration=1)
    cold = Task.objects.create(project=project, name="cold", duration=1)

    for i in range(100):
        hot.name = f"hot-{i}"
        hot.save()

    since = _watermark(project)
    cold.name = "cold-EDITED"
    cold.save()

    assert _seq(cold) > since
    assert list(Task.objects.filter(project=project, sync_seq__gt=since)) == [cold]


@pytest.mark.django_db
def test_batched_writes_share_one_value_that_the_watermark_covers(project: Project) -> None:
    """``coalesce_sync_seq`` draws once per project, not once per row (#1527).

    Sharing a value is safe precisely because the delta is ``> since`` and the
    checkpoint is the maximum: the batch is wholly after any prior checkpoint and
    wholly at-or-below the new one.
    """
    from django.db import transaction

    from trueppm_api.apps.sync.sequence import coalesce_sync_seq

    before = _watermark(project)
    with transaction.atomic(), coalesce_sync_seq():
        tasks = [Task.objects.create(project=project, name=f"BT{i}", duration=1) for i in range(3)]
        for t in tasks:
            t.name = f"{t.name}-x"
            t.save(known_exists=True)

    seqs = {_seq(t) for t in tasks}
    assert len(seqs) == 1, "a coalesced batch must draw exactly one value"
    only = seqs.pop()
    assert only > before
    assert _watermark(project) == only
    # And the batch is delivered exactly once: a pull at the new checkpoint is empty.
    assert not Task.objects.filter(project=project, sync_seq__gt=only).exists()


@pytest.mark.django_db
def test_shared_calendar_stays_at_or_below_every_owner_watermark(calendar: Calendar) -> None:
    """A shared row carries one cursor, so every owner's checkpoint must cover it.

    If it did not, the calendar would sit permanently above the lagging project's
    watermark and be handed back on every single pull.
    """
    a = Project.objects.create(name="A", start_date=date(2026, 1, 1), calendar=calendar)
    b = Project.objects.create(name="B", start_date=date(2026, 1, 1), calendar=calendar)
    # Drive A's sequence well ahead of B's so the two draws differ.
    for i in range(10):
        Task.objects.create(project=a, name=f"T{i}", duration=1)

    calendar.name = "Std (edited)"
    calendar.save()

    seq = _seq(calendar)
    assert seq <= _watermark(a)
    assert seq <= _watermark(b)


@pytest.mark.django_db
def test_calendar_created_before_any_project_is_still_delivered(db: object) -> None:
    """A calendar with no owner yet cannot draw a cursor — linking one must fix it.

    Creation order is not under the client's control (a calendar is normally
    created first and a project pointed at it), so without the link hook the
    calendar would keep ``sync_seq = 0`` and never appear in any delta.
    """
    orphan = Calendar.objects.create(name="Orphan")
    assert _seq(orphan) == 0

    project = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=orphan)

    seq = _seq(orphan)
    assert seq > 0
    assert seq <= _watermark(project)


@pytest.mark.django_db
def test_repointing_a_project_calendar_delivers_the_new_one(project: Project) -> None:
    """Switching the FK gives the newly-referenced calendar a cursor for this project."""
    replacement = Calendar.objects.create(name="Replacement")
    since = _watermark(project)

    reloaded = Project.objects.get(pk=project.pk)
    reloaded.calendar = replacement
    reloaded.save()

    assert _seq(replacement) > since
    assert _seq(replacement) <= _watermark(project)
