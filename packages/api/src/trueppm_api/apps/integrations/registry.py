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
from dataclasses import dataclass
from typing import Any, ClassVar

# Canonical cached-status values for a task link (#637). The provider maps a
# provider-specific state onto one of these; the model stores the string and the
# UI renders a badge per value. ``unknown`` covers links we can't classify
# (commits, branches, an unreachable provider, a missing credential).
LINK_STATUS_OPEN = "open"
LINK_STATUS_DRAFT = "draft"
LINK_STATUS_MERGED = "merged"
LINK_STATUS_CLOSED = "closed"
LINK_STATUS_UNKNOWN = "unknown"
LINK_STATUS_VALUES: tuple[str, ...] = (
    LINK_STATUS_OPEN,
    LINK_STATUS_DRAFT,
    LINK_STATUS_MERGED,
    LINK_STATUS_CLOSED,
    LINK_STATUS_UNKNOWN,
)
# Pre-built ``(value, value)`` pairs for the model's ``CharField(choices=...)``.
# Defined here (module level) rather than as a class-body comprehension in the
# model — the latter trips the django-stubs plugin and makes it skip the whole
# model's manager/field inference.
LINK_STATUS_CHOICES: tuple[tuple[str, str], ...] = tuple(
    (value, value) for value in LINK_STATUS_VALUES
)

# Worst-status precedence for at-a-glance link-status rollups (#767, ADR-0154).
# Most-attention-first: the *worst* status across a task's links is the one with
# the **minimum** rank present. The ordering mirrors the existing detail-drawer
# badge color severity (critical → at-risk → on-track → success → neutral) so the
# list/Gantt glyphs read the same as the per-link badges. The same ordering is
# duplicated in packages/web/src/lib/linkStatus.ts; a unit test in each language
# pins it so the two cannot drift.
LINK_STATUS_RANK: dict[str, int] = {
    LINK_STATUS_CLOSED: 0,
    LINK_STATUS_DRAFT: 1,
    LINK_STATUS_OPEN: 2,
    LINK_STATUS_MERGED: 3,
    LINK_STATUS_UNKNOWN: 4,
}
# Inverse map: an aggregated ``Min(rank)`` over a task's links maps back to a value.
LINK_STATUS_BY_RANK: dict[int, str] = {rank: status for status, rank in LINK_STATUS_RANK.items()}


@dataclass(frozen=True)
class LinkMetadata:
    """Live status + title for a task link, returned by ``fetch_metadata`` (#637).

    Attributes:
        status: One of :data:`LINK_STATUS_VALUES`.
        title: Human title the provider reported (PR/MR/issue title), or
            ``None`` when unavailable — the UI falls back to the raw URL.
    """

    status: str
    title: str | None = None


@dataclass(frozen=True)
class VerifyResult:
    """Outcome of verifying a PAT against its provider (ADR-0049 §3, #677).

    Returned by :meth:`TaskLinkProvider.verify_token`. ``ok`` drives whether the
    credentials viewset persists the row; the remaining fields are best-effort
    metadata for the response / logs.

    Attributes:
        ok: ``True`` if the token is usable (or the provider cannot verify and
            accepts unverified — see ``reason="unverified"``).
        username: The authenticated account name the provider reported, if any.
        scopes: Token scopes the provider exposed (GitHub returns these in a
            header; GitLab does not on ``/user``), or ``None`` when unknown.
        reason: A machine-readable code when ``ok`` is ``False``
            (``invalid_token``, ``provider_unreachable``, ``provider_timeout``,
            ``blocked_host``) or ``"unverified"`` when accepted without a check.
    """

    ok: bool
    username: str | None = None
    scopes: list[str] | None = None
    reason: str | None = None


@dataclass(frozen=True)
class OutgoingChannelEvent:
    """A TruePPM event handed to an ``OutgoingChannelProvider.render``.

    Carries the event name alongside the raw payload so a renderer can build a
    provider-specific message (e.g. a Slack attachment title) without
    re-parsing the payload. Immutable — an event is a fact that already
    happened; a renderer must not mutate it.

    Attributes:
        event_type: The ``WebhookEventType`` value, e.g. ``"task.assigned"``.
        project_id: UUID string of the project the event occurred on.
        payload: The generic event payload dict (the ``generic`` provider
            returns this unchanged).
    """

    event_type: str
    project_id: str
    payload: dict[str, Any]


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
    def fetch_metadata(self, url: str, credential: Any) -> LinkMetadata:
        """Fetch live status / title for ``url`` using ``credential`` (#637).

        Makes a single SSRF-guarded, 5-second-bounded GET against the provider
        API. ``credential`` is the caller's :class:`IntegrationCredential` for
        this provider, or ``None`` when none is connected — providers that need
        auth return ``LinkMetadata(status="unknown")`` in that case rather than
        raising. Transport / parse failures also degrade to ``"unknown"``; the
        method does not raise for an unreachable provider.
        """

    @classmethod
    def verify_token(cls, plaintext: str, *, base_url: str | None = None) -> VerifyResult:
        """Verify ``plaintext`` is a usable PAT for this provider (#677).

        Deliberately **not** abstract: the default accepts the token without a
        live check (``reason="unverified"``). This keeps the extension point
        additive — Enterprise providers (``jira``, ``servicenow``) registered
        against the base class before this method existed keep working and
        simply degrade to "accepted, unverified" rather than failing to
        instantiate. Providers that can cheaply verify a PAT (GitLab / GitHub
        ping ``/user``) override this; the ``generic`` provider inherits the
        no-op, which is exactly the "accepted but unverified" behavior ADR-0049
        §3 specifies for it.

        Args:
            plaintext: The PAT to verify. Never logged or persisted in cleartext.
            base_url: Self-hosted instance base URL (GitLab CE/EE, GitHub
                Enterprise Server); ``None``/empty means the SaaS default host.
        """
        return VerifyResult(ok=True, reason="unverified")


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
    def render(self, event: OutgoingChannelEvent) -> dict[str, Any]:
        """Render ``event`` into the provider-specific JSON payload shape.

        The returned dict becomes the HTTP POST body verbatim — the existing
        ``deliver_webhook`` task signs and posts it unchanged (ADR-0083). The
        provider does NOT perform the POST; transport, retries, HMAC signing,
        and the ``X-TruePPM-Webhook-Sequence`` header stay in ``deliver_webhook``.
        """


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
