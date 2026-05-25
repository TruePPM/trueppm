"""Tests for the ADR-0049 provider registry.

The registry's contract is small and load-bearing: OSS providers must be
registered at app-ready, duplicate keys must be rejected, and a handler
that does not subclass the registry's base must be rejected. A bug in any
of these silently breaks Enterprise's ability to extend the credential /
webhook / notification surfaces — these tests are the canary.
"""

from __future__ import annotations

import abc
from typing import Any, ClassVar

import pytest

from trueppm_api.apps.integrations.outgoing import OSS_OUTGOING_CHANNEL_PROVIDERS
from trueppm_api.apps.integrations.providers import OSS_TASK_LINK_PROVIDERS
from trueppm_api.apps.integrations.registry import (
    NOTIFICATION_CHANNELS,
    OUTGOING_CHANNEL_PROVIDERS,
    TASK_LINK_PROVIDERS,
    NotificationChannel,
    OutgoingChannelProvider,
    ProviderRegistry,
    TaskLinkProvider,
)


def test_oss_task_link_providers_registered_at_app_ready() -> None:
    """``apps.py`` registers gitlab/github/generic on app ready.

    If this fails, the credentials viewset will reject every connect
    request as "unknown provider" — the failure mode is silent and only
    surfaces when a user clicks Connect. The test guards against that.
    """
    keys = TASK_LINK_PROVIDERS.keys()
    assert set(keys) >= {"gitlab", "github", "generic"}
    for handler in OSS_TASK_LINK_PROVIDERS:
        assert TASK_LINK_PROVIDERS.get(handler.key) is handler


def test_registry_rejects_duplicate_key() -> None:
    """Re-registering a key is always a bug — duplicate Enterprise keys
    collide with OSS keys, and we want a loud ValueError at startup, not
    a quiet last-writer-wins overwrite."""
    reg = ProviderRegistry("test", _Dummy)

    class A(_Dummy):
        key: ClassVar[str] = "a"

    class B(_Dummy):
        key: ClassVar[str] = "a"

    reg.register("a", A)
    with pytest.raises(ValueError, match="already registered"):
        reg.register("a", B)


def test_registry_rejects_wrong_base_class() -> None:
    reg = ProviderRegistry("test", _Dummy)

    class NotADummy:
        pass

    with pytest.raises(TypeError, match="must subclass"):
        reg.register("x", NotADummy)


def test_registry_get_returns_none_for_unknown_key() -> None:
    """Unknown keys must degrade gracefully — a row whose provider was
    un-registered (Enterprise plugin uninstalled) reads back as None
    rather than raising, so the UI can render "Unknown provider"."""
    assert TASK_LINK_PROVIDERS.get("definitely-not-a-real-provider") is None


def test_registry_keys_are_sorted() -> None:
    """Deterministic ordering keeps the credentials list stable across
    requests — the page renders one section per provider in the same
    order every time."""
    keys = TASK_LINK_PROVIDERS.keys()
    assert keys == sorted(keys)


def test_oss_outgoing_channel_providers_registered_at_app_ready() -> None:
    """#638 populates ``OUTGOING_CHANNEL_PROVIDERS`` with the OSS generic +
    slack renderers at app-ready. If this fails, ``dispatch_webhooks`` can't
    resolve a webhook's ``format`` to a renderer and every delivery is dropped
    as "unknown provider" — a silent failure that only surfaces in the
    delivery log."""
    keys = OUTGOING_CHANNEL_PROVIDERS.keys()
    assert set(keys) >= {"generic", "slack"}
    for handler in OSS_OUTGOING_CHANNEL_PROVIDERS:
        assert OUTGOING_CHANNEL_PROVIDERS.get(handler.key) is handler


def test_notification_registry_exists_but_empty() -> None:
    """0.2 reserves the notification slot so #639 can register cleanly, but
    does not populate it. If this is ever non-empty in OSS without #639 being
    merged, something registered out-of-band."""
    assert NOTIFICATION_CHANNELS.keys() == []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Dummy(abc.ABC):
    """Minimal ABC used to instantiate a throwaway registry for unit tests."""

    key: ClassVar[str]

    @abc.abstractmethod
    def noop(self) -> None:  # pragma: no cover — never called
        ...


# Ensure the type imports are referenced so mypy doesn't drop them.
_ = (TaskLinkProvider, OutgoingChannelProvider, NotificationChannel, Any)
