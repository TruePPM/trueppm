"""Registration guard and contained invocation for the extension-provider hooks (#2859, #3866).

Most extension points are registries keyed by name, and ``ProviderRegistry`` raises
on a duplicate key. Eleven hooks are instead a module-global ``Callable | None`` with
an unconditional-assignment setter — the shape that fits a hook where at most one
provider can be meaningful (is enforcement active? what is the default posture?).
All eleven route through this guard as of #3779 (#2859 introduced it but converted
only 6 of the 11 slots).

Unconditional assignment makes them **last-write-wins**: two registrations silently
overwrite, and the winner is import order. That is the wrong failure mode for a
cross-repo seam. OSS registers nothing, so the realistic conflict is an Enterprise
build registering twice — from an ``AppConfig.ready()`` that runs more than once, or
from two apps that each think they own the hook — and the symptom would be an
enforcement policy that silently stops applying, with nothing in any log.

The guard is deliberately narrow, because the existing call patterns are legitimate:

* clearing (``None``) is always allowed — every test teardown does it;
* re-registering the *same* callable is a no-op, so an idempotent ``ready()`` is fine;
* only replacing a live provider with a *different* one raises.

**Invoking** a provider goes through :func:`invoke_extension_provider` (#3866). A
provider is a callable OSS does not review, so it gets the containment
``dispatch_extension_signal()`` gives a receiver: its exception is logged and replaced
by a fallback the call site states, never propagated into the OSS request or task.
``scripts/check-extension-points.py`` fails a slot that is called directly.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, TypeVar

from celery.exceptions import SoftTimeLimitExceeded
from django.db import connection, transaction

logger = logging.getLogger(__name__)

_T = TypeVar("_T")


class DuplicateProviderError(RuntimeError):
    """Raised when a second, different provider is registered against a single-provider hook."""


def guard_single_provider(current: _T | None, incoming: _T | None, hook: str) -> _T | None:
    """Return ``incoming``, or raise if it would silently displace a different provider.

    Args:
        current: The provider currently registered, or ``None``.
        incoming: The provider being registered, or ``None`` to clear.
        hook: The hook's name, for the error message.

    Returns:
        ``incoming``, so a setter can write ``_PROVIDER = guard_single_provider(...)``.

    Raises:
        DuplicateProviderError: If a *different* provider is already registered.
    """
    if incoming is None or current is None or current is incoming:
        return incoming
    raise DuplicateProviderError(
        f"{hook} already has a provider registered ({current!r}); refusing to replace it "
        f"with {incoming!r}. This hook holds at most one provider, so an unconditional "
        f"overwrite would make the winner depend on import order and silently disable the "
        f"loser. Clear it explicitly (register None) if the replacement is intended."
    )


def invoke_extension_provider(
    provider: Callable[..., _T], *args: Any, hook: str, fallback: _T
) -> _T:
    """Call an extension provider without letting it break the OSS path that asked.

    The fail direction belongs to the call site, not to this helper: ``fallback`` is
    what the caller does when the answer is unknown. Pass the OSS default for a
    configuration seam. For a seam that guards access or exposure, pass a sentinel
    (``None``) and resolve it to the stricter outcome, marked ``FAIL-CLOSED``.

    Inside a transaction (``ATOMIC_REQUESTS``) the provider runs in its own savepoint,
    for the reason ``dispatch_extension_signal()`` does (#4084): a ``DatabaseError``
    it raises, or swallows, would otherwise leave the surrounding OSS write aborted.

    Args:
        provider: The registered callable. The caller handles the ``None`` (nothing
            registered) case first, so the community edition pays no savepoint.
        *args: Positional arguments for the provider.
        hook: The seam's name, for the log line.
        fallback: Returned when the provider raises.

    Returns:
        The provider's result, or ``fallback``.
    """
    try:
        if connection.in_atomic_block:
            with transaction.atomic(savepoint=True):
                return provider(*args)
        return provider(*args)
    except SoftTimeLimitExceeded:
        # The worker's signal that the *task* is out of time, which happens to land
        # here. Swallowing it would let a CPM run carry on with a fallback answer.
        raise
    except Exception:
        logger.exception("%s provider raised; using the OSS fallback", hook)
        return fallback
