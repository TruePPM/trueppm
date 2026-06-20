"""Management command to bootstrap a TruePPM admin (superuser) account.

Runs automatically on container startup (both Docker Compose and Kubernetes).
Idempotent: if a superuser already exists the command exits immediately — it
will NOT reset a production password on re-deploy.

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
    Admin email address (default: ``admin@trueppm.dev``).
``DJANGO_SUPERUSER_USERNAME``
    Admin username; defaults to the local part of the email.
``DJANGO_SUPERUSER_PASSWORD``
    Explicit password.  When omitted a secure random password is generated
    via :func:`secrets.token_urlsafe`.
``TRUEPPM_ADMIN_PASSWORD_FILE``
    Path where the one-time password is written (default:
    ``/tmp/trueppm_admin_password``).  Override in production to a
    non-world-writable location (e.g. an emptyDir volume mount).
"""

from __future__ import annotations

import logging
import os
import secrets

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

logger = logging.getLogger(__name__)

# Default intentionally uses /tmp for dev convenience; production deployments
# must set TRUEPPM_ADMIN_PASSWORD_FILE to a non-world-writable path.
_PASSWORD_FILE = os.environ.get(  # nosec B108
    "TRUEPPM_ADMIN_PASSWORD_FILE", "/tmp/trueppm_admin_password"
)


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

        if User.objects.filter(is_superuser=True).exists():
            self.stdout.write("Admin user already exists — skipping bootstrap.")
            return

        email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "admin@trueppm.dev").strip()
        username = os.environ.get("DJANGO_SUPERUSER_USERNAME", "").strip() or email.split("@")[0]
        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD", "").strip() or secrets.token_urlsafe(
            16
        )

        user, created = User.objects.get_or_create(
            email=email,
            defaults={"username": username},
        )
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

        action = "Created" if created else "Promoted existing user to"

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
