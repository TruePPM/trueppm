"""Parse a Jira Server / Data Center XML export into computable ProjectData.

Jira's ``Export → XML`` produces an RSS-style document — one ``<item>`` per
issue carrying ``<key>``, ``<summary>``, ``<timeoriginalestimate seconds=...>``,
and an ``<issuelinks>`` block. We read the *smallest computable set* (ADR-0259,
#1664): a task per issue, a duration from the original estimate, and an FS
dependency per ``Blocks`` link. Everything else (sprints, assignees, subtask
hierarchy, custom fields, start-date constraints) is deferred — CPM derives
dates from durations + dependencies, so a critical path needs nothing more.

The output is the shared ``msproject`` interchange dataclass (``ProjectData``)
so the existing, battle-tested ``msproject.importer.import_project`` persists it
— no duplicate task/dependency creation logic.
"""

from __future__ import annotations

import math
from xml.etree.ElementTree import Element

# defusedxml forbids entity expansion and external-entity resolution, closing
# the XXE / billion-laughs vector on this untrusted-file parse (mirrors the MS
# Project parser, #771). A prospect's export is untrusted input.
from defusedxml.ElementTree import fromstring as _safe_fromstring
from django.conf import settings

from trueppm_api.apps.msproject.dataclasses import (
    PredecessorLinkData,
    ProjectData,
    TaskData,
)
from trueppm_api.apps.projects.models import TaskStatus
from trueppm_api.apps.scheduling.units import SECONDS_PER_WORKING_DAY

# Jira status *name* (lower-cased) → TaskStatus value (#1768). The reliable
# signal is Jira's status *category* (To Do / In Progress / Done), but the basic
# ``Export → XML`` only carries the status name, so we map the common Jira / Jira
# Agile status names onto TruePPM's board columns — mirroring the status-map
# concept in ``projects.inbound_sync.DEFAULT_STATUS_MAP``. An unknown or missing
# status maps to None, and the importer falls back to NOT_STARTED — but a known
# "Done"/"In Progress" is no longer silently dropped as unstarted future work.
_STATUS_MAP: dict[str, str] = {
    "backlog": TaskStatus.BACKLOG.value,
    "to do": TaskStatus.NOT_STARTED.value,
    "todo": TaskStatus.NOT_STARTED.value,
    "open": TaskStatus.NOT_STARTED.value,
    "reopened": TaskStatus.NOT_STARTED.value,
    "selected for development": TaskStatus.NOT_STARTED.value,
    "in progress": TaskStatus.IN_PROGRESS.value,
    "in development": TaskStatus.IN_PROGRESS.value,
    "in review": TaskStatus.REVIEW.value,
    "review": TaskStatus.REVIEW.value,
    "in test": TaskStatus.REVIEW.value,
    "done": TaskStatus.COMPLETE.value,
    "closed": TaskStatus.COMPLETE.value,
    "resolved": TaskStatus.COMPLETE.value,
    "complete": TaskStatus.COMPLETE.value,
}


def _map_status(item: Element) -> str | None:
    """Map a Jira ``<item>``'s ``<status>`` name onto a TaskStatus value.

    Returns None when the export carries no status or an unrecognized one, in
    which case the importer applies its NOT_STARTED default.
    """
    raw = (item.findtext("status") or "").strip().lower()
    if not raw:
        return None
    return _STATUS_MAP.get(raw)


# Jira stores the original estimate in seconds; convert on the nominal
# working-day length from the unit seam (#2290) rather than a bare ``8 * 60 * 60``
# so a 0.5 canonical-unit change re-homes in one place. A per-instance
# working-day length remains a later concern.
_SECONDS_PER_DAY = SECONDS_PER_WORKING_DAY

# The Jira issue-link type whose direction encodes a schedule dependency. The
# outward direction ("blocks") makes this issue the predecessor; the inward
# direction ("is blocked by") makes it the successor.
_BLOCKS_LINK_NAME = "blocks"


class JiraImportError(ValueError):
    """The uploaded file is not a parseable Jira XML export."""


def _seconds_to_days(raw: str | None) -> int:
    """Convert a Jira ``timeoriginalestimate`` seconds value to whole days.

    Rounds up so a sub-day estimate still yields a schedulable duration, and
    floors at 1 so a task with no (or an unparseable) estimate is never
    zero-length — a zero-duration task is invisible to CPM float/critical-path
    math, which is the whole reason this importer reads estimates at all.
    """
    if not raw:
        return 1
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        return 1
    if seconds <= 0:
        return 1
    return max(1, math.ceil(seconds / _SECONDS_PER_DAY))


