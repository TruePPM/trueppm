"""Import a canonical JSON seed file (ADR-0109, issue #615).

Usage::

    python manage.py import_seed <path> [--owner <username>] [--create-users]
    python manage.py import_seed <path> --check

Loads a seed document into the database via ``import_seed``. Re-running with the
same file rebuilds the program subtree idempotently on the program slug; note
that imported resources are created fresh each run (not deduplicated by email),
so re-import can accumulate global resource rows — the deliberate cost of never
rebinding a pre-existing resource into the importer's program (#1004).
``--create-users`` mints any accounts the seed references that do not yet exist
(intended for ``make seed`` and local demos, not production).

``--check`` is the dry run (#2418): validate the file, print every diagnostic,
exit 0/1, and touch neither the database nor the program slug the document
names. Because the import is wipe-then-recreate on that slug (ADR-0109), this
is how an operator answers *"will this be accepted?"* before pointing a
destructive operation at a live program.
"""

from __future__ import annotations

import json
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed import SeedValidationError, import_seed, inspect_seed
from trueppm_api.apps.projects.seed.importer import SeedReplaceAmbiguous, SeedReplaceRequired

User = get_user_model()


class Command(BaseCommand):
    help = "Import a TruePPM JSON seed file into the database, or --check it without importing."

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
        parser.add_argument(
            "--no-replace",
            action="store_true",
            help=(
                "Refuse to import when a live program you own already holds this "
                "seed's slug, instead of replacing it. The REST endpoint defaults "
                "to refusing; this command defaults to replacing, because re-running "
                "`make seed` in place is its whole job and an operator at a shell "
                "has --check available to look first (ADR-0726)."
            ),
        )
        parser.add_argument(
            "--check",
            action="store_true",
            help=(
                "Validate the file and report every problem without importing it. "
                "Exits 1 if the document is invalid. Writes nothing."
            ),
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

        if options["check"]:
            self._check(path, payload)
            return

        # Owner resolution is deliberately *after* the --check branch: a dry run
        # must work on an instance with no superuser (a self-hoster validating a
        # file before the first real import), and resolving an owner it would
        # never use would fail that case for no reason.
        owner = self._resolve_owner(options.get("owner"))

        try:
            program = import_seed(
                payload,
                owner=owner,
                create_users=options["create_users"],
                replace=not options["no_replace"],
            )
        except SeedValidationError as exc:
            # Surface every validation error, one per line, then fail.
            raise CommandError(str(exc)) from exc
        except SeedReplaceRequired as exc:
            raise CommandError(
                f"{exc} Re-run without --no-replace to replace it (its projects move "
                "to Trash), or edit the seed's program.slug."
            ) from exc
        except SeedReplaceAmbiguous as exc:
            # Reachable because Program.code is non-unique: an owner can hold two
            # live programs under one slug. Without this the operator gets a raw
            # traceback for what is an ordinary, actionable refusal.
            raise CommandError(
                f"{exc} Delete or re-code one of them, or import as a different user."
            ) from exc

        project_count = Project.objects.filter(program=program).count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Imported program {program.name!r} (slug {program.code!r}) "
                f"with {project_count} project(s)."
            )
        )

    def _check(self, path: str, payload: Any) -> None:
        """Report validation diagnostics for ``payload`` and exit 0/1.

        Leads with what the file *claims* to be, because the first thing a dry
        run has to answer is "did I grab the right file?" — the program slug in
        particular, since that is what the real import would wipe and rebuild.
        """
        report = inspect_seed(payload)

        self.stdout.write(f"Checked {path}")
        self.stdout.write(f"  schema_version: {report.schema_version or '(missing)'}")
        self.stdout.write(f"  program:        {report.program_name or '(unnamed)'}")
        self.stdout.write(f"  slug:           {report.program_slug or '(missing)'}")
        self.stdout.write(
            f"  contents:       {report.project_count} project(s), "
            f"{report.task_count} task(s), {report.resource_count} resource(s)"
        )

        if report.valid:
            self.stdout.write(self.style.SUCCESS("Valid. No problems found."))
            return

        count = len(report.errors)
        noun = "problem" if count == 1 else "problems"
        self.stdout.write("")
        for error in report.errors:
            self.stdout.write(self.style.ERROR(f"  {error}"))
        # CommandError is how a management command exits non-zero without a
        # traceback; --check's contract is an exit code a CI job can gate on.
        raise CommandError(f"Invalid seed document: {count} {noun} found.")

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
