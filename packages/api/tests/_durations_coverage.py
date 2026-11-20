"""Coverage ratchet for ``.test_durations`` (pytest-split's balancing baseline).

pytest-split gives a test with no recorded duration the *average* of the known
ones. When the baseline lags the suite, the slow tests that were added since are
the ones guessed wrong, and the api:test shards stop balancing (#5084). The
check is coverage-based, not age-based, on purpose: an age limit would red main
on a calendar date with no code cause, whereas a coverage share only moves when
tests are added.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

# Share of collected tests allowed to lack a recorded duration. Right after
# the #5084 regeneration 3.4% (528 of 15,641) were already missing, so 20%
# leaves ample slack before the guard asks for a refresh while still tripping
# long before the 86%-missing state that prompted #5084.
MAX_MISSING_SHARE = 0.20


def missing_share(collected: Iterable[str], durations_path: Path) -> tuple[int, int]:
    """Return ``(missing, total)`` for collected node ids against the baseline.

    A missing or unparseable file counts every test as missing: that is the
    state the guard exists to flag, not one to excuse.
    """
    ids = list(collected)
    try:
        loaded = json.loads(durations_path.read_text())
    except (OSError, ValueError):
        loaded = None
    known = set(loaded) if isinstance(loaded, dict) else set()
    return sum(1 for nodeid in ids if nodeid not in known), len(ids)


def check_durations_coverage(
    collected: Iterable[str],
    durations_path: Path,
    max_share: float = MAX_MISSING_SHARE,
) -> str | None:
    """Return a failure message when too many tests lack a duration, else ``None``."""
    missing, total = missing_share(collected, durations_path)
    if total == 0 or missing / total <= max_share:
        return None
    return (
        f"{missing}/{total} collected tests ({missing / total:.0%}) have no entry in "
        f"{durations_path.name}; the limit is {max_share:.0%}. pytest-split guesses "
        "their duration, so api:test shards no longer balance. Play the manual "
        "`api:test-durations` CI job and commit its packages/api/.test_durations artifact."
    )
