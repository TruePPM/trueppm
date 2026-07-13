"""``project_notification_matrix`` surface registration (ADR-0086 / ADR-0204, #1916).

Registers ``ProjectNotificationPreference.matrix`` against the generic
forward-migration registry defined in ``projects.schema_migrations`` — the
same registry ``BoardSavedView.config`` uses (#645). The registry primitives
stay app-agnostic in the ``projects`` app (per ADR-0204's note that a
cross-app surface registers against them with one call); this module owns
only the notifications-specific surface key, current version, and transform,
importing the generic ``register_surface`` / ``register_migration`` /
``migrate_payload`` functions rather than duplicating them.

Importing this module (done once, from ``notifications.serializers``) runs
the ``register_surface`` / ``register_migration`` calls at the bottom as a
side effect — mirroring how importing ``projects.schema_migrations`` registers
``board_saved_view``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from trueppm_api.apps.projects.schema_migrations import (
    register_migration,
    register_surface,
)

from .models import PROJECT_NOTIFICATION_DEFAULT_MATRIX

# Surface key — shared constant (mirror ``SURFACE_*`` in the web registry).
SURFACE_PROJECT_NOTIFICATION_MATRIX = "project_notification_matrix"


def _project_notification_matrix_v0_to_v1(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Backfill any event type / channel missing from a pre-convention matrix.

    A version-0 payload predates ``schema_version`` and may be missing rows or
    cells that were added to ``PROJECT_NOTIFICATION_DEFAULT_MATRIX`` after the
    row was first written. Fill any absent ``(event_type, channel)`` cell with
    its documented default; keep every existing value (including any extra
    keys — dispatch and the view-layer overlay already treat unknown keys as
    inert, and the write-side ``_ProjectNotificationMatrixField`` validator
    drops them on the next save).
    """
    upgraded: dict[str, dict[str, Any]] = {
        evt: dict(chans) for evt, chans in payload.items() if isinstance(chans, dict)
    }
    for event_type, default_row in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items():
        row = upgraded.setdefault(event_type, {})
        for channel, default in default_row.items():
            row.setdefault(channel, default)
    return upgraded


register_surface(SURFACE_PROJECT_NOTIFICATION_MATRIX, current_version=1)
register_migration(SURFACE_PROJECT_NOTIFICATION_MATRIX, 0, _project_notification_matrix_v0_to_v1)
