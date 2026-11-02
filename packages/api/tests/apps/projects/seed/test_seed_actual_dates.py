"""Seed export/import carries ``actual_start``/``actual_finish`` (#3161).

ADR-0132 makes a task's actuals the floor of its schedule. Before this, the
exporter dropped them, so an in-flight project re-imported from its own export
rescheduled from the planned dates.
"""

from __future__ import annotations

import copy
import json
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program
from trueppm_api.apps.projects.seed.validation import SeedValidationError, validate_seed

User = get_user_model()

# 2026-02-01 is a Sunday: the actual dates deliberately land on a weekend to prove
# they are not snapped to a working day on import.
_START = "2026-01-05"
_STARTED = "2026-01-10"  # Saturday
_FINISHED = "2026-01-18"  # Sunday


def _doc(version: str = "1.0") -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema_version": version,
        "program": {"slug": "act", "name": "Actuals", "methodology": "WATERFALL", "lead": "alex"},
        "accounts": [{"slug": "alex", "username": "act-alex", "role": "OWNER"}],
        "projects": [
            {
                "slug": "p",
                "name": "P",
                "methodology": "WATERFALL",
                "start_date": _START,
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "In flight",
                        "status": "IN_PROGRESS",
                        "duration": 10,
                        "actual_start": _STARTED,
                    },
                    {
                        "wbs_path": "2",
                        "name": "Done",
                        "status": "COMPLETE",
                        "duration": 5,
                        "actual_start": _STARTED,
                        "actual_finish": _FINISHED,
                    },
                    {"wbs_path": "3", "name": "Untouched", "duration": 3},
                ],
            }
        ],
    }
    if version.startswith("2"):
        doc["anchor"] = "2026-02-01"
    return doc


def _tasks(program: Any) -> dict[str, Task]:
    return {t.wbs_path: t for t in Task.objects.filter(project__program=program)}


def _errors(doc: dict[str, Any]) -> list[str]:
    with pytest.raises(SeedValidationError) as exc:
        validate_seed(doc)
    return exc.value.errors


@pytest.mark.django_db
def test_import_persists_actual_dates_without_snapping() -> None:
    owner = User.objects.create_user("act-owner")
    tasks = _tasks(import_seed(_doc(), owner=owner, create_users=True))
    assert tasks["1"].actual_start == date(2026, 1, 10)
    assert tasks["1"].actual_finish is None
    assert tasks["2"].actual_start == date(2026, 1, 10)
    assert tasks["2"].actual_finish == date(2026, 1, 18)
    assert tasks["3"].actual_start is None
    assert tasks["3"].actual_finish is None


@pytest.mark.django_db
def test_export_emits_actuals_only_where_present() -> None:
    owner = User.objects.create_user("act-owner")
    program = import_seed(_doc(), owner=owner, create_users=True)
    by_wbs = {t["wbs_path"]: t for t in export_program(program)["projects"][0]["tasks"]}
    assert by_wbs["1"]["actual_start"] == _STARTED
    assert "actual_finish" not in by_wbs["1"]  # start without finish
    assert by_wbs["2"]["actual_finish"] == _FINISHED
    assert "actual_start" not in by_wbs["3"]  # neither: keys stay absent
    assert "actual_finish" not in by_wbs["3"]


@pytest.mark.django_db
@pytest.mark.parametrize("with_events", [False, True])
def test_export_import_export_is_a_fixpoint_with_in_progress_task(with_events: bool) -> None:
    owner = User.objects.create_user("act-owner")
    program = import_seed(_doc("2.0" if with_events else "1.0"), owner=owner, create_users=True)
    first_doc = export_program(program, with_events=with_events)
    validate_seed(first_doc)
    first = dump_seed(first_doc)
    again = import_seed(json.loads(first), owner=owner, create_users=True, replace=True)
    assert dump_seed(export_program(again, with_events=with_events)) == first
    assert _tasks(again)["1"].actual_start == date(2026, 1, 10)


@pytest.mark.django_db
def test_replay_does_not_clobber_an_authored_actual_finish() -> None:
    doc = _doc("2.0")
    doc["events"] = [
        {"at": "A-5T10:00", "action": "task.status", "target": "task:p:1", "to": "IN_PROGRESS"},
        {"at": "A-2T10:00", "action": "task.status", "target": "task:p:2", "to": "COMPLETE"},
    ]
    validate_seed(doc)
    owner = User.objects.create_user("act-owner")
    tasks = _tasks(import_seed(doc, owner=owner, create_users=True))
    # Beats land at A-5 / A-2; the authored dates must win.
    assert tasks["1"].actual_start == date(2026, 1, 10)
    assert tasks["2"].actual_finish == date(2026, 1, 18)


