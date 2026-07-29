"""Pure parsing helpers for the Valkey topology settings (ADR-0716, #2554).

Deliberately free of any Django import. ``settings/base.py`` needs
:func:`parse_sentinels` at module import time, and importing
``core.valkey_checks`` there instead would run ``@register()`` against Django's
check registry *while settings are still being read*. Keeping the parser in its
own stdlib-only module lets both settings and the checks share one
implementation without that ordering hazard.
"""

from __future__ import annotations

DEFAULT_REDIS_URL = "redis://redis:6379"


def _parse_sentinel(entry: str) -> tuple[str, int]:
    """Parse one ``host:port`` sentinel entry.

    ``rpartition`` rather than ``split`` so a bracketed IPv6 literal
    (``[::1]:26379``) keeps its colons and only the final ``:port`` is taken.
    """
    host, _, port = entry.strip().rpartition(":")
    if not host or not port:
        msg = f"expected host:port, got {entry!r}"
        raise ValueError(msg)
    try:
        return host, int(port)
    except ValueError:
        msg = f"port is not a number in {entry!r}"
        raise ValueError(msg) from None


def parse_sentinels(raw: str) -> list[tuple[str, int]]:
    """Parse a comma-separated ``host:port,host:port`` sentinel list.

    Returns an empty list for empty input, which is what disables Sentinel mode.
    Raises ``ValueError`` naming the first malformed entry.
    """
    return [_parse_sentinel(entry) for entry in raw.split(",") if entry.strip()]
