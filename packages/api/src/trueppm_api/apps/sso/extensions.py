"""OSS extension seams for SSO (ADR-0187 §4–5, ADR-0177 idiom).

Two single-slot provider registries that govern the two capabilities the
OSS/Enterprise boundary excludes from the community edition. Each degrades to a
**safe community default** when no provider is registered, so the OSS edition is
fully functional standalone and ``trueppm-enterprise`` attaches with zero OSS
change (the one-way dependency holds: enterprise → OSS, never the reverse).

1. ``oidc_role_for`` — group→role mapping. OSS ignores claims and returns the
   admin-chosen ``default_role``. Enterprise registers a mapper that reads
   ``groups``/custom claims (requesting the wider scope through its own provider
   extension) and maps them to roles, with an auth-event audit trail.
2. ``local_login_allowed`` — enforced-SSO / disable-local-accounts. OSS always
   returns ``True``; password login is never blocked. Enterprise registers a
   provider that enforces ``allow_password_signin=False`` for non-exempt accounts.

Extension inputs are treated as **untrusted** even though enterprise is "ours"
(threat model, Boundary 5): both seams have a typed, narrow signature and the
callers fail safe on a raising provider.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from trueppm_api.apps.sso.models import OIDCProvider

logger = logging.getLogger("trueppm.sso")

# Enterprise registers a callable mapping (claims, config) → workspace-role int.
# OSS leaves it None → the auto-create role is always ``config.default_role``.
_IDENTITY_MAPPER: Callable[[dict[str, Any], OIDCProvider], int] | None = None

# Enterprise registers a callable user → bool ("may this user complete a password
# login?"). OSS leaves it None → password login is always allowed.
_LOCAL_LOGIN_POLICY: Callable[[Any], bool] | None = None


def register_oidc_identity_mapper(
    provider: Callable[[dict[str, Any], OIDCProvider], int] | None,
) -> None:
    """Register (or clear, with ``None``) the claims→role mapper. Enterprise calls this."""
    global _IDENTITY_MAPPER
    _IDENTITY_MAPPER = provider


def oidc_role_for(claims: dict[str, Any], config: OIDCProvider) -> int:
    """Resolve the workspace-role ordinal to grant an auto-created SSO member.

    OSS default: ignore the claims entirely and return ``config.default_role`` —
    there is no ``groups`` scope and no claim→role logic in the community edition.
    A registered enterprise mapper may read claims; if it raises or returns a
    non-int, we fall back to ``default_role`` (fail safe — never grant *more* than
    the admin-configured floor on a buggy mapper).
    """
    if _IDENTITY_MAPPER is None:
        return int(config.default_role)
    try:
        role = _IDENTITY_MAPPER(claims, config)
    except Exception:
        logger.exception("oidc identity mapper raised; falling back to default_role")
        return int(config.default_role)
    if not isinstance(role, int):
        logger.error("oidc identity mapper returned non-int %r; using default_role", role)
        return int(config.default_role)
    return role


def register_local_login_policy_provider(provider: Callable[[Any], bool] | None) -> None:
    """Register (or clear, with ``None``) the password-login policy. Enterprise calls this."""
    global _LOCAL_LOGIN_POLICY
    _LOCAL_LOGIN_POLICY = provider


def local_login_policy_enforced() -> bool:
    """Whether an edition actually enforces the ``allow_password_signin`` setting.

    OSS returns ``False`` — the community edition never blocks password login, so
    persisting ``allow_password_signin`` would be a set-but-ignored no-op. The SSO
    write serializer uses this to *reject* the field in OSS instead of silently
    swallowing it (#2025). Enterprise registers a policy provider, flipping this to
    ``True``, and its own serializer accepts and honors the field.
    """
    return _LOCAL_LOGIN_POLICY is not None


def local_login_allowed(user: Any) -> bool:
    """Whether ``user`` may complete a username/password login.

    OSS default: always ``True`` — the community edition never enforces
    "Allow password sign-in: OFF" (that enforcement is an enterprise capability;
    ADR-0187 §4). A registered enterprise provider may return ``False`` to block
    local login; if it raises, OSS fails **open** (login allowed) so a buggy
    enterprise policy can never lock every admin out of the install.
    """
    if _LOCAL_LOGIN_POLICY is None:
        return True
    try:
        return bool(_LOCAL_LOGIN_POLICY(user))
    except Exception:
        logger.exception("local login policy provider raised; allowing password login")
        return True
