"""The README's "Summary tasks" example must run and show what it claims (#4728).

``schedule()`` has no summary concept: it schedules every task it is given as a
leaf. The README tells library users to run ``expand_summary_dependencies`` first,
and shows a phase whose link reaches the leaves only after that expansion. This
executes the README's own code block, so the documented example cannot rot, and
pins the contrast the prose draws against scheduling the raw rows.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from trueppm_scheduler import Calendar, Project, schedule

_README = Path(__file__).resolve().parents[1] / "README.md"


def _summary_example() -> str:
    text = _README.read_text()
    section = text[text.index("### Summary tasks") :]
    match = re.search(r"```python\n(.*?)```", section, re.DOTALL)
    assert match, "README 'Summary tasks' section lost its python example"
    return match.group(1)


def test_readme_summary_example_expands_then_schedules() -> None:
    ns: dict[str, object] = {}
    exec(compile(_summary_example(), "README.md#summary-tasks", "exec"), ns)
    assert ns["test"].early_start == date(2026, 1, 12)  # type: ignore[attr-defined]


def test_readme_summary_example_unexpanded_schedules_summary_as_leaf() -> None:
    ns: dict[str, object] = {}
    exec(compile(_summary_example(), "README.md#summary-tasks", "exec"), ns)
    raw = schedule(
        Project(
            id="p-1",
            name="Unexpanded",
            start_date=date(2026, 1, 5),
            tasks=ns["tasks"],  # type: ignore[arg-type]
            dependencies=ns["deps"],  # type: ignore[arg-type]
            calendar=Calendar(),
        )
    )
    by_id = {t.id: t for t in raw.tasks}
    assert "phase" in by_id  # scheduled as an ordinary task, no error
    assert by_id["test"].early_start == date(2026, 1, 5)  # the phase reached no leaf
