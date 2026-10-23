"""Management command to bootstrap a TruePPM admin (superuser) account.

Runs automatically on container startup (both Docker Compose and Kubernetes).
Idempotent: if a superuser already exists the command exits immediately — it
will NOT reset a production password on re-deploy.

When no superuser exists, the command resolves ``DJANGO_SUPERUSER_EMAIL`` (matched
case-insensitively) and either creates a fresh superuser or, for an existing
**non-superuser** holding that address, promotes it and resets its password. The
promotion is how an operator recovers an install whose only superuser was demoted,
but it is a privilege grant, so it is announced on stdout rather than reported as an
ordinary create (#3175).

Promotion is **opt-in**: an existing non-superuser
is promoted only when ``TRUEPPM_ADMIN_PROMOTE_EXISTING`` is truthy. Otherwise the
command refuses, leaves the account untouched, and says how to proceed. Without the
opt-in, anyone able to register ``DJANGO_SUPERUSER_EMAIL`` ahead of the operator
(the default is a well-known address) would inherit superuser on the next pod start
after the real admin is demoted, keeping every PAT, refresh token, and SSO link they
already held. When promotion does happen, the account's existing credentials are
revoked in the same transaction (#4586).

The command refuses, writing nothing, in three cases: an existing non-superuser holds
the email and the opt-in is unset; several accounts share the email; or the target
username already belongs to a different account.

Concurrency
-----------
The Helm chart runs this as a **per-pod** ``bootstrap`` init container, so at
``replicaCount >= 2`` several pods run it against one database at once. Without
arbitration, every pod passes the "no superuser" check before any of them
commits, each mints its own password and writes it to its own pod-local file,
and the last ``save()`` wins — leaving the other pods holding a password that
does not work, with nothing to tell the operator which file is real (#4039).
The check-and-create therefore runs under a transaction-scoped PostgreSQL
advisory lock: the first pod creates the admin, the others block until it
commits and then see the superuser and skip. Exactly one pod ever holds the
password file.

Credential delivery
-------------------
The password is written to a file (default ``/tmp/trueppm_admin_password``)
with atomic 0o600 permissions so it never appears in container log aggregators
(CloudWatch, Datadog, etc.).  Override the path via the
``TRUEPPM_ADMIN_PASSWORD_FILE`` environment variable.  If the file write fails
the password falls back to management-command stdout *only* — it is never
passed to ``logger.*`` which would forward it to log aggregators.

Environment variables
---------------------
``DJANGO_SUPERUSER_EMAIL``
    Admin email address (default: ``admin@example.com``).

    The default is an RFC 2606 reserved domain, chosen so it can never be
    delivered to. It used to be ``admin@trueppm.com`` — a domain the *vendor*
    owns and the operator does not, which put every un-overridden install's
    root account at an address its owner could not receive password-reset mail
    at, and someone else could (#3175). Always set this explicitly.
``DJANGO_SUPERUSER_USERNAME``
    Admin username; defaults to the local part of the email.
``DJANGO_SUPERUSER_PASSWORD``
    Explicit password.  When omitted a secure random password is generated
    via :func:`secrets.token_urlsafe`.
``TRUEPPM_ADMIN_PROMOTE_EXISTING``
    Set to ``1``/``true``/``yes`` to allow promoting an existing non-superuser account
    that holds ``DJANGO_SUPERUSER_EMAIL`` (default: refuse). Promotion revokes the
    account's personal access tokens, refresh tokens, durable grants, and SSO links.

``TRUEPPM_ADMIN_PASSWORD_FILE`` environment variable.  If the file write fails
the password falls back to management-command stdout *only* — it is never
passed to ``logger.*`` which would forward it to log aggregators.

Environment variables
---------------------
``DJANGO_SUPERUSER_EMAIL``
    Admin email address (default: ``admin@example.com``).

    The default is an RFC 2606 reserved domain, chosen so it can never be
    delivered to. It used to be ``admin@trueppm.com`` — a domain the *vendor*
    owns and the operator does not, which put every un-overridden install's
    root account at an address its owner could not receive password-reset mail
    at, and someone else could (#3175). Always set this explicitly.
``DJANGO_SUPERUSER_USERNAME``
    Admin username; defaults to the local part of the email.
``DJANGO_SUPERUSER_PASSWORD``
    Explicit password.  When omitted a secure random password is generated
    via :func:`secrets.token_urlsafe`.
``TRUEPPM_ADMIN_PROMOTE_EXISTING``
    Set to ``1``/``true``/``yes`` to allow promoting an existing non-superuser account
    that holds ``DJANGO_SUPERUSER_EMAIL`` (default: refuse). Promotion revokes the
    account's personal access tokens, refresh tokens, durable grants, and SSO links.

Refusals (an unconfirmed promotion, or several accounts sharing the email) are
reported on stderr and the command exits 0: the Helm ``bootstrap`` init container
gates pod start, so a non-zero exit would turn a recoverable configuration problem
into a full API outage on the next restart.

``TRUEPPM_ADMIN_PASSWORD_FILE``
    Path where the one-time password is written (default:
    ``/tmp/trueppm_admin_password``).  Override in production to a
    non-world-writable location (e.g. an emptyDir volume mount).

The three refusals above are reported on stderr and the logger, and the command
exits 0: the Helm ``bootstrap`` init container gates pod start, so a non-zero exit
would turn a recoverable configuration problem into a full API outage on the next
restart.
"""

