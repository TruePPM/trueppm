"""The PyPI README's "Limits for embedders" table must match the exported caps (#4167).

``packages/scheduler/README.md`` is the PyPI long-description, and its "Limits for
embedders" table (under "## Errors and input limits") documents the numeric value of
every exported ``MAX_*``/``MC_*`` validator cap for an embedder deciding whether the
defaults fit their use case. Nothing else checks that the table's numbers still match
the constants the engine actually enforces — a cap could be retuned in ``engine.py``
and the README would keep quoting the old value until a human happened to notice.
This test parses the table out of the README and asserts every row against
``getattr(trueppm_scheduler, name)``, in both directions, so neither a stale README
value nor an undocumented cap can slip past it.
"""

from __future__ import annotations

import re
from pathlib import Path

import trueppm_scheduler as ts
from trueppm_scheduler import engine as _engine

_README_PATH = Path(__file__).resolve().parents[1] / "README.md"

# The caps the README's "Limits for embedders" table documents. Kept as an explicit
# set (rather than reusing test_public_surface's _VALIDATOR_CAPS) because that list is
# the full exported surface, including caps the table is free to omit; this test's job
# is specifically the table's own completeness and accuracy, not the export surface.
_DOCUMENTED_CAPS = frozenset(
    {
        "MAX_DURATION_DAYS",
        "MAX_LAG_DAYS",
        "MAX_PROJECT_SPAN_DAYS",
        "MAX_DEPENDENCIES",
        "MAX_EXPANDED_EDGES",
        "MAX_CALENDAR_EXCEPTIONS",
        "MAX_CALENDAR_SCAN_DAYS",
        "MAX_LAG_DELTA_CELLS",
        "MAX_INDEX_CELLS",
        "MAX_VELOCITY_SPRINTS",
        "MC_SENSITIVITY_CAP",
        "_MAX_RUNS_ABSOLUTE",
    }
)


def _actual(name: str) -> int:
    """Resolve a documented cap: the exported constant, else the engine's private one.

    ``_MAX_RUNS_ABSOLUTE`` (the ``monte_carlo(runs=…)`` ceiling) is documented in the
    table but deliberately not exported, so it is read from ``engine`` directly.
    """
    return getattr(ts, name) if hasattr(ts, name) else getattr(_engine, name)


def _parse_limits_table() -> dict[str, int]:
    """Extract {cap_name: documented_value} from the README's "Limits for embedders" table.

    The table lives between the "### Limits for embedders" heading and the next
    "```python" fenced block; each row has the shape
    ``| `NAME` | `VALUE` | description |``.
    """
    text = _README_PATH.read_text()
    section_start = text.index("### Limits for embedders")
    section_end = text.index("```python", section_start)
    section = text[section_start:section_end]

    values: dict[str, int] = {}
    for match in re.finditer(r"\|\s*`([A-Z_]+)`\s*\|\s*`(\d+)`\s*\|", section):
        name, raw_value = match.groups()
        values[name] = int(raw_value)
    return values


class TestReadmeLimitsContract:
    def test_table_documents_exactly_the_expected_caps(self) -> None:
        documented = _parse_limits_table()
        assert set(documented) == _DOCUMENTED_CAPS, (
            "README 'Limits for embedders' table and this test's expected cap set "
            f"disagree; documented-only={sorted(set(documented) - _DOCUMENTED_CAPS)}, "
            f"missing-from-table={sorted(_DOCUMENTED_CAPS - set(documented))}"
        )

    def test_table_values_match_the_exported_constants(self) -> None:
        documented = _parse_limits_table()
        mismatched = {
            name: (documented_value, _actual(name))
            for name, documented_value in documented.items()
            if documented_value != _actual(name)
        }
        assert not mismatched, (
            "README 'Limits for embedders' table has drifted from the exported "
            f"constants (documented, actual): {mismatched}"
        )


class TestReadmeSummaryFanOutStatement:
    """The README's #4437 limitation must state the engine's real behavior (#4706).

    FF/SF links into a summary fan out to every leaf; the README once said the
    opposite. Pin the corrected wording and the engine behavior it describes.
    """

    def test_readme_states_ff_sf_into_summary_fan_out(self) -> None:
        text = " ".join(_README_PATH.read_text().split())
        assert (
            "FF/SF links *into* a summary fan out to every leaf, so every leaf "
            "(not only the latest-finishing one) must finish no earlier than the "
            "link requires — short leaves lose float"
        ) in text
        assert "do not fan out to every leaf" not in text

    def test_engine_fans_ff_and_sf_into_every_leaf(self) -> None:
        from datetime import timedelta

        from trueppm_scheduler import Dependency, DependencyType, Task

        for dep_type in (DependencyType.FF, DependencyType.SF):
            tasks = [Task(id=i, name=i, duration=timedelta(days=1)) for i in "XSAB"]
            result = _engine.expand_summary_dependencies(
                tasks, [Dependency("X", "S", dep_type)], {"S": ["A", "B"]}
            )
            assert {(d.predecessor_id, d.successor_id) for d in result.dependencies} == {
                ("X", "A"),
                ("X", "B"),
            }
