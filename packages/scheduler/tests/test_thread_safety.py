"""Concurrent schedule() calls on one process agree (#4543, #4441).

A cheap smoke test, not a proof: N threads share one ``Project`` (and therefore one
``Calendar`` with exceptions, whose lazy index is built on first use) and must all
produce the same result as a serial call.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from trueppm_scheduler import Calendar, DateRange, Dependency, Project, Task, schedule


def _project() -> Project:
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id=f"t{i}", name=f"t{i}", duration=timedelta(days=2 + i % 3)) for i in range(12)
        ],
        dependencies=[
            Dependency(predecessor_id=f"t{i}", successor_id=f"t{i + 1}") for i in range(11)
        ],
        calendar=Calendar(
            exceptions=[
                DateRange(date(2026, 3, 9), date(2026, 3, 10)),
                DateRange(date(2026, 4, 1), date(2026, 4, 3)),
            ]
        ),
    )


def _fingerprint(project: Project) -> list[tuple[str, date, date, bool]]:
    result = schedule(project)
    return sorted((t.id, t.early_start, t.early_finish, t.is_critical) for t in result.tasks)


def test_concurrent_schedule_calls_agree_with_serial() -> None:
    expected = _fingerprint(_project())
    shared = _project()  # one Calendar, index not yet built
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: _fingerprint(shared), range(64)))
    assert all(r == expected for r in results)
