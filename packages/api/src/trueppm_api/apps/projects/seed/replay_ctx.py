"""Seed event-replay context flag (ADR-0113).

Replaying a v2 seed timeline writes hundreds of backdated rows. Those writes
must not trigger the live side effects a real edit would — a demo load must not
spam websocket boards, fire webhooks/notifications, or stamp *today's* burndown
snapshot (replay drives backdated snapshots itself, per simulated day).

This module holds a single ``ContextVar`` so the synchronously-fired signal
receivers (`task_status_changed` → burndown) and any dispatch primitive can
cheaply ask "are we mid-replay?" without importing the importer (which would
create a cycle: the importer imports models, models' receivers would import the
importer). It deliberately has zero model/Django imports.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from contextvars import ContextVar

_seed_replay: ContextVar[bool] = ContextVar("seed_replay", default=False)


def is_seed_replay_active() -> bool:
    """True while a seed timeline is being replayed in the current context."""
    return _seed_replay.get()


@contextlib.contextmanager
def seed_replay() -> Iterator[None]:
    """Mark the current context as replaying a seed timeline.

    Receivers that produce live side effects (today-dated burndown, board
    broadcasts, notifications) short-circuit while this is active so a demo
    load never leaks an effect into a real workspace.
    """
    token = _seed_replay.set(True)
    try:
        yield
    finally:
        _seed_replay.reset(token)
