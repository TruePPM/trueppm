"""Unit tests for fuzzy column auto-detection (mapping.py, #743).

No database and no Django settings: mapping.py is deliberately ORM-free so the
preview endpoint and the Celery task can share one implementation.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.csvimport.mapping import (
    detect_mapping,
    field_choices,
    missing_required,
    normalize_header,
)


class TestNormalizeHeader:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Name", "name"),
            ("  Task Name  ", "taskname"),
            ("% Complete", "complete"),
            ("%Complete", "complete"),
            ("Depends On", "dependson"),
            ("start_date", "startdate"),
            ("Predecessors", "predecessor"),
            ("", ""),
        ],
    )
    def test_folds_to_comparison_key(self, raw: str, expected: str) -> None:
        assert normalize_header(raw) == expected

    def test_short_stems_keep_their_trailing_s(self) -> None:
        # A 3-character stem must not be depluralized into something else.
        assert normalize_header("IDs") == "ids"


class TestDetectMapping:
    def test_reference_headers_map_with_zero_correction(self) -> None:
        """The #111 alias table's own spellings all resolve. Acceptance criterion."""
        headers = [
            "Task ID",
            "Phase",
            "Task",
            "Days",
            "Begin",
            "Due",
            "Progress",
            "Owner",
            "Depends On",
            "Description",
        ]
        by_header = {m.header: m.field for m in detect_mapping(headers)}
        assert by_header == {
            "Task ID": "external_id",
            "Phase": "wbs",
            "Task": "name",
            "Days": "duration",
            "Begin": "planned_start",
            "Due": "planned_finish",
            "Progress": "percent_complete",
            "Owner": "resource",
            "Depends On": "predecessors",
            "Description": "notes",
        }
        assert missing_required(detect_mapping(headers)) == []

    def test_canonical_headers_map_exactly(self) -> None:
        mappings = detect_mapping(["Name", "Duration", "Start", "Finish"])
        assert [m.field for m in mappings] == [
            "name",
            "duration",
            "planned_start",
            "planned_finish",
        ]
        assert {m.confidence for m in mappings} == {"exact"}

    def test_substring_headers_map_fuzzily(self) -> None:
        mappings = detect_mapping(["Task Name", "Planned Start Date", "Estimated Effort"])
        assert [m.field for m in mappings] == ["name", "planned_start", "duration"]

    def test_start_is_not_swallowed_by_a_name_alias(self) -> None:
        """Field declaration order is load-bearing; assert it, don't assume it."""
        by_header = {m.header: m.field for m in detect_mapping(["Start", "Title"])}
        assert by_header["Start"] == "planned_start"
        assert by_header["Title"] == "name"

    def test_unmatched_column_is_reported_not_dropped(self) -> None:
        mappings = detect_mapping(["Name", "Cost Center"])
        unmatched = [m for m in mappings if m.field is None]
        assert len(unmatched) == 1
        assert unmatched[0].header == "Cost Center"
        assert unmatched[0].confidence == "none"

    def test_second_column_claiming_a_taken_field_says_why(self) -> None:
        mappings = detect_mapping(["Name", "Task Name"])
        assert mappings[0].field == "name"
        # The operator must be able to see *why* the column vanished.
        assert mappings[1].field is None
        assert mappings[1].confidence == "duplicate"

    def test_missing_required_reports_absent_name(self) -> None:
        assert missing_required(detect_mapping(["Duration", "Start"])) == ["name"]


class TestOverrides:
    def test_override_beats_auto_detection(self) -> None:
        mappings = detect_mapping(["Name", "Widget"], overrides={"Widget": "notes"})
        by_header = {m.header: m.field for m in mappings}
        assert by_header["Widget"] == "notes"
        assert next(m for m in mappings if m.header == "Widget").confidence == "override"

    def test_override_cannot_be_preempted_by_a_column_further_left(self) -> None:
        """An override is honored even when an earlier column would auto-claim it."""
        mappings = detect_mapping(["Title", "Widget"], overrides={"Widget": "name"})
        by_header = {m.header: m.field for m in mappings}
        assert by_header["Widget"] == "name"
        # "Title" loses the field it would otherwise have claimed.
        assert by_header["Title"] is None

    def test_empty_override_forces_a_column_to_be_ignored(self) -> None:
        mappings = detect_mapping(["Name", "Duration"], overrides={"Duration": ""})
        by_header = {m.header: m.field for m in mappings}
        assert by_header["Duration"] is None

    def test_unknown_field_in_override_is_discarded_not_raised(self) -> None:
        """A stale client must not be able to 500 the import."""
        mappings = detect_mapping(["Name", "Duration"], overrides={"Duration": "not_a_field"})
        by_header = {m.header: m.field for m in mappings}
        # Falls through to auto-detection rather than blowing up.
        assert by_header["Duration"] == "duration"


class TestFieldChoices:
    def test_catalog_is_serializable_and_flags_the_required_field(self) -> None:
        choices = field_choices()
        assert {"field": "name", "label": "Task name", "required": True} in choices
        assert all(set(c) == {"field", "label", "required"} for c in choices)
