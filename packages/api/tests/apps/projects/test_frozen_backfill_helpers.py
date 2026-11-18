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


def test_frozen_mc_latest_cache_key_matches_live_today() -> None:
    from trueppm_api.apps.scheduling.views import mc_latest_cache_key

    assert sync_backfill._frozen_mc_latest_cache_key("abc") == mc_latest_cache_key("abc")


@pytest.mark.django_db
def test_frozen_tombstone_floor_backfill_matches_live_today() -> None:
    """The sync.0008 copies raise floors and bump cached forecasts like the live ones."""
    from django.core.cache import cache

    from trueppm_api.apps.scheduling.models import MonteCarloRun
    from trueppm_api.apps.sync.models import ProgramSyncSequence
    from trueppm_api.apps.sync.sequence import (
        backfill_tombstone_floors,
        bump_cached_forecast_plan_versions,
    )

    cal = Calendar.objects.create(name="FrozenFloor")
    results = []
    for fn, bump in (
        (backfill_tombstone_floors, bump_cached_forecast_plan_versions),
        (
            sync_backfill.frozen_backfill_tombstone_floors,
            sync_backfill.frozen_bump_cached_forecast_plan_versions,
        ),
    ):
        project = Project.objects.create(name="F", start_date=date(2026, 1, 5), calendar=cal)
        Project.objects.filter(pk=project.pk).update(last_sync_version=5, tombstone_floor=0)
        key = sync_backfill._frozen_mc_latest_cache_key(project.pk)
        cache.set(key, {"plan_version": 5}, 60)
        try:
            fn(Project, ProgramSyncSequence, MonteCarloRun)
            moved = bump(Project)
            project.refresh_from_db()
            results.append(
                (project.last_sync_version, project.tombstone_floor, moved, cache.get(key))
            )
        finally:
            cache.delete(key)
    assert results[0] == results[1] == (6, 6, results[0][2], {"plan_version": 6})
    assert results[0][2] >= 1
