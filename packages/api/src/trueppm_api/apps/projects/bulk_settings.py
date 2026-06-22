"""Bulk-PATCH of inherited settings across many Program or Project rows (ADR-0161, #1233).

The settings matrix (Workspace → Programs and Program → Projects) lets an admin set an
inherited field — methodology, iteration label, risk policy — on a *selection* of entities
in one call instead of N per-entity PATCHes. This module holds the request envelope, the
per-scope field-whitelist serializers (which reuse the same field-level validation as the
per-entity serializers), and the atomic apply routine. The thin ``ProgramViewSet`` actions
in :mod:`program_views` wire these to two routes.

Scope of the 0.3 slice (the rest of #1233's field list is deferred — see ADR-0161):
  * Programs (workspace scope): ``methodology``, ``iteration_label``,
    ``risk_slip_propagation``, ``risk_escalation_days``.
  * Projects (program scope): ``methodology``, ``iteration_label``.

``calendar`` (Project-only, schedule-affecting with no bulk recalc path yet) and the
notification defaults (not Program/Project fields — they live in
``ProjectNotificationPreference``) are deferred to follow-ups.
"""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied

from trueppm_api.apps.projects.methodology import methodology_override_locked
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.workspace.models import Workspace

# Cap on the rows a single bulk call may touch. Generous for a real workspace (programs) or
# program (projects) selection, but bounds the per-row ``select_for_update`` + ``save`` loop
# so the endpoint can't be used to lock a large slice of the table in one request.
MAX_BULK_TARGETS = 200


def _validate_iteration_label(value: str | None) -> str | None:
    """Mirror ``Program/ProjectSerializer.validate_iteration_label`` (ADR-0116).

    ``None`` clears the override so the row inherits its parent's label; a non-null
    empty/whitespace string is rejected because "inherit" already has an explicit
    representation (``null``). ``max_length`` is enforced by the model field.
    """
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        raise serializers.ValidationError(
            "Enter a label for the iteration container, or clear it to inherit the parent default."
        )
    return stripped


class _InheritedMethodologyMixin:
    """Shared ``methodology`` lock backstop (ADR-0107 §4).

    A per-entity methodology override is forbidden only while a workspace enforcement lock
    is active — which never happens in OSS (no enforcement provider is registered), so this
    is the server-side backstop for a direct API write. Re-sending the current value is a
    harmless no-op and is allowed even under a lock. ``PermissionDenied`` (403) is the
    correct response for a policy refusal, matching the per-entity serializers.
    """

    instance: Any  # set by DRF when the serializer wraps a model row
    context: dict[str, Any]  # provided by the DRF serializer this mixes into

    def validate_methodology(self, value: str) -> str:
        instance = getattr(self, "instance", None)
        if instance is not None and value == instance.methodology:
            return value
        # Read the singleton from context (hoisted once per bulk call by
        # apply_bulk_fields) so a 200-row batch doesn't reload it per row; fall back to a
        # direct load when the serializer is used standalone.
        workspace = self.context.get("workspace") or Workspace.load()
        if methodology_override_locked(workspace):
            raise PermissionDenied(
                "This workspace's methodology policy locks the delivery model to the "
                "workspace default — it can't be set per entity."
            )
        return value


class ProgramBulkFieldsSerializer(_InheritedMethodologyMixin, serializers.ModelSerializer[Program]):
    """Whitelist + field validation for a workspace-scope program bulk-PATCH."""

    class Meta:
        model = Program
        fields = [  # noqa: RUF012 — DRF Meta field list (matches the serializers.py per-file ignore)
            "methodology",
            "iteration_label",
            "risk_slip_propagation",
            "risk_escalation_days",
        ]

    def validate_iteration_label(self, value: str | None) -> str | None:
        return _validate_iteration_label(value)


