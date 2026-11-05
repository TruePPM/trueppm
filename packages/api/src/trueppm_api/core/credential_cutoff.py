"""Per-user credential cutoff: "every token issued before now is dead" (#4499).

A password reset (and every other "sign out every device" action) blacklists the
account's refresh tokens, but an already-issued **access** JWT is stateless: it
keeps authenticating for the rest of its 15-minute lifetime. Within that window
it could mint a WebSocket ticket, a Personal Access Token, a project token or a
share link — a fresh, durable credential that survives the reset that was meant
to cut the attacker off.

The cutoff closes that window. ``revoke_all_refresh_tokens`` stamps
``UserProfile.credentials_revoked_at``; the JWT authenticator, the refresh view and
the WebSocket handshake refuse any credential issued at or before it.

**The ``iat`` boundary is strict, and that is deliberate.** A JWT's ``iat`` is a
whole-second epoch (simplejwt truncates), while the cutoff is a microsecond
timestamp. A token whose ``iat`` second is the cutoff's own second cannot be
ordered against the reset: it may have been minted 0.9 s before it. If such a
token were accepted, an attacker refreshing a stolen session in a tight loop is
guaranteed one token in the reset's second that survives for 15 minutes. So a
token with ``iat <= floor(cutoff)`` is refused. The cost is that a *legitimate*
login completing inside the same wall-clock second as the reset is refused once
and has to sign in again — a human cannot type a new password into the sign-in
form that fast, so the fail-closed side is the right one to land on.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from django.core.exceptions import ObjectDoesNotExist
from django.utils import timezone


def mark_credentials_revoked(user: Any, *, at: datetime | None = None) -> datetime:
    """Record that every credential ``user`` holds as of ``at`` is revoked.

    Upserts the user's profile row (rows are created lazily, so an account that has
    never touched its preferences has none yet). Runs inside the caller's
    transaction: the cutoff must commit or roll back with the revocation it
    accompanies.

    Args:
        user: The account whose existing credentials are being cut off.
        at: The cutoff instant. Defaults to now.

    Returns:
        The cutoff that was stored.
    """
    from trueppm_api.apps.profiles.models import UserProfile

    cutoff = at or timezone.now()
    UserProfile.objects.update_or_create(user=user, defaults={"credentials_revoked_at": cutoff})
    return cutoff


def credentials_revoked_at(user: Any) -> datetime | None:
    """Return ``user``'s credential cutoff, or ``None`` when none was ever set.

    Reads the reverse one-to-one ``profile`` accessor, so callers on a hot path
    should load the user with ``select_related("profile")`` — the authenticators in
    this codebase do, which keeps the check to a join on the query they already run
    rather than a second query per request.
    """
    try:
        profile = user.profile
    except (ObjectDoesNotExist, AttributeError):
        return None
    return profile.credentials_revoked_at  # type: ignore[no-any-return]


def issued_before_cutoff(iat: Any, cutoff: datetime | None, *, whole_seconds: bool = True) -> bool:
    """Whether a credential issued at ``iat`` predates ``cutoff`` (and so is dead).

    ``iat`` is a JWT ``iat`` claim (epoch seconds). With ``whole_seconds`` (the
    default, for JWTs) the comparison is strict on the whole second — see the module
    docstring for why a token minted in the cutoff's own second is refused. A
    credential whose issue time we record ourselves at full precision (the WebSocket
    ticket) passes ``whole_seconds=False`` and is compared exactly. A credential
    with no usable ``iat`` is refused whenever a cutoff exists: it cannot be shown
    to postdate it.

    Args:
        iat: The credential's issued-at, in epoch seconds.
        cutoff: The account's cutoff, or ``None`` if never set.
        whole_seconds: ``iat`` carries only second precision.

    Returns:
        ``True`` when the credential must be refused.
    """
    if cutoff is None:
        return False
    if isinstance(iat, bool) or not isinstance(iat, int | float):
        return True
    issued = float(iat)
    if whole_seconds:
        return issued <= math.floor(cutoff.timestamp())
    return issued <= cutoff.timestamp()
