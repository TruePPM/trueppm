"""Parse a CSV / Excel upload into computable ``ProjectData`` (#743, ADR-0632).

The output is the shared ``msproject`` interchange dataclass (``ProjectData``),
so the existing, battle-tested ``msproject.importer.import_project`` persists it
— exactly as the Jira adapter does (ADR-0259). This module writes nothing; it is
Django-free apart from importing that dataclass, which is itself ORM-free.

Two shapes of hierarchy are recognized, matching what real spreadsheets carry:

- a **WBS / outline code** column ("1", "1.1", "1.2") -> dotted ``outline_number``
- **indentation** in the task-name column (leading spaces, tabs, or dots)
  -> ``outline_level``

``_build_wbs_paths`` in the importer already prefers a dotted outline number and
falls back to the level sequence, so both land on correct ltree paths without
any hierarchy code here.

Row-level errors are **data, not exceptions**: a bad date or an unresolvable
predecessor records a ``RowError`` and the row still imports with that one field
dropped. Only a structurally unusable file (no header, no name column,
unreadable bytes) raises ``CsvImportError``.
"""

from __future__ import annotations

import contextlib
import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from trueppm_api.apps.csvimport.mapping import ColumnMapping, detect_mapping, missing_required
from trueppm_api.apps.msproject.dataclasses import (
    AssignmentData,
    PredecessorLinkData,
    ProjectData,
    ResourceData,
    TaskData,
)

#: How many parsed rows the preview endpoint echoes back to the wizard.
SAMPLE_ROW_COUNT = 10

_CSV_EXTENSIONS = {"csv", "tsv", "txt"}
_XLSX_EXTENSIONS = {"xlsx", "xlsm"}
SUPPORTED_EXTENSIONS = _CSV_EXTENSIONS | _XLSX_EXTENSIONS

# Text encodings tried in order. utf-8-sig first so a BOM written by Excel is
# consumed rather than becoming part of the first header ("﻿Name").
_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

_TRUEY = {"y", "yes", "true", "t", "1", "x", "on"}

# "3", "3FS", "3FS+2d", "5SS-1 day", "12 ff + 3"
_PREDECESSOR_RE = re.compile(
    r"^\s*(?P<ref>[^\s,;+\-]+?)\s*"
    r"(?:(?P<type>FS|SS|FF|SF)\s*)?"
    r"(?:(?P<sign>[+-])\s*(?P<lag>\d+(?:\.\d+)?)\s*(?:d|day|days)?\s*)?$",
    re.IGNORECASE,
)

_DURATION_RE = re.compile(r"(-?\d+(?:\.\d+)?)")

_SLASH_DATE_RE = re.compile(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$")

# Non-slash date layouts, tried in order against the raw cell text.
_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d %b %Y",
    "%d %B %Y",
    "%b %d %Y",
    "%B %d %Y",
    "%d-%b-%Y",
    "%d-%b-%y",
)


class CsvImportError(Exception):
    """The upload is structurally unusable and no rows can be produced."""


#: Severity is **declared per diagnostic code, not decided by control flow.**
#:
#: The distinction that matters to an operator is exactly one thing: *did the row
#: survive?* A row dropped for having no name is a different event from a row that
#: imported with its start date unset, and collapsing both into "7 problems" hides
#: the only one that lost data. Keeping the mapping as a table rather than as
#: branch structure means a reader can answer "what is fatal here?" by reading one
#: dict, and the wizard can group by severity without re-deriving the rule.
#:
#: ``error``   — the row did **not** import.
#: ``warning`` — the row imported; one field was dropped or defaulted.
SEVERITY_BY_CODE: dict[str, str] = {
    "missing_name": "error",
    "bad_date": "warning",
    "bad_duration": "warning",
    "bad_percent": "warning",
    "unknown_predecessor": "warning",
    "self_dependency": "warning",
    "finish_before_start": "warning",
}

#: Fallback for a code added without a severity. Warning, not error: a new check
#: must not silently start dropping rows from the operator's point of view just
#: because someone forgot the table.
DEFAULT_SEVERITY = "warning"