def _issue_key(item: Element) -> str | None:
    key = (item.findtext("key") or "").strip()
    return key or None


def _issue_name(item: Element, key: str) -> str:
    summary = (item.findtext("summary") or "").strip()
    if summary:
        return summary
    # Fall back to the RSS <title> ("[PROJ-1] Summary"), stripping the key
    # prefix Jira prepends; last resort is the bare key so the row is never
    # nameless.
    title = (item.findtext("title") or "").strip()
    prefix = f"[{key}]"
    if title.startswith(prefix):
        title = title[len(prefix) :].strip()
    return title or key


def _blocks_edges(item: Element, key: str) -> list[tuple[str, str]]:
    """Extract ``(blocker_key, blocked_key)`` edges from one issue's links.

    Reads both directions of every ``Blocks`` link type: an *outward* link makes
    ``key`` the blocker (predecessor); an *inward* link makes ``key`` the blocked
    issue (successor). Both are normalized to the same blocker→blocked shape so a
    later dedupe collapses the two halves of a single link that appears on both
    endpoints' exports.
    """
    links = item.find("issuelinks")
    if links is None:
        return []
    edges: list[tuple[str, str]] = []
    for link_type in links.findall("issuelinktype"):
        name = (link_type.findtext("name") or "").strip().lower()
        if name != _BLOCKS_LINK_NAME:
            continue
        outward = link_type.find("outwardlinks")
        if outward is not None:
            for other in _linked_keys(outward):
                edges.append((key, other))  # this issue blocks `other`
        inward = link_type.find("inwardlinks")
        if inward is not None:
            for other in _linked_keys(inward):
                edges.append((other, key))  # `other` blocks this issue
    return edges


def _linked_keys(container: Element) -> list[str]:
    keys: list[str] = []
    for link in container.findall("issuelink"):
        other = (link.findtext("issuekey") or "").strip()
        if other:
            keys.append(other)
    return keys


def _parse_channel(content: bytes) -> Element:
    """Parse the export bytes and return its ``<channel>`` element.

    Raises:
        JiraImportError: If the bytes are not well-formed XML or carry no
            ``<channel>`` element.
    """
    try:
        # _safe_fromstring is untyped (Any); pin to Element so the resolved
        # channel keeps its type through the return.
        root: Element = _safe_fromstring(content)
    except Exception as exc:  # defusedxml raises various parse/entity errors
        raise JiraImportError(f"Not a parseable Jira XML export: {exc}") from exc

    channel = root.find("channel") if root.tag != "channel" else root
    if channel is None:
        raise JiraImportError("Jira XML export has no <channel> element.")
    return channel


def _enforce_row_cap(items: list[Element]) -> None:
    """Reject an export whose issue count exceeds the import row cap.

    The upload SIZE is bounded but the issue count is not (#1721) — a large
    export would build one Task object per issue and bulk-create the lot through
    the shared importer, a worker-memory / transaction-time DoS within the byte
    cap. Reject outright before building anything.
    """
    max_rows = getattr(settings, "JIRA_IMPORT_MAX_ROWS", 20_000)
    if len(items) > max_rows:
        raise JiraImportError(
            f"Jira export has too many issues ({len(items)}); the import limit is "
            f"{max_rows}. Split the export and import in batches."
        )


def _collect_ordered_issues(
    items: list[Element], warnings: list[str]
) -> tuple[dict[str, int], list[tuple[str, Element]]]:
    """Collect keyed issues in document order and assign each a synthetic uid.

    The ProjectData interchange keys by int uid; Jira keys are strings, so a
    stable ``key_to_uid`` map is built here. Keyless and duplicate-key issues are
    dropped with a warning (keeping the first of a duplicate pair).
    """
    key_to_uid: dict[str, int] = {}
    ordered: list[tuple[str, Element]] = []
    for item in items:
        key = _issue_key(item)
        if key is None:
            warnings.append("Skipped an issue with no key.")
            continue
        if key in key_to_uid:
            warnings.append(f"Duplicate issue key {key} skipped.")
            continue
        key_to_uid[key] = len(key_to_uid) + 1
        ordered.append((key, item))
    return key_to_uid, ordered


