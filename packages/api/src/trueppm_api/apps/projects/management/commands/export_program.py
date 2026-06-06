"""Export a program to canonical JSON seed format (ADR-0109, issue #616).

Usage::

    python manage.py export_program <slug> [--out <path>]

``<slug>`` matches ``Program.code``. Writes to ``--out`` if given, else stdout.
The output round-trips: re-importing it reproduces the program.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program


class Command(BaseCommand):
    help = "Export a TruePPM program to a canonical JSON seed file."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("slug", help="Program slug (Program.code).")
        parser.add_argument("--out", help="Output file path. Defaults to stdout.")

    def handle(self, *args: Any, **options: Any) -> None:
        slug = options["slug"]
        program = Program.objects.filter(code=slug, is_deleted=False).first()
        if program is None:
            raise CommandError(f"No live program with slug {slug!r}.")

        body = dump_seed(export_program(program))
        out = options.get("out")
        if out:
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(body)
            self.stdout.write(self.style.SUCCESS(f"Exported program {slug!r} to {out}"))
        else:
            self.stdout.write(body)