@dataclass
class RowError:
    """One row-scoped diagnostic.

    A ``warning`` row still imports, minus the offending field; an ``error`` row
    did not import at all. Both ride back in the same list so the operator sees
    one ordered account of what happened to their file.
    """

    row: int
    column: str | None
    code: str
    message: str

    @property
    def severity(self) -> str:
        return SEVERITY_BY_CODE.get(self.code, DEFAULT_SEVERITY)

    def as_dict(self) -> dict[str, Any]:
        return {
            "row": self.row,
            "column": self.column,
            "code": self.code,
            "message": self.message,
            "severity": self.severity,
        }


@dataclass
class ParseResult:
    """Everything both the preview and the commit path need from one upload."""

    project_data: ProjectData
    headers: list[str] = field(default_factory=list)
    mapping: list[ColumnMapping] = field(default_factory=list)
    #: First ``SAMPLE_ROW_COUNT`` data rows, raw cell text, for the wizard.
    sample_rows: list[list[str]] = field(default_factory=list)
    row_errors: list[RowError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: Data rows read (after skipping blank and ``#``-comment rows).
    total_rows: int = 0
    #: Data rows dropped because ``max_rows`` was reached.
    truncated_rows: int = 0

    @property
    def error_count(self) -> int:
        """Diagnostics whose row did not import."""
        return sum(1 for e in self.row_errors if e.severity == "error")

    @property
    def warning_count(self) -> int:
        """Diagnostics whose row imported with a field dropped or defaulted."""
        return sum(1 for e in self.row_errors if e.severity == "warning")


# --- File readers --------------------------------------------------------


def _extension(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _decode(content: bytes) -> str:
    for encoding in _ENCODINGS:
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    # latin-1 maps every byte, so this is unreachable in practice; keep the
    # explicit raise so a future edit to _ENCODINGS cannot silently return None.
    raise CsvImportError("Could not decode the file as text. Save it as UTF-8 CSV.")


def _read_csv_rows(content: bytes) -> tuple[list[list[str]], list[str]]:
    """Decode and split a delimited text upload into rows of raw cell text."""
    warnings: list[str] = []
    text = _decode(content)
    if not text.strip():
        raise CsvImportError("The file is empty.")

    # Sniff the delimiter from the first non-comment lines so tab- and
    # semicolon-separated exports (common from European Excel) work unchanged.
    sample = "\n".join(
        line
        for line in text.splitlines()[:20]
        if line.strip() and not line.lstrip().startswith("#")
    )
    delimiter = ","
    # A single-column file gives the sniffer nothing to work with; comma is the
    # correct fallback because it degrades to one column either way.
    with contextlib.suppress(csv.Error):
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    if delimiter != ",":
        warnings.append(f"Detected '{delimiter}' as the column separator.")

    rows = [list(row) for row in csv.reader(io.StringIO(text), delimiter=delimiter)]
    return rows, warnings


def _read_xlsx_rows(
    content: bytes, max_uncompressed_bytes: int
) -> tuple[list[list[str]], list[str]]:
    """Read the first worksheet of an .xlsx upload into rows of cell values.

    Guards decompression bombs before parsing. openpyxl inherits XXE hardening
    from ``defusedxml`` automatically (it is a direct dependency of this
    package), but nothing in that stack bounds the *inflated* size of a zip
    member -- a 1 MB upload can expand to gigabytes. Summing the central
    directory's declared sizes is cheap, reads no member data, and happens
    before any XML parser sees a byte.
    """
    warnings: list[str] = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise CsvImportError(
            "That .xlsx file could not be opened. Re-save it from Excel and try again."
        ) from exc

    declared = sum(info.file_size for info in archive.infolist())
    if declared > max_uncompressed_bytes:
        raise CsvImportError(
            f"The workbook expands to {declared // (1024 * 1024)} MB, over the "
            f"{max_uncompressed_bytes // (1024 * 1024)} MB limit. "
            "Export the sheet as CSV instead."
        )

    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise CsvImportError("Excel import is unavailable on this server.") from exc

    try:
        workbook = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as exc:
        raise CsvImportError(
            "That .xlsx file could not be read. Re-save it from Excel and try again."
        ) from exc

    try:
        sheet_names = list(workbook.sheetnames)
        if len(sheet_names) > 1:
            warnings.append(
                f"Only the first sheet ('{sheet_names[0]}') was imported. "
                f"{len(sheet_names) - 1} other sheet(s) were ignored."
            )
        worksheet = workbook[sheet_names[0]]
        rows = [[_cell_text(cell) for cell in row] for row in worksheet.iter_rows(values_only=True)]
    finally:
        workbook.close()

    return rows, warnings


def _cell_text(value: Any) -> str:
    """Render one openpyxl cell value as the text the CSV path would have seen."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


# --- Value coercion ------------------------------------------------------


def _prefers_day_first(raw_dates: list[str]) -> bool:
    """Decide whether ambiguous ``a/b/yyyy`` dates are D/M/Y rather than M/D/Y.

    A slash date is only self-identifying when its first component exceeds 12
    (13/04/2026 can only be D/M). We scan **every** date cell in the file before
    parsing any of them, so one unambiguous row settles the whole column. With
    no evidence either way we assume M/D/Y (US English, per project convention)
    and the caller warns, because silently reading 03/04 as March 4 when the
    operator meant 3 April is a data-integrity bug, not a formatting nit.
    """
    for raw in raw_dates:
        match = _SLASH_DATE_RE.match(raw.strip())
        if not match:
            continue
        first, second = int(match.group(1)), int(match.group(2))
        if first > 12 and second <= 12:
            return True
        if second > 12 and first <= 12:
            return False
    return False


def _parse_date(raw: str, day_first: bool) -> date | None:
    text = (raw or "").strip()
    if not text:
        return None

    match = _SLASH_DATE_RE.match(text)
    if match:
        a, b, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
        if year < 100:
            year += 2000 if year < 70 else 1900
        day, month = (a, b) if day_first else (b, a)
        try:
            return date(year, month, day)
        except ValueError:
            return None

    # Excel sometimes hands back a full timestamp for a date-formatted cell.
    text = text.split("T")[0].split(" 00:00:00")[0]
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _parse_duration(raw: str) -> float | None:
    """Read a duration cell as working days ("5", "5d", "5 days", "3.5")."""
    text = (raw or "").strip()
    if not text:
        return None
    match = _DURATION_RE.search(text)
    if not match:
        return None
    value = float(match.group(1))
    # "8h"/"16 hrs" is an effort column in hours, not days. Convert on the
    # standard 8-hour day rather than importing an 8-day task.
    if re.search(r"\b(h|hr|hrs|hour|hours)\b", text, re.IGNORECASE):
        value = value / 8.0
    if re.search(r"\b(w|wk|wks|week|weeks)\b", text, re.IGNORECASE):
        value = value * 5.0
    return value


def _parse_percent(raw: str) -> float | None:
    """Read a %-complete cell, normalizing a 0..1 fraction to 0..100."""
    text = (raw or "").strip()
    if not text:
        return None
    had_sign = "%" in text
    match = _DURATION_RE.search(text)
    if not match:
        return None
    value = float(match.group(1))
    # A bare "0.5" with a decimal point and no % sign is a fraction (Excel's
    # native percent storage); "50%" and "50" are already percentages.
    if not had_sign and 0.0 < value <= 1.0 and "." in match.group(1):
        value *= 100.0
    return max(0.0, min(100.0, value))


def _parse_bool(raw: str) -> bool:
    return (raw or "").strip().lower() in _TRUEY


def _indent_level(raw_name: str) -> int:
    """Infer outline depth from leading whitespace or dot-leaders in a name.

    Two spaces or one tab is one level (the common Excel convention); leading
    dots ("...Design") are treated the same way, one level per dot.
    """
    leading = len(raw_name) - len(raw_name.lstrip(" \t."))
    if leading == 0:
        return 0
    prefix = raw_name[:leading]
    tabs = prefix.count("\t")
    dots = prefix.count(".")
    spaces = prefix.count(" ")
    return tabs + dots + spaces // 2


# --- Main entry point ----------------------------------------------------


def parse_spreadsheet(
    content: bytes,
    filename: str,
    *,
    column_map: dict[str, str] | None = None,
    max_rows: int = 5000,
    max_uncompressed_bytes: int = 100 * 1024 * 1024,
    project_name: str = "",
) -> ParseResult:
    """Parse an uploaded CSV/XLSX into ``ProjectData`` plus preview metadata.

    Args:
        content: Raw uploaded bytes.
        filename: Sanitized filename; only its extension is used, to pick a reader.
        column_map: Optional ``{header: field}`` overrides from the wizard's
            mapping step. Wins over auto-detection, field by field.
        max_rows: Hard cap on data rows; the remainder is reported in
            ``truncated_rows`` rather than silently dropped.
        max_uncompressed_bytes: Zip-bomb ceiling for .xlsx uploads.
        project_name: Fallback name for the ``ProjectData`` header.

    Raises:
        CsvImportError: The file is unreadable, empty, has no header row, or has
            no column that can supply ``Task.name``.
    """
    ext = _extension(filename)
    if ext in _XLSX_EXTENSIONS:
        raw_rows, warnings = _read_xlsx_rows(content, max_uncompressed_bytes)
    elif ext in _CSV_EXTENSIONS:
        raw_rows, warnings = _read_csv_rows(content)
    else:
        raise CsvImportError(f"Unsupported file type: .{ext}. Upload a .csv or .xlsx file.")

    rows = [r for r in raw_rows if not _is_skippable(r)]
    if not rows:
        raise CsvImportError("The file has no readable rows.")

    headers = [str(cell).strip() for cell in rows[0]]
    if not any(headers):
        raise CsvImportError("The first row must be a header row naming each column.")

    mapping = detect_mapping(headers, overrides=column_map)
    missing = missing_required(mapping)
    if missing:
        raise CsvImportError(
            "No column could be matched to the task name. "
            "Rename a column to 'Name' or 'Task', or map one explicitly."
        )

    by_field = {m.field: m.index for m in mapping if m.field}
    data_rows = rows[1:]

    truncated = 0
    if len(data_rows) > max_rows:
        truncated = len(data_rows) - max_rows
        warnings.append(
            f"Only the first {max_rows:,} rows were imported; {truncated:,} were skipped."
        )
        data_rows = data_rows[:max_rows]

    result = ParseResult(
        project_data=ProjectData(name=project_name[:255]),
        headers=headers,
        mapping=mapping,
        row_errors=[],
        warnings=warnings,
        total_rows=len(data_rows),
        truncated_rows=truncated,
    )
    result.sample_rows = [
        [_cell(row, i) for i in range(len(headers))] for row in data_rows[:SAMPLE_ROW_COUNT]
    ]

    _build_tasks(result, data_rows, by_field)
    _resolve_predecessors(result, data_rows, by_field)
    _build_resources(result, data_rows, by_field)

    result.project_data.warnings = list(result.warnings)
    return result


def _is_skippable(row: list[Any]) -> bool:
    """True for a blank row or a ``#``-prefixed comment row."""
    cells = [str(c).strip() for c in row if c is not None]
    if not any(cells):
        return True
    return bool(cells) and cells[0].startswith("#")


def _cell(row: list[Any], index: int | None) -> str:
    if index is None or index >= len(row) or row[index] is None:
        return ""
    return str(row[index])


def _build_tasks(
    result: ParseResult,
    data_rows: list[list[Any]],
    by_field: dict[str, int],
) -> None:
    """Turn each data row into a ``TaskData``, recording per-field failures."""
    name_index = by_field["name"]

    # Resolve the date convention once, over every date cell in the file, so a
    # single unambiguous row (13/04) settles the whole import.
    date_indices = [by_field[f] for f in ("planned_start", "planned_finish") if f in by_field]
    raw_dates = [_cell(row, i) for row in data_rows for i in date_indices]
    day_first = _prefers_day_first(raw_dates)
    if date_indices and any(_SLASH_DATE_RE.match(d.strip()) for d in raw_dates):
        result.warnings.append(
            "Dates like 03/04/2026 were read as "
            + ("day/month/year." if day_first else "month/day/year.")
        )

    has_wbs_column = "wbs" in by_field
    tasks: list[TaskData] = []

    for offset, row in enumerate(data_rows):
        # Row numbers are 1-based and count the header, so they line up with
        # what the operator sees in Excel's row gutter.
        row_number = offset + 2
        raw_name = _cell(row, name_index)
        name = raw_name.strip()
        if not name:
            result.row_errors.append(
                RowError(
                    row_number, result.headers[name_index], "missing_name", "Row has no task name."
                )
            )
            continue

        task = TaskData(uid=offset + 1, name=name[:255])
        task.outline_number = str(len(tasks) + 1)
        task.outline_level = _indent_level(raw_name)

        if has_wbs_column:
            wbs_raw = _cell(row, by_field["wbs"]).strip()
            if wbs_raw:
                _apply_wbs(task, wbs_raw)

        _apply_duration(task, row, by_field, result, row_number)
        _apply_dates(task, row, by_field, result, row_number, day_first)
        _apply_percent(task, row, by_field, result, row_number)

        if "milestone" in by_field and _parse_bool(_cell(row, by_field["milestone"])):
            task.is_milestone = True
        if task.duration_days == 0:
            task.is_milestone = True
        if "notes" in by_field:
            task.notes = _cell(row, by_field["notes"]).strip()[:2000]

        tasks.append(task)

    result.project_data.tasks = tasks


def _apply_wbs(task: TaskData, wbs_raw: str) -> None:
    """Apply a WBS column value as either a dotted code or a bare depth."""
    if "." in wbs_raw and all(p.strip().isdigit() for p in wbs_raw.split(".")):
        # A dotted outline code carries the hierarchy directly; the importer's
        # _build_wbs_paths prefers this over the level sequence.
        task.outline_number = wbs_raw.strip()
        task.outline_level = wbs_raw.count(".")
    elif wbs_raw.isdigit():
        # A bare integer in a "Level"/"Outline" column is a depth, not a code.
        task.outline_level = int(wbs_raw)


def _apply_duration(
    task: TaskData,
    row: list[Any],
    by_field: dict[str, int],
    result: ParseResult,
    row_number: int,
) -> None:
    if "duration" not in by_field:
        return
    raw = _cell(row, by_field["duration"])
    if not raw.strip():
        return
    value = _parse_duration(raw)
    if value is None:
        result.row_errors.append(
            RowError(
                row_number,
                result.headers[by_field["duration"]],
                "bad_duration",
                f"Could not read '{raw.strip()}' as a duration; defaulted to 1 day.",
            )
        )
        return
    if value < 0:
        result.row_errors.append(
            RowError(
                row_number,
                result.headers[by_field["duration"]],
                "bad_duration",
                f"Negative duration '{raw.strip()}'; defaulted to 1 day.",
            )
        )
        return
    task.duration_days = round(value)


def _apply_dates(
    task: TaskData,
    row: list[Any],
    by_field: dict[str, int],
    result: ParseResult,
    row_number: int,
    day_first: bool,
) -> None:
    start = finish = None
    if "planned_start" in by_field:
        raw = _cell(row, by_field["planned_start"])
        if raw.strip():
            start = _parse_date(raw, day_first)
            if start is None:
                result.row_errors.append(
                    RowError(
                        row_number,
                        result.headers[by_field["planned_start"]],
                        "bad_date",
                        f"Could not read '{raw.strip()}' as a date; the start was left unset.",
                    )
                )
    if "planned_finish" in by_field:
        raw = _cell(row, by_field["planned_finish"])
        if raw.strip():
            finish = _parse_date(raw, day_first)
            if finish is None:
                result.row_errors.append(
                    RowError(
                        row_number,
                        result.headers[by_field["planned_finish"]],
                        "bad_date",
                        f"Could not read '{raw.strip()}' as a date; the finish was left unset.",
                    )
                )

    if start:
        task.start = start.isoformat()

    # ProjectData carries a start + duration, not a finish, so a file that gives
    # both has its duration derived from the span (inclusive of both endpoints).
    # An explicit Duration column already read above wins, because it is the
    # operator's stated intent rather than something inferred.
    if start and finish and "duration" not in by_field:
        span = (finish - start).days + 1
        if span < 1:
            result.row_errors.append(
                RowError(
                    row_number,
                    result.headers[by_field["planned_finish"]],
                    "finish_before_start",
                    "Finish is before start; duration defaulted to 1 day.",
                )
            )
        else:
            task.duration_days = span


def _apply_percent(
    task: TaskData,
    row: list[Any],
    by_field: dict[str, int],
    result: ParseResult,
    row_number: int,
) -> None:
    if "percent_complete" not in by_field:
        return
    raw = _cell(row, by_field["percent_complete"])
    if not raw.strip():
        return
    value = _parse_percent(raw)
    if value is None:
        result.row_errors.append(
            RowError(
                row_number,
                result.headers[by_field["percent_complete"]],
                "bad_percent",
                f"Could not read '{raw.strip()}' as a percentage; treated as 0%.",
            )
        )
        return
    task.percent_complete = value


def _resolve_predecessors(
    result: ParseResult,
    data_rows: list[list[Any]],
    by_field: dict[str, int],
) -> None:
    """Attach FS/SS/FF/SF links, quarantining refs that do not resolve.

    References are matched against the source file's own ID column when it has
    one (how MS Project and Asana CSV exports encode dependencies), and against
    1-based row position otherwise. Both are tried for every reference, so a
    file that mixes the two still resolves.
    """
    if "predecessors" not in by_field:
        return

    tasks = result.project_data.tasks
    column = result.headers[by_field["predecessors"]]

    # Map every usable handle -> uid. Row position is registered first so an
    # explicit ID column overrides it on collision (the ID is the stronger claim).
    by_handle: dict[str, int] = {}
    for position, task in enumerate(tasks, start=1):
        by_handle[str(position)] = task.uid
    if "external_id" in by_field:
        id_index = by_field["external_id"]
        # data_rows and tasks diverge when a row was dropped for a missing name,
        # so walk the tasks and re-read the row each one came from via its uid.
        for task in tasks:
            raw_id = _cell(data_rows[task.uid - 1], id_index).strip()
            if raw_id:
                by_handle[raw_id] = task.uid

    for task in tasks:
        row_number = task.uid + 1
        raw = _cell(data_rows[task.uid - 1], by_field["predecessors"]).strip()
        if not raw:
            continue
        for token in re.split(r"[,;]", raw):
            if not token.strip():
                continue
            link = _parse_predecessor(token, by_handle)
            if link is None:
                result.row_errors.append(
                    RowError(
                        row_number,
                        column,
                        "unknown_predecessor",
                        f"Predecessor '{token.strip()}' does not match any row; "
                        "the link was skipped.",
                    )
                )
                continue
            if link.predecessor_uid == task.uid:
                result.row_errors.append(
                    RowError(
                        row_number,
                        column,
                        "self_dependency",
                        "A task cannot depend on itself; the link was skipped.",
                    )
                )
                continue
            task.predecessor_links.append(link)


def _parse_predecessor(token: str, by_handle: dict[str, int]) -> PredecessorLinkData | None:
    match = _PREDECESSOR_RE.match(token)
    if not match:
        return None
    uid = by_handle.get(match.group("ref").strip())
    if uid is None:
        return None
    lag = float(match.group("lag") or 0)
    if match.group("sign") == "-":
        lag = -lag
    return PredecessorLinkData(
        predecessor_uid=uid,
        dep_type=(match.group("type") or "FS").upper(),
        lag_days=round(lag),
    )


def _build_resources(
    result: ParseResult,
    data_rows: list[list[Any]],
    by_field: dict[str, int],
) -> None:
    """Collect distinct assignee names and attach one assignment per task.

    Names are deduplicated case-insensitively but the first-seen spelling is
    kept, so "J. Smith" and "j. smith" become one resource named as first
    written. ``import_project`` match-or-creates these against the project's
    resource pool.
    """
    if "resource" not in by_field:
        return

    resources: list[ResourceData] = []
    uid_by_key: dict[str, int] = {}

    for task in result.project_data.tasks:
        raw = _cell(data_rows[task.uid - 1], by_field["resource"]).strip()
        if not raw:
            continue
        for part in re.split(r"[,;/]", raw):
            name = part.strip()
            if not name:
                continue
            key = name.lower()
            if key not in uid_by_key:
                uid_by_key[key] = len(resources) + 1
                resources.append(ResourceData(uid=uid_by_key[key], name=name[:255]))
            task.resource_assignments.append(
                AssignmentData(task_uid=task.uid, resource_uid=uid_by_key[key], units=1.0)
            )

    result.project_data.resources = resources
