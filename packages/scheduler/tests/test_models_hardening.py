"""Assertion-hardening tests for models helpers (#2330 — mutation survivors).

Mutation testing (#2282) left survivors in three small models helpers whose
*messages* and *element handling* were executed but unasserted:

* ``_parse_timedelta`` — the sub-microsecond quantization guard (#1862) raised
  the right error, but no test read the message, so mutating it to ``None`` or
  changing its case went unnoticed.
* ``_reject_duplicate_keys`` — same, for the duplicate-key rejection message.
* ``_serialize`` — the list branch recursed over each element, but no test
  asserted the *elements* survive serialization (a mutant serializing ``None``
  in their place passed).

mutmut 3.8.0 began mutating methods of ``@dataclass`` classes, which every model
here is (#3720). That exposed the same executed-but-unasserted shape across the
whole (de)serialization surface: defaults, field labels in error messages, the
``working_days`` bounds, the duplicate-key hook on ``from_json``, and the
exception-interval cache. The second half of this file pins those.
"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
)
from trueppm_scheduler.models import (
    _parse_timedelta,
    _reject_duplicate_keys,
    _serialize,
)


def test_parse_timedelta_sub_microsecond_message_is_specific() -> None:
    # 86400 s + 100 ns: sub-µs fraction is quantized away by timedelta, so the
    # guard must reject it (and the message names *why* — both sentences).
    with pytest.raises(ValueError) as exc:
        _parse_timedelta(86400.0000001)
    msg = str(exc.value)
    assert "sub-microsecond precision that would be" in msg
    assert "silently quantized; the Rust engine rejects it" in msg
    assert "XX" not in msg  # not mangled with mutmut's sentinel wrapping


def test_parse_timedelta_accepts_exact_whole_day() -> None:
    # A clean whole-day value round-trips and must NOT be over-rejected (#1818).
    assert _parse_timedelta(86400.0) == timedelta(days=1)


def test_reject_duplicate_keys_message_names_the_key() -> None:
    with pytest.raises(ValueError) as exc:
        _reject_duplicate_keys([("duration", 1), ("duration", 2)])
    assert "Duplicate JSON key 'duration' is not allowed" in str(exc.value)


def test_reject_duplicate_keys_passes_through_unique_pairs() -> None:
    assert _reject_duplicate_keys([("a", 1), ("b", 2)]) == {"a": 1, "b": 2}


def test_serialize_recurses_into_list_elements() -> None:
    # Each element must be serialized in place — a mutant that serialized None
    # for every element would yield [None, None, None].
    result = _serialize([date(2026, 1, 2), timedelta(days=1), {"k": date(2026, 1, 3)}])
    assert result == ["2026-01-02", 86400.0, {"k": "2026-01-03"}]


# ---------------------------------------------------------------------------
# DateRange / Dependency / Task.from_dict — defaults and field labels (#3720)
# ---------------------------------------------------------------------------


def test_date_range_from_dict_error_names_the_start_field() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        DateRange.from_dict({"start": "2026/04/01", "end": "2026-04-30"})
    assert str(exc.value) == (
        "Invalid date range: start must be an ISO-8601 date string in YYYY-MM-DD "
        "format, got '2026/04/01'."
    )


def test_date_range_from_dict_error_names_the_end_field() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        DateRange.from_dict({"start": "2026-04-01", "end": "2026/04/30"})
    assert str(exc.value) == (
        "Invalid date range: end must be an ISO-8601 date string in YYYY-MM-DD "
        "format, got '2026/04/30'."
    )


def test_dependency_from_dict_defaults_to_fs_with_no_lag() -> None:
    # Both keys are optional in the documented mapping; omitting them must yield
    # the dataclass defaults, not a parse error or a one-second lag.
    dep = Dependency.from_dict({"predecessor_id": "A", "successor_id": "B"})
    assert dep == Dependency("A", "B")
    assert dep.dep_type is DependencyType.FS
    assert dep.lag == timedelta()


def test_dependency_from_dict_bad_type_lists_every_allowed_value() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Dependency.from_dict({"predecessor_id": "A", "successor_id": "B", "dep_type": "XY"})
    msg = str(exc.value)
    assert re.fullmatch(
        r"Invalid dependency type 'XY'; must be one of: "
        r"(FS|FF|SS|SF), (FS|FF|SS|SF), (FS|FF|SS|SF), (FS|FF|SS|SF)\.",
        msg,
    ), msg
    assert {t.value for t in DependencyType} == set(re.findall(r"\b(?:FS|FF|SS|SF)\b", msg))


def test_task_from_dict_float_defaults_are_zero() -> None:
    t = Task.from_dict({"id": "t", "name": "T", "duration": 86400.0})
    assert t.total_float == timedelta()
    assert t.free_float == timedelta()


def test_task_from_dict_reads_both_float_fields_by_name() -> None:
    t = Task.from_dict(
        {
            "id": "t",
            "name": "T",
            "duration": 86400.0,
            "total_float": 172800.0,
            "free_float": 86400.0,
        }
    )
    assert t.total_float == timedelta(days=2)
    assert t.free_float == timedelta(days=1)


# ---------------------------------------------------------------------------
# Calendar.from_dict — defaults, bitmask bounds, and exact messages (#3720)
# ---------------------------------------------------------------------------


def test_calendar_from_dict_empty_mapping_yields_documented_defaults() -> None:
    cal = Calendar.from_dict({})
    assert cal.working_days == 0b0011111
    assert cal.hours_per_day == 8.0
    assert cal.timezone == "UTC"
    assert cal.exceptions == ()
    assert cal == Calendar()


def test_calendar_from_dict_non_mapping_message_names_the_type() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Calendar.from_dict("weekdays")  # type: ignore[arg-type]
    assert str(exc.value) == "calendar must be an object, got str."


@pytest.mark.parametrize("mask", [0, 1, 127])
def test_calendar_from_dict_accepts_both_bitmask_bounds(mask: int) -> None:
    # [0, 127] is inclusive at both ends: 0 is an all-non-working week (valid, if
    # useless), 127 a seven-day week.
    assert Calendar.from_dict({"working_days": mask}).working_days == mask


@pytest.mark.parametrize("mask", [128, -1])
def test_calendar_from_dict_rejects_masks_outside_the_seven_bits(mask: int) -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Calendar.from_dict({"working_days": mask})
    assert str(exc.value) == f"working_days must be an integer bitmask in [0, 127] (got {mask})."


def test_calendar_from_dict_rejects_non_numeric_hours_per_day() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Calendar.from_dict({"hours_per_day": "eight"})
    assert str(exc.value) == "hours_per_day must be a number (got 'eight')."


def test_calendar_from_dict_rejects_non_string_timezone() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Calendar.from_dict({"timezone": 5})
    assert str(exc.value) == "timezone must be a string (got 5)."


# ---------------------------------------------------------------------------
# Calendar exception index and compose (#3720)
# ---------------------------------------------------------------------------


def test_exception_index_is_served_from_cache_until_exceptions_change() -> None:
    # The O(log E) lookup (#1206) only pays off if the index is built once. A
    # mutant that never hits the cache still answers correctly — just rebuilds
    # on every is_working_day call — so identity is the observable.
    cal = Calendar(exceptions=[DateRange(date(2026, 12, 24), date(2026, 12, 26))])
    first = cal._exception_intervals()
    assert cal._exception_intervals() is first
    cal.exceptions = [DateRange(date(2027, 1, 1), date(2027, 1, 1))]
    rebuilt = cal._exception_intervals()
    assert rebuilt is not first
    assert rebuilt == ([date(2027, 1, 1).toordinal()], [date(2027, 1, 1).toordinal()])


def test_exception_index_merges_adjacent_ranges_into_one_interval() -> None:
    cal = Calendar(
        exceptions=[
            DateRange(date(2026, 12, 25), date(2026, 12, 28)),
            DateRange(date(2026, 12, 22), date(2026, 12, 24)),
        ]
    )
    assert cal._exception_intervals() == (
        [date(2026, 12, 22).toordinal()],
        [date(2026, 12, 28).toordinal()],
    )


def test_exception_index_keeps_a_one_day_gap_as_two_intervals() -> None:
    cal = Calendar(
        exceptions=[
            DateRange(date(2026, 12, 22), date(2026, 12, 23)),
            DateRange(date(2026, 12, 25), date(2026, 12, 28)),
        ]
    )
    assert cal._exception_intervals() == (
        [date(2026, 12, 22).toordinal(), date(2026, 12, 25).toordinal()],
        [date(2026, 12, 23).toordinal(), date(2026, 12, 28).toordinal()],
    )
    # Thursday 2026-12-24 sits in the gap and must stay workable.
    assert cal.is_working_day(date(2026, 12, 24))


def test_compose_ands_masks_that_are_not_subsets_of_each_other() -> None:
    # Mon-Fri AND Mon-Thu cannot tell AND from "take the last mask", because the
    # last mask is already the intersection. Tue-Fri AND Mon-Wed can: Tue-Wed.
    tue_fri = Calendar(working_days=0b0011110)
    mon_wed = Calendar(working_days=0b0000111)
    assert Calendar.compose([tue_fri, mon_wed]).working_days == 0b0000110
    assert Calendar.compose([mon_wed, tue_fri]).working_days == 0b0000110


# ---------------------------------------------------------------------------
# Project.from_dict / from_json / to_json (#3720)
# ---------------------------------------------------------------------------


def test_project_from_dict_error_names_start_date() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Project.from_dict({"id": "p", "name": "P", "start_date": "2026/04/02"})
    assert str(exc.value) == (
        "Invalid project document: start_date must be an ISO-8601 date string in "
        "YYYY-MM-DD format, got '2026/04/02'."
    )


def test_project_from_dict_error_names_status_date() -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        Project.from_dict(
            {"id": "p", "name": "P", "start_date": "2026-04-02", "status_date": "2026/04/10"}
        )
    assert str(exc.value) == (
        "Invalid project document: status_date must be an ISO-8601 date string in "
        "YYYY-MM-DD format, got '2026/04/10'."
    )


def test_project_from_json_rejects_a_duplicate_key() -> None:
    # The hook is what makes Python agree with the Rust engine's serde, which
    # rejects the same document (#1862). Without it json.loads keeps the last id.
    doc = '{"id": "p", "id": "q", "name": "P", "start_date": "2026-04-02"}'
    with pytest.raises(InvalidScheduleInput) as exc:
        Project.from_json(doc)
    assert str(exc.value) == (
        "Invalid project JSON: Duplicate JSON key 'id' is not allowed in a project document."
    )


def test_project_from_json_deep_nesting_message_is_exact() -> None:
    payload = "[" * 20_000 + "1" + "]" * 20_000
    with pytest.raises(InvalidScheduleInput) as exc:
        Project.from_json(payload)
    assert str(exc.value) == "Project JSON is nested too deeply to parse."


def test_project_to_json_forwards_keyword_arguments() -> None:
    p = Project(id="p", name="P", start_date=date(2026, 4, 2))
    pretty = p.to_json(indent=2)
    assert pretty == json.dumps(p.to_dict(), indent=2)
    assert pretty != p.to_json()
