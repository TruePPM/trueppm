"""Exceptions raised by the scheduler engine."""

from __future__ import annotations

from trueppm_scheduler.models import (
    _short_repr,
)

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class SchedulerError(ValueError):
    """Common base class for every exception the scheduler engine raises.

    Subclasses :class:`ValueError` so existing ``except ValueError`` callers keep
    working, while giving consumers of the public ``trueppm-scheduler`` package a
    single type to catch (``except SchedulerError``) for any scheduler-originated
    failure. Introduced ahead of the 1.0 public-surface freeze: interposing a
    common base is backward compatible to add now (the concrete exceptions remain
    :class:`ValueError` subclasses) but would be a breaking change to add later.
    """


_CYCLE_MSG_MAX_IDS = 10


_CYCLE_MSG_ID_CHARS = 80


class CyclicDependencyError(SchedulerError):
    """Raised when the dependency graph contains a cycle.

    The offending cycle is provided so callers can surface it to users
    without parsing a raw networkx exception. ``cycle`` is the full, canonical
    path (first id repeated at the end); the message is a bounded, escaped
    rendering of it: each id is ``repr()``-formatted (control characters cannot
    forge log lines), ids longer than ``_CYCLE_MSG_ID_CHARS`` are cut, and
    only the first ``_CYCLE_MSG_MAX_IDS`` ids are listed, followed by
    ``… (+M more)``.
    """

    def __init__(self, cycle: list[str]) -> None:
        """Build the error from the offending cycle.

        Args:
            cycle: The full, canonical cycle path (first id repeated at the end).
                Kept verbatim on :attr:`cycle`; the message is a bounded, escaped
                rendering of it.
        """
        self.cycle = cycle
        shown = [_short_repr(c, _CYCLE_MSG_ID_CHARS) for c in cycle[:_CYCLE_MSG_MAX_IDS]]
        ids = " → ".join(shown)
        if len(cycle) > _CYCLE_MSG_MAX_IDS:
            ids += f" … (+{len(cycle) - _CYCLE_MSG_MAX_IDS} more)"
        super().__init__(f"Cyclic dependency detected: {ids}")


class SimulationCapExceeded(SchedulerError):
    """Raised when n_simulations or task count exceeds the configured cap.

    The message is user-facing and suitable for inclusion in an API response
    body without further processing.
    """


class InvalidScheduleInput(SchedulerError):
    """Raised when a project's input is structurally valid but out of range.

    Covers the degenerate inputs that would otherwise drive the day-by-day
    calendar walk into a multi-million-iteration spin and an uncaught
    ``OverflowError`` (a calendar with no working day, an absurd duration or
    lag), plus malformed ``children_map`` cycles. Subclasses :class:`SchedulerError`
    (and thus :class:`ValueError`) so existing ``except ValueError`` callers keep
    working; raised eagerly at the public entry points so a single hostile project
    can never tie up a worker. The message is user-facing.
    """
