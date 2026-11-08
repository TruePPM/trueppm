"""The CPM page's Monte Carlo slip snippet obeys the display rule (#4726).

``features/scheduler.md`` must not compute slip by subtracting two shown days
(the rule in ``ScheduleResult``'s docstring, #4178). The page's usage block is
executed here, and its slip helper is run across a weekend hop.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import pytest

from trueppm_scheduler import Calendar


def _find_page() -> Path:
    """The scheduler feature page, found by walking up from this file.

    Not a fixed ``parents[N]``: under mutmut's copied ``mutants/tests/`` sandbox a
    fixed depth lands on ``packages/scheduler`` and the page reads as absent, which
    the ``skipif`` below would turn into a silent skip (#4880).
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "website/src/content/docs/features/scheduler.md"
        if candidate.is_file():
            return candidate
    return here.parents[2] / "website/src/content/docs/features/scheduler.md"


PAGE = _find_page()

# ``(<expr>.p80 - <expr>.project_finish).days`` or any shown-day subtraction.
_SHOWN_DAY_SUBTRACTION = re.compile(
    r"\(\s*[\w.]+\.(?:p\d+|project_finish)\s*-\s*[\w.]+\.(?:p\d+|project_finish)\s*\)\s*\.days"
)


def _usage_block() -> str:
    text = PAGE.read_text()
    blocks = re.findall(r"```python\n(.*?)```", text, flags=re.S)
    (block,) = [b for b in blocks if "monte_carlo(project" in b]
    return block


@pytest.mark.skipif(not PAGE.exists(), reason="website tree not present")
def test_page_does_not_subtract_shown_days() -> None:
    assert not _SHOWN_DAY_SUBTRACTION.search(PAGE.read_text())


@pytest.mark.skipif(not PAGE.exists(), reason="website tree not present")
def test_page_snippet_uses_real_api_and_runs_across_a_weekend() -> None:
    block = _usage_block()
    assert not _SHOWN_DAY_SUBTRACTION.search(block)
    assert "is_working_day" in block
    assert "p80_at_day_start" in block

    ns: dict[str, object] = {}
    exec(compile(block, "scheduler.md", "exec"), ns)
    helper = ns["working_days_after"]
    cal = Calendar()
    friday, monday = date(2026, 4, 10), date(2026, 4, 13)
    # Start of Monday == end of Friday in working time: no slip, though the shown
    # days differ by three calendar days.
    assert (monday - friday).days == 3
    assert helper(friday, monday, True, cal) == 0  # type: ignore[operator]
    # End of Monday is one working day later.
    assert helper(friday, monday, False, cal) == 1  # type: ignore[operator]
    # Same day, and a percentile shown before the CPM finish, are no slip.
    assert helper(friday, friday, False, cal) == 0  # type: ignore[operator]
    assert helper(friday, date(2026, 4, 9), False, cal) == 0  # type: ignore[operator]
