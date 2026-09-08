"""Effective per-project resource capacity — the one place the override resolves.

``ProjectResource.units_override`` is a **per-project** capacity statement ("this
person is only half on this project"). Every per-project capacity read must resolve
it the same way, or two adjacent surfaces report different numbers for the same
person on the same day (#3574).

The fallback expression itself was duplicated across the model, the serializer and
the utilization engine (#1582). Every Python resolution now goes through
:func:`effective_units`. There is exactly ONE other copy, and it is unavoidable:
``annotate_tasks_queryset`` resolves the same rule SQL-side as
``Coalesce("units_override", "resource__max_units")`` because the comparison happens
inside a subquery's HAVING. Keep the two in step; do not add a third.

Cross-project reads (``resource-contention``, and any other span that aggregates
several projects at once) deliberately keep ``Resource.max_units``: a slice of one
person's time on one project is not a statement about their total capacity, and the
slices are not additive.

This module is the OSS-side read surface for that fact. A cross-project consumer that
aggregates per-project capacity must **call** :func:`projects_effective_units` rather
than re-derive the fallback — a second copy of it is how #3574 happened, and any
reimplementation reaching for ``units_override or max_units`` gets the legitimate ``0``
wrong.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable

# Stand-in when a resource row carries no capacity at all. Mirrors
# ``Resource.max_units``' own model default (full time), rendered at the field's two
# decimal places so a fallback and a stored value serialize identically.
DEFAULT_MAX_UNITS = Decimal("1.00")


def effective_units(
    units_override: Decimal | None,
    max_units: Decimal | None,
) -> Decimal:
    """Resolve one resource's effective capacity on one project.

    Args:
        units_override: ``ProjectResource.units_override`` for this (project,
            resource) pair, or ``None`` when the pair has no roster row or the
            roster row sets no override.
        max_units: ``Resource.max_units``, the resource's default capacity.

    Returns:
        The override when one is set, otherwise the resource default.

    ``units_override`` is nullable **and** ``0`` is a legitimate stored value — a
    person rostered on a project but holding no capacity there. The test is
    therefore ``is not None`` and never truthiness: ``units_override or max_units``
    would silently promote a deliberate 0 back to full time, which is the inverse of
    what the override was set to say.
    """
    if units_override is not None:
        return Decimal(units_override)
    if max_units is not None:
        return Decimal(max_units)
    return DEFAULT_MAX_UNITS


def project_effective_units(project_id: Any) -> dict[str, Decimal]:
    """Map ``str(resource_id) -> effective capacity`` for one project's roster.

    One query. Resources with assignments on the project but no roster row are
    absent from the map by construction — callers fall back to
    ``Resource.max_units`` for those, which is what an unrostered assignee's
    capacity is.
    """
    return projects_effective_units([project_id]).get(str(project_id), {})


def resource_effective_units(project_id: Any, resource: Any) -> Decimal:
    """One resource's effective capacity on one project — a single-row lookup.

    For callers that need exactly one pair. Hits the
    ``uniq_project_resource_project_resource`` unique index rather than reading the
    whole roster; use :func:`project_effective_units` when several are needed.
    Falls back to ``resource.max_units`` when the resource is not on the roster.
    """
    from trueppm_api.apps.resources.models import ProjectResource

    row = (
        ProjectResource.objects.filter(
            project_id=project_id, resource_id=resource.pk, is_deleted=False
        )
        .values_list("units_override")
        .first()
    )
    return effective_units(row[0] if row is not None else None, resource.max_units)


def projects_effective_units(project_ids: Iterable[Any]) -> dict[str, dict[str, Decimal]]:
    """Batched :func:`project_effective_units` — one query for many projects.

    Returns ``{str(project_id): {str(resource_id): capacity}}``. Callers that span
    several projects (the batched sprint capacity path, #1012) use this so threading
    the override does not reintroduce a per-project query.
    """
    from trueppm_api.apps.resources.models import ProjectResource

    ids = [pid for pid in project_ids if pid is not None]
    if not ids:
        return {}

    out: dict[str, dict[str, Decimal]] = {}
    rows = ProjectResource.objects.filter(project_id__in=ids, is_deleted=False).values_list(
        "project_id", "resource_id", "units_override", "resource__max_units"
    )
    for project_id, resource_id, units_override, max_units in rows:
        out.setdefault(str(project_id), {})[str(resource_id)] = effective_units(
            units_override, max_units
        )
    return out
