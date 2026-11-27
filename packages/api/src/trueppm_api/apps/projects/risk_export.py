"""Server-side risk register CSV (#1200, data-interchange spec §5.6.1).

The column contract is the one the web Risks view writes (``riskExport.ts``) and
the importer reads (:mod:`risk_import`), so a downloaded register round-trips. It
adds one column the importer ignores, ``Owner Name``, because ``Owner`` carries the
member id that matching needs and a person pasting the register into a report
needs a name. The dialect is spec §5.5: RFC 4180, CRLF, UTF-8 with no BOM, ISO
dates, stored enum values.

Risks carry no ADR-0104 team-private signal and no email address, so the file
sits at the same tier as the risk list it mirrors (Viewer+), per ADR-0634 §6.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from django.db.models import F, QuerySet

HEADERS = (
    "ID",
    "Title",
    "Status",
    "Category",
    "Response",
    "P",
    "I",
    "Severity",
    "Owner",
    "Owner Name",
    "Mitigation Due Date",
    "Trigger",
    "Contingency",
    "Description",
)

#: Leading characters a spreadsheet evaluates as a formula (CSV injection). Mirrors
#: ``escapeField`` in ``packages/web/src/utils/exportCsv.ts``: such a cell is
#: prefixed with a single quote so it is shown as text.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _cell(value: Any) -> str:
    text = "" if value is None else str(value)
    if text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def _owner_name(owner: Any) -> str:
    if owner is None:
        return ""
    from trueppm_api.apps.workspace.serializers import display_name_for

    return str(display_name_for(owner.first_name, owner.last_name, owner.username))


def ordered_register(risks: QuerySet[Any]) -> QuerySet[Any]:
    """The register in report order: highest severity first, then oldest first."""
    return risks.select_related("owner", "project").order_by(
        (F("probability") * F("impact")).desc(), "created_at", "pk"
    )


def risk_register_csv(risks: QuerySet[Any]) -> str:
    """Render the given risks as the register CSV, one row per risk."""
    from trueppm_api.apps.projects.serializers import RiskSerializer

    ids = RiskSerializer()
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(HEADERS)
    for risk in ordered_register(risks):
        due = risk.mitigation_due_date
        writer.writerow(
            [
                _cell(value)
                for value in (
                    ids.get_qualified_id(risk),
                    risk.title,
                    risk.status,
                    risk.category,
                    risk.response,
                    risk.probability,
                    risk.impact,
                    risk.probability * risk.impact,
                    risk.owner_id,
                    _owner_name(risk.owner),
                    due.isoformat() if due else "",
                    risk.trigger,
                    risk.contingency,
                    risk.description,
                )
            ]
        )
    return buf.getvalue()
