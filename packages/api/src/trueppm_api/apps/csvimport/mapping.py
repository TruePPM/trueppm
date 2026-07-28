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
    #: When True the field is *not* consumed on match, so several columns can
    #: claim it and the parser unions their values. Correct only for fields that
    #: are naturally many — a sheet routinely carries `Tags`, `Component` and
    #: `Team` that should all become labels, or `Predecessor 1`/`Predecessor 2`
    #: from an MS Project export. Everything else keeps exactly-one behavior and
    #: today's `duplicate` reporting: two `Name` columns is a mistake, not a
    #: union (#2406).
    multi: bool = False
    #: Aliases that match only in the exact tier, never as a fuzzy substring.
    #: For a short alias the substring tier is actively harmful — "tag" is
    #: contained in "Percentage" and "Stage", so a fuzzy "tag" would quietly
    #: route a percentage column into labels. Listing it here keeps `Tags` an
    #: exact hit while `Percentage` stays unmapped.
    exact_only: tuple[str, ...] = ()


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
        # An MS Project CSV export splits dependencies across `Predecessor 1`,
        # `Predecessor 2`, … — all of them are real links (#2406).
        multi=True,
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
    # Declared last on purpose. Its aliases are the loosest in the table
    # ("category", "component", "stream" are all plausible substrings of another
    # column's header), and `detect_mapping` assigns each column to the first
    # field it matches — so every more specific field gets its claim in first.
    FieldSpec(
        field="labels",
        label="Labels",
        required=False,
        aliases=("label", "tag", "category", "component", "stream", "workstream"),
        # A sheet's `Tags`, `Component` and `Team` columns are all labels.
        multi=True,
        exact_only=("tag",),
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

# The subset of each field's aliases eligible for the fuzzy substring tier. An
# alias listed in ``exact_only`` is withheld here so it can still win an exact
# match while never claiming a header that merely contains it.
_FUZZY_ALIASES: dict[str, tuple[str, ...]] = {
    spec.field: tuple(
        alias
        for alias in _NORMALIZED_ALIASES[spec.field]
        if alias not in {normalize_header(a) for a in spec.exact_only}
    )
    for spec in TARGET_FIELDS
}

#: Fields that accept several source columns (``FieldSpec.multi``).
MULTI_FIELDS: frozenset[str] = frozenset(s.field for s in TARGET_FIELDS if s.multi)


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
    """Resolve one normalized header key to a field, skipping already-taken ones.

    A ``multi`` field is never in ``taken`` (the callers do not add it), so it
    stays claimable by any number of columns.
    """
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
        for alias in _FUZZY_ALIASES[spec.field]:
            if len(alias) >= 3 and alias in key:
                return spec.field, "fuzzy"

    return None, "none"


def _claim(field: str, taken: set[str]) -> None:
    """Consume a field so no later column can claim it — unless it is multi."""
    if field not in MULTI_FIELDS:
        taken.add(field)


def _resolve_overrides(
    headers: list[str],
    overrides: dict[str, str],
    taken: set[str],
) -> dict[int, tuple[str | None, str]]:
    """Pin the caller's explicit column choices, claiming their fields as we go.

    Runs before auto-detection: a column further left that auto-matches the same
    field would otherwise claim it first and demote the operator's explicit
    choice to ``duplicate``.
    """
    resolved: dict[int, tuple[str | None, str]] = {}
    for index, header in enumerate(headers):
        if header not in overrides:
            continue
        field = overrides[header] or None
        if field is not None and field not in FIELD_BY_NAME:
            # A stale client naming a field we no longer publish must not 500 the
            # import — drop the override and let auto-detection have the column.
            continue
        if field is not None and field in taken:
            resolved[index] = (None, "duplicate")
            continue
        resolved[index] = (field, "override" if field else "none")
        if field:
            _claim(field, taken)
    return resolved


def _resolve_auto(
    headers: list[str],
    resolved: dict[int, tuple[str | None, str]],
    taken: set[str],
) -> None:
    """Auto-detect every column the caller did not pin, extending ``resolved``."""
    for index, header in enumerate(headers):
        if index in resolved:
            continue
        key = normalize_header(header)
        field, confidence = _match_field(key, taken)
        if field:
            _claim(field, taken)
        elif key and _matches_any_alias(key):
            # It *would* have matched, but the field was already claimed.
            confidence = "duplicate"
        resolved[index] = (field, confidence)


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
        One ``ColumnMapping`` per column, in column order. A single-valued field
        is claimed by at most one column; a second column matching a claimed
        field is reported with ``confidence="duplicate"`` and ``field=None`` so
        the operator can see *why* it was dropped rather than watching it
        silently vanish. A ``multi`` field (``labels``, ``predecessors``) is
        never consumed, so every column claiming it maps and the parser unions
        their values (#2406).
    """
    taken: set[str] = set()
    resolved = _resolve_overrides(headers, overrides or {}, taken)
    _resolve_auto(headers, resolved, taken)
    return [
        ColumnMapping(
            index=index,
            header=header,
            field=resolved[index][0],
            confidence=resolved[index][1],
        )
        for index, header in enumerate(headers)
    ]


def _matches_any_alias(key: str) -> bool:
    """True when ``key`` matches some field's alias, ignoring what is taken."""
    for field, aliases in _NORMALIZED_ALIASES.items():
        if key in aliases:
            return True
        if any(len(alias) >= 3 and alias in key for alias in _FUZZY_ALIASES[field]):
            return True
    return False


def missing_required(mappings: list[ColumnMapping]) -> list[str]:
    """Return the required fields no column supplies, in declaration order."""
    mapped = {m.field for m in mappings if m.field}
    return [f for f in REQUIRED_FIELDS if f not in mapped]


def indexes_by_field(mappings: list[ColumnMapping]) -> dict[str, list[int]]:
    """Invert the mapping into ``{field: [column index, ...]}`` in column order.

    Uniformly a list even for single-valued fields, so a caller cannot reach a
    ``multi`` field's columns through an accessor that silently drops all but
    one — the type is what forces every read site to decide (#2406).
    """
    by_field: dict[str, list[int]] = {}
    for m in mappings:
        if m.field:
            by_field.setdefault(m.field, []).append(m.index)
    return by_field


def field_choices() -> list[dict[str, object]]:
    """Serializable field catalog for the wizard's per-column dropdown.

    ``multi`` tells the wizard which cards accept more than one source column,
    so frame 2.1 can render the Labels card as an additive list rather than a
    single-select that appears broken when a second column is chosen.
    """
    return [
        {"field": s.field, "label": s.label, "required": s.required, "multi": s.multi}
        for s in TARGET_FIELDS
    ]