class ProjectBulkFieldsSerializer(_InheritedMethodologyMixin, serializers.ModelSerializer[Project]):
    """Whitelist + field validation for a program-scope project bulk-PATCH.

    Deliberately narrower than :class:`ProgramBulkFieldsSerializer`: ``calendar`` is
    omitted (schedule-affecting, no bulk recalc path yet) and the program-only risk fields
    do not exist on Project. Only the two benign, non-schedule inherited fields ship here.
    """

    class Meta:
        model = Project
        fields = ["methodology", "iteration_label"]  # noqa: RUF012 — DRF Meta field list

    def validate_iteration_label(self, value: str | None) -> str | None:
        return _validate_iteration_label(value)


class BulkFieldsRequestSerializer(serializers.Serializer[Any]):
    """Request envelope: which rows to change, and which fields to set on them.

    ``ids`` are the entities the user checked; ``fields`` is the partial field map to apply.
    Only the named fields on the named rows change — every other row and every other field
    keeps inheriting (#1233). The *values* in ``fields`` are validated per-scope by the
    per-entity serializer the caller passes to :func:`apply_bulk_fields`; this envelope only
    enforces the request shape (non-empty, well-typed ids, bounded count).
    """

    ids = serializers.ListField(
        child=serializers.UUIDField(),
        allow_empty=False,
        max_length=MAX_BULK_TARGETS,
    )
    # The wire key is "fields" (the partial field map). Declaring a field named ``fields``
    # shadows DRF's base ``Serializer.fields`` property for the type checker only — at
    # runtime declared fields live in ``_declared_fields`` and the ``.fields`` property
    # still returns the BindingDict (verified by the endpoint tests).
    fields = serializers.DictField(allow_empty=False)  # type: ignore[assignment]


def apply_bulk_fields(
    *,
    field_serializer_cls: type[serializers.ModelSerializer[Any]],
    queryset: QuerySet[Any],
    ids: list[Any],
    fields: dict[str, Any],
) -> list[Any]:
    """Validate ``fields`` against the scope whitelist and apply them to the rows in
    ``queryset`` whose pk is in ``ids``. **Must run inside ``transaction.atomic()``**
    (it locks the targets with ``select_for_update``).

    Raises ``serializers.ValidationError`` (→ 400) for a field not bulk-editable in this
    scope, an id outside the allowed scope, or a bad value. All-or-nothing: any failure
    raises inside the caller's atomic block and rolls the whole batch back. Returns the
    updated rows with their freshly bumped ``server_version``.
    """
    allowed = set(field_serializer_cls.Meta.fields)
    unknown = sorted(set(fields) - allowed)
    if unknown:
        raise serializers.ValidationError(
            {"fields": f"Not bulk-editable in this scope: {unknown}. Allowed: {sorted(allowed)}."}
        )

    # Dedupe while preserving the caller's order; compare as str so UUID objects and the
    # DB's UUID pks match regardless of representation.
    unique_ids = list(dict.fromkeys(str(i) for i in ids))
    rows = list(queryset.filter(pk__in=unique_ids).select_for_update())
    found = {str(r.pk) for r in rows}
    missing = [i for i in unique_ids if i not in found]
    if missing:
        # 400, not silent skip: an id outside scope is a client error (wrong program,
        # archived/closed/deleted row, or another tenant's entity) the caller should see.
        raise serializers.ValidationError(
            {"ids": f"Not found or outside the allowed scope: {missing}."}
        )

    # Hoist the workspace singleton out of the loop — the methodology validator needs it,
    # and reloading it per row would be a needless N+1 on a 200-row batch (perf-check #1233).
    workspace = Workspace.load()
    for row in rows:
        ser = field_serializer_cls(row, data=fields, partial=True, context={"workspace": workspace})
        ser.is_valid(raise_exception=True)
        ser.save()  # per-row save() so VersionedModel bumps server_version + history audits
    return rows


def build_bulk_response(rows: list[Any], fields: dict[str, Any]) -> dict[str, Any]:
    """Lightweight, context-free response for a bulk apply.

    Returns each touched row's id and its new ``server_version`` (so an offline client can
    advance its sync watermark) plus the field names applied — not a full re-serialization,
    which would need the viewset's queryset annotations and request context.
    """
    return {
        "updated": [{"id": str(r.pk), "server_version": r.server_version} for r in rows],
        "fields": sorted(fields),
    }
