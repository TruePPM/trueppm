"""Single resolver for ``TRUEPPM_``-prefixed env vars with a deprecated bare fallback.

Operator settings live under the ``TRUEPPM_`` prefix. Names that shipped bare
before the prefix standard (#1325, #3791) keep working as a *deprecated*
fallback so an existing ``values.yaml`` upgrades without a config change.

Precedence, the same for every setting (#4482):

1. the prefixed name, when set to a **non-empty** value;
2. the legacy bare name, when set to a non-empty value (logs a WARNING once per
   process naming the replacement);
3. the default.

An *empty* prefixed value is "unset", never an override: the Helm chart ships
some prefixed keys as ``""`` placeholders, and an empty string cannot be a
meaningful value for a cookie name, an origin or an integer cap, so letting it
shadow a real legacy override would silently discard the operator's setting.

The legacy names are removed on the 1.0 dual-read window (#4405).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, TypeVar

import environ

_T = TypeVar("_T")

_log = logging.getLogger("trueppm.settings")
_warned: set[str] = set()


def env_with_legacy(
    env: environ.Env,
    prefixed: str,
    legacy: str,
    default: _T,
    cast: Callable[[str], Any] = str,
) -> _T:
    """Resolve ``prefixed`` with ``legacy`` as a deprecated fallback.

    Args:
        env: The ``environ.Env`` the settings module reads through.
        prefixed: The canonical ``TRUEPPM_``-prefixed variable name.
        legacy: The deprecated bare variable name.
        default: Returned when neither name carries a non-empty value.
        cast: Converts the raw string (``int``, a bool parser, ...); a malformed
            value raises, exactly as ``env.int`` would.

    Returns:
        The resolved, cast value.
    """
    raw = env.str(prefixed, default="")
    if raw != "":
        return cast(raw)  # type: ignore[no-any-return]
    legacy_raw = env.str(legacy, default="")
    if legacy_raw != "":
        if legacy not in _warned:
            _warned.add(legacy)
            _log.warning(
                "Environment variable %s is deprecated; rename it to %s. The bare "
                "name is still read as a fallback and will be removed at 1.0.",
                legacy,
                prefixed,
            )
        return cast(legacy_raw)  # type: ignore[no-any-return]
    return default


def parse_bool(raw: str) -> bool:
    """Parse an env string with the same truthiness ``environ.Env.bool`` uses.

    Anything outside the truthy set (including a typo such as ``"flase"``) is
    ``False``, exactly as ``environ.Env.bool`` behaves. That is intended to stay
    behavior-compatible with the pre-#4482 ``env.bool`` reads, but note the
    asymmetry for ``AUTH_REFRESH_COOKIE_SECURE``: a garbage value drops the
    ``Secure`` flag. Tightening it to raise is a behavior change tracked
    separately, not done here.
    """
    return raw.strip().lower() in {"true", "on", "ok", "y", "yes", "1"}
