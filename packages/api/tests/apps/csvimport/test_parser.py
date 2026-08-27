"""Unit tests for the CSV / Excel parser (parser.py, #743).

No database: the parser produces ``ProjectData`` and never writes.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.csvimport.parser import (
    MAX_PARKED_NOTES_LENGTH,
    MAX_PARKED_VALUE_LENGTH,
    REVIEW_BRANCH_NAME,
    SEVERITY_BY_CODE,
    UNRESOLVED_REASON,
    CsvImportError,
    RowError,
    parse_spreadsheet,
)
from trueppm_api.apps.csvimport.template import CSV_TEMPLATE

from .fixtures import (
    ALL_NAMELESS_CSV,
    CYCLIC_CSV,
    DAY_FIRST_CSV,
    DOTTED_WBS_WITH_NAMELESS_CSV,
    EMPTY_CSV,
    INDENTED_CSV,
    INDENTED_WITH_NAMELESS_CSV,
    LABELS_CSV,
    MESSY_CSV,
    MULTI_PREDECESSOR_CSV,
    NO_NAME_COLUMN_CSV,
    REFERENCE_CSV,
    SEMICOLON_CSV,
    build_huge_header_nameless_csv,
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
        """Every row, in file order — not a sample (#3082).

        This used to assert Discovery, Stakeholder interviews and Web UI, which is three
        of seven and misses the only shape that fails. ``Discovery`` is row 1 and its
        code is ``1``, so the positional fallback and the intended code agree by
        coincidence; the dotted rows were always read correctly. ``Build`` — a *second*
        bare-integer row — is the one that landed at its row index instead of its code,
        and it was not asserted.
        """
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        numbers = [(t.name, t.outline_number) for t in result.project_data.tasks]
        assert numbers == [
            ("Discovery", "1"),
            ("Stakeholder interviews", "1.1"),
            ("Requirements draft", "1.2"),
            ("Build", "2"),
            ("Data model", "2.1"),
            ("API endpoints", "2.2"),
            ("Web UI", "2.3"),
        ]

    def test_the_second_phase_row_is_read_as_a_code_not_a_depth(self) -> None:
        """The defect in isolation, stated as what went wrong rather than as a shape.

        A bare cell in a column that also holds dotted cells is an outline *code* — a
        phase's own number. Reading it as a depth left ``outline_number`` at the
        positional fallback ``str(task_count + 1)``, so ``Build`` (4th row) became ``4``
        while its children stayed at ``2.1``/``2.2``/``2.3``, pointing at a number no
        live row held. ``wbs_path`` is the only record of parenthood, so those three
        rendered at project root and the WBS had a hole at ``2``.
        """
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}

        assert by_name["Build"].outline_number == "2"
        assert by_name["Build"].outline_level == 0, "a top-level code is depth 0, not 2"

        parents = {(t.outline_number or "").rsplit(".", 1)[0] for t in result.project_data.tasks}
        numbers = {t.outline_number for t in result.project_data.tasks}
        orphans = {p for p in parents if p and "." not in p and p not in numbers}
        assert orphans == set(), f"these codes have no row holding them: {orphans}"

    def test_a_bare_integer_column_is_still_read_as_depths(self) -> None:
        """The ``Level``/``Outline`` convention ``_apply_wbs`` was written for.

        The fix must not regress it: a column with no dotted cell anywhere is a depth
        column, and its bare integers keep meaning depth. This is the branch that lets
        ``_append_review_branch`` rely on ``outline_number`` still being the positional
        sequence when the file is not dotted.
        """
        depths_csv = (
            b"Task,Level,Days\n"
            b"Discovery,0,1\n"
            b"Stakeholder interviews,1,5\n"
            b"Build,0,1\n"
            b"Data model,1,10\n"
        )
        result = parse_spreadsheet(depths_csv, "levels.csv")
        tasks = result.project_data.tasks
        assert [t.outline_level for t in tasks] == [0, 1, 0, 1]
        assert [t.outline_number for t in tasks] == ["1", "2", "3", "4"], (
            "a depth column leaves outline_number as the positional sequence"
        )

    def test_one_dotted_cell_settles_the_whole_column(self) -> None:
        """The scan is over the column, not the cell — one dotted row is enough.

        Mirrors ``_slash_date_evidence``: a convention that consecutive rows are allowed
        to disagree about is not a convention. Here only the last row is dotted, and it
        still has to decide how the three bare rows above it are read — including the
        two the parser has already walked past by then, which is why the scan runs
        before any row is built rather than during the loop.
        """
        mixed_csv = b"Task,WBS,Days\nAlpha,1,1\nBeta,2,1\nGamma,3,1\nGamma detail,3.1,1\n"
        result = parse_spreadsheet(mixed_csv, "mixed.csv")
        tasks = result.project_data.tasks
        assert [t.outline_number for t in tasks] == ["1", "2", "3", "3.1"]
        assert [t.outline_level for t in tasks] == [0, 0, 0, 1]

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
        # Five of six rows land in the plan; the nameless one is parked, not
        # dropped, so the task list also carries the review branch (#2732).
        assert result.plan_task_count == 5
        assert len(result.project_data.tasks) == 7
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

    def test_severity_separates_dropped_rows_from_degraded_ones(self) -> None:
        """The only distinction an operator needs: did the row become a task?"""
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        by_code = {e.code: e for e in result.row_errors}
        # The nameless row is not part of the plan — it is parked for review.
        assert by_code["missing_name"].severity == "error"
        # These four rows imported, each minus one field.
        for code in ("bad_date", "bad_duration", "unknown_predecessor", "self_dependency"):
            assert by_code[code].severity == "warning", code

    def test_counts_are_split_not_just_totalled(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        assert result.error_count == 1
        assert result.warning_count == 4
        # The error count equals the number of rows that did NOT become plan
        # tasks — those rows are still present, in the review branch.
        assert result.plan_task_count == result.total_rows - result.error_count

    def test_severity_rides_in_the_serialized_payload(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        assert all("severity" in e.as_dict() for e in result.row_errors)

    def test_every_unresolvable_code_has_a_parked_row_phrasing(self) -> None:
        """A code that parks a row must be able to name itself on that row."""
        parked_codes = {code for code, severity in SEVERITY_BY_CODE.items() if severity == "error"}
        assert parked_codes <= set(UNRESOLVED_REASON), parked_codes - set(UNRESOLVED_REASON)

    def test_an_undeclared_code_defaults_to_warning_not_error(self) -> None:
        """A new check must not silently start reading as data loss."""
        err = RowError(row=2, column=None, code="brand_new_check", message="x")
        assert err.severity == "warning"

    def test_every_code_the_parser_emits_has_a_declared_severity(self) -> None:
        """Guards the table against drifting behind the parser."""
        emitted = set()
        for fixture in (MESSY_CSV, REFERENCE_CSV):
            emitted |= {e.code for e in parse_spreadsheet(fixture, "p.csv").row_errors}
        emitted |= {
            e.code
            for e in parse_spreadsheet(
                b"Name,Start,Finish\nT,2026-03-06,2026-03-02\n", "p.csv"
            ).row_errors
        }
        emitted |= {
            e.code for e in parse_spreadsheet(b"Name,% Complete\nT,abc\n", "p.csv").row_errors
        }
        assert emitted <= set(SEVERITY_BY_CODE), emitted - set(SEVERITY_BY_CODE)

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


class TestImportReviewBranch:
    """Unresolvable rows are parked in the outline, never dropped (#2732)."""

    def test_a_nameless_row_becomes_a_task_under_the_review_branch(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        names = _names(result)
        assert REVIEW_BRANCH_NAME in names
        # The parked task names the spreadsheet row and why it is here, so the
        # operator's next action does not need the wizard still to be open.
        assert names[-1] == "Row 7 — no task name"

    def test_the_branch_is_last_in_the_outline(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        names = _names(result)
        assert names[-2] == REVIEW_BRANCH_NAME
        assert names[:5] == [
            "Good row",
            "Bad date",
            "Bad duration",
            "Ghost predecessor",
            "Self referential",
        ]

    def test_the_parked_task_keeps_the_row_s_raw_values(self) -> None:
        """ "Nothing is silently dropped" means the *values*, not just the count."""
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        notes = result.project_data.tasks[-1].notes
        # MESSY_CSV row 7 is `6,,2,2026-03-02,` — ID, Duration and Start survive.
        assert "ID: 6" in notes
        assert "Duration: 2" in notes
        assert "Start: 2026-03-02" in notes

    def test_no_branch_when_every_row_resolves(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        assert result.unresolved_rows == []
        assert REVIEW_BRANCH_NAME not in _names(result)
        assert result.review_task_count == 0
        assert result.plan_task_count == len(result.project_data.tasks)

    def test_parked_rows_carry_no_dependency_edges(self) -> None:
        """The graph the caller validates (ADR-0259) must be the real rows' one."""
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        for task in result.project_data.tasks[-2:]:
            assert task.predecessor_links == []
            assert task.resource_assignments == []

    def test_a_dotted_wbs_file_gets_a_dotted_review_branch(self) -> None:
        result = parse_spreadsheet(DOTTED_WBS_WITH_NAMELESS_CSV, "plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        branch = by_name[REVIEW_BRANCH_NAME].outline_number
        # A fresh top-level code, so the branch cannot land inside a real phase.
        # Asserted relationally rather than as a literal: which number is free
        # depends on how _apply_wbs read the file's own codes, and the property
        # that matters is only that no imported row already claims it.
        heads = {
            (t.outline_number or "").split(".")[0]
            for t in result.project_data.tasks
            if t.name not in (REVIEW_BRANCH_NAME, "Row 6 — no task name")
        }
        assert branch.isdigit()
        assert branch not in heads
        assert by_name["Row 6 — no task name"].outline_number == f"{branch}.1"

    def test_an_indented_file_keeps_its_level_hierarchy(self) -> None:
        """A dotted number here would flip _build_wbs_paths for the whole file."""
        result = parse_spreadsheet(INDENTED_WITH_NAMELESS_CSV, "plan.csv")
        assert not any("." in (t.outline_number or "") for t in result.project_data.tasks)
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name[REVIEW_BRANCH_NAME].outline_level == 0
        assert by_name["Row 5 — no task name"].outline_level == 1
        # Untouched: the real rows keep the depths indentation gave them.
        assert by_name["Design"].outline_level == 1

    def test_a_file_of_only_bad_rows_still_arrives(self) -> None:
        result = parse_spreadsheet(ALL_NAMELESS_CSV, "plan.csv")
        assert result.plan_task_count == 0
        assert _names(result) == [
            REVIEW_BRANCH_NAME,
            "Row 2 — no task name",
            "Row 3 — no task name",
        ]

    def test_the_branch_names_the_file_it_came_from(self) -> None:
        result = parse_spreadsheet(ALL_NAMELESS_CSV, "q3-plan.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert "q3-plan.csv" in by_name[REVIEW_BRANCH_NAME].notes

    def test_a_parked_row_s_notes_are_bounded_by_a_huge_header(self) -> None:
        """The notes key is header text, and it is written once per parked row.

        Truncating only the value side leaves the *key* free to multiply with the
        row count, which is how a sub-megabyte upload expands into gigabytes of
        strings inside the worker.
        """
        content = build_huge_header_nameless_csv(header_chars=100_000, rows=5)
        result = parse_spreadsheet(content, "wide.csv")

        parked = [t for t in result.project_data.tasks if t.name.startswith("Row ")]
        assert len(parked) == 5
        for task in parked:
            assert len(task.notes) <= MAX_PARKED_NOTES_LENGTH
        for unresolved in result.unresolved_rows:
            for header in unresolved.values:
                assert len(header) <= MAX_PARKED_VALUE_LENGTH

    def test_parked_uids_do_not_collide_with_imported_rows(self) -> None:
        result = parse_spreadsheet(MESSY_CSV, "plan.csv")
        uids = [t.uid for t in result.project_data.tasks]
        assert len(set(uids)) == len(uids)


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

    def test_the_convention_is_reported_with_the_value_that_settled_it(self) -> None:
        """The passive warning is replaced by evidence a reader can check (#2926).

        The old behavior appended "Dates like 03/04/2026 were read as
        day/month/year." to ``warnings`` — read-only, below the preview, and
        unfalsifiable by the reader. It is deleted, not moved: leaving it in
        place alongside a live control would be two sources of truth about the
        same inference.
        """
        result = parse_spreadsheet(DAY_FIRST_CSV, "plan.csv")
        assert not any("day/month/year" in w for w in result.warnings)

        convention = result.date_order
        assert convention.resolved == "dmy"
        assert convention.ambiguous is False
        assert convention.evidence is not None
        # Names the row, column and value it was derived from, so the operator
        # can check the claim against their own file in five seconds.
        assert convention.evidence["value"] == "13/04/2026"
        assert convention.evidence["reason"] == "no_thirteenth_month"
        assert convention.evidence["row"] > 1

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


class TestLabels:
    """`labels` was not a mappable field at all — a Tags column imported
    silently unmapped, landing the spreadsheet migrator in a project where
    every 0.4 label feature is empty (#2406)."""

    def test_tags_column_becomes_labels(self) -> None:
        result = parse_spreadsheet(LABELS_CSV, "labels.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Fit-out"].labels == []
        assert "safety" in by_name["Site survey"].labels

    def test_two_label_columns_are_unioned_onto_the_task(self) -> None:
        result = parse_spreadsheet(LABELS_CSV, "labels.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Site survey"].labels == ["safety", "rework", "Civil"]

    def test_cells_split_on_the_shared_separators(self) -> None:
        """Same `, ; /` convention the resource column has always used."""
        result = parse_spreadsheet(LABELS_CSV, "labels.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Foundation pour"].labels == ["safety", "permit", "Civil"]

    def test_case_variants_collapse_to_the_first_spelling(self) -> None:
        """An import must not mint `SAFETY` alongside the `safety` it just saw."""
        result = parse_spreadsheet(LABELS_CSV, "labels.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Steel erection"].labels == ["safety", "Structural"]

    def test_a_task_repeating_a_label_across_columns_gets_it_once(self) -> None:
        csv = b"Name,Tags,Component\nA,shared,Shared\n"
        result = parse_spreadsheet(csv, "dup.csv")
        assert result.project_data.tasks[0].labels == ["shared"]

    def test_long_names_are_truncated_with_a_warning(self) -> None:
        csv = b"Name,Tags\nA," + b"x" * 80 + b"\n"
        result = parse_spreadsheet(csv, "long.csv")
        assert len(result.project_data.tasks[0].labels[0]) == 50
        assert any("shortened" in w for w in result.warnings)

    def test_distinct_label_count_is_capped(self) -> None:
        """A Notes column accidentally mapped to labels would otherwise mint one
        catalog entry per row."""
        rows = b"".join(f"T{i},label-{i}\n".encode() for i in range(150))
        result = parse_spreadsheet(b"Name,Tags\n" + rows, "many.csv")
        distinct = {name for t in result.project_data.tasks for name in t.labels}
        assert len(distinct) == 100
        assert any(e.code == "too_many_labels" for e in result.row_errors)

    def test_no_label_column_leaves_tasks_unlabeled(self) -> None:
        result = parse_spreadsheet(REFERENCE_CSV, "ref.csv")
        assert all(t.labels == [] for t in result.project_data.tasks)

    def test_template_carries_a_labels_column(self) -> None:
        """The template is a worked example; it has to demonstrate the field."""
        result = parse_spreadsheet(CSV_TEMPLATE.encode(), "template.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert by_name["Cutover rehearsal"].labels == ["launch", "ops"]


class TestMultiColumnPredecessors:
    def test_both_predecessor_columns_are_read(self) -> None:
        result = parse_spreadsheet(MULTI_PREDECESSOR_CSV, "preds.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert sorted(link.predecessor_uid for link in by_name["Build"].predecessor_links) == [1, 2]

    def test_the_same_ref_in_two_columns_is_one_link(self) -> None:
        """Two columns naming the same predecessor is a union, not two edges."""
        result = parse_spreadsheet(MULTI_PREDECESSOR_CSV, "preds.csv")
        by_name = {t.name: t for t in result.project_data.tasks}
        assert len(by_name["Inspect"].predecessor_links) == 1

    def test_a_row_error_names_the_column_the_token_came_from(self) -> None:
        csv = b"ID,Name,Predecessor 1,Predecessor 2\n1,A,,\n2,B,1,nope\n"
        result = parse_spreadsheet(csv, "preds.csv")
        [error] = [e for e in result.row_errors if e.code == "unknown_predecessor"]
        assert error.column == "Predecessor 2"


class TestDateOrderOverride:
    """#2926 — the operator can assert the convention their own export uses.

    The bug this closes is silent: ``Design,03/04/2026,05/04/2026`` means 3 Apr
    → 5 Apr (three days) to a European exporter, and auto reads it as 4 Mar →
    4 May (sixty-two days) with no control anywhere to say otherwise.
    """

    #: Every value valid under both conventions — nothing self-identifies.
    AMBIGUOUS = b"Name,Start,Finish\nDesign,03/04/2026,05/04/2026\n"

    def test_auto_still_reads_the_ambiguous_file_as_month_first(self) -> None:
        """`auto` is unchanged, byte for byte — this ticket adds a control, not a new default."""
        result = parse_spreadsheet(self.AMBIGUOUS, "plan.csv", date_order="auto")
        assert result.project_data.tasks[0].start == "2026-03-04"
        assert result.project_data.tasks[0].duration_days == 62

    def test_the_override_produces_the_duration_the_operator_meant(self) -> None:
        result = parse_spreadsheet(self.AMBIGUOUS, "plan.csv", date_order="dmy")
        assert result.project_data.tasks[0].start == "2026-04-03"
        assert result.project_data.tasks[0].duration_days == 3

    def test_an_ambiguous_file_says_so_and_offers_both_readings(self) -> None:
        """The state the ticket exists for: auto is a coin flip and must announce it."""
        convention = parse_spreadsheet(self.AMBIGUOUS, "plan.csv").date_order
        assert convention.ambiguous is True
        assert convention.evidence is None
        assert convention.resolved == "mdy"

        readings = {r.order: r for r in convention.readings}
        assert set(readings) == {"mdy", "dmy"}
        # The 59-day difference on one task is the whole argument for the block.
        assert readings["mdy"].duration_days == 62
        assert readings["dmy"].duration_days == 3
        assert readings["mdy"].sample_name == "Design"

    def test_a_self_identifying_file_is_never_ambiguous(self) -> None:
        convention = parse_spreadsheet(DAY_FIRST_CSV, "plan.csv").date_order
        assert convention.ambiguous is False
        assert convention.readings == []

    def test_an_iso_file_is_not_ambiguous_and_needs_no_argument(self) -> None:
        content = b"Name,Start,Finish\nTask,2026-04-03,2026-04-05\n"
        convention = parse_spreadsheet(content, "plan.csv").date_order
        assert convention.resolved == "iso"
        assert convention.ambiguous is False

    def test_iso_refuses_to_reinterpret_a_slash_date(self) -> None:
        """Asserting ISO rules out slash dates; a row carrying one is malformed, not re-guessed."""
        result = parse_spreadsheet(self.AMBIGUOUS, "plan.csv", date_order="iso")
        assert result.project_data.tasks[0].start is None
        assert [e.code for e in result.row_errors] == ["bad_date", "bad_date"]
        assert result.date_order.values_failed == 2

    def test_rows_that_fail_under_the_chosen_order_are_counted_not_hidden(self) -> None:
        """Choosing M/D/Y on a file containing 13/04 is allowed, counted, and named."""
        content = (
            b"Name,Start,Finish\nDesign,03/04/2026,05/04/2026\nHandover,13/04/2026,14/04/2026\n"
        )
        convention = parse_spreadsheet(content, "plan.csv", date_order="mdy").date_order
        assert convention.values_matched == 2
        assert convention.values_failed == 2

    def test_the_override_still_reports_what_auto_would_have_done(self) -> None:
        """The override copy names both, so the operator can see what they changed."""
        convention = parse_spreadsheet(self.AMBIGUOUS, "plan.csv", date_order="dmy").date_order
        assert convention.requested == "dmy"
        assert convention.resolved == "dmy"
        assert convention.auto_resolved == "mdy"

    def test_no_mapped_date_column_means_nothing_to_settle(self) -> None:
        """Reported as inert rather than resolved — the wizard greys the control out."""
        convention = parse_spreadsheet(b"Name,Notes\nTask,hello\n", "plan.csv").date_order
        assert convention.has_date_columns is False
        assert convention.ambiguous is False

    def test_an_unknown_order_is_rejected_rather_than_ignored(self) -> None:
        """A misspelled order that silently fell back to auto is the corruption this closes."""
        with pytest.raises(CsvImportError, match="Unknown date order"):
            parse_spreadsheet(self.AMBIGUOUS, "plan.csv", date_order="d/m/y")

    def test_the_preview_shows_the_raw_cell_beside_what_it_was_read_as(self) -> None:
        content = (
            b"Name,Start,Finish\nDesign,03/04/2026,05/04/2026\nHandover,13/04/2026,14/04/2026\n"
        )
        rows = parse_spreadsheet(content, "plan.csv", date_order="mdy").date_preview
        assert rows[0]["raw_start"] == "03/04/2026"
        assert rows[0]["start"] == "2026-03-04"
        assert rows[0]["duration_days"] == 62
        # Row 14 in the design's example: unreadable under the guess, and shown
        # as such rather than omitted.
        assert rows[1]["start"] is None
        assert rows[1]["unreadable"] is True
