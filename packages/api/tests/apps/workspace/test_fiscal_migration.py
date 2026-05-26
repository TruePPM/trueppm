"""Unit tests for the free-text → structured fiscal-anchor parser (#756).

The parser lives inside migration 0002; we import it directly and exercise it
against representative legacy values rather than driving the full migration, so
a regression in the parsing rules fails fast and in isolation.
"""

from __future__ import annotations

import importlib

import pytest

_migration = importlib.import_module(
    "trueppm_api.apps.workspace.migrations.0002_remove_workspace_fiscal_year_start_and_more"
)
parse = _migration._parse_fiscal_text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("January 1", (1, 1)),
        ("April 1", (4, 1)),
        ("April", (4, 1)),  # month only → day defaults to 1
        ("April 6", (4, 6)),  # UK tax year
        ("Apr 6", (4, 6)),  # abbreviation
        ("December 31", (12, 31)),
        ("4/1", (4, 1)),  # numeric M/D
        ("10-1", (10, 1)),  # numeric M-D
        ("October, 1", (10, 1)),  # stray comma
        ("  april   6 ", (4, 6)),  # surrounding/inner whitespace
    ],
)
def test_parses_representative_inputs(raw: str, expected: tuple[int, int]) -> None:
    assert parse(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("February 29", (2, 1)),  # year-agnostic Feb cap → day clamped, falls back to 1
        ("April 31", (4, 1)),  # 30-day month rejects 31 → day falls back to 1
        ("", (1, 1)),  # empty
        ("not a date", (1, 1)),  # unparseable
        ("Smarch 4", (1, 1)),  # bogus month name
        ("13/1", (1, 1)),  # month out of range
    ],
)
def test_unparseable_or_invalid_falls_back(raw: str, expected: tuple[int, int]) -> None:
    assert parse(raw) == expected
