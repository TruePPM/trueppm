"""The in-progress example quoted in the output-field docs, run as written (#4701).

``early_start`` is the start of the remaining work (the data date for in-progress
work) and ``scheduled_start`` is the start of the whole span. Both docs quote the
same example; the dates are computed here and required to appear in the specific
example block (README) or paragraph (website), so drift in the engine or the
prose fails this test.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path

import pytest

from trueppm_scheduler import Project, Task, schedule

# The package root, in the checkout and in mutmut's ``mutants/`` sandbox alike:
# ``also_copy`` puts README.md beside ``mutants/tests/``. A fixed ``parents[3]``
# lands one level too high in the sandbox and kills the stats pass (#4900).
README = Path(__file__).resolve().parents[1] / "README.md"


def _find_website_page() -> Path:
    """The scheduler feature page, found by walking up from this file.

    Not a fixed ``parents[N]``: the sandbox sits one level deeper (see
    ``test_cpm_page_slip_doc.py``, #4880).
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "website/src/content/docs/features/scheduler.md"
        if candidate.is_file():
            return candidate
    return here.parents[2] / "website/src/content/docs/features/scheduler.md"


WEBSITE = _find_website_page()


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


def _lit(d: date) -> str:
    return f"date({d.year}, {d.month}, {d.day})"


def test_in_progress_example_values() -> None:
    t = _run()
    assert t.early_start == date(2026, 1, 12)
    assert t.early_finish == date(2026, 1, 21)
    assert t.scheduled_start == date(2026, 1, 5)
    # remaining work: 75% of 10 days
    assert 10 * (1 - 25 / 100) == 7.5


def test_readme_example_block_quotes_computed_values() -> None:
    t = _run()
    text = README.read_text()
    block = re.search(r"```python\ntask = Task\(.*?```", text, re.S)
    assert block, "the README in-progress example block was removed"
    body = block.group(0)
    for field, value in (
        ("early_start", t.early_start),
        ("early_finish", t.early_finish),
        ("scheduled_start", t.scheduled_start),
    ):
        assert re.search(rf"# {field}\s+== {re.escape(_lit(value))}", body), field
    assert _lit(date(2026, 1, 12)) in body  # status_date input
    assert "percent_complete=25" in body and "timedelta(days=10)" in body


@pytest.mark.skipif(not WEBSITE.exists(), reason="website tree not present")
def test_website_paragraph_quotes_computed_values() -> None:
    t = _run()
    text = WEBSITE.read_text()
    para = next((p for p in text.split("\n\n") if p.startswith("For example, a 10-day task")), None)
    assert para, "the website in-progress example paragraph was removed"
    for field, value in (
        ("early_start", t.early_start),
        ("early_finish", t.early_finish),
        ("scheduled_start", t.scheduled_start),
    ):
        assert f"`{field}` {value.isoformat()}" in para, field
    assert "`status_date` of 2026-01-12" in para
    assert "7.5 days" in para