from __future__ import annotations

import logging
import os
import secrets
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import connection, transaction

logger = logging.getLogger(__name__)

# Default intentionally uses /tmp for dev convenience; production deployments
# must set TRUEPPM_ADMIN_PASSWORD_FILE to a non-world-writable path.
_PASSWORD_FILE = os.environ.get(  # nosec B108
    "TRUEPPM_ADMIN_PASSWORD_FILE", "/tmp/trueppm_admin_password"
)

#: Fixed advisory-lock key for the bootstrap, distinct from
#: ``migrate_locked.MIGRATION_ADVISORY_LOCK_KEY``. Every pod must use the same
#: literal or the lock arbitrates nothing; not derived from ``hash()``, which is
#: salted per process.
BOOTSTRAP_ADVISORY_LOCK_KEY = 4_113_188_002


def _promote_existing_allowed() -> bool:
    """True when the operator opted in to promoting an existing non-superuser."""
    return os.environ.get("TRUEPPM_ADMIN_PROMOTE_EXISTING", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


class Command(BaseCommand):
    """Bootstrap a TruePPM superuser on first run; no-op if one already exists."""

    help = (
        "Bootstrap a superuser on first run. "
        "Writes the one-time password to a file rather than stdout "
        "so it is not visible in container log aggregators."
    )

    def handle(self, *args: object, **options: object) -> None:
        """Execute the command.

        Exits immediately when a superuser already exists so that re-deploying
        a Kubernetes pod or restarting the compose stack does not overwrite a
        production password.
        """
        User = get_user_model()

        with transaction.atomic():
            if connection.vendor == "postgresql":
                # xact-scoped: released at COMMIT, so a waiting pod only proceeds
                # once the winner's superuser row is visible to it. SQLite has no
                # advisory locks and is necessarily single-process.
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_advisory_xact_lock(%s)", [BOOTSTRAP_ADVISORY_LOCK_KEY]
                    )

            if User.objects.filter(is_superuser=True).exists():
                self.stdout.write("Admin user already exists — skipping bootstrap.")
                return

            result = self._bootstrap()

        if result is None:
            return
        email, username, password, created = result
        self._deliver(email, username, password, created)

    def _bootstrap(self) -> tuple[str, str, str, bool] | None:
        """Create or promote the superuser. Caller holds the bootstrap lock.

        Returns ``None`` when it refused (ambiguous email, promotion not opted into,
        or username collision); nothing has been written in that case.
        """
        User = get_user_model()

        # Empty or whitespace counts as unset: compose's `DJANGO_SUPERUSER_EMAIL=` passes
        # "" through, which would otherwise match every blank-email account.
        email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "").strip() or "admin@example.com"
        username = os.environ.get("DJANGO_SUPERUSER_USERNAME", "").strip() or email.split("@")[0]
        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD", "").strip() or secrets.token_urlsafe(
            16
        )

        # auth.User.email is not unique, so get_or_create(email=...) would raise
        # MultipleObjectsReturned and crash-loop the init container on every start.
        # Fetch two rows to detect ambiguity and fail closed instead of guessing.
        matches = list(User.objects.filter(email__iexact=email).order_by("pk")[:2])
        if len(matches) > 1:
            self._refuse(
                f"more than one account has the email {email!r} "
                f"(pk={matches[0].pk}, pk={matches[1].pk}, ...). Refusing to pick one "
                "to promote. Set DJANGO_SUPERUSER_EMAIL to an unused address, or "
                "make the email unique, then restart. No superuser was created."
            )
            return None

        created = not matches
        if created:
            user = User(email=email, username=username)
        else:
            user = matches[0]
            if not _promote_existing_allowed():
                self._refuse(
                    f"{email} already exists as a non-superuser account and no "
                    "superuser exists. Refusing to promote it (its existing tokens and "
                    "SSO links would gain superuser). Set DJANGO_SUPERUSER_EMAIL to an "
                    "unused address, or set TRUEPPM_ADMIN_PROMOTE_EXISTING=true to "
                    "promote this account deliberately. No changes were made."
                )
                return None

        # username is unique (case-sensitive) and may already belong to a different
        # row; saving would raise IntegrityError and crash-loop the init container.
        if User.objects.filter(username=username).exclude(pk=user.pk).exists():
            self._refuse(
                f"the username {username!r} already belongs to a different account "
                f"than {email}. Set DJANGO_SUPERUSER_USERNAME to an unused username, "
                "then restart. No superuser was created."
            )
            return None

        # Bootstrap-only: password is an operator-supplied env var or a
        # cryptographically random token (above), not interactive signup input —
        # AUTH_PASSWORD_VALIDATORS govern the registration path, not superuser
        # provisioning.
        # nosemgrep: unvalidated-password
        user.set_password(password)
        user.username = username
        user.is_staff = True
        user.is_superuser = True
        user.save()
        if not created:
            self._revoke_existing_credentials(user)
        return email, username, password, created

    def _refuse(self, message: str) -> None:
        """Report a refusal on stderr and the logger; the caller then exits 0."""
        logger.error("create_admin: %s", message)
        self.stderr.write(self.style.ERROR(f"ERROR: {message}"))

    def _revoke_existing_credentials(self, user: Any) -> None:
        """Cut off every credential the account held before it became superuser.

        The password reset alone does not touch PATs, refresh tokens, durable
        grants, live sockets or an SSO binding, all of which would now carry superuser.
        Deleting the ``SocialAccount`` forces a re-link, and that re-link is refused
        for the now-superuser account: ``sso/services.py`` will not auto-bind an IdP
        identity to a superuser or staff account by verified email (#4629), so the
        old identity cannot sign back in as the promoted admin.
        """
        from allauth.socialaccount.models import SocialAccount

        from trueppm_api.apps.access.services import (
            revoke_all_personal_access_tokens,
            revoke_all_refresh_tokens,
            revoke_personal_durable_grants,
        )
        from trueppm_api.apps.access.signals import evict_all_live_project_sockets

        revoke_all_personal_access_tokens(user, reason="bootstrap_promotion")
        revoke_all_refresh_tokens(user)
        revoke_personal_durable_grants(user)
        SocialAccount.objects.filter(user=user).delete()
        evict_all_live_project_sockets(user.pk)

    def _deliver(self, email: str, username: str, password: str, created: bool) -> None:
        """Announce the bootstrap and hand the password to the operator.

        Runs after COMMIT, so a pod never writes a password file for a
        transaction that rolled back.
        """
        # An existing row being promoted is a privilege grant on an account the
        # operator did not necessarily know was there — say so plainly rather than
        # letting it read like a routine bootstrap line.
        if created:
            action = "Created"
        else:
            action = "Promoted existing user to"
            self.stdout.write(
                self.style.WARNING(
                    f"WARNING: {email} already existed as a non-superuser. It has been "
                    "granted superuser + staff, its password has been RESET, and its tokens "
                    "and SSO links have been revoked. Now unset TRUEPPM_ADMIN_PROMOTE_EXISTING "
                    "(Helm: admin.promoteExisting): left set, it silently re-applies the next "
                    "time the only superuser is demoted."
                )
            )

        # Write to file rather than stdout — credentials in stdout end up in
        # every log aggregator that ships container output.
        pw_to_stdout = False
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
            # O_NOFOLLOW prevents a symlink attack on the world-writable /tmp
            # directory (Linux and macOS only; ignored on platforms that lack it).
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            # Mode 0o600 is applied atomically at file creation — avoids the
            # TOCTOU window that a two-step open()+chmod() would leave.
            fd = os.open(_PASSWORD_FILE, flags, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(password + "\n")
            password_info = f"[REDACTED — written to {_PASSWORD_FILE}]"
        except OSError as exc:
            # File write failed.  Fall back to management-command stdout only;
            # do NOT use logger.* (log aggregators capture WARNING+ lines).
            # No secret logged: the only arg is the OSError; the password is
            # surfaced solely on command stdout below, never via the logger.
            # nosemgrep: python-logger-credential-disclosure
            logger.warning(
                "create_admin: could not write password file (%s). "
                "Credential printed to command stdout only.",
                exc,
            )
            pw_to_stdout = True
            password_info = password

        self.stdout.write("")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  TRUEPPM INITIAL ADMIN CREDENTIALS"))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(f"  {action} admin: {email} (username={username})")
        self.stdout.write(f"  Password: {password_info}")
        if not pw_to_stdout:
            self.stdout.write(
                self.style.WARNING(
                    f"  Retrieve the password from {_PASSWORD_FILE}, then delete the file."
                )
            )
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write("")
