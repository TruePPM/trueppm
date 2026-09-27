"""The documented milestone display rule, run as written (#4178).

``ScheduleResult``'s docstring states how a milestone instant on non-working time
is shown and warns consumers that the shown day can hop a weekend with no
working-time move. Its example is executed here so the documented rule cannot
drift from the engine: the package does not collect doctests on its own.
"""

from __future__ import annotations

import doctest

from trueppm_scheduler.engine import ScheduleResult


def test_schedule_result_display_rule_example_holds() -> None:
    finder = doctest.DocTestFinder(recurse=False)
    (test,) = finder.find(ScheduleResult, "ScheduleResult", globs={})
    assert test.examples, "the display-rule example was removed from the docstring"
    runner = doctest.DocTestRunner(optionflags=doctest.ELLIPSIS)
    result = runner.run(test)
    assert result.failed == 0
    assert result.attempted >= 4
