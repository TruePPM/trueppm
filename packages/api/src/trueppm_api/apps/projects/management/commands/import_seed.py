"""Import a canonical JSON seed file (ADR-0109, issue #615).

Usage::

    python manage.py import_seed <path> [--owner <username>] [--create-users]

Loads a seed document into the database via ``import_seed``. Re-running with the
same file rebuilds the program subtree idempotently on the program slug; note
that imported resources are created fresh each run (not deduplicated by email),
so re-import can accumulate global resource rows — the deliberate cost of never
rebinding a pre-existing resource into the importer's program (#1004).
``--create-users`` mints any accounts the seed references that do not yet exist
(intended for ``make seed`` and local demos, not production).
"""

from __future__ import annotations

import json
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed import SeedValidationError, import_seed

User = get_user_model()


class Command(BaseCommand):
    help = "Import a TruePPM JSON seed file into the database."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("path", help="Path to the JSON seed file.")
        parser.add_argument(
            "--owner",
            help="Username to own the imported program. Defaults to the first superuser.",
        )
        parser.add_argument(
            "--create-users",
            action="store_true",
            help="Create accounts referenced by the seed if they do not exist.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        path = options["path"]
        try:
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except FileNotFoundError as exc:
            raise CommandError(f"Seed file not found: {path}") from exc
        except json.JSONDecodeError as exc:
            raise CommandError(f"Seed file is not valid JSON: {exc}") from exc

        owner = self._resolve_owner(options.get("owner"))

        try:
            program = import_seed(payload, owner=owner, create_users=options["create_users"])
        except SeedValidationError as exc:
            # Surface every validation error, one per line, then fail.
            raise CommandError(str(exc)) from exc

        project_count = Project.objects.filter(program=program).count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Imported program {program.name!r} (slug {program.code!r}) "
                f"with {project_count} project(s)."
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
                "No superuser to own the program. Pass --owner <username> or create a superuser."
            )
        return owner
