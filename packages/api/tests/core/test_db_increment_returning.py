"""The shared atomic-counter helper (#2567).

``core.db.increment_returning`` is the API's one interpolated-SQL site. Both
counters drawn through it — ``VersionedModel.server_version`` (ADR-0142) and
``Project.last_sync_version`` (the ``sync_seq`` allocator, ADR-0686) — already have
behavioral suites of their own; these tests pin the *seam* those two call sites now
share, so a change to the helper cannot quietly alter either:

* the returned value is the post-increment one, read in the same statement;
* only the named field moves, so the two counters on one row stay independent;
* a pk matching no row returns ``None``, and each caller's translation of that
  ``None`` (``0`` for the sequence, "leave the version alone" for the model) is
  what its own contract depends on.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.sync.sequence import _next_seq
from trueppm_api.core.db import increment_returning


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="Counter", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )


@pytest.mark.django_db
def test_returns_the_post_increment_value_and_persists_it(project: Project) -> None:
    before = int(Project.objects.values_list("last_sync_version", flat=True).get(pk=project.pk))

    returned = increment_returning(Project, "last_sync_version", project.pk)

    assert returned == before + 1
    # The read-back is part of the same statement, so the row must already agree —
    # there is no separate write to lose.
    after = int(Project.objects.values_list("last_sync_version", flat=True).get(pk=project.pk))
    assert after == returned


@pytest.mark.django_db
def test_repeated_calls_are_strictly_increasing(project: Project) -> None:
    values = [increment_returning(Project, "last_sync_version", project.pk) for _ in range(4)]

    assert values == sorted(values)
    assert len(set(values)) == 4


@pytest.mark.django_db
def test_only_the_named_field_moves(project: Project) -> None:
    """``server_version`` and ``last_sync_version`` live on the same row and must
    not shadow each other — the field name selects the column, nothing else."""
    task = Task.objects.create(project=project, name="T", duration=1)
    server_before = int(Task.objects.values_list("server_version", flat=True).get(pk=task.pk))
    sync_before = int(Task.objects.values_list("sync_seq", flat=True).get(pk=task.pk))

    increment_returning(Task, "server_version", task.pk)

    task.refresh_from_db(fields=["server_version", "sync_seq"])
    assert task.server_version == server_before + 1
    assert task.sync_seq == sync_before


@pytest.mark.django_db
def test_absent_row_returns_none(db: object) -> None:
    """A pk that matches no row is not an error — the caller decides."""
    assert increment_returning(Project, "last_sync_version", uuid.uuid4()) is None


@pytest.mark.django_db
def test_sequence_translates_a_missing_row_to_zero(db: object) -> None:
    """``_next_seq`` maps the helper's ``None`` to 0, and a 0 cursor is never
    delivered — the invariant that lets a hard-deleted project's concurrent write
    fail closed instead of stamping a bogus cursor."""
    assert _next_seq(uuid.uuid4()) == 0


@pytest.mark.django_db
def test_model_save_leaves_server_version_alone_when_the_row_is_gone(project: Project) -> None:
    """The UPDATE path's ``None`` branch: a row hard-deleted under an in-flight save
    keeps its in-memory version rather than resetting it."""
    task = Task.objects.create(project=project, name="Gone", duration=1)
    stale = Task(pk=task.pk, project=project, name="Gone", duration=1)
    stale.server_version = 7
    Task.objects.filter(pk=task.pk).delete()

    stale._increment_server_version_returning()

    assert stale.server_version == 7
