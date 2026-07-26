"""Unit tests for the CSV / Excel parser (parser.py, #743).

No database: the parser produces ``ProjectData`` and never writes.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.csvimport.parser import CsvImportError, parse_spreadsheet
from trueppm_api.apps.csvimport.template import CSV_TEMPLATE

from .fixtures import (
    CYCLIC_CSV,
    DAY_FIRST_CSV,
    EMPTY_CSV,
    INDENTED_CSV,
    MESSY_CSV,
    NO_NAME_COLUMN_CSV,
    REFERENCE_CSV,
    SEMICOLON_CSV,
    build_xlsx,
    build_zip_bomb,
)


def _names(result: object) -> list[str]:
    return [t.name for t in result.project_data.tasks]  # type: ignore[attr-defined]


class TestReferenceFixture:
    """The #111 reference sheet must import with zero manual correction."""

    def test_all_rows_parse(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        assert _names(result) == [
            "Discovery",
            "Stakeholder interviews",
            "Requirements draft",
            "Build",
            "Data model",
            "API endpoints",
            "Web UI",
        ]
        assert result.row_errors == []

    def test_comment_and_blank_rows_are_skipped(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        # The '# Exported from ...' line and the blank line between rows 3 and 4
        # are gone, and neither became a task.
        assert result.total_rows == 7
        assert not any(n.startswith("#") for n in _names(result))

    def test_durations_and_percentages_are_read(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Stakeholder interviews"].duration_days == 5
        assert by_name["Stakeholder interviews"].percent_complete == 100.0
        assert by_name["Requirements draft"].percent_complete == 60.0
        assert by_name["Data model"].duration_days == 10

    def test_wbs_column_drives_the_hierarchy(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Discovery"].outline_number == "1"
        assert by_name["Stakeholder interviews"].outline_number == "1.1"
        assert by_name["Web UI"].outline_number == "2.3"

    def test_predecessors_resolve_against_the_id_column(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        links = by_name["Requirements draft"].predecessor_links
        assert len(links) == 1
        # "2" is the ID column value of "Stakeholder interviews".
        assert links[0].predecessor_uid == 2
        assert links[0].dep_type == "FS"

    def test_dependency_type_and_lag_are_parsed(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        ss_link = by_name["API endpoints"].predecessor_links[0]
        assert (ss_link.dep_type, ss_link.lag_days) == ("SS", 0)
        lagged = by_name["Web UI"].predecessor_links[0]
        assert (lagged.dep_type, lagged.lag_days) == ("FS", 2)

    def test_assignees_become_deduplicated_resources(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        assert sorted(r.name for r in result.project_data.resources) == [
            "A. Rivera",
            "J. Chen",
            "P. Osei",
        ]


class TestHierarchyFromIndentation:
    def test_leading_spaces_become_outline_levels(self) -> None:
        result = parse_spreadsheet(INDENTED_CSV, "plan.csv")
        levels = [t.outline_level for t in result.project_data.tasks]
        assert levels == [0, 1, 1, 2, 2, 0, 1]

    def test_indented_names_are_stripped(self) -> None:
        result = parse_spreadsheet(INDENTED_CSV, "plan.csv")
        assert "Backend" in _names(result)


class TestRowLevelErrors:
    """Row errors are data: the row still imports, minus the offending field."""

    def test_valid_rows_still_import_alongside_bad_ones(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        # Five of six rows import; only the nameless row is dropped.
        assert len(result.project_data.tasks) == 5
        assert "Good row" in _names(result)

    def test_each_error_is_reported_by_row_number(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        by_code = {e.code: e for e in result.row_errors}
        assert set(by_code) == {
            "bad_date",
            "bad_duration",
            "unknown_predecessor",
            "self_dependency",
            "missing_name",
        }
        # Row numbers count the header, matching Excel's row gutter.
        assert by_code["bad_date"].row == 3
        assert by_code["bad_duration"].row == 4
        assert by_code["unknown_predecessor"].row == 5
        assert by_code["self_dependency"].row == 6
        assert by_code["missing_name"].row == 7

    def test_errors_name_the_offending_column(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        by_code = {e.code: e for e in result.row_errors}
        assert by_code["bad_date"].column == "Start"
        assert by_code["bad_duration"].column == "Duration"

    def test_unresolvable_and_self_links_are_quarantined(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Ghost predecessor"].predecessor_links == []
        assert by_name["Self referential"].predecessor_links == []

    def test_a_cycle_is_left_intact_for_the_graph_guard(self) -> None:
        """The parser must not silently break cycles -- the guard rejects them."""
        result = parse_spreadsheet(CYCLIC_CSV, "plan.csv")
        edges = [
            (link.predecessor_uid, t.uid)
            for t in result.project_data.tasks
            for link in t.predecessor_links
        ]
        assert sorted(edges) == [(1, 2), (2, 1)]


class TestDateHandling:
    def test_one_unambiguous_row_flips_the_whole_file_to_day_first(self) -> None:
        result = parse_spreadsheet(DAY_FIRST_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        # 13/04 proves D/M/Y, so the ambiguous 03/04 is 3 April, not 4 March.
        assert by_name["Ambiguous"].start == "2026-04-03"
        assert by_name["Clearly day first"].start == "2026-04-13"

    def test_us_format_is_assumed_without_contrary_evidence(self) -> None:
        content = b"Name,Start\nOnly row,03/04/2026\n"
        result = parse_spreadsheet(content, "plan.csv")
        assert result.project_data.tasks[0].start == "2026-03-04"

    def test_the_assumed_convention_is_stated_in_a_warning(self) -> None:
        """Silently guessing a date order would be a data-integrity bug."""
        result = parse_spreadsheet(DAY_FIRST_CSV, "plan.csv")
        assert any("day/month/year" in w for w in result.warnings)

    def test_iso_dates_parse_regardless_of_convention(self) -> None:
        content = b"Name,Start\nTask,2026-11-30\n"
        result = parse_spreadsheet(content, "plan.csv")
        assert result.project_data.tasks[0].start == "2026-11-30"

    def test_duration_is_derived_from_a_start_finish_span(self) -> None:
        content = b"Name,Start,Finish\nTask,2026-03-02,2026-03-06\n"
        result = parse_spreadsheet(content, "plan.csv")
        # Inclusive of both endpoints: Mon-Fri is 5 days.
        assert result.project_data.tasks[0].duration_days == 5

    def test_an_explicit_duration_column_wins_over_a_derived_span(self) -> None:
        content = b"Name,Duration,Start,Finish\nTask,2,2026-03-02,2026-03-06\n"
        result = parse_spreadsheet(content, "plan.csv")
        assert result.project_data.tasks[0].duration_days == 2

    def test_finish_before_start_is_reported(self) -> None:
        content = b"Name,Start,Finish\nTask,2026-03-06,2026-03-02\n"
        result = parse_spreadsheet(content, "plan.csv")
        assert [e.code for e in result.row_errors] == ["finish_before_start"]


class TestValueCoercion:
    @pytest.mark.parametrize(
        ("cell", "expected"),
        [
            (b"5", 5),
            (b"5d", 5),
            (b"5 days", 5),
            (b"3.4", 3),
            (b"16 hours", 2),
            (b"2 weeks", 10),
        ],
    )
    def test_duration_spellings(self, cell: bytes, expected: int) -> None:
        result = parse_spreadsheet(b"Name,Duration\nTask," + cell + b"\n", "p.csv")
        assert result.project_data.tasks[0].duration_days == expected

    @pytest.mark.parametrize(
        ("cell", "expected"),
        [(b"50", 50.0), (b"50%", 50.0), (b"0.5", 50.0), (b"1", 1.0), (b"250", 100.0)],
    )
    def test_percent_spellings(self, cell: bytes, expected: float) -> None:
        result = parse_spreadsheet(b"Name,% Complete\nTask," + cell + b"\n", "p.csv")
        assert result.project_data.tasks[0].percent_complete == expected

    def test_zero_duration_is_a_milestone(self) -> None:
        result = parse_spreadsheet(b"Name,Duration\nGo live,0\n", "p.csv")
        assert result.project_data.tasks[0].is_milestone is True

    def test_explicit_milestone_column(self) -> None:
        result = parse_spreadsheet(b"Name,Milestone\nGo live,yes\n", "p.csv")
        assert result.project_data.tasks[0].is_milestone is True


class TestDelimitersAndEncodings:
    def test_semicolon_delimited_files_parse(self) -> None:
        result = parse_spreadsheet(SEMICOLON_CSV, "plan.csv")
        assert _names(result) == ["Design", "Build"]
        assert any("separator" in w for w in result.warnings)

    def test_utf8_bom_is_consumed_not_glued_to_the_first_header(self) -> None:
        content = "﻿Name,Duration\nDesign,3\n".encode()
        result = parse_spreadsheet(content, "plan.csv")
        assert result.headers[0] == "Name"
        assert _names(result) == ["Design"]

    def test_cp1252_bytes_still_decode(self) -> None:
        content = "Name,Duration\nCaf\xe9 build,3\n".encode("cp1252")
        result = parse_spreadsheet(content, "plan.csv")
        assert _names(result) == ["Café build"]


class TestXlsx:
    def test_xlsx_parses_the_same_as_csv(self) -> None:
        rows: list[list[object]] = [
            ["Name", "Duration", "Start"],
            ["Design", 3, "2026-03-02"],
            ["Build", 5, "2026-03-05"],
        ]
        result = parse_spreadsheet(build_xlsx(rows), "plan.xlsx")
        assert _names(result) == ["Design", "Build"]
        assert result.project_data.tasks[0].duration_days == 3

    def test_real_date_cells_are_read(self) -> None:
        from datetime import datetime

        rows: list[list[object]] = [
            ["Name", "Start"],
            ["Design", datetime(2026, 3, 2)],
        ]
        result = parse_spreadsheet(build_xlsx(rows), "plan.xlsx")
        assert result.project_data.tasks[0].start == "2026-03-02"

    def test_extra_sheets_are_ignored_with_a_warning(self) -> None:
        rows: list[list[object]] = [["Name"], ["Design"]]
        content = build_xlsx(rows, sheet_names=["Plan", "Notes", "Lookup"])
        result = parse_spreadsheet(content, "plan.xlsx")
        assert _names(result) == ["Design"]
        assert any("2 other sheet" in w for w in result.warnings)

    def test_a_zip_bomb_is_rejected_before_parsing(self) -> None:
        """openpyxl's defusedxml hardening covers XXE but not inflation."""
        bomb = build_zip_bomb(50 * 1024 * 1024)
        assert len(bomb) < 200_000, "fixture should stay tiny while declaring 50 MB"
        with pytest.raises(CsvImportError, match="expands to"):
            parse_spreadsheet(bomb, "bomb.xlsx", max_uncompressed_bytes=10 * 1024 * 1024)

    def test_a_non_zip_upload_named_xlsx_is_rejected_cleanly(self) -> None:
        with pytest.raises(CsvImportError, match="could not be opened"):
            parse_spreadsheet(b"this is not a zip", "fake.xlsx")


class TestStructuralRejection:
    """The only cases that raise rather than reporting row errors."""

    def test_no_name_column_is_rejected(self) -> None:
        with pytest.raises(CsvImportError, match="task name"):
            parse_spreadsheet(NO_NAME_COLUMN_CSV, "plan.csv")

    def test_empty_file_is_rejected(self) -> None:
        with pytest.raises(CsvImportError, match="empty"):
            parse_spreadsheet(EMPTY_CSV, "plan.csv")

    def test_unsupported_extension_is_rejected(self) -> None:
        with pytest.raises(CsvImportError, match="Unsupported file type"):
            parse_spreadsheet(b"Name\nTask\n", "plan.pdf")


class TestRowCap:
    def test_rows_past_the_cap_are_reported_not_silently_dropped(self) -> None:
        rows = b"Name,Duration\n" + b"".join(f"Task {i},1\n".encode() for i in range(50))
        result = parse_spreadsheet(rows, "plan.csv", max_rows=10)
        assert len(result.project_data.tasks) == 10
        assert result.truncated_rows == 40
        assert any("40" in w for w in result.warnings)


class TestTemplate:
    def test_the_shipped_template_maps_with_zero_correction(self) -> None:
        """Guards the template and the alias table against drifting apart."""
        result = parse_spreadsheet(CSV_TEMPLATE.encode(), "template.csv")
        unmapped = [m.header for m in result.mapping if m.field is None]
        assert unmapped == []
        assert result.row_errors == []

    def test_the_template_demonstrates_what_it_claims_to(self) -> None:
        result = parse_spreadsheet(CSV_TEMPLATE.encode(), "template.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        # Nesting, a lag, an SS link, and a zero-duration milestone.
        assert by_name["Stakeholder interviews"].outline_number == "1.1"
        assert by_name["Go live"].is_milestone is True
        assert by_name["API endpoints"].predecessor_links[0].dep_type == "SS"
        assert by_name["Go live"].predecessor_links[0].lag_days == 2


class TestOverridesReachTheParser:
    def test_a_column_override_changes_what_is_imported(self) -> None:
        content = b"Widget,Gadget\nDesign,3\n"
        result = parse_spreadsheet(
            content, "plan.csv", column_map={"Widget": "name", "Gadget": "duration"}
        )
        assert _names(result) == ["Design"]
        assert result.project_data.tasks[0].duration_days == 3
