"""Every writable ``timezone`` field must reject a non-IANA value at the write.

Six ``CharField`` columns named ``timezone`` / ``*_timezone`` each gained a
``validate_<field>`` in a separate pass — ``TaskRecurrenceRule``, ``UserProfile`` and
the digest field first, ``Workspace`` and ``Project`` next, ``Calendar`` last — and
between passes the only thing asserting "every write path validates" was a prose list
inside each validator's docstring, which was wrong twice. Nothing downstream can raise
on a bad zone (the quiet-hours resolver walks past it, the CPM engine ignores it, the
seed replayer falls back to UTC), so the write is the only place a client can be told;
a seventh field added without a validator would reopen the class silently.

This walks the live tree rather than a hand-written list: every model field whose name
marks it as a timezone, every ``ModelSerializer`` that exposes it writable, and the
``validate_<field>`` hook DRF would run for it.
"""

from __future__ import annotations

from django.apps import apps
from django.db import models
from django.urls import get_resolver
from rest_framework import serializers


def _timezone_fields() -> dict[type[models.Model], set[str]]:
    found: dict[type[models.Model], set[str]] = {}
    for model in apps.get_models():
        for field in model._meta.get_fields():
            if isinstance(field, models.CharField) and (
                field.name == "timezone" or field.name.endswith("_timezone")
            ):
                found.setdefault(model, set()).add(field.name)
    return found


def _all_model_serializers() -> list[type[serializers.ModelSerializer]]:  # type: ignore[type-arg]
    # Resolving the URLconf imports every routed view module, and with it every
    # serializer module — so the subclass walk below sees the whole tree, not just
    # whatever this test process happened to import first.
    _ = get_resolver().url_patterns
    seen: list[type[serializers.ModelSerializer]] = []  # type: ignore[type-arg]
    stack: list[type[serializers.ModelSerializer]] = [serializers.ModelSerializer]  # type: ignore[type-arg]
    while stack:
        cls = stack.pop()
        for sub in cls.__subclasses__():
            if sub not in seen and sub.__module__.startswith("trueppm_api."):
                seen.append(sub)
            stack.append(sub)
    return seen


def _writable_timezone_exposures() -> list[tuple[type, str]]:
    tz_fields = _timezone_fields()
    exposures: list[tuple[type, str]] = []
    for cls in _all_model_serializers():
        meta = getattr(cls, "Meta", None)
        model = getattr(meta, "model", None)
        if model not in tz_fields:
            continue
        declared_fields = getattr(meta, "fields", ())
        read_only = set(getattr(meta, "read_only_fields", ()))
        for name in sorted(tz_fields[model]):
            if declared_fields != serializers.ALL_FIELDS and name not in declared_fields:
                continue
            if name in read_only:
                continue
            explicit = cls._declared_fields.get(name)
            if explicit is not None and explicit.read_only:
                continue
            exposures.append((cls, name))
    return exposures


def test_the_sweep_sees_the_known_fields() -> None:
    """Guard the guard: an empty walk would pass vacuously."""
    names = {f"{m.__name__}.{n}" for m, fs in _timezone_fields().items() for n in fs}
    assert {
        "Calendar.timezone",
        "Project.timezone",
        "TaskRecurrenceRule.timezone",
        "Workspace.timezone",
        "UserProfile.timezone",
        "UserNotificationSettings.digest_timezone",
    } <= names, names
    assert len(_writable_timezone_exposures()) >= 6


def test_every_writable_timezone_field_has_a_validator() -> None:
    missing = sorted(
        f"{cls.__module__}.{cls.__name__}.validate_{name}"
        for cls, name in _writable_timezone_exposures()
        if not callable(getattr(cls, f"validate_{name}", None))
    )
    assert not missing, (
        "Writable timezone fields without a validate_<field> hook (add one in the same "
        "form as CalendarSerializer.validate_timezone, or mark the field read-only):\n  "
        + "\n  ".join(missing)
    )
