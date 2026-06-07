"""Load a bundled sample project (issue #375).

Usage::

    python manage.py load_sample_project [--sample <key>] [--owner <username>]

Imports a bundled sample seed (default: the Atlas hybrid-large launch demo) and
flags its projects as sample data. Idempotent — re-running replaces the sample.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed.samples import (
    DEFAULT_SAMPLE,
    SAMPLES,
    UnknownSampleError,
    load_sample,
)

User = get_user_model()


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

    def handle(self, *args: Any, **options: Any) -> None:
        owner = self._resolve_owner(options.get("owner"))
        try:
            program = load_sample(options["sample"], owner=owner, create_users=True)
        except UnknownSampleError as exc:
            raise CommandError(str(exc)) from exc

        count = Project.objects.filter(program=program).count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Loaded sample {program.name!r} with {count} project(s) (marked is_sample)."
            )
        )

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