def _collect_blocks_edges(
    ordered: list[tuple[str, Element]], key_to_uid: dict[str, int], warnings: list[str]
) -> set[tuple[str, str]]:
    """Collect and dedupe ``(blocker, blocked)`` Blocks edges across all issues.

    Self-loops and edges touching an issue absent from this export can't be
    scheduled and are dropped with a warning; the returned set is deduped so the
    two halves of a link that appears on both endpoints' exports collapse.
    """
    edge_set: set[tuple[str, str]] = set()
    for key, item in ordered:
        for blocker, blocked in _blocks_edges(item, key):
            if blocker == blocked:
                warnings.append(f"Self-referential Blocks link on {blocker} skipped.")
                continue
            if blocker not in key_to_uid or blocked not in key_to_uid:
                missing = blocker if blocker not in key_to_uid else blocked
                warnings.append(f"Blocks link to {missing} (not in this export) skipped.")
                continue
            edge_set.add((blocker, blocked))
    return edge_set


def _group_predecessors_by_successor(
    edge_set: set[tuple[str, str]], key_to_uid: dict[str, int]
) -> dict[str, list[int]]:
    """Group predecessor uids by successor key for the ProjectData shape.

    Each ``TaskData`` carries the links for which it is the successor, so the
    blocker→blocked edges are inverted into ``{blocked_key: [blocker_uid, ...]}``.
    """
    predecessors_by_successor: dict[str, list[int]] = {}
    for blocker, blocked in edge_set:
        predecessors_by_successor.setdefault(blocked, []).append(key_to_uid[blocker])
    return predecessors_by_successor


def _build_task(
    index: int,
    key: str,
    item: Element,
    key_to_uid: dict[str, int],
    predecessors_by_successor: dict[str, list[int]],
) -> TaskData:
    """Build one ``TaskData`` from a Jira ``<item>`` and its resolved predecessors."""
    estimate = item.find("timeoriginalestimate")
    seconds = estimate.get("seconds") if estimate is not None else None
    predecessor_links = [
        PredecessorLinkData(predecessor_uid=pred_uid, dep_type="FS", lag_days=0)
        for pred_uid in sorted(predecessors_by_successor.get(key, []))
    ]
    mapped_status = _map_status(item)
    # A terminal status (Done/Closed → COMPLETE, or Review) means the work is
    # 100% delivered, but the basic Jira XML export carries no percent field, so
    # bulk_create would persist COMPLETE at 0% — an incoherent card and a task
    # the Monte Carlo completion check still treats as unstarted. Set the
    # fraction the FloatField stores (1.0 == 100%, matching the MS Project
    # parser's raw/100; the 0-100 storage correction is tracked as #1759).
    percent = 1.0 if mapped_status in (TaskStatus.COMPLETE.value, TaskStatus.REVIEW.value) else 0.0
    return TaskData(
        uid=key_to_uid[key],
        name=_issue_name(item, key)[:512],
        duration_days=_seconds_to_days(seconds),
        # Flat WBS: sequential top-level outline numbers. Subtask / parent
        # hierarchy is deferred (ADR-0259 out-of-scope).
        outline_number=str(index + 1),
        outline_level=0,
        # #1768: carry the source status so completed/in-flight issues do not
        # re-import as NOT_STARTED and inflate the forecast.
        status=mapped_status,
        percent_complete=percent,
        predecessor_links=predecessor_links,
    )


def parse_jira_xml(content: bytes) -> ProjectData:
    """Parse Jira XML export bytes into ``ProjectData`` (tasks + FS dependencies).

    Args:
        content: Raw bytes of a Jira Server / DC XML export.

    Returns:
        ``ProjectData`` with one ``TaskData`` per issue (flat WBS, duration from
        the original estimate) and ``PredecessorLinkData`` FS edges derived from
        ``Blocks`` issue links. Self-referential links and links to issues absent
        from the export are dropped and noted in ``warnings`` (quarantine, not
        crash) — a cyclic *set* of edges is left intact for the caller's graph
        guard to reject before anything is persisted (#1665).

    Raises:
        JiraImportError: If the bytes are not a well-formed Jira XML export
            (unparseable XML, or no ``<channel>``/``<item>`` structure).
    """
    channel = _parse_channel(content)
    items = channel.findall("item")
    _enforce_row_cap(items)

    warnings: list[str] = []
    key_to_uid, ordered = _collect_ordered_issues(items, warnings)
    if not ordered:
        raise JiraImportError("Jira XML export contains no importable issues.")

    edge_set = _collect_blocks_edges(ordered, key_to_uid, warnings)
    predecessors_by_successor = _group_predecessors_by_successor(edge_set, key_to_uid)

    tasks = [
        _build_task(index, key, item, key_to_uid, predecessors_by_successor)
        for index, (key, item) in enumerate(ordered)
    ]

    channel_title = (channel.findtext("title") or "").strip()
    name = channel_title or "Imported from Jira"
    return ProjectData(name=name[:255], start_date=None, tasks=tasks, warnings=warnings)
