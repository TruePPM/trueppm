"""Load a bundled sample project (issue #375).

Usage::

    python manage.py load_sample_project [--sample <key>] [--owner <username>]
                                         [--with-personas]

Imports a bundled sample seed (default: the Atlas hybrid-large launch demo) and
flags its projects as sample data. Idempotent — re-running replaces the sample.

``--with-personas`` additionally gives the sample's persona accounts a usable
login password so an evaluator can sign in *as* each persona (Alex the PM, Sarah
the sponsor, …) rather than only viewing their work. The password is resolved the
same way the demo seeds resolve it (#1350): ``TRUEPPM_DEMO_PASSWORD`` if set, else
``"demo"`` under ``DEBUG``, else a random token printed once — so a fixed weak
password can never silently reach a public instance. Without the flag the personas
are created with unusable passwords, exactly as before.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed.samples import (
    DEFAULT_SAMPLE,
    SAMPLES,
    UnknownSampleError,
    load_sample,
    sample_accounts,
)

User = get_user_model()

DEMO_PASSWORD_ENV = "TRUEPPM_DEMO_PASSWORD"


class Command(BaseCommand):
    help = "Load a bundled sample project into the database."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--sample",
            default=DEFAULT_SAMPLE,
            help=f"Sample key to load. Known: {sorted(SAMPLES)}. Default: {DEFAULT_SAMPLE}.",
        )
        parser.add_argument(
            "--owner",
            help="Username to own the sample program. Defaults to the first superuser.",
        )
        parser.add_argument(
            "--with-personas",
            action="store_true",
            help=(
                "Give the sample's persona accounts a usable login password so you "
                "can sign in as each one. Password: $TRUEPPM_DEMO_PASSWORD, else "
                "'demo' under DEBUG, else a random token printed once."
            ),
        )

    def handle(self, *args: Any, **options: Any) -> None:
        owner = self._resolve_owner(options.get("owner"))
        sample_key = options["sample"]
        with_personas = options["with_personas"]

        persona_password: str | None = None
        password_source: str | None = None
        if with_personas:
            persona_password, password_source = self._resolve_demo_password()

        try:
            program = load_sample(
                sample_key, owner=owner, create_users=True, persona_password=persona_password
            )
        except UnknownSampleError as exc:
            raise CommandError(str(exc)) from exc

        count = Project.objects.filter(program=program).count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Loaded sample {program.name!r} with {count} project(s) (marked is_sample)."
            )
        )
        if with_personas:
            self._report_personas(sample_key, persona_password, password_source)
        else:
            self.stdout.write(
                "  Personas created with unusable passwords (view-only). "
                "Re-run with --with-personas to enable persona logins."
            )

    def _report_personas(self, sample_key: str, password: str | None, source: str | None) -> None:
        """Print the real, sample-namespaced persona usernames + the login password.

        This is the fix's payoff (#1760): the evaluation guide told readers to
        "Sign in as Alex", but the seeded username is ``atlas-alex`` and the
        password was unusable. Echo both so the walkthrough actually works.
        """
        accounts = sample_accounts(sample_key)
        # ``TRUEPPM_DEMO_PASSWORD`` (operator opt-in) and DEBUG's "demo" are safe to
        # echo; a randomly generated production token is also printed once because
        # there is no other way to recover it — but it is never a re-derivable value.
        if source == "env":
            detail = f"password set via {DEMO_PASSWORD_ENV}"
        else:
            detail = f"password={password!r}"
        self.stdout.write(self.style.SUCCESS(f"  Persona logins enabled ({detail}):"))
        for account in accounts:
            username = account.get("username", "")
            display = account.get("display_name", "")
            self.stdout.write(f"    {username}  ({display})")

    def _resolve_demo_password(self) -> tuple[str, str]:
        """Resolve the persona login password and its source (mirrors #1350).

        A fixed weak password must never reach a public (non-DEBUG) instance.
        Resolution order: ``TRUEPPM_DEMO_PASSWORD`` env var, then ``"demo"`` under
        ``DEBUG``, else a random token printed once so the operator can record it.
        """
        env_password = os.environ.get(DEMO_PASSWORD_ENV)
        if env_password:
            return env_password, "env"
        if settings.DEBUG:
            return "demo", "debug"
        return secrets.token_urlsafe(16), "generated"

    def _resolve_owner(self, username: str | None) -> Any:
        if username:
            owner = User.objects.filter(username=username).first()
            if owner is None:
                raise CommandError(f"No user with username {username!r}.")
            return owner
        owner = User.objects.filter(is_superuser=True).order_by("pk").first()
        if owner is None:
            raise CommandError(
                "No superuser to own the sample. Pass --owner <username> or create a superuser."
            )
        return owner
