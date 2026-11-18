"""The frozen migration helpers still do what they were copied to do (#4603).

``projects/backfill.py`` and ``backfill_bundled_templates.py`` hold point-in-time
copies of live service code so a data migration cannot drift with a refactor. These
tests pin the copies to the outcome the migrations promised *as of today*; they are
not a promise that the copies track ``services`` forever (a deliberate divergence
should change the live function and leave these alone).
"""

from __future__ import annotations

from datetime import date

import pytest

from trueppm_api.apps.projects import backfill, backfill_bundled_templates, bundled_templates
from trueppm_api.apps.projects.models import Calendar, Methodology, Project, Task, TaskStatus
from trueppm_api.apps.projects.services import rollup_config_defaults
from trueppm_api.apps.sync import backfill as sync_backfill
from trueppm_api.apps.sync.sequence import BOARD_EVENT_SEQ_UPGRADE_OFFSET


@pytest.mark.parametrize("methodology", [m.value for m in Methodology] + ["UNEXPECTED"])
def test_frozen_rollup_defaults_match_live_today(methodology: str) -> None:
    assert backfill.frozen_rollup_config_defaults(methodology) == rollup_config_defaults(
        methodology
    )


def test_frozen_board_event_offset_matches_live_today() -> None:
    assert sync_backfill.BOARD_EVENT_SEQ_UPGRADE_OFFSET == BOARD_EVENT_SEQ_UPGRADE_OFFSET


def test_frozen_bundled_templates_match_live_today() -> None:
    assert backfill_bundled_templates.BUNDLED_TEMPLATE_NAMES == (
        bundled_templates.BUNDLED_TEMPLATE_NAMES
    )
    frozen = [(n, d, b()) for n, d, b in backfill_bundled_templates.BUNDLED_TEMPLATES]
    live = [(n, d, b()) for n, d, b in bundled_templates.BUNDLED_TEMPLATES]
    assert frozen == live


@pytest.mark.django_db
def test_frozen_clear_nulls_output_outside_committed_set_in_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backfill, "_FROZEN_PROJECT_CHUNK", 1)
    cal = Calendar.objects.create(name="FrozenClear")
    projects = [
        Project.objects.create(name=f"P{i}", start_date=date(2026, 1, 5), calendar=cal)
        for i in range(3)
    ]
    stale = [
        Task.objects.create(
            project=p,
            name="Groomed out",
            duration=3,
            status=TaskStatus.BACKLOG,
            early_finish=date(2026, 4, 1),
            total_float=12,
            is_critical=True,
        )
        for p in projects
    ]
    live = Task.objects.create(
        project=projects[0],
        name="Committed",
        duration=2,
        status=TaskStatus.NOT_STARTED,
        early_finish=date(2026, 4, 2),
        total_float=1,
    )

    assert backfill.frozen_clear_all_uncommitted_cpm_output(Task, Project) == 3
    for task in stale:
        task.refresh_from_db()
        assert task.early_finish is None
        assert task.total_float is None
        assert task.is_critical is None or task.is_critical is False
    live.refresh_from_db()
    assert live.early_finish == date(2026, 4, 2)
    assert backfill.frozen_clear_all_uncommitted_cpm_output(Task, Project) == 0
