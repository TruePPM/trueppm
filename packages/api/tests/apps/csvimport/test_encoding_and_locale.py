"""Encoding and decimal-separator handling for the CSV importer (#2892).

Every case here starts from **bytes on disk**, not from a Python ``str``. That is
the whole point: the bug was at the decode boundary, and a test that hands the
parser an already-decoded string has walked past the defect before asserting
anything. ``files/`` holds the fixtures; see its README for what each one is.

To regenerate a lost fixture::

    utf16 = "Name,Duration,% Complete\\r\\nDesign,5,50%\\r\\nBuild,10,0\\r\\n"
    Path("files/utf16_bom.csv").write_bytes(utf16.encode("utf-16"))
    Path("files/utf16_no_bom.csv").write_bytes(utf16.encode("utf-16-le"))
"""

from __future__ import annotations

from pathlib import Path

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.csvimport.parser import (
    CsvImportError,
    _parse_decimal,
    parse_spreadsheet,
)

FILES = Path(__file__).parent / "files"


def _read(name: str) -> bytes:
    return (FILES / name).read_bytes()


def _by_name(result: object) -> dict[str, object]:
    return {t.name: t for t in result.project_data.tasks}  # type: ignore[attr-defined]


class TestByteOrderMarkedEncodings:
    """A BOM is evidence, not a guess — it must beat the lossy codec ladder."""

    def test_utf16_with_bom_imports_as_readable_text(self) -> None:
        result = parse_spreadsheet(_read("utf16_bom.csv"), "plan.csv")
        assert result.headers == ["Name", "Duration", "% Complete"]
        assert [t.name for t in result.project_data.tasks] == ["Design", "Build"]

    def test_utf16_with_bom_maps_and_imports_its_values(self) -> None:
        result = parse_spreadsheet(_read("utf16_bom.csv"), "plan.csv")
        tasks = _by_name(result)
        assert tasks["Design"].duration_days == 5  # type: ignore[attr-defined]
        assert tasks["Design"].percent_complete == 50.0  # type: ignore[attr-defined]
        assert tasks["Build"].duration_days == 10  # type: ignore[attr-defined]

    def test_utf16_no_longer_produces_a_phantom_nul_row(self) -> None:
        """The mojibake parse minted a third task named "\\x00" (#2892)."""
        result = parse_spreadsheet(_read("utf16_bom.csv"), "plan.csv")
        assert len(result.project_data.tasks) == 2
        assert all("\x00" not in t.name for t in result.project_data.tasks)

    def test_no_header_is_reported_as_an_exact_match_to_mojibake(self) -> None:
        """The regression's signature: full confidence over a misread file.

        Both mojibake headers matched at ``confidence="exact"`` because
        ``normalize_header`` strips the interleaved NULs before comparing. The
        assertion that matters is not "confidence is lower" — it is that the
        header text the confidence describes is the real header text.
        """
        result = parse_spreadsheet(_read("utf16_bom.csv"), "plan.csv")
        exact = [m.header for m in result.mapping if m.confidence == "exact"]
        assert all("\x00" not in header for header in exact)

    @pytest.mark.parametrize(
        "encoding",
        ["utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-8-sig"],
    )
    def test_every_bom_marked_encoding_round_trips(self, encoding: str) -> None:
        body = "Name,Duration\nDesign,5\n"
        marked = body.encode(encoding)
        if encoding in {"utf-16-le", "utf-16-be", "utf-32"}:
            # Hand-add the mark the endian-specific codecs omit, which is exactly
            # what a Windows tool writing a fixed-endian stream does.
            marked = {"utf-16-le": b"\xff\xfe", "utf-16-be": b"\xfe\xff"}.get(
                encoding, b"\xff\xfe\x00\x00"
            ) + (marked if encoding != "utf-32" else marked[4:])
        result = parse_spreadsheet(marked, "plan.csv")
        assert result.headers == ["Name", "Duration"]


class TestUndecodableUploadsAreRefused:
    """A failed decode must raise, never report confidence over mojibake."""

    def test_bomless_utf16_is_refused_rather_than_guessed(self) -> None:
        with pytest.raises(CsvImportError) as exc:
            parse_spreadsheet(_read("utf16_no_bom.csv"), "plan.csv")
        assert "NUL" in str(exc.value)
        assert "UTF-8 CSV" in str(exc.value)

    def test_binary_content_is_refused(self) -> None:
        body = b"Name,Duration\n" + bytes(range(1, 32)) * 40
        with pytest.raises(CsvImportError) as exc:
            parse_spreadsheet(body, "plan.csv")
        assert "UTF-8 CSV" in str(exc.value)

    def test_plain_utf8_and_cp1252_still_import(self) -> None:
        """The guard must not reject the files it was always meant to accept."""
        for encoding in ("utf-8", "cp1252"):
            body = "Name,Duration\nDesign — phaseé,5\n".encode(encoding, "replace")
            result = parse_spreadsheet(body, "plan.csv")
            assert result.headers == ["Name", "Duration"]
            assert len(result.project_data.tasks) == 1


