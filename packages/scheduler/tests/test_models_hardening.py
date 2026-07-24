"""Assertion-hardening tests for models helpers (#2330 — mutation survivors).

Mutation testing (#2282) left survivors in three small models helpers whose
*messages* and *element handling* were executed but unasserted:

* ``_parse_timedelta`` — the sub-microsecond quantization guard (#1862) raised
  the right error, but no test read the message, so mutating it to ``None`` or
  changing its case went unnoticed.
* ``_reject_duplicate_keys`` — same, for the duplicate-key rejection message.
* ``_serialize`` — the list branch recursed over each element, but no test
  asserted the *elements* survive serialization (a mutant serializing ``None``
  in their place passed).
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler.models import (
    _parse_timedelta,
    _reject_duplicate_keys,
    _serialize,
)


def test_parse_timedelta_sub_microsecond_message_is_specific() -> None:
    # 86400 s + 100 ns: sub-µs fraction is quantized away by timedelta, so the
    # guard must reject it (and the message names *why* — both sentences).
    with pytest.raises(ValueError) as exc:
        _parse_timedelta(86400.0000001)
    msg = str(exc.value)
    assert "sub-microsecond precision that would be" in msg
    assert "silently quantized; the Rust engine rejects it" in msg
    assert "XX" not in msg  # not mangled with mutmut's sentinel wrapping


def test_parse_timedelta_accepts_exact_whole_day() -> None:
    # A clean whole-day value round-trips and must NOT be over-rejected (#1818).
    assert _parse_timedelta(86400.0) == timedelta(days=1)


def test_reject_duplicate_keys_message_names_the_key() -> None:
    with pytest.raises(ValueError) as exc:
        _reject_duplicate_keys([("duration", 1), ("duration", 2)])
    assert "Duplicate JSON key 'duration' is not allowed" in str(exc.value)


def test_reject_duplicate_keys_passes_through_unique_pairs() -> None:
    assert _reject_duplicate_keys([("a", 1), ("b", 2)]) == {"a": 1, "b": 2}


def test_serialize_recurses_into_list_elements() -> None:
    # Each element must be serialized in place — a mutant that serialized None
    # for every element would yield [None, None, None].
    result = _serialize([date(2026, 1, 2), timedelta(days=1), {"k": date(2026, 1, 3)}])
    assert result == ["2026-01-02", 86400.0, {"k": "2026-01-03"}]
