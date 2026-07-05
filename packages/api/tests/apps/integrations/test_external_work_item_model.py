"""Isolation-invariant guard tests for ``ExternalWorkItem`` (ADR-0097 §2).

These are the tests the ADR calls out by name: the read-only, OSS-boundary
invariant is enforced *here*, not merely in prose. The day someone makes
``ExternalWorkItem`` a ``VersionedModel`` "to get mobile offline," these fail —
which is the whole point. Each clause of the §2 invariant has an assertion:

1. plain ``models.Model``, not ``VersionedModel`` (no sync-delta membership);
2. no ``server_version`` / tombstone columns;
3. never enters the WebSocket board broadcast;
4. the pull can never mint a ``Task`` (no relation into project data);
5. unique per ``(user, source, external_id)`` and validated ``source``.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models

from trueppm_api.apps.integrations.models import ExternalWorkItem, IntegrationCredential
from trueppm_api.apps.projects.models import VersionedModel

User = get_user_model()

pytestmark = pytest.mark.django_db


def _field_names() -> set[str]:
    return {f.name for f in ExternalWorkItem._meta.get_fields()}


def test_not_versioned_model() -> None:
    """The load-bearing invariant: ExternalWorkItem is a plain Model.

    ``VersionedModel`` is the mechanism by which a row joins the project sync
    delta and gains ``server_version``. Not subclassing it is what keeps this a
    per-user cache the offline protocol never touches (ADR-0097 §2)."""
    assert not issubclass(ExternalWorkItem, VersionedModel)
    assert issubclass(ExternalWorkItem, models.Model)


def test_no_server_version_or_tombstone_columns() -> None:
    """No sync-protocol columns — a sync delta pull can never select this row."""
    fields = _field_names()
    assert "server_version" not in fields
    assert "is_deleted" not in fields
    assert "deleted_version" not in fields


def test_cannot_mint_a_task() -> None:
    """No relation into project data — the cache can never become a Task.

    A structural guard: if a future edit adds a FK/relation from an external
    item into ``projects`` (Task/Project), the read-only boundary is broken."""
    fields = _field_names()
    assert "task" not in fields
    for field in ExternalWorkItem._meta.get_fields():
        related = getattr(field, "related_model", None)
        related_name = related.__name__ if related is not None else ""
        assert related_name in ("", "User"), (
            f"ExternalWorkItem.{field.name} relates to {related_name!r}; the read-only "
            "invariant (ADR-0097 §2) forbids any relation into project data."
        )


def test_not_wired_into_board_broadcast() -> None:
    """ExternalWorkItem never crosses the WebSocket board broadcast (ADR-0097 §2).

    The broadcast fans out project-scoped board events; a per-user external cache
    has no board and must not appear in the broadcast module's source."""
    import inspect

    from trueppm_api.apps.sync import broadcast

    assert "ExternalWorkItem" not in inspect.getsource(broadcast)


def test_unique_per_user_source_external_id() -> None:
    """The (user, source, external_id) uniqueness backs idempotent upsert."""
    user = User.objects.create_user(username="ewi_user", password="pw")
    ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="RIV-1", display_bucket="todo"
    )
    with pytest.raises(IntegrityError):
        ExternalWorkItem.objects.create(
            user=user, source="jira", external_id="RIV-1", display_bucket="done"
        )


def test_clean_rejects_unregistered_source() -> None:
    """``source`` is validated against the live EXTERNAL_TASK_SOURCES registry."""
    user = User.objects.create_user(username="ewi_clean", password="pw")
    item = ExternalWorkItem(user=user, source="not_a_source", external_id="X-1")
    with pytest.raises(ValidationError):
        item.full_clean()


def test_integration_credential_config_defaults_to_empty_dict() -> None:
    """The ADR-0097 §2 ``config`` extension defaults to ``{}`` for git PATs."""
    user = User.objects.create_user(username="cfg_user", password="pw")
    cred = IntegrationCredential.objects.create(
        user=user, provider="github", secret_ciphertext=b"x"
    )
    cred.refresh_from_db()
    assert cred.config == {}