class TestDecimalSeparator:
    """`1,5` is one and a half, and truncating it to 1 is data corruption."""

    def test_european_export_reads_its_durations_and_percentages(self) -> None:
        result = parse_spreadsheet(_read("european_decimals.csv"), "plan.csv")
        tasks = _by_name(result)
        # duration_days is an integer field, so 3.5 rounds — the assertion is that
        # it rounds from 3.5 and not from a truncated 3.
        assert tasks["Design"].duration_days == 4  # type: ignore[attr-defined]
        assert tasks["Build"].duration_days == 10  # type: ignore[attr-defined]
        assert tasks["Integrate"].duration_days == 2  # type: ignore[attr-defined]

    def test_fraction_percent_written_with_a_comma_is_not_zeroed(self) -> None:
        """`0,5` means 50 %, and importing it as 0 % is silent corruption."""
        result = parse_spreadsheet(_read("european_decimals.csv"), "plan.csv")
        tasks = _by_name(result)
        assert tasks["Design"].percent_complete == 50.0  # type: ignore[attr-defined]
        assert tasks["Build"].percent_complete == 75.0  # type: ignore[attr-defined]
        assert tasks["Integrate"].percent_complete == 100.0  # type: ignore[attr-defined]

    def test_no_row_error_is_recorded_for_a_readable_european_cell(self) -> None:
        result = parse_spreadsheet(_read("european_decimals.csv"), "plan.csv")
        assert [e.as_dict() for e in result.row_errors] == []

    @pytest.mark.parametrize(
        ("cell", "expected", "had_fraction"),
        [
            # Single comma, non-3-digit tail -> decimal mark.
            ("3,5", 3.5, True),
            ("10,25", 10.25, True),
            ("0,5", 0.5, True),
            # Single comma, 3-digit tail -> US thousands grouping.
            ("1,500", 1500.0, False),
            # Single period is unchanged in every case, including the 3-digit
            # tail: every previously-correct US file must parse identically.
            ("1.5", 1.5, True),
            ("1.500", 1.5, True),
            ("0.5", 0.5, True),
            # Both marks present -> the last one is the decimal mark.
            ("1.234,56", 1234.56, True),
            ("1,234.56", 1234.56, True),
            # A repeated mark can only be grouping.
            ("1.234.567", 1234567.0, False),
            ("1,234,567", 1234567.0, False),
            # Plain integers, signs, trailing separators, and embedded units.
            ("5", 5.0, False),
            ("-3", -3.0, False),
            ("5,", 5.0, False),
            ("8h", 8.0, False),
            ("16 hrs", 16.0, False),
        ],
    )
    def test_decimal_reader_resolves_each_convention(
        self, cell: str, expected: float, had_fraction: bool
    ) -> None:
        parsed = _parse_decimal(cell)
        assert parsed is not None
        value, fraction = parsed
        assert value == pytest.approx(expected)
        assert fraction is had_fraction

    @pytest.mark.parametrize("cell", ["", "n/a", "TBD", "--", "days"])
    def test_decimal_reader_reports_no_number(self, cell: str) -> None:
        assert _parse_decimal(cell) is None

    def test_hour_and_week_units_still_convert_after_the_rewrite(self) -> None:
        """The unit conversions ride on top of the number, not inside it.

        The unit suffix must be word-separated to be recognized — a bare "16h"
        reads as 16 days, which is pre-existing behavior this change deliberately
        leaves alone (the ``\\b`` in the unit pattern finds no boundary between a
        digit and a letter). Only the number extraction changed.
        """
        result = parse_spreadsheet(
            b'Name,Duration\nDesign,16 hrs\nBuild,2 weeks\nReview,"1,5 days"\n', "plan.csv"
        )
        tasks = _by_name(result)
        assert tasks["Design"].duration_days == 2  # type: ignore[attr-defined]
        assert tasks["Build"].duration_days == 10  # type: ignore[attr-defined]
        # A comma decimal composes with a unit suffix: 1.5 days, not 1.
        assert tasks["Review"].duration_days == 2  # type: ignore[attr-defined]


@pytest.mark.django_db
class TestUploadEndpointDecodeBoundary:
    """The parser is only half the path; the upload has to behave too."""

    def _client(self, project: object) -> APIClient:
        from django.contrib.auth import get_user_model

        from trueppm_api.apps.access.models import ProjectMembership, Role

        user = get_user_model().objects.create_user(username="euro-pm", password="x")
        ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    @pytest.fixture
    def project(self, db: object) -> object:
        from datetime import date

        from trueppm_api.apps.projects.models import Calendar, Project

        calendar = Calendar.objects.create(name="Standard")
        return Project.objects.create(
            name="Locale target", start_date=date(2026, 1, 5), calendar=calendar
        )

    def test_preview_of_a_utf16_upload_returns_readable_headers(self, project: object) -> None:
        response = self._client(project).post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",  # type: ignore[attr-defined]
            {
                "file": SimpleUploadedFile(
                    "plan.csv", _read("utf16_bom.csv"), content_type="text/csv"
                )
            },
            format="multipart",
        )
        assert response.status_code == 200
        assert response.data["headers"] == ["Name", "Duration", "% Complete"]

    def test_preview_of_a_bomless_utf16_upload_is_a_400_naming_the_fix(
        self, project: object
    ) -> None:
        response = self._client(project).post(
            f"/api/v1/projects/{project.pk}/import/csv/preview/",  # type: ignore[attr-defined]
            {
                "file": SimpleUploadedFile(
                    "plan.csv", _read("utf16_no_bom.csv"), content_type="text/csv"
                )
            },
            format="multipart",
        )
        assert response.status_code == 400
        assert "UTF-8 CSV" in response.data["detail"]
