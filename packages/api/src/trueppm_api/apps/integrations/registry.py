"""Provider registries for external integrations (ADR-0049 §1).

Three runtime-extensible registries map a short ``CharField`` key on a stored
row to a class that knows how to handle it. OSS registers its built-ins at
``AppConfig.ready()``; Enterprise registers richer connectors against the
same registries from its own ``AppConfig.ready()``. There is no monkey-patching
and no ``TextChoices`` value list to keep in sync between repos — see ADR-0049
"Alternatives Considered" for why this shape was chosen.

``TASK_LINK_PROVIDERS`` is populated in 0.2 alongside #587; ``matches()`` and
``fetch_metadata()`` bodies for the OSS providers land with #637.
``OUTGOING_CHANNEL_PROVIDERS`` and ``NOTIFICATION_CHANNELS`` are scaffolded
here so #638 / #639 can register against them without restructuring.
"""

from __future__ import annotations

import abc
from collections.abc import Iterator
from typing import Any, ClassVar


class ProviderRegistry:
    """A registry of provider keys → handler classes.

    Stays minimal on purpose: ``register()`` rejects duplicate keys and
    handlers that don't subclass the configured base, ``get()`` returns the
    handler or ``None``, ``keys()`` returns a sorted list. The narrow surface
    keeps OSS↔Enterprise integration testable as a contract.

    Args:
        name: Human-readable name used in error messages.
        base_class: Abstract base that registered handlers must subclass.
    """

    def __init__(self, name: str, base_class: type) -> None:
        self._name = name
        self._base = base_class
        self._registry: dict[str, type] = {}

    def register(self, key: str, handler: type) -> None:
        """Register ``handler`` under ``key``.

        Raises:
            ValueError: If ``key`` is already registered. Duplicate keys are
                always a bug — Enterprise picks a distinct namespace
                (``slack_app`` vs OSS ``slack``).
            TypeError: If ``handler`` does not subclass the registry's base.
        """
        if key in self._registry:
            raise ValueError(f"{self._name}: provider {key!r} already registered")
        if not issubclass(handler, self._base):
            raise TypeError(f"{self._name}: {handler} must subclass {self._base}")
        self._registry[key] = handler

    def get(self, key: str) -> type | None:
        """Return the handler for ``key`` or ``None`` if not registered.

        Returning ``None`` for unknown keys lets stored rows whose provider
        was un-registered (Enterprise downgraded, plugin removed) degrade
        gracefully — the UI surfaces "Unknown provider" instead of 500ing.
        """
        return self._registry.get(key)

    def keys(self) -> list[str]:
        """Sorted list of registered keys — stable for tests + UI menus."""
        return sorted(self._registry)

    def __iter__(self) -> Iterator[str]:
        """Iterate over registered keys in sorted order.

        Lets callers write ``for key in TASK_LINK_PROVIDERS`` instead of
        ``for key in TASK_LINK_PROVIDERS.keys()`` — both work; the former
        is what ``ruff SIM118`` prefers.
        """
        return iter(self.keys())

    def __contains__(self, key: object) -> bool:
        return key in self._registry


# ---------------------------------------------------------------------------
# Base classes (ABCs) — handler contracts
# ---------------------------------------------------------------------------


class TaskLinkProvider(abc.ABC):
    """Base class for ``TASK_LINK_PROVIDERS`` entries (ADR-0049 §1).

    OSS providers register here at app-ready; #637 fills in ``matches()``
    and ``fetch_metadata()`` bodies for gitlab / github / generic. The
    registry slot is reserved in 0.2 so the credentials viewset and
    ``apps/integrations`` schema both know which provider keys are valid.
    """

    key: ClassVar[str]
    label: ClassVar[str]
    requires_credential: ClassVar[bool] = True

    @classmethod
    @abc.abstractmethod
    def matches(cls, url: str) -> bool:
        """Return ``True`` if this provider can handle ``url``.

        Implementations are filled in by #637. The 0.2 stubs raise
        ``NotImplementedError`` — the registry still exposes ``keys()`` for
        the credentials API to validate provider strings against.
        """

    @abc.abstractmethod
    def fetch_metadata(self, url: str, credential: Any) -> Any:
        """Fetch live status / title for ``url`` using ``credential``.

        Implementation lands with #637 (5-second timeout, SSRF-protected).
        """


class OutgoingChannelProvider(abc.ABC):
    """Base class for ``OUTGOING_CHANNEL_PROVIDERS`` entries (ADR-0049 §2).

    Registry slot reserved here so #638 (webhook format extension) can land
    without restructuring. The handler renders provider-specific JSON
    payloads from ``WebhookEventType`` events; the existing
    ``apps/webhooks/`` retry / audit substrate stays unchanged.
    """

    key: ClassVar[str]
    label: ClassVar[str]

    @abc.abstractmethod
    def render(self, event: Any) -> dict[str, Any]:
        """Render ``event`` into the provider-specific JSON payload shape."""


class NotificationChannel(abc.ABC):
    """Base class for ``NOTIFICATION_CHANNELS`` entries (ADR-0049 §1).

    Used by ``UserNotificationPreference`` rows to validate the ``channel``
    field. The existing ``apps/notifications/`` migration ships ``in_app``
    and ``email`` as DB-level ``TextChoices`` (ADR-0075 vintage); this
    registry adds the extension-point shape #639 needs to register richer
    channels (``slack_dm``, ``teams_dm``, ``sms``) without an OSS migration.
    """

    key: ClassVar[str]
    label: ClassVar[str]

    @abc.abstractmethod
    def send(self, user: Any, event: Any) -> Any:
        """Deliver ``event`` to ``user`` via this channel."""


# ---------------------------------------------------------------------------
# Registry instances — populated by AppConfig.ready() / Enterprise startup
# ---------------------------------------------------------------------------


TASK_LINK_PROVIDERS = ProviderRegistry("TASK_LINK_PROVIDERS", TaskLinkProvider)
OUTGOING_CHANNEL_PROVIDERS = ProviderRegistry("OUTGOING_CHANNEL_PROVIDERS", OutgoingChannelProvider)
NOTIFICATION_CHANNELS = ProviderRegistry("NOTIFICATION_CHANNELS", NotificationChannel)
