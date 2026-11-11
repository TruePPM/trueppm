"""Writer-side atomicity of the sync cursor (#2617).

The delta pull is lossless only if a synced write commits its ``sync_seq`` draw
(an ``UPDATE`` on ``Project.last_sync_version``) and the row it stamps in ONE
transaction. If the draw commits first, a pull in the gap reports ``W`` while the
row carrying ``W`` is still invisible; the client adopts ``since = W`` and
``sync_seq__gt=W`` excludes that row from every pull after it.

HTTP writes get that atomicity from ``ATOMIC_REQUESTS`` (pinned by #2613's
``test_http_writes_commit_the_cursor_allocation_with_their_row``). These tests
cover what runs *without* a request transaction — the Celery Beat recurrence
sweep is the path that was found — so they are ``transaction=True``: under the
default test transaction every write is already atomic and the window cannot
exist, which is exactly why the defect was invisible to the suite.

The observer is a second, independent database connection reading at the instant
between the allocator draw and the row write — the moment a concurrent pull would
read its watermark.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import date, time
from typing import Any
from unittest.mock import patch

import pytest
from django.db import connection, connections, transaction
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RecurrenceEndType,
    Task,
    TaskRecurrenceFrequency,
    TaskRecurrenceRule,
)
from trueppm_api.apps.sync import sequence
from trueppm_api.apps.sync.sequence import SyncSeqOutsideTransactionError

pytestmark = pytest.mark.django_db(transaction=True)

MONDAY = date(2026, 6, 1)


@pytest.fixture
def observer() -> Iterator[Any]:
    """A second connection: a concurrent pull's view of the committed state."""
    other = connections.create_connection("default")
    try:
        yield other
    finally:
        other.close()


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=MONDAY, calendar=calendar)


def _committed_view(other: Any, project_id: Any) -> tuple[int, set[int]]:
    """What a pull on another connection would see: (watermark, visible task cursors)."""
    with other.cursor() as cur:
        cur.execute("SELECT last_sync_version FROM projects_project WHERE id = %s", [project_id])
        watermark = int(cur.fetchone()[0])
        cur.execute("SELECT sync_seq FROM projects_task WHERE project_id = %s", [project_id])
        visible = {int(row[0]) for row in cur.fetchall()}
    return watermark, visible


def _observe_between_draw_and_row(
    other: Any, *, occurrences_only: bool = False
) -> tuple[list[tuple[int, set[int]]], Any]:
    """Patch the save()-path allocator to snapshot the committed state right after each draw."""
    observed: list[tuple[int, set[int]]] = []
    real_allocate = sequence.allocate

    def _hooked(instance: Any) -> None:
        real_allocate(instance)
        if isinstance(instance, Task) and (
            not occurrences_only or instance.recurrence_rule_id is not None
        ):
            observed.append(_committed_view(other, instance.project_id))

    return observed, patch.object(sequence, "allocate", _hooked)


def _assert_no_published_gap(observed: list[tuple[int, set[int]]], stamped: list[int]) -> None:
    """Every row at or below an observed watermark must have been visible with it."""
    assert observed, "fixture invalid — the hook never ran"
    for (watermark, visible), seq in zip(observed, stamped, strict=True):
        hidden = {s for s in stamped if s <= watermark} - visible
        assert seq > watermark and not hidden, (
            f"a concurrent pull read watermark {watermark} while the row stamped "
            f"{seq} was uncommitted — it would adopt since={watermark} and skip "
            "that row forever"
        )


def test_autocommit_create_does_not_publish_the_cursor_before_the_row(
    project: Project, observer: Any
) -> None:
    """The bare INSERT path (``Task.objects.create`` with no outer transaction).

    Negative control: on the pre-fix ``save()`` the draw autocommits, so the
    observer reads ``watermark == task.sync_seq`` with the row not yet visible.
    """
    assert not connection.in_atomic_block, "fixture invalid — must run in autocommit"
    observed, hook = _observe_between_draw_and_row(observer)
    with hook:
        task = Task.objects.create(project=project, name="t", duration=1)

    _assert_no_published_gap(observed, [task.sync_seq])
    watermark, visible = _committed_view(observer, project.pk)
    assert watermark == task.sync_seq and task.sync_seq in visible


