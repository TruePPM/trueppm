"""Conformance guard: a membership's identity is immutable after create (#2586).

``PATCH`` on a membership used to accept ``user`` and silently re-point the row at
another account, skipping every invariant ``create`` enforces (role ceiling,
duplicate 409, last-Owner, ``joined_at``). Reassignment is remove + add.

The behavioral tests live beside each viewset; this file is the structural net so a
*new* membership-shaped serializer cannot reintroduce the hole. It is the same shape
of guard ``ProjectResourceSerializer`` / ``TaskResourceSerializer`` apply to their
``project`` / ``task`` FKs (#1711).
"""

from __future__ import annotations

import inspect

import pytest
from django.contrib.auth import get_user_model
from django.db import models
from rest_framework import serializers

from trueppm_api.apps.access import serializers as access_serializers
from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership

User = get_user_model()

_MEMBERSHIP_MODELS = (ProjectMembership, ProgramMembership)


def _membership_write_serializers() -> list[type[serializers.ModelSerializer]]:  # type: ignore[type-arg]
    found = []
    for _name, cls in inspect.getmembers(access_serializers, inspect.isclass):
        if cls.__module__ != access_serializers.__name__:
            continue
        if not issubclass(cls, serializers.ModelSerializer):
            continue
        meta = getattr(cls, "Meta", None)
        if getattr(meta, "model", None) not in _MEMBERSHIP_MODELS:
            continue
        if "Read" in cls.__name__:
            continue
        found.append(cls)
    return found


def _user_fk_names(model: type[models.Model]) -> set[str]:
    return {
        f.name
        for f in model._meta.get_fields()
        if isinstance(f, models.ForeignKey) and f.related_model is User
    }


def test_the_guard_finds_the_serializers_it_is_meant_to_guard() -> None:
    names = {c.__name__ for c in _membership_write_serializers()}
    assert {
        "ProjectMembershipWriteSerializer",
        "ProjectMembershipUpdateSerializer",
        "ProgramMembershipWriteSerializer",
        "ProgramMembershipUpdateSerializer",
    } <= names


@pytest.mark.parametrize(
    "serializer_cls",
    [c for c in _membership_write_serializers() if c.__name__.endswith("UpdateSerializer")],
    ids=lambda c: c.__name__,
)
def test_update_serializers_declare_no_user_fk_field(
    serializer_cls: type[serializers.ModelSerializer],  # type: ignore[type-arg]
) -> None:
    """The PATCH-body schema must not advertise the identity FK at all."""
    model = serializer_cls.Meta.model  # type: ignore[attr-defined]
    declared = set(serializer_cls().fields)
    assert not declared & _user_fk_names(model), (
        f"{serializer_cls.__name__} exposes a User FK on update; reassignment must go "
        "through remove + add (#2586)"
    )


@pytest.mark.parametrize(
    "serializer_cls",
    [c for c in _membership_write_serializers() if not c.__name__.endswith("UpdateSerializer")],
    ids=lambda c: c.__name__,
)
@pytest.mark.django_db
def test_shared_write_serializers_refuse_user_when_bound_to_an_instance(
    serializer_cls: type[serializers.ModelSerializer],  # type: ignore[type-arg]
) -> None:
    """Defense in depth: even the create serializer 400s a ``user`` key on update."""
    model = serializer_cls.Meta.model  # type: ignore[attr-defined]
    ser = serializer_cls(model(), data={"user": 1}, partial=True)
    assert not ser.is_valid()
    assert "user" in ser.errors
