"""Unit tests for the Jira XML parser (#1664). No DB — pure parsing."""

from __future__ import annotations

import pytest

from trueppm_api.apps.jiraimport.parser import JiraImportError, parse_jira_xml

from .fixtures import CHAIN_EXPORT, CYCLIC_EXPORT, MESSY_EXPORT


def test_parses_tasks_names_and_durations() -> None:
    data = parse_jira_xml(CHAIN_EXPORT)
    by_name = {t.name: t for t in data.tasks}
    assert set(by_name) == {"Design the schema", "Build the API", "Ship it"}
    # 28800s / 28800 = 1 day; 144000s / 28800 = 5 days; no estimate → floor of 1.
    assert by_name["Design the schema"].duration_days == 1
    assert by_name["Build the API"].duration_days == 5
    assert by_name["Ship it"].duration_days == 1
    # Flat WBS — sequential top-level outline numbers, no nesting.
    assert {t.outline_number for t in data.tasks} == {"1", "2", "3"}
    assert all(t.outline_level == 0 for t in data.tasks)


def test_parses_blocks_edges_in_both_directions() -> None:
    data = parse_jira_xml(CHAIN_EXPORT)
    uid = {t.name: t.uid for t in data.tasks}
    preds = {t.name: {link.predecessor_uid for link in t.predecessor_links} for t in data.tasks}
    # PROJ-1 blocks PROJ-2 (outward on PROJ-1) → PROJ-1 is PROJ-2's predecessor.
    assert preds["Build the API"] == {uid["Design the schema"]}
    # PROJ-2 blocks PROJ-3 (inward "is blocked by" on PROJ-3) → PROJ-2 is PROJ-3's.
    assert preds["Ship it"] == {uid["Build the API"]}
    assert preds["Design the schema"] == set()
    # All derived dependencies are FS with zero lag.
    for t in data.tasks:
        for link in t.predecessor_links:
            assert link.dep_type == "FS"
            assert link.lag_days == 0


def test_quarantines_self_and_dangling_links() -> None:
    data = parse_jira_xml(MESSY_EXPORT)
    assert len(data.tasks) == 1
    # Neither the self-loop nor the link to the absent PROJ-99 becomes an edge.
    assert data.tasks[0].predecessor_links == []
    joined = " ".join(data.warnings)
    assert "Self-referential" in joined
    assert "PROJ-99" in joined


def test_cyclic_edges_left_intact_for_the_guard() -> None:
    # The parser is not the cycle gate — it emits the cyclic edge set and lets
    # the shared graph guard reject it (so the rejection is identical to the
    # interactive path). Here we just confirm the edges are present.
    data = parse_jira_xml(CYCLIC_EXPORT)
    uid = {t.name: t.uid for t in data.tasks}
    edges = {(link.predecessor_uid, t.uid) for t in data.tasks for link in t.predecessor_links}
    assert (uid["A"], uid["B"]) in edges
    assert (uid["B"], uid["A"]) in edges


@pytest.mark.parametrize(
    "content",
    [
        b"not xml at all",
        b"<rss><channel></channel></rss>",  # no items
        b"<rss></rss>",  # no channel
    ],
)
def test_rejects_unparseable_or_empty(content: bytes) -> None:
    with pytest.raises(JiraImportError):
        parse_jira_xml(content)