def test_autocommit_update_does_not_publish_the_cursor_before_the_row(
    project: Project, observer: Any
) -> None:
    """The UPDATE path: ``server_version`` bump, draw, then the row's UPDATE."""
    task = Task.objects.create(project=project, name="t", duration=1)
    observed, hook = _observe_between_draw_and_row(observer)
    with hook:
        task.name = "renamed"
        task.save()

    watermark, visible = observed[0]
    assert task.sync_seq > watermark, (
        f"watermark {watermark} published before the UPDATE stamping {task.sync_seq}"
    )
    # The committed row still carries its previous cursor at that instant.
    assert max(visible) <= watermark


def test_beat_recurrence_sweep_does_not_publish_a_cursor_ahead_of_its_rows(
    project: Project, observer: Any
) -> None:
    """The path #2617 found: ``generate_recurring_occurrences`` runs in autocommit."""
    from trueppm_api.apps.projects.tasks import generate_recurring_occurrences

    template = Task.objects.create(
        project=project, name="Standup", duration=1, planned_start=timezone.localdate()
    )
    TaskRecurrenceRule.objects.create(
        task=template,
        frequency=TaskRecurrenceFrequency.DAILY,
        interval=1,
        end_type=RecurrenceEndType.NEVER,
        time_of_day=time(9, 0),
    )
    template.refresh_from_db()

    observed, hook = _observe_between_draw_and_row(observer, occurrences_only=True)
    with hook:
        generate_recurring_occurrences.run()

    occurrences = list(
        Task.objects.filter(project=project, recurrence_rule__isnull=False).order_by("sync_seq")
    )
    assert occurrences, "fixture invalid — the sweep materialized nothing"
    _assert_no_published_gap(observed, [t.sync_seq for t in occurrences])

    # End to end: a client that pulled inside the gap adopts the watermark it saw
    # there as its checkpoint, and must still receive every occurrence afterwards.
    # Pre-fix that watermark equals the first occurrence's cursor, so it is skipped.
    since = observed[0][0]
    delivered = set(
        Task.objects.filter(project=project, sync_seq__gt=since).values_list("pk", flat=True)
    )
    assert {t.pk for t in occurrences} <= delivered


def test_coalesced_batch_in_autocommit_raises_in_strict_mode(project: Project) -> None:
    """Only the first draw per project hits the allocator; the batch itself is gated."""
    with (
        pytest.raises(SyncSeqOutsideTransactionError),
        sequence.coalesce_sync_seq(),
    ):
        Task.objects.create(project=project, name="t", duration=1)
    with transaction.atomic(), sequence.coalesce_sync_seq():
        Task.objects.create(project=project, name="t", duration=1)


@override_settings(TRUEPPM_SYNC_SEQ_REQUIRE_ATOMIC=False)
def test_coalesced_batch_in_autocommit_logs_in_production(
    project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    with (
        caplog.at_level(logging.ERROR, logger="trueppm_api.apps.sync.sequence"),
        sequence.coalesce_sync_seq(),
    ):
        pass
    assert any("#2617" in r.getMessage() for r in caplog.records)


def test_save_inside_a_transaction_adds_no_savepoint(project: Project) -> None:
    """The hot path is untouched: no extra round-trips under ATOMIC_REQUESTS."""
    task = Task.objects.create(project=project, name="t", duration=1)
    with transaction.atomic(), CaptureQueriesContext(connection) as ctx:
        task.name = "x"
        task.save()
    assert not [q for q in ctx.captured_queries if "SAVEPOINT" in q["sql"]]


def test_direct_allocator_draw_in_autocommit_raises_in_strict_mode(project: Project) -> None:
    """The gate: a bulk writer drawing a cursor outside a transaction fails loudly."""
    with pytest.raises(SyncSeqOutsideTransactionError):
        sequence.allocate_for_projects([project.pk])
    with pytest.raises(SyncSeqOutsideTransactionError):
        sequence.allocate_program_seq()
    with transaction.atomic():
        assert sequence.allocate_for_projects([project.pk]) > 0


@override_settings(TRUEPPM_SYNC_SEQ_REQUIRE_ATOMIC=False)
def test_direct_allocator_draw_in_autocommit_logs_in_production(
    project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    """Production degrades to a logged error rather than failing the write."""
    with caplog.at_level(logging.ERROR, logger="trueppm_api.apps.sync.sequence"):
        assert sequence.allocate_for_projects([project.pk]) > 0
    assert any("#2617" in r.getMessage() for r in caplog.records)


def test_dev_settings_run_the_allocator_gate_strict() -> None:
    """The gate only bites if the test/dev settings enable it."""
    from django.conf import settings

    assert settings.TRUEPPM_SYNC_SEQ_REQUIRE_ATOMIC is True
