"""The in-progress example quoted in the output-field docs, run as written (#4701).

``early_start`` is the start of the remaining work (the data date for in-progress
work) and ``scheduled_start`` is the start of the whole span. Both docs quote the
same example; the dates are computed here and required to appear in the docs text,
so a change to the engine or to the prose that breaks the quote fails this test.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from trueppm_scheduler import Project, Task, schedule

REPO = Path(__file__).resolve().parents[3]
README = REPO / "packages/scheduler/README.md"
WEBSITE = REPO / "packages/website/src/content/docs/features/scheduler.md"


def _run() -> Task:
    task = Task(
        id="A",
        name="A",
        duration=timedelta(days=10),
        percent_complete=25,
        actual_start=date(2026, 1, 5),
    )
    result = schedule(
        Project(
            id="p",
            name="p",
            start_date=date(2026, 1, 5),
            status_date=date(2026, 1, 12),
            tasks=[task],
            dependencies=[],
        )
    )
    return result.tasks[0]


def test_in_progress_example_values() -> None:
    t = _run()
    assert t.early_start == date(2026, 1, 12)
    assert t.early_finish == date(2026, 1, 21)
    assert t.scheduled_start == date(2026, 1, 5)


def test_docs_quote_the_computed_values() -> None:
    t = _run()
    for path in (README, WEBSITE):
        text = path.read_text()
        for value in (t.early_start, t.early_finish, t.scheduled_start):
            iso = value.isoformat()
            readme_form = f"date({value.year}, {value.month}, {value.day})"
            assert iso in text or readme_form in text, f"{path.name} does not quote {iso}"
    readme = README.read_text()
    assert "date(2026, 1, 12)" in readme and "date(2026, 1, 21)" in readme
    assert "date(2026, 1, 5)" in readme
