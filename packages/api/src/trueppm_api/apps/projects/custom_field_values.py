"""Typed read/write logic for per-task custom-field values (#2143, ADR-0528).

Two responsibilities, both keyed off ``ProjectCustomField.field_type``:

* :func:`build_custom_fields_map` — the *read* surface. Turns a task's prefetched
  ``TaskCustomFieldValue`` rows into the flat ``{"<field_id>": <json value>}`` map
  the Task payload (and the sync delta) carries. Unset values are omitted entirely
  — no ``null``, no placeholder — so the board card renders nothing for them
  (docs/design/board-card-custom-fields.md §5).
* :func:`validate_custom_field_write` — the *write* surface. Validates a raw
  ``{"value": …}`` payload against the field's type and returns the model-column
  kwargs to persist, raising DRF ``ValidationError`` with the documented 400 shapes
  (enum membership for selects, live-user FK for person, number/date parsing).

Kept out of the (very large) ``serializers.py`` so the typed dispatch is unit-testable
in isolation and shared verbatim by ``TaskSerializer``, ``SyncTaskSerializer``, and
``TaskCustomFieldValueView`` without a circular import.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from rest_framework import serializers

from trueppm_api.apps.projects.models import (
    CustomFieldType,
    ProjectCustomField,
    TaskCustomFieldValue,
)

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Task

User = get_user_model()

_MULTI_SELECT_MAX = 50  # mirrors the option-list cap on the field definition.
# NUMBER values persist to a numeric(20,6) column: at most 14 integer digits and 6
# decimal places. Bound the magnitude and quantize so a crafted value cannot overflow
# the column (Postgres DataError → HTTP 500) or store excess precision.
_NUMBER_MAX = Decimal(10) ** 14
_NUMBER_QUANTUM = Decimal("0.000001")


def _person_repr(user: Any) -> dict[str, str]:
    """Serialize a person value the way the board already renders assignees.

    ``{id, name, initials}`` so the card can draw the avatar + name with no second
    fetch; initials fall back to the username when the name is unset, matching
    ``RiskSerializer.get_owner_initials``.
    """
    name = user.get_full_name() or user.get_username()
    parts: list[str] = []
    if user.first_name:
        parts.append(user.first_name[0].upper())
    if user.last_name:
        parts.append(user.last_name[0].upper())
    initials = "".join(parts[:2]) if parts else user.get_username()[:2].upper()
    return {"id": str(user.pk), "name": name, "initials": initials}


def resolve_custom_field_value(value: TaskCustomFieldValue, field: ProjectCustomField) -> Any:
    """Resolve one value row to its flat-dict JSON form, or ``None`` when unset.

    ``None`` means "omit from the map" — the caller drops the key so an unset field
    consumes zero card real estate. Note ``BOOLEAN`` returns ``False`` (a real value)
    only when it was explicitly set; a never-set checkbox resolves to ``None``.
    """
    resolver = _VALUE_RESOLVERS.get(field.field_type)
    return resolver(value) if resolver is not None else None


# Per-type resolvers keyed by ``field_type`` — a flat dispatch table replacing an
# if-ladder so each type's read shape is one entry and a new type is a one-line add.
_VALUE_RESOLVERS: dict[str, Callable[[TaskCustomFieldValue], Any]] = {
    CustomFieldType.TEXT: lambda v: v.value_text or None,
    # Decimal → float for clean JSON; the web layer formats (thousands, units).
    CustomFieldType.NUMBER: (
        lambda v: float(v.value_number) if v.value_number is not None else None
    ),
    CustomFieldType.DATE: lambda v: v.value_date.isoformat() if v.value_date else None,
    CustomFieldType.SINGLE_SELECT: lambda v: v.value_option or None,
    CustomFieldType.MULTI_SELECT: lambda v: list(v.value_multi) if v.value_multi else None,
    CustomFieldType.BOOLEAN: lambda v: v.value_bool,  # True / False / None
    CustomFieldType.USER: lambda v: _person_repr(v.value_user) if v.value_user_id else None,
}


def build_custom_fields_map(task: Task) -> dict[str, Any]:
    """Flat ``{"<field_id>": <value>}`` map for a task's populated custom fields.

    Iterates the ``custom_field_values`` prefetch cache (never a fresh query — the
    read paths prefetch it with ``field`` select-related). Values that resolve to
    ``None`` (unset) are omitted, so the map only ever carries set values and an
    unset field consumes zero card real estate.
    """
    out: dict[str, Any] = {}
    for value in task.custom_field_values.all():
        resolved = resolve_custom_field_value(value, value.field)
        if resolved is not None:
            out[str(value.field_id)] = resolved
    return out


def _clear_kwargs() -> dict[str, Any]:
    """Column kwargs that null out every typed column (defaults for text/multi)."""
    return {
        "value_text": "",
        "value_number": None,
        "value_date": None,
        "value_option": "",
        "value_multi": [],
        "value_user": None,
        "value_bool": None,
    }


def _write_text(field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise serializers.ValidationError({"value": "value must be a string."})
    if len(raw) > 2000:
        raise serializers.ValidationError({"value": "value must be ≤ 2000 characters."})
    kwargs["value_text"] = raw
    return kwargs


def _write_number(field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    # Reject bools (they are ``int`` subclasses) and un-parseable strings.
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        raise serializers.ValidationError({"value": "value must be a number."})
    try:
        num = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        raise serializers.ValidationError({"value": "value must be a number."}) from None
    # This is a raw APIView, not a DRF DecimalField — validate the magnitude and
    # finiteness here, or a crafted NaN/Infinity/over-precision value reaches the
    # numeric(20,6) column and raises a Postgres DataError (HTTP 500) or round-trips
    # as spec-invalid JSON ``NaN`` on every subsequent read (the #2123-2127 fuzz-500
    # class; the nightly Schemathesis job is schedule-only and won't catch it).
    if not num.is_finite():
        raise serializers.ValidationError({"value": "value must be a finite number."})
    if abs(num) >= _NUMBER_MAX:
        raise serializers.ValidationError(
            {"value": "value is out of range (at most 14 integer digits)."}
        )
    kwargs["value_number"] = num.quantize(_NUMBER_QUANTUM)  # clamp to 6 dp
    return kwargs


def _write_date(field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise serializers.ValidationError({"value": "value must be an ISO-8601 date string."})
    try:
        kwargs["value_date"] = date.fromisoformat(raw)
    except ValueError:
        raise serializers.ValidationError(
            {"value": "value must be an ISO-8601 date (YYYY-MM-DD)."}
        ) from None
    return kwargs


def _write_boolean(field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, bool):
        raise serializers.ValidationError({"value": "value must be a boolean."})
    kwargs["value_bool"] = raw
    return kwargs


def _write_single_select(
    field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise serializers.ValidationError({"value": "value must be an option value string."})
    allowed = {opt.get("value") for opt in field.options}
    if raw not in allowed:
        raise serializers.ValidationError(
            {"value": f"{raw!r} is not a valid option for field {field.name!r}."}
        )
    kwargs["value_option"] = raw
    return kwargs


def _write_multi_select(
    field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(raw, list) or not all(isinstance(v, str) for v in raw):
        raise serializers.ValidationError({"value": "value must be a list of option values."})
    if len(raw) > _MULTI_SELECT_MAX:
        raise serializers.ValidationError(
            {"value": f"value must contain at most {_MULTI_SELECT_MAX} options."}
        )
    allowed = {opt.get("value") for opt in field.options}
    for v in raw:
        if v not in allowed:
            raise serializers.ValidationError(
                {"value": f"{v!r} is not a valid option for field {field.name!r}."}
            )
    # De-duplicate while preserving author order — an idempotent, forgiving write.
    kwargs["value_multi"] = list(dict.fromkeys(raw))
    return kwargs


def _write_user(field: ProjectCustomField, raw: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise serializers.ValidationError({"value": "value must be a user id string."})
    # The person must be a live member of the field's project — mirrors the
    # assignee membership guard (#684) so a person field cannot smuggle a
    # non-member (or a user from another project) onto the task.
    from trueppm_api.apps.access.models import ProjectMembership

    # One generic message for both "no such user" and "exists but not a member" so
    # the endpoint is not an existence oracle for arbitrary user ids.
    not_member = serializers.ValidationError(
        {"value": f"user {raw!r} is not a valid member of this project."}
    )
    try:
        user = User.objects.get(pk=raw)
    except (User.DoesNotExist, ValueError, ValidationError):
        raise not_member from None
    is_member = ProjectMembership.objects.filter(
        project_id=field.project_id, user_id=user.pk
    ).exists()
    if not is_member:
        raise not_member
    kwargs["value_user"] = user
    return kwargs


# Per-type write validators keyed by ``field_type``. Each takes the field, the raw
# JSON value and the pre-cleared kwargs, validates and sets exactly one typed column,
# and returns the kwargs (or raises DRF ``ValidationError`` → HTTP 400). Splitting the
# old single if-ladder into one function per type keeps each — and the dispatcher —
# well under the cognitive-complexity budget.
_VALUE_WRITERS: dict[str, Callable[[ProjectCustomField, Any, dict[str, Any]], dict[str, Any]]] = {
    CustomFieldType.TEXT: _write_text,
    CustomFieldType.NUMBER: _write_number,
    CustomFieldType.DATE: _write_date,
    CustomFieldType.BOOLEAN: _write_boolean,
    CustomFieldType.SINGLE_SELECT: _write_single_select,
    CustomFieldType.MULTI_SELECT: _write_multi_select,
    CustomFieldType.USER: _write_user,
}


def validate_custom_field_write(field: ProjectCustomField, raw: Any) -> dict[str, Any]:
    """Validate a raw value against ``field``'s type → model-column kwargs.

    Raises DRF ``ValidationError`` (HTTP 400) with a ``{"value": …}`` shape on any
    type mismatch. The returned dict always sets exactly one typed column and leaves
    the rest at their empty defaults, so applying it over an existing row cleanly
    overwrites a prior value (the write path is a full upsert, not a partial merge).
    """
    writer = _VALUE_WRITERS.get(field.field_type)
    if writer is None:
        raise serializers.ValidationError(
            {"value": f"unsupported field type {field.field_type!r}."}
        )
    return writer(field, raw, _clear_kwargs())
