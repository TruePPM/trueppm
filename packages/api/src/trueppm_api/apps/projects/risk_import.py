"""CSV import for the project risk register.

issue 223 / ADR-0043 addendum. The symmetric counterpart of the #222 export:
a CSV produced by "Export CSV" round-trips back through this parser. Parsing and
validation live here — free of Django request objects — so the logic is unit
testable in isolation and ``RiskViewSet.import_csv`` stays a thin orchestrator.

The accepted columns mirror the export (``riskExport.ts``); the issue's extended
column set (residual probability/impact, cost/schedule impact, contingency
reserve) maps to fields the Risk model does not have and is out of scope.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import TYPE_CHECKING

from trueppm_api.apps.projects.models import RiskCategory, RiskResponse, RiskStatus

if TYPE_CHECKING:
    from django.contrib.auth.models import User

# Hard limits — this is a one-time onboarding import, not a bulk pipeline.
# Anything larger is rejected outright (HTTP 400) rather than partially
# processed, so a giant paste can't tie up a worker or balloon a transaction.
MAX_BYTES = 2 * 1024 * 1024  # 2 MB
MAX_ROWS = 500


class RiskImportError(Exception):
    """File-level failure — the upload could not be parsed at all.

    Raised for an undecodable file, a missing required ``Title`` column, an
    empty file, or a row count over :data:`MAX_ROWS`. The view maps this to a
    400 with the message as ``detail``. Row-level problems never raise — they
    accumulate as :class:`ImportIssue` entries instead.
    """


@dataclass(frozen=True)
class ImportIssue:
    """A per-row problem. ``row`` is the spreadsheet line (header = row 1)."""

    row: int
    field: str
    message: str


@dataclass
class RiskDraft:
    """Validated, ready-to-create values for one risk."""

    title: str
    description: str
    status: str
    probability: int
    impact: int
    category: str | None
    response: str | None
    mitigation_due_date: date | None
    trigger: str
    contingency: str
    owner: User | None


@dataclass
class ImportPlan:
    """Outcome of parsing — what to create, and what went wrong per row."""

    drafts: list[RiskDraft] = field(default_factory=list)
    errors: list[ImportIssue] = field(default_factory=list)
    warnings: list[ImportIssue] = field(default_factory=list)

    @property
    def skipped(self) -> int:
        """Number of data rows dropped — those with at least one error."""
        return len({issue.row for issue in self.errors})


def _reverse_label_map(choices: list[tuple[str, str]]) -> dict[str, str]:
    """Map both the stored value and the human label (lowercased) → value.

    The export writes human labels ("In Progress"); a hand-edited CSV may carry
    raw enum values instead. Accept either so the round-trip is forgiving.
    """
    mapping: dict[str, str] = {}
    for value, label in choices:
        mapping[value.lower()] = value
        mapping[label.lower()] = value
    return mapping


_STATUS_MAP = _reverse_label_map(list(RiskStatus.choices))
_CATEGORY_MAP = _reverse_label_map(list(RiskCategory.choices))
_RESPONSE_MAP = _reverse_label_map(list(RiskResponse.choices))

# Accepted header spellings → canonical draft key (lowercased + stripped before
# lookup). Export-only artifacts (ID, Severity) are accepted then ignored so a
# verbatim export round-trips without "unknown column" noise; the "P"/"I"
# short headers and their long forms both resolve.
_HEADER_ALIASES: dict[str, str] = {
    "title": "title",
    "description": "description",
    "status": "status",
    "category": "category",
    "response": "response",
    "p": "probability",
    "probability": "probability",
    "i": "impact",
    "impact": "impact",
    "owner": "owner",
    "mitigation due date": "mitigation_due_date",
    "trigger": "trigger",
    "contingency": "contingency",
    "id": "_ignored",
    "severity": "_ignored",
}

# ISO first (machine-edited), then the export's en-US short format ("Jun 9, 2026")
# and its long form. Unparseable dates warn rather than fail the whole row.
_DATE_FORMATS = ("%Y-%m-%d", "%b %d, %Y", "%B %d, %Y")


def _parse_date(raw: str) -> date | None:
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def _parse_pi(raw: str, label: str, row_num: int, plan: ImportPlan) -> int | None:
    """Parse a probability/impact cell into 1-5.

    The Risk model requires both (NOT NULL, no default), but a hand-built CSV
    may leave them blank. Blank → default 1 with a warning. Present-but-invalid
    (non-numeric or out of range) → error and the row is skipped, since a stray
    value here usually means the columns were mis-mapped and guessing a severity
    would be worse than skipping.
    """
    if not raw:
        plan.warnings.append(ImportIssue(row_num, label, f"{label} is blank — defaulted to 1."))
        return 1
    try:
        parsed = int(raw)
    except ValueError:
        plan.errors.append(
            ImportIssue(row_num, label, f"{label} must be a whole number 1-5, got '{raw}'.")
        )
        return None
    if not 1 <= parsed <= 5:
        plan.errors.append(
            ImportIssue(row_num, label, f"{label} must be between 1 and 5, got {parsed}.")
        )
        return None
    return parsed


def parse_risk_csv(raw: bytes, owner_index: dict[str, User]) -> ImportPlan:
    """Parse and validate a risk CSV into a create plan.

    ``owner_index`` maps lowercased UUID / email / username → project-member
    user; it is built by the caller (:func:`build_owner_index`) so this function
    stays DB-free and unit-testable. Owner matching is scoped to that index, so
    a CSV can never assign a risk to a non-member (prevents cross-project
    assignment via a crafted file).

    Row policy:
      * error (row skipped): missing Title, or P/I present but outside 1-5
      * warning (row imported, value coerced): unrecognized status/category/
        response, unparseable date, unmatched owner, or blank P/I (defaulted)

    Raises:
        RiskImportError: file-level failure (undecodable, empty, no Title
            column, or more than :data:`MAX_ROWS` rows).
    """
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RiskImportError(
            "File is not valid UTF-8 text. Export it as CSV (UTF-8) and try again."
        ) from exc

    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration as exc:
        raise RiskImportError("The file is empty.") from exc

    # Column index → canonical key, skipping ignored and unknown columns.
    col_keys: dict[int, str] = {}
    for idx, name in enumerate(header):
        key = _HEADER_ALIASES.get(name.strip().lower())
        if key and key != "_ignored":
            col_keys[idx] = key
    if "title" not in col_keys.values():
        raise RiskImportError(
            "Missing required 'Title' column. The first row must be a header that "
            "includes Title (an unmodified export works as-is)."
        )

    plan = ImportPlan()
    data_rows = 0
    for offset, cells in enumerate(reader):
        # Skip wholly blank lines (trailing newline, blank separator rows).
        if not any(cell.strip() for cell in cells):
            continue
        data_rows += 1
        if data_rows > MAX_ROWS:
            raise RiskImportError(
                f"Too many rows (limit {MAX_ROWS}). Split the file and import in batches."
            )
        row_num = offset + 2  # header is row 1; first data row is row 2

        values: dict[str, str] = {}
        for idx, key in col_keys.items():
            if idx < len(cells):
                values[key] = cells[idx].strip()

        title = values.get("title", "")
        if not title:
            plan.errors.append(ImportIssue(row_num, "Title", "Title is required."))
            continue

        prob = _parse_pi(values.get("probability", ""), "P", row_num, plan)
        imp = _parse_pi(values.get("impact", ""), "I", row_num, plan)
        if prob is None or imp is None:
            continue

        # Status: blank → Open silently (expected); unrecognized → warn + Open.
        status_raw = values.get("status", "")
        status_val: str = RiskStatus.OPEN
        if status_raw:
            mapped = _STATUS_MAP.get(status_raw.lower())
            if mapped is None:
                plan.warnings.append(
                    ImportIssue(
                        row_num,
                        "Status",
                        f"Unrecognized status '{status_raw}' — defaulted to Open.",
                    )
                )
            else:
                status_val = mapped

        category_val: str | None = None
        category_raw = values.get("category", "")
        if category_raw:
            category_val = _CATEGORY_MAP.get(category_raw.lower())
            if category_val is None:
                plan.warnings.append(
                    ImportIssue(
                        row_num, "Category", f"Unrecognized category '{category_raw}' — left blank."
                    )
                )

        response_val: str | None = None
        response_raw = values.get("response", "")
        if response_raw:
            response_val = _RESPONSE_MAP.get(response_raw.lower())
            if response_val is None:
                plan.warnings.append(
                    ImportIssue(
                        row_num, "Response", f"Unrecognized response '{response_raw}' — left blank."
                    )
                )

        due_val: date | None = None
        due_raw = values.get("mitigation_due_date", "")
        if due_raw:
            due_val = _parse_date(due_raw)
            if due_val is None:
                plan.warnings.append(
                    ImportIssue(
                        row_num,
                        "Mitigation Due Date",
                        f"Couldn't read date '{due_raw}' — left blank.",
                    )
                )

        owner_val: User | None = None
        owner_raw = values.get("owner", "")
        if owner_raw:
            owner_val = owner_index.get(owner_raw.lower())
            if owner_val is None:
                plan.warnings.append(
                    ImportIssue(
                        row_num,
                        "Owner",
                        f"No project member matches '{owner_raw}' — left unassigned.",
                    )
                )

        plan.drafts.append(
            RiskDraft(
                title=title[:512],  # mirror the model's max_length
                description=values.get("description", ""),
                status=status_val,
                probability=prob,
                impact=imp,
                category=category_val,
                response=response_val,
                mitigation_due_date=due_val,
                trigger=values.get("trigger", ""),
                contingency=values.get("contingency", ""),
                owner=owner_val,
            )
        )

    if data_rows == 0:
        raise RiskImportError("No data rows found below the header.")

    return plan


def build_owner_index(project_id: str) -> dict[str, User]:
    """Build the lowercased UUID/email/username → member lookup for owner matching.

    One query (``select_related('user')``), scoped to active project members so
    an import can never assign a risk to someone outside the project. Imported
    here-locally to avoid a circular import at module load (access ↔ projects).
    """
    from trueppm_api.apps.access.models import ProjectMembership

    index: dict[str, User] = {}
    memberships = ProjectMembership.objects.filter(
        project_id=project_id, is_deleted=False
    ).select_related("user")
    for membership in memberships:
        user = membership.user
        if user is None:
            continue
        index[str(user.pk).lower()] = user
        if user.email:
            index[user.email.lower()] = user
        if user.username:
            index[user.username.lower()] = user
    return index
