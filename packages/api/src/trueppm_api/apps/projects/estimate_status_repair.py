"""Data repair for legacy ``''`` values in ``estimate_status`` (#2600).

Lives outside the migration so a test can exercise it: importing a migration module
couples the suite to migration file names, which a squash deletes.
"""

from __future__ import annotations

from typing import Any


def normalize_blank_estimate_status(*models: Any) -> int:
    """Turn ``''`` ``estimate_status`` rows into NULL ("not tracked") on each model.

    The field was client-writable until it became read-only, and DRF derived
    ``allow_blank`` from ``blank=True``, so ``PATCH {"estimate_status": ""}`` stored a
    third value distinct from NULL and both choices. History rows keep their own copy of
    the column, so callers pass both ``Task`` and ``HistoricalTask``. A queryset
    ``update()`` is deliberate: the column is derived governance state, not a user edit,
    so no ``server_version`` bump and no history row is wanted.

    Args:
        *models: Model classes (or migration-state models) carrying ``estimate_status``.

    Returns:
        The total number of rows repaired.
    """
    return sum(
        model.objects.filter(estimate_status="").update(estimate_status=None) for model in models
    )
