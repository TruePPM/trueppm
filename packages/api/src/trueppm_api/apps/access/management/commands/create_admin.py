"""Management command to create or update an admin (superuser) account.

Reads credentials from environment variables so it can be used non-interactively
in Docker Compose dev bootstrapping, Kubernetes post-install hooks, and CI pipelines.

Required env vars:
    DJANGO_SUPERUSER_EMAIL     — the admin's email (used as username if
                                 DJANGO_SUPERUSER_USERNAME is not set)
    DJANGO_SUPERUSER_PASSWORD  — the admin's password

Optional env vars:
    DJANGO_SUPERUSER_USERNAME  — explicit username; defaults to the local part of
                                 the email address (everything before the @)

Idempotent: if a user with the given email already exists the password and staff/
superuser flags are updated rather than creating a duplicate.
"""

from __future__ import annotations

import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    """Create or update a Django superuser from environment variables."""

    help = "Create or update a superuser from DJANGO_SUPERUSER_* env vars."

    def handle(self, *args: object, **options: object) -> None:
        """Execute the command.

        Raises:
            CommandError: when a required environment variable is missing.
        """
        email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "").strip()
        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD", "").strip()

        if not email:
            raise CommandError(
                "DJANGO_SUPERUSER_EMAIL environment variable is required."
            )
        if not password:
            raise CommandError(
                "DJANGO_SUPERUSER_PASSWORD environment variable is required."
            )

        # Default username to the local part of the email so callers do not need
        # to provide a separate DJANGO_SUPERUSER_USERNAME unless they want one.
        username = (
            os.environ.get("DJANGO_SUPERUSER_USERNAME", "").strip()
            or email.split("@")[0]
        )

        User = get_user_model()

        user, created = User.objects.get_or_create(
            email=email,
            defaults={"username": username},
        )

        user.set_password(password)
        user.is_staff = True
        user.is_superuser = True
        # Ensure the username stays in sync if the user already existed.
        if not created:
            user.username = username
        user.save()

        verb = "Created" if created else "Updated"
        self.stdout.write(
            self.style.SUCCESS(f"{verb} admin user: {email} (username={username})")
        )
