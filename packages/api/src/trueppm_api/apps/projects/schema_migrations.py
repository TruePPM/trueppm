"""Forward-migration registry for user-saved JSON state (ADR-0086 / ADR-0201).

Every user-saved JSON payload (saved views, filters, dashboards) carries a
top-level ``schema_version: int``. No business code reads a raw stored payload;
it dispatches through this registry, which upgrades a payload to the current
version **on read** before any consumer sees it.

The registry is a generic, surface-keyed chain of pure ``v(n) -> v(n+1)``
transforms. Reading a ``v1`` payload when the surface's current version is ``v3``
applies ``v1->v2`` then ``v2->v3``. Writes always emit the current version.

Design contract (mirrored in ``packages/web/src/lib/schemaMigrations.ts``):

* A stored payload with no ``schema_version`` key is treated as version ``0``.
* A payload at a version *newer* than the running code (e.g. after a downgrade)
  is a hard error, not a silent best-effort read.
* Surface keys are shared string constants, not duplicated literals, so the API
  and web registries can be audited against each other.

New saved-state surfaces register their current version and their upgrade steps
here (one ``register_migration`` call per ``v(n) -> v(n+1)`` transform) and read
through :func:`migrate_payload`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

# Surface keys — shared constants (mirror ``SURFACE_*`` in the web registry).
SURFACE_BOARD_SAVED_VIEW = "board_saved_view"

#: A single ``v(n) -> v(n+1)`` transform. Receives a payload known to be at
#: ``from_version`` and returns the payload at ``from_version + 1``. Must be pure.
Migration = Callable[[Mapping[str, Any]], dict[str, Any]]

# {surface: {from_version: transform}} — the ordered upgrade chain per surface.
_MIGRATIONS: dict[str, dict[int, Migration]] = {}

# {surface: current_version} — the version a fresh write emits and a read targets.
_CURRENT_VERSIONS: dict[str, int] = {}


class UnknownSchemaVersionError(ValueError):
    """A stored payload is at a version newer than the running code supports.

    Raised deliberately instead of best-effort reading a future-version payload
    (e.g. after a rollback to an older deployment). Loud failure is preferred to
    silently mis-reading data written by newer code (ADR-0086).
    """


def register_surface(surface: str, current_version: int) -> None:
    """Register a surface and its current schema version.

    Args:
        surface: Stable surface key (use a ``SURFACE_*`` constant).
        current_version: The version a fresh write emits; reads upgrade to it.
    """
    _CURRENT_VERSIONS[surface] = current_version
    _MIGRATIONS.setdefault(surface, {})


def register_migration(surface: str, from_version: int, fn: Migration) -> None:
    """Register a single ``from_version -> from_version + 1`` transform.

    Args:
        surface: Stable surface key (use a ``SURFACE_*`` constant).
        from_version: The version this transform upgrades *from*.
        fn: Pure function upgrading a ``from_version`` payload to the next version.
    """
    _MIGRATIONS.setdefault(surface, {})[from_version] = fn


def current_version(surface: str) -> int:
    """Return the current schema version for a surface (default 1 if unregistered)."""
    return _CURRENT_VERSIONS.get(surface, 1)


def stored_version(payload: Mapping[str, Any]) -> int:
    """Return the version stored in a payload, treating an absent key as 0.

    A missing ``schema_version`` means the payload predates the convention
    (ADR-0086), so it is treated as version 0 and run through the full chain.
    """
    raw = payload.get("schema_version", 0) if isinstance(payload, Mapping) else 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def migrate_payload(
    surface: str,
    payload: Mapping[str, Any],
    from_version: int | None = None,
) -> tuple[dict[str, Any], int]:
    """Upgrade a stored payload to the surface's current version on read.

    Applies the ordered ``v(n) -> v(n+1)`` chain until the payload reaches the
    current version, then stamps ``schema_version`` on the result. Re-running
    against an already-current payload is a no-op (empty chain), so this is
    idempotent.

    Args:
        surface: Stable surface key (use a ``SURFACE_*`` constant).
        payload: The stored JSON payload (may lack ``schema_version``).
        from_version: Override the detected version; defaults to the payload's
            own ``schema_version`` (absent => 0).

    Returns:
        A ``(upgraded_payload, current_version)`` tuple. ``upgraded_payload``
        carries ``schema_version`` set to the current version.

    Raises:
        UnknownSchemaVersionError: If the payload is at a version newer than the
            surface's registered current version.
    """
    target = current_version(surface)
    version = stored_version(payload) if from_version is None else from_version

    if version > target:
        raise UnknownSchemaVersionError(
            f"Payload for surface {surface!r} is at schema_version {version}, "
            f"but this code only supports up to {target}."
        )

    result: dict[str, Any] = dict(payload) if isinstance(payload, Mapping) else {}
    steps = _MIGRATIONS.get(surface, {})
    while version < target:
        transform = steps.get(version)
        if transform is None:
            # A gap in the chain is a programming error — a version bump landed
            # without its transform. Fail loudly rather than mis-read.
            raise UnknownSchemaVersionError(
                f"No migration registered for surface {surface!r} from version "
                f"{version} (current version is {target})."
            )
        result = transform(result)
        version += 1

    result["schema_version"] = target
    return result, target


# ---------------------------------------------------------------------------
# board_saved_view surface (#191, useBoardSavedViews)
# ---------------------------------------------------------------------------

# The six canonical config keys and their documented defaults. Kept in sync with
# BoardSavedViewSerializer.validate_config (the write-side normalizer).
_BOARD_VIEW_DEFAULTS: dict[str, Any] = {
    "sort": "priority",
    "show_wip": True,
    "show_col_tints": True,
    "evm_mode": "off",
    "show_cost": False,
    "risk_linked_only": False,
}


def _board_view_v0_to_v1(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Backfill the six canonical config keys on a pre-convention board view.

    A version-0 payload predates ``schema_version`` and may be missing keys that
    were added to the config shape over time. Fill any absent canonical key with
    its documented default; keep existing values (including any extra keys, which
    the write-side validator drops on the next save).
    """
    upgraded = dict(payload)
    for key, default in _BOARD_VIEW_DEFAULTS.items():
        upgraded.setdefault(key, default)
    return upgraded


register_surface(SURFACE_BOARD_SAVED_VIEW, current_version=1)
register_migration(SURFACE_BOARD_SAVED_VIEW, 0, _board_view_v0_to_v1)
