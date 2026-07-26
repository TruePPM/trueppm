"""Fuzzy column auto-detection for spreadsheet import (#743, ADR-0632).

Maps a spreadsheet's header row onto TruePPM task fields using the #111 alias
table. Deliberately **Django-free** so the preview endpoint and the Celery
import task share one implementation and it can be unit-tested without a
database.

Matching is three-tier, tried in order, so a confident hit always beats a
speculative one:

1. ``exact``   — the normalized header equals a known alias ("Task Name" -> name)
2. ``fuzzy``   — the normalized header *contains* an alias as a whole token
                 ("Planned Start Date" -> planned_start)
3. unmatched   — reported with ``field=None`` so the wizard can offer a dropdown

Normalization folds case, strips every non-alphanumeric character, and removes a
trailing plural "s", so ``"% Complete"``, ``"%complete"`` and ``"Percent
Completes"`` all collapse to the same key.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- Target fields -------------------------------------------------------


@dataclass(frozen=True)
class FieldSpec:
    """One importable TruePPM field and the header aliases that map to it."""

    field: str
    label: str
    required: bool
    aliases: tuple[str, ...]


# The #111 alias table. Order matters: `detect_mapping` assigns each column to
# the first field it matches, so more specific fields are declared before the
# looser ones they could otherwise be captured by (planned_start before name --
# "Start" must never be eaten by a substring match on a name alias).
TARGET_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec(
        field="external_id",
        label="ID",
        required=False,
        # A source-file row identifier. Predecessor references are resolved
        # against this when present, which is how MS Project and Asana CSV
        # exports encode their dependency columns.
        aliases=("id", "taskid", "uid", "no", "number", "ref", "key", "item"),
    ),
    FieldSpec(
        field="wbs",
        label="WBS / Phase",
        required=False,
        aliases=("wbs", "wbscode", "phase", "level", "outline", "outlinenumber", "outlinelevel"),
    ),
    FieldSpec(
        field="name",
        label="Task name",
        required=True,
        aliases=("name", "task", "title", "taskname", "activity", "summary", "workitem"),
    ),
    FieldSpec(
        field="duration",
        label="Duration (days)",
        required=False,
        aliases=("duration", "day", "effort", "estimate", "workday", "durationday"),
    ),
    FieldSpec(
        field="planned_start",
        label="Planned start",
        required=False,
        aliases=("start", "begin", "startdate", "begindate", "plannedstart", "starton"),
    ),
    FieldSpec(
        field="planned_finish",
        label="Planned finish",
        required=False,
        aliases=("finish", "end", "due", "finishdate", "enddate", "duedate", "plannedfinish"),
    ),
    FieldSpec(
        field="percent_complete",
        label="% complete",
        required=False,
        aliases=("complete", "percentcomplete", "done", "progress", "pctcomplete", "percentdone"),
    ),
    FieldSpec(
        field="resource",
        label="Assignee",
        required=False,
        aliases=("assignee", "owner", "resource", "assignedto", "responsible", "who"),
    ),
    FieldSpec(
        field="predecessors",
        label="Predecessors",
        required=False,
        aliases=("predecessor", "dependson", "depends", "dependency", "blockedby", "after"),
    ),
    FieldSpec(
        field="milestone",
        label="Milestone",
        required=False,
        aliases=("milestone", "ismilestone"),
    ),
    FieldSpec(
        field="notes",
        label="Notes",
        required=False,
        aliases=("note", "description", "comment", "detail", "remark"),
    ),
)

FIELD_BY_NAME: dict[str, FieldSpec] = {spec.field: spec for spec in TARGET_FIELDS}

REQUIRED_FIELDS: tuple[str, ...] = tuple(s.field for s in TARGET_FIELDS if s.required)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize_header(raw: str) -> str:
    """Fold a raw header to its comparison key.

    Lowercases, drops every non-alphanumeric character, and strips one trailing
    plural "s" (but never from a two-character stem, so "as"/"is" survive).
    """
    key = _NON_ALNUM.sub("", (raw or "").strip().lower())
    if len(key) > 3 and key.endswith("s"):
        key = key[:-1]
    return key


# Aliases are declared above in readable form, but matching happens in the same
# normalized space as the headers -- otherwise the depluralizer that turns
# "Progress" into "progres" would make the literal alias "progress" unreachable.
# Normalizing once here rather than per comparison keeps that invariant in one
# place and off the hot path. Longest-first so a fuzzy substring match prefers
# the most specific alias ("plannedstart" over "start").
_NORMALIZED_ALIASES: dict[str, tuple[str, ...]] = {
    spec.field: tuple(sorted({normalize_header(a) for a in spec.aliases}, key=len, reverse=True))
    for spec in TARGET_FIELDS
}


@dataclass(frozen=True)
class ColumnMapping:
    """How one spreadsheet column was resolved against the alias table."""

    index: int
    header: str
    field: str | None
    #: ``exact`` | ``fuzzy`` | ``none`` | ``duplicate`` | ``override``
    confidence: str

    @property
    def is_mapped(self) -> bool:
        return self.field is not None


def _match_field(key: str, taken: set[str]) -> tuple[str | None, str]:
    """Resolve one normalized header key to a field, skipping already-taken ones."""
    if not key:
        return None, "none"

    for spec in TARGET_FIELDS:
        if spec.field in taken:
            continue
        if key in _NORMALIZED_ALIASES[spec.field]:
            return spec.field, "exact"

    # Tier 2: the header *contains* an alias ("plannedstartdate" -> "plannedstart").
    for spec in TARGET_FIELDS:
        if spec.field in taken:
            continue
        for alias in _NORMALIZED_ALIASES[spec.field]:
            if len(alias) >= 3 and alias in key:
                return spec.field, "fuzzy"

    return None, "none"


def detect_mapping(
    headers: list[str],
    overrides: dict[str, str] | None = None,
) -> list[ColumnMapping]:
    """Map each header column to a TruePPM field.

    Args:
        headers: The spreadsheet's header row, in column order.
        overrides: Optional caller-supplied ``{header: field}`` map. An override
            always wins over auto-detection; ``field`` of ``""`` or ``None``
            forces the column to be ignored. An override naming an unknown field
            is discarded rather than raising -- the wizard's dropdown is the
            source of valid names and a stale client should not 500 the import.

    Returns:
        One ``ColumnMapping`` per column, in column order. A field is claimed by
        at most one column; a second column matching a claimed field is reported
        with ``confidence="duplicate"`` and ``field=None`` so the operator can
        see *why* it was dropped rather than watching it silently vanish.
    """
    overrides = overrides or {}
    result: list[ColumnMapping] = []
    taken: set[str] = set()

    # Pass 1 -- honor explicit overrides so they cannot be pre-empted by an
    # auto-detected column further left claiming the same field.
    resolved: dict[int, tuple[str | None, str]] = {}
    for index, header in enumerate(headers):
        if header not in overrides:
            continue
        field = overrides[header] or None
        if field is not None and field not in FIELD_BY_NAME:
            continue
        if field is not None and field in taken:
            resolved[index] = (None, "duplicate")
            continue
        resolved[index] = (field, "override" if field else "none")
        if field:
            taken.add(field)

    # Pass 2 -- auto-detect everything the caller did not pin.
    for index, header in enumerate(headers):
        if index in resolved:
            continue
        key = normalize_header(header)
        field, confidence = _match_field(key, taken)
        if field:
            taken.add(field)
        elif key and _matches_any_alias(key):
            # It *would* have matched, but the field was already claimed.
            confidence = "duplicate"
        resolved[index] = (field, confidence)

    for index, header in enumerate(headers):
        field, confidence = resolved[index]
        result.append(ColumnMapping(index=index, header=header, field=field, confidence=confidence))
    return result


def _matches_any_alias(key: str) -> bool:
    """True when ``key`` matches some field's alias, ignoring what is taken."""
    for aliases in _NORMALIZED_ALIASES.values():
        if key in aliases:
            return True
        if any(len(alias) >= 3 and alias in key for alias in aliases):
            return True
    return False


def missing_required(mappings: list[ColumnMapping]) -> list[str]:
    """Return the required fields no column supplies, in declaration order."""
    mapped = {m.field for m in mappings if m.field}
    return [f for f in REQUIRED_FIELDS if f not in mapped]


def field_choices() -> list[dict[str, object]]:
    """Serializable field catalog for the wizard's per-column dropdown."""
    return [{"field": s.field, "label": s.label, "required": s.required} for s in TARGET_FIELDS]
