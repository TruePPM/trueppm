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

**Clock skew between replicas.** A token's ``iat`` and a ticket's issue time come
from the clock of the pod that minted it; the cutoff comes from the clock of the
pod that ran the reset. Those are different processes, often on different nodes.
If the minting pod's clock runs ahead, a token minted *before* the reset can carry
an ``iat`` *after* the cutoff and be accepted. So :func:`mark_credentials_revoked`
stamps the cutoff :data:`CLOCK_SKEW_MARGIN` into the future — fail-closed, like the
same-second rule. Together the two refuse everything issued up to roughly 1–2 s
after the reset: a sign-in completing that soon after a reset is refused once and
has to sign in again. This assumes the replicas' clocks are NTP-synchronized to
well within the margin — an assumption about the operator's hosts, not something
this code can verify. Skew larger than the margin reopens the window by the excess.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any

from django.core.exceptions import ObjectDoesNotExist
from django.utils import timezone
from django.utils.translation import gettext_lazy as _
from rest_framework.exceptions import AuthenticationFailed

#: Forward margin added to every stored cutoff to absorb clock skew between the
#: replica that runs the reset and the replicas that minted tokens (see the
#: module docstring). One second plus the whole-second ``iat`` rule gives a
#: 1–2 s refusal window after a reset.
CLOCK_SKEW_MARGIN = timedelta(seconds=1)


def mark_credentials_revoked(user: Any, *, at: datetime | None = None) -> datetime:
    """Record that every credential ``user`` holds as of ``at`` is revoked.

    Upserts the user's profile row (rows are created lazily, so an account that has
    never touched its preferences has none yet). Runs inside the caller's
    transaction: the cutoff must commit or roll back with the revocation it
    accompanies.

    Args:
        user: The account whose existing credentials are being cut off.
        at: The revocation instant. Defaults to now. :data:`CLOCK_SKEW_MARGIN` is
            added either way, so the stored cutoff is always ``at + margin``.

    Returns:
        The cutoff that was stored (including the margin).
    """
    from trueppm_api.apps.profiles.models import UserProfile

    cutoff = (at or timezone.now()) + CLOCK_SKEW_MARGIN
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


def lock_and_recheck_credential_cutoff(request: Any) -> None:
    """Serialize a durable-grant mint against a concurrent credential sweep (#4839).

    The authenticator checks the cutoff when the request *starts*. A password reset
    that commits after that check but before the mint's INSERT commits is invisible
    to both sides: the reset's sweep (``revoke_all_personal_access_tokens``,
    ``revoke_personal_durable_grants``) runs under READ COMMITTED and cannot see an
    uncommitted row, and the mint already passed authentication. The row survives
    the sweep, and a PAT can have no expiry.

    Both sides therefore take a row lock on the caller's ``UserProfile``.
    ``mark_credentials_revoked`` (``update_or_create`` -> ``SELECT ... FOR UPDATE``)
    holds it from the cutoff stamp to commit, so the sweep always runs under it. This
    function takes the same lock and then re-reads the cutoff from the *locked* row
    (never a cached ``request.user.profile``):

    - reset first: the mint blocks until the reset commits, re-reads the new cutoff
      and is refused;
    - mint first: the reset blocks on the lock until the mint commits, so its sweep
      (a later statement, hence a later snapshot) sees and revokes the new grant.

    Call it **first** in the mint, before any other row lock, so every path acquires
    the profile lock before the rows the sweep touches (no lock-order inversion with
    the reset). That includes the credential's own row: an API-token caller's
    ``last_used_at`` stamp is deferred to ``on_commit`` precisely so the request holds
    no ``ApiToken`` row lock when it gets here (``OwnerScopedApiTokenAuthentication``).
    It must run inside the request's transaction (``ATOMIC_REQUESTS``) so
    the lock is held until the mint commits; outside one ``select_for_update`` raises
    ``TransactionManagementError`` rather than silently locking nothing.

    The profile row is created lazily, so it may not exist yet: ``get_or_create``
    inserts it first. Two creators collide on the unique ``user`` key and the loser
    waits for the winner's commit, so the lock is never a no-op.

    **Where the issue time comes from.** A JWT caller: ``request.auth`` is the
    validated token and its ``iat`` is compared on the whole second, exactly as the
    authenticator does. A Personal Access Token caller (some mint endpoints, such as
    the workspace invite create, do not refuse API tokens): ``request.auth`` is the
    ``ApiToken`` row, which has no ``iat``, so its ``created_at`` is compared at full
    precision. A PAT created after the cutoff passes; one created at or before it is
    refused (a reset's PAT sweep revokes those anyway; this closes the in-flight gap).
    **Any other auth type, or a JWT with no usable ``iat``, is refused whenever a
    cutoff exists** (fail-closed, as :func:`issued_before_cutoff` does for the
    authenticator).

    Raises:
        AuthenticationFailed: the caller's token predates the cutoff (HTTP 401).
    """
    from trueppm_api.apps.profiles.models import UserProfile

    user = request.user
    if not getattr(user, "is_authenticated", False):
        return
    UserProfile.objects.get_or_create(user=user)
    cutoff = (
        UserProfile.objects.select_for_update()
        .values_list("credentials_revoked_at", flat=True)
        .get(user=user)
    )
    from trueppm_api.apps.projects.models import ApiToken

    auth: Any = getattr(request, "auth", None)
    if isinstance(auth, ApiToken):
        # Fail-closed under cross-pod clock skew: created_at comes from the minting pod's
        # clock and the cutoff from the resetting pod's, so a PAT legitimately created just
        # after a reset on a slow-clocked pod can land at or before the cutoff and be
        # refused here until the next cutoff.
        refused = issued_before_cutoff(auth.created_at.timestamp(), cutoff, whole_seconds=False)
    else:
        iat = auth.get("iat") if auth is not None and hasattr(auth, "get") else None
        refused = issued_before_cutoff(iat, cutoff)
    if refused:
        raise AuthenticationFailed(_("This session was signed out. Please sign in again."))
