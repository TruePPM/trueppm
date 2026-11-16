"""Unit tests for the Beat sweep resume cursor (#4420)."""

from __future__ import annotations

from unittest.mock import patch

from django.core.cache import cache

from trueppm_api.core.sweep_cursor import clear_cursor, rotate_after_cursor, save_cursor

ITEMS = ["a", "b", "c", "d"]


def test_no_cursor_keeps_order() -> None:
    assert rotate_after_cursor("s", ITEMS, str) == ITEMS


def test_cursor_rotates_and_wraps() -> None:
    save_cursor("s", "b")
    assert rotate_after_cursor("s", ITEMS, str) == ["c", "d", "a", "b"]


def test_cursor_past_end_or_for_deleted_item() -> None:
    save_cursor("s", "z")
    assert rotate_after_cursor("s", ITEMS, str) == ITEMS
    save_cursor("s", "bb")  # deleted item between b and c
    assert rotate_after_cursor("s", ITEMS, str) == ["c", "d", "a", "b"]


def test_clear_cursor() -> None:
    save_cursor("s", "b")
    clear_cursor("s")
    assert cache.get("sweep-cursor:s") is None


def test_cache_outage_never_fails_the_sweep() -> None:
    with patch("trueppm_api.core.sweep_cursor.cache") as broken:
        broken.get.side_effect = ConnectionError
        broken.set.side_effect = ConnectionError
        broken.delete.side_effect = ConnectionError
        assert rotate_after_cursor("s", ITEMS, str) == ITEMS
        save_cursor("s", "a")
        clear_cursor("s")


def test_integer_keys_are_rejected() -> None:
    import pytest

    with pytest.raises(TypeError):
        rotate_after_cursor("s", [1, 2, 10], lambda i: i)
