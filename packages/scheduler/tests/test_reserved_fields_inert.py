"""Pin the reserved-but-inert contract for ``hours_per_day``, ``timezone`` and ``planned_finish``.

``models.py`` and the README document these three fields as accepted, round-tripped and
*not consumed* by the engine (#826, sub-day scheduling is #1216). Before this file no
test asserted that, so someone wiring ``hours_per_day`` into date math would break the
documented contract with every suite green, and the Rust engine (which ignores the
fields) would silently diverge.

The claim is about *accepted* values: validation only requires ``hours_per_day`` to be a
finite real and ``timezone`` to be a string, so ``1e9`` and ``"Not/AZone"`` are accepted
and must be exactly as inert as ``24`` and ``"Asia/Tokyo"``. (``nan``/``inf`` are
rejected at parse time — covered below so the boundary of the claim is itself pinned.)

The comparison is serialized JSON of ``to_dict()`` output, byte for byte, so a changed
date, float, or key order anywhere in the result fails.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

import pytest

from trueppm_scheduler.derive import Quantity, derive_value
from trueppm_scheduler.engine import InvalidScheduleInput, monte_carlo, schedule
from trueppm_scheduler.models import Project

_DAY = 86400.0


def _base_doc() -> dict[str, Any]:
    """A project with enough structure that a date-math mutation would show.

    Dependencies of all four types with lag, a non-default Sun-Wed week, a calendar
    exception, a second per-task calendar, PERT estimates (so Monte Carlo has variance),
    and actuals on a started and a finished task. Sunday-Wednesday means a Wednesday
    mutation (the issue's negative control) and a weekend assumption both land on
    working/non-working days that the schedule actually crosses.
    """
    est = {
        "optimistic_duration": 2 * _DAY,
        "most_likely_duration": 4 * _DAY,
        "pessimistic_duration": 9 * _DAY,
    }
    return {
        "id": "p-inert",
        "name": "Inert reserved fields",
        "start_date": "2026-01-05",
        "status_date": "2026-01-14",
        "tasks": [
            {
                "id": "A",
                "name": "A",
                "duration": 5 * _DAY,
                "actual_start": "2026-01-05",
                "actual_finish": "2026-01-12",
                "percent_complete": 100.0,
            },
            {
                "id": "B",
                "name": "B",
                "duration": 6 * _DAY,
                "actual_start": "2026-01-13",
                "percent_complete": 40.0,
                **est,
            },
            {"id": "C", "name": "C", "duration": 4 * _DAY, **est},
            {"id": "D", "name": "D", "duration": 8 * _DAY, "calendar_id": "seven", **est},
            {"id": "E", "name": "E", "duration": 3 * _DAY, **est},
            {"id": "F", "name": "F", "duration": 0.0},
            # Milestones read ``Calendar.is_working_day`` directly for their display
            # day (the bulk date walks use the weekday mask), so they are what makes a
            # per-weekday mutation of that predicate visible to this test.
            {"id": "M1", "name": "M1", "duration": 0.0},
            {"id": "M2", "name": "M2", "duration": 0.0},
            {"id": "M3", "name": "M3", "duration": 0.0},
            {"id": "M4", "name": "M4", "duration": 0.0},
        ],
        "dependencies": [
            {"predecessor_id": "A", "successor_id": "B", "dep_type": "FS", "lag": 0.0},
            {"predecessor_id": "A", "successor_id": "C", "dep_type": "SS", "lag": 2 * _DAY},
            {"predecessor_id": "B", "successor_id": "D", "dep_type": "FF", "lag": 1 * _DAY},
            {"predecessor_id": "C", "successor_id": "E", "dep_type": "SF", "lag": 0.0},
            {"predecessor_id": "D", "successor_id": "F", "dep_type": "FS", "lag": 0.0},
            {"predecessor_id": "E", "successor_id": "F", "dep_type": "FS", "lag": 3 * _DAY},
            {"predecessor_id": "A", "successor_id": "M1", "dep_type": "FS", "lag": 0.0},
            {"predecessor_id": "C", "successor_id": "M2", "dep_type": "FS", "lag": 1 * _DAY},
            {"predecessor_id": "B", "successor_id": "M3", "dep_type": "SS", "lag": 0.0},
            {"predecessor_id": "E", "successor_id": "M4", "dep_type": "FF", "lag": 2 * _DAY},
        ],
        "calendar": {
            "working_days": 0b0001111 << 0 | 0b1000000,  # Mon-Thu + Sun
            "exceptions": [{"start": "2026-01-20", "end": "2026-01-21"}],
            "hours_per_day": 8.0,
            "timezone": "UTC",
        },
        "calendars": {
            "seven": {
                "working_days": 0b1111111,
                "exceptions": [],
                "hours_per_day": 8.0,
                "timezone": "UTC",
            }
        },
    }


def _with_hours(hours: float) -> dict[str, Any]:
    doc = _base_doc()
    doc["calendar"]["hours_per_day"] = hours
    for cal in doc["calendars"].values():
        cal["hours_per_day"] = hours
    return doc


def _with_timezone(tz: str) -> dict[str, Any]:
    doc = _base_doc()
    doc["calendar"]["timezone"] = tz
    for cal in doc["calendars"].values():
        cal["timezone"] = tz
    return doc


def _with_planned_finish(iso: str) -> dict[str, Any]:
    doc = _base_doc()
    for t in doc["tasks"]:
        t["planned_finish"] = iso
    return doc


VARIANTS: dict[str, dict[str, Any]] = {
    "hours_per_day=0.5": _with_hours(0.5),
    "hours_per_day=24": _with_hours(24.0),
    "hours_per_day=1e9": _with_hours(1e9),
    "timezone=Asia/Tokyo": _with_timezone("Asia/Tokyo"),
    "timezone=Not/AZone": _with_timezone("Not/AZone"),
    "planned_finish=far-before": _with_planned_finish("1990-01-01"),
    "planned_finish=far-after": _with_planned_finish("2999-12-31"),
}


def _strip_echo(obj: Any) -> Any:
    """Drop ``planned_finish`` keys: ``Task.to_dict`` round-trips the user's input.

    The echo of the value we set is the documented round-trip, not engine behavior, so
    it is removed from both sides; every *computed* field is still compared byte for byte.
    """
    if isinstance(obj, dict):
        return {k: _strip_echo(v) for k, v in obj.items() if k != "planned_finish"}
    if isinstance(obj, list):
        return [_strip_echo(v) for v in obj]
    return obj


def _dump(obj: Any) -> str:
    return json.dumps(_strip_echo(obj), sort_keys=False, separators=(",", ":"))


def _schedule_json(doc: dict[str, Any]) -> str:
    return _dump(schedule(Project.from_dict(deepcopy(doc))).to_dict())


def _mc_json(doc: dict[str, Any]) -> str:
    return _dump(monte_carlo(Project.from_dict(deepcopy(doc)), runs=200, seed=1).to_dict())


def _derive_json(doc: dict[str, Any]) -> str:
    project = Project.from_dict(deepcopy(doc))
    out = [
        derive_value(project, t.id, q).to_dict()
        for t in project.tasks
        for q in (
            Quantity.EARLY_START,
            Quantity.EARLY_FINISH,
            Quantity.LATE_START,
            Quantity.LATE_FINISH,
            Quantity.TOTAL_FLOAT,
        )
    ]
    return _dump(out)


ENGINES = {"schedule": _schedule_json, "monte_carlo": _mc_json, "derive_value": _derive_json}


@pytest.fixture(scope="module")
def baselines() -> dict[str, str]:
    return {name: fn(_base_doc()) for name, fn in ENGINES.items()}


@pytest.mark.parametrize("variant", sorted(VARIANTS))
@pytest.mark.parametrize("engine", sorted(ENGINES))
def test_reserved_field_is_inert(engine: str, variant: str, baselines: dict[str, str]) -> None:
    """Changing a reserved field must not change one byte of the engine's output."""
    assert ENGINES[engine](VARIANTS[variant]) == baselines[engine]


def test_baseline_is_not_vacuous(baselines: dict[str, str]) -> None:
    """The baseline must carry real dates, or byte-equality proves nothing."""
    result = schedule(Project.from_dict(_base_doc()))
    assert len(result.tasks) == 10
    assert len({t.early_finish for t in result.tasks}) > 3
    assert any(t.early_start != result.tasks[0].early_start for t in result.tasks)
    assert len(baselines["derive_value"]) > 1000


def test_variants_actually_reach_the_calendar() -> None:
    """The variants must really set the field, not silently parse back to the default."""
    assert Project.from_dict(deepcopy(VARIANTS["hours_per_day=1e9"])).calendar.hours_per_day == 1e9
    assert (
        Project.from_dict(deepcopy(VARIANTS["timezone=Not/AZone"])).calendar.timezone == "Not/AZone"
    )
    pf = Project.from_dict(deepcopy(VARIANTS["planned_finish=far-after"]))
    assert all(t.planned_finish is not None for t in pf.tasks)


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_hours_per_day_is_rejected_not_inert(bad: float) -> None:
    """The inertness claim covers accepted values only; non-finite input is refused."""
    doc = _with_hours(bad)
    with pytest.raises(InvalidScheduleInput):
        Project.from_dict(doc)
