"""Data-backfill helpers for the workspace app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_MONTH_LOOKUP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


def _max_day(month: int) -> int:
    """Year-agnostic day ceiling (Feb=28; 30-day months reject 31)."""
    if month == 2:
        return 28
    if month in (4, 6, 9, 11):
        return 30
    return 31


def _parse_numeric_fiscal(text: str) -> tuple[int | None, int]:
    """Parse a numeric ``"M/D"`` / ``"M-D"`` (or bare ``"M"``) anchor.

    Returns ``(month, day)`` with ``month`` ``None`` when the leading separator's
    first field is not a valid 1-12 month; ``day`` defaults to 1. The first of
    ``/`` or ``-`` present in the string wins, matching the original scan order.
    """
    sep = next((s for s in ("/", "-") if s in text), None)
    if sep is None:
        return (None, 1)
    parts = [p.strip() for p in text.split(sep) if p.strip()]
    if not parts or not parts[0].isdigit():
        return (None, 1)
    month = int(parts[0])
    if not 1 <= month <= 12:
        return (None, 1)
    day = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 1
    return (month, day)


def _parse_word_fiscal(text: str) -> tuple[int | None, int]:
    """Parse a word-form ``"<monthname> [day]"`` anchor.

    Returns ``(month, day)`` where ``month`` is ``None`` for an unrecognized
    leading token; ``day`` is the first trailing digit token, else 1.
    """
    tokens = text.replace(",", " ").split()
    if not tokens:
        return (None, 1)
    month = _MONTH_LOOKUP.get(tokens[0])
    day = 1
    for tok in tokens[1:]:
        if tok.isdigit():
            day = int(tok)
            break
    return (month, day)


def _parse_fiscal_text(raw: str) -> tuple[int, int]:
    """Best-effort parse of a free-text fiscal anchor into ``(month, day)``.

    Returns ``(1, 1)`` for anything unrecognized. Day is clamped to the month's
    valid range so the structured value is always internally consistent.
    """
    if not raw:
        return (1, 1)
    text = raw.strip().lower()

    month, day = _parse_numeric_fiscal(text)
    if month is None:
        month, day = _parse_word_fiscal(text)

    if month is None:
        logger.warning(
            "workspace.fiscal_year_start migration: could not parse %r; defaulting to January 1.",
            raw,
        )
        return (1, 1)

    if day < 1 or day > _max_day(month):
        day = 1
    return (month, day)
