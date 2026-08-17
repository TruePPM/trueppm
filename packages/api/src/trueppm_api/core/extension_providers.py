"""Duplicate-registration guard for the single-provider extension hooks (#2859).

Most extension points are registries keyed by name, and ``ProviderRegistry`` raises
on a duplicate key. Six hooks are instead a module-global ``Callable | None`` with an
unconditional-assignment setter — the shape that fits a hook where at most one
provider can be meaningful (is enforcement active? what is the default posture?).

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
"""

from __future__ import annotations

from typing import TypeVar

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
