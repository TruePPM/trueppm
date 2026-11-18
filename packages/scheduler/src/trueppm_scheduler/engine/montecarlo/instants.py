"""Per-run link instants of the Monte Carlo forward pass's milestone columns."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np


class _InstantColumns:
    """Each run's link instant, start-of-day display and deficit, for instant columns only.

    Only a milestone or zero-base column (:func:`_mc_forward_pass`) is ever an
    instant, and only links out of one read these values, so they are stored for
    those columns alone rather than as three more runs x tasks matrices. Held for
    every column they were 13 of the forward pass's 29 bytes a cell, although a
    typical project has a handful of milestones among thousands of tasks (#3824).

    Values start at zero, as the full-width matrices did. Reading a column that is
    not an instant raises ``KeyError`` rather than returning those zeros: no caller
    does, and one that started to would be reading a value nothing ever wrote.
    """

    __slots__ = ("_slot", "deficit", "ordinal", "start_display")

    def __init__(self, runs: int, cols: Iterable[int]) -> None:
        self._slot = {col: i for i, col in enumerate(sorted(set(cols)))}
        width = len(self._slot)
        # int32: date ordinals (at most ~3.7M for year 9999) fit far inside it (#4710).
        self.ordinal = np.zeros((runs, width), dtype=np.int32)
        self.start_display = np.zeros((runs, width), dtype=bool)
        # How far each link instant's true point lies before its midnight (#4697).
        self.deficit = np.zeros((runs, width), dtype=np.float64)

    def ordinal_of(self, col: int) -> np.ndarray:
        """Each run's link instant of ``col``, as a date ordinal."""
        return self.ordinal[:, self._slot[col]]

    def start_display_of(self, col: int) -> np.ndarray:
        """Whether each run reads ``col``'s link instant as the start of its day."""
        return self.start_display[:, self._slot[col]]

    def deficit_of(self, col: int) -> np.ndarray:
        """How far each run's true instant of ``col`` lies before its midnight."""
        return self.deficit[:, self._slot[col]]

    def store(
        self, col: int, ordinal: np.ndarray, start_display: np.ndarray, deficit: np.ndarray
    ) -> None:
        """Record ``col``'s per-run link instant once its column is resolved."""
        slot = self._slot[col]
        self.ordinal[:, slot] = ordinal
        self.start_display[:, slot] = start_display
        self.deficit[:, slot] = deficit
