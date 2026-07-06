"""Unit tests for the Jira XML parser (#1664). No DB — pure parsing."""

from __future__ import annotations

import pytest

from trueppm_api.apps.jiraimport.parser import JiraImportError, parse_jira_xml

from .fixtures import CHAIN_EXPORT, CYCLIC_EXPORT, EDGE_CASE_EXPORT, MESSY_EXPORT


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


def test_skips_issue_with_no_key_and_warns() -> None:
    data = parse_jira_xml(EDGE_CASE_EXPORT)
    names = {t.name for t in data.tasks}
    assert "No key issue" not in names
    assert any("Skipped an issue with no key" in w for w in data.warnings)


def test_duplicate_key_skipped_keeping_the_first() -> None:
    data = parse_jira_xml(EDGE_CASE_EXPORT)
    # "First" (the first PROJ-1) is kept; "Duplicate key repeat" (the second
    # PROJ-1) is dropped.
    names = [t.name for t in data.tasks]
    assert names.count("First") == 1
    assert "Duplicate key repeat" not in names
    assert any("Duplicate issue key PROJ-1 skipped" in w for w in data.warnings)


def test_issue_name_falls_back_to_title_when_summary_missing() -> None:
    data = parse_jira_xml(EDGE_CASE_EXPORT)
    # No <summary> on PROJ-1 -> falls back to <title>, with the "[PROJ-1] "
    # prefix stripped.
    assert "First" in {t.name for t in data.tasks}


def test_non_blocks_link_type_is_ignored() -> None:
    data = parse_jira_xml(EDGE_CASE_EXPORT)
    first = next(t for t in data.tasks if t.name == "First")
    second = next(t for t in data.tasks if t.name == "Second")
    # The "Duplicate" issuelinktype on PROJ-1 must not be read as a dependency.
    assert first.predecessor_links == []
    assert second.predecessor_links == []


@pytest.mark.parametrize("name", ["Second", "Third"])
def test_seconds_to_days_edge_cases_default_to_one_day(name: str) -> None:
    # "Second" has an unparseable estimate (ValueError); "Third" has a
    # zero-second estimate. Both must floor to 1 day so CPM never sees a
    # zero-length (invisible) task.
    data = parse_jira_xml(EDGE_CASE_EXPORT)
    task = next(t for t in data.tasks if t.name == name)
    assert task.duration_days == 1
