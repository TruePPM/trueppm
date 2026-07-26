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
        # `multi` joined the catalog in #2406 so the wizard can render the Labels
        # card as an additive list rather than a single-select.
        assert {
            "field": "name",
            "label": "Task name",
            "required": True,
            "multi": False,
        } in choices
        assert all(set(c) == {"field", "label", "required", "multi"} for c in choices)


class TestLabelsField:
    """`labels` was absent from the alias table entirely — a sheet's Tags column
    imported silently unmapped (#2406)."""

    @pytest.mark.parametrize(
        "header",
        ["Labels", "Label", "Tags", "Tag", "Category", "Component", "Stream", "Workstream"],
    )
    def test_label_headers_map(self, header: str) -> None:
        [mapping] = detect_mapping([header])
        assert mapping.field == "labels", mapping

    def test_labels_is_offered_to_the_wizard(self) -> None:
        by_field = {c["field"]: c for c in field_choices()}
        assert by_field["labels"]["label"] == "Labels"
        assert by_field["labels"]["required"] is False

    @pytest.mark.parametrize("header", ["Percentage", "Stage", "Vantage"])
    def test_short_alias_does_not_claim_a_header_that_merely_contains_it(self, header: str) -> None:
        """ "tag" is a substring of "Percentage" and "Stage". Fuzzy-matching it
        would quietly route a percentage column into labels, so it is exact-only."""
        [mapping] = detect_mapping([header])
        assert mapping.field != "labels", mapping


class TestMultiColumnFields:
    def test_two_label_columns_both_map(self) -> None:
        mappings = detect_mapping(["Name", "Tags", "Component"])
        assert [m.field for m in mappings] == ["name", "labels", "labels"]
        assert all(m.confidence != "duplicate" for m in mappings)

    def test_two_predecessor_columns_both_map(self) -> None:
        """An MS Project export spreads dependencies across numbered columns."""
        mappings = detect_mapping(["Name", "Predecessor 1", "Predecessor 2"])
        assert [m.field for m in mappings] == ["name", "predecessors", "predecessors"]

    def test_a_second_name_column_is_still_a_duplicate(self) -> None:
        """The multi flag is opt-in per field, not a global relaxation — two
        name columns is a mistake, not a union."""
        mappings = detect_mapping(["Task Name", "Title"])
        assert mappings[0].field == "name"
        assert mappings[1].field is None
        assert mappings[1].confidence == "duplicate"

    def test_single_valued_fields_still_reject_duplicates(self) -> None:
        mappings = detect_mapping(["Name", "Start", "Begin", "Owner", "Assignee"])
        fields = [m.field for m in mappings]
        assert fields.count("planned_start") == 1
        assert fields.count("resource") == 1
        assert [m.confidence for m in mappings].count("duplicate") == 2

    def test_field_choices_marks_the_multi_fields(self) -> None:
        by_field = {c["field"]: c for c in field_choices()}
        assert by_field["labels"]["multi"] is True
        assert by_field["predecessors"]["multi"] is True
        assert by_field["name"]["multi"] is False

    def test_overrides_can_pin_several_columns_to_labels(self) -> None:
        mappings = detect_mapping(
            ["Name", "Team", "Squad"],
            overrides={"Team": "labels", "Squad": "labels"},
        )
        assert [m.field for m in mappings] == ["name", "labels", "labels"]
        assert [m.confidence for m in mappings[1:]] == ["override", "override"]

    def test_overrides_still_reject_a_duplicate_single_valued_field(self) -> None:
        mappings = detect_mapping(
            ["Name", "Alpha", "Beta"],
            overrides={"Alpha": "notes", "Beta": "notes"},
        )
        assert mappings[1].field == "notes"
        assert mappings[2].field is None
        assert mappings[2].confidence == "duplicate"