@pytest.mark.parametrize("bad", ["2026-13-40", "yesterday", 20260110, "A-5x"])
@pytest.mark.parametrize("field", ["actual_start", "actual_finish"])
def test_malformed_actual_date_is_a_validation_error_not_a_crash(field: str, bad: Any) -> None:
    for version in ("1.0", "2.0"):
        doc = _doc(version)
        doc["projects"][0]["tasks"][2][field] = bad
        assert any(f"tasks[2].{field}" in e for e in _errors(doc))


def test_actual_finish_before_actual_start_is_refused() -> None:
    doc = _doc()
    task = doc["projects"][0]["tasks"][1]
    task["actual_start"], task["actual_finish"] = _FINISHED, _STARTED
    assert any("cannot be earlier than actual start" in e for e in _errors(doc))


def test_unknown_task_key_is_still_rejected() -> None:
    doc = copy.deepcopy(_doc())
    doc["projects"][0]["tasks"][2]["actual_middle"] = _STARTED
    assert _errors(doc)


@pytest.mark.parametrize("status", ["IN_PROGRESS", "NOT_STARTED", "BACKLOG", "ON_HOLD"])
def test_actual_finish_on_a_non_signoff_status_is_refused(status: str) -> None:
    doc = _doc()
    task = doc["projects"][0]["tasks"][2]
    task.update(status=status, actual_finish=_FINISHED)
    assert any("tasks[2].actual_finish" in e and "review or complete" in e for e in _errors(doc))


@pytest.mark.parametrize("status", ["REVIEW", "COMPLETE"])
def test_actual_finish_on_a_signoff_status_is_accepted(status: str) -> None:
    doc = _doc()
    doc["projects"][0]["tasks"][2].update(status=status, actual_finish=_FINISHED)
    validate_seed(doc)


@pytest.mark.parametrize("version", ["1.0", "2.0"])
@pytest.mark.parametrize(
    ("value", "needle"),
    [
        ("9999-01-01", "in the future"),  # far future: the bound fires before the span cap
        ("0001-01-01", "more than"),  # far past: the cap is absolute, not one-sided
        ("2999-01-01", "in the future"),  # inside the span cap, past the data date
    ],
)
def test_out_of_range_actual_start_is_refused(version: str, value: str, needle: str) -> None:
    doc = _doc(version)
    doc["projects"][0]["tasks"][2]["actual_start"] = value
    assert any("tasks[2].actual_start" in e and needle in e for e in _errors(doc))


def test_v2_relative_offset_beyond_the_future_bound_is_refused() -> None:
    # A seedDate offset is capped at four digits (~27 years), which can never reach
    # the 366000-day span cap, so the reachable v2 failure is the future bound.
    doc = _doc("2.0")
    doc["projects"][0]["tasks"][2]["actual_start"] = "A+9999!"
    assert any("tasks[2].actual_start" in e and "in the future" in e for e in _errors(doc))


@pytest.mark.django_db
def test_reopened_task_keeping_its_finish_still_round_trips() -> None:
    """A legacy row (reopened before ADR-1153 cleared the stamp) must stay exportable."""
    owner = User.objects.create_user("act-owner")
    program = import_seed(_doc(), owner=owner, create_users=True)
    done = _tasks(program)["2"]
    Task.objects.filter(pk=done.pk).update(status="IN_PROGRESS")  # finish left behind
    assert Task.objects.get(pk=done.pk).actual_finish == date(2026, 1, 18)

    first_doc = export_program(program)
    by_wbs = {t["wbs_path"]: t for t in first_doc["projects"][0]["tasks"]}
    assert by_wbs["2"]["status"] == "IN_PROGRESS"
    assert "actual_finish" not in by_wbs["2"]
    assert by_wbs["2"]["actual_start"] == _STARTED
    validate_seed(first_doc)  # the project's own export is importable

    first = dump_seed(first_doc)
    again = import_seed(json.loads(first), owner=owner, create_users=True, replace=True)
    assert dump_seed(export_program(again)) == first
