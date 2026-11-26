"""Export forecast-vs-actual calibration records as JSON Lines (ADR-1511, #4747).

An operator command, deliberately not an HTTP endpoint: the export crosses every
opted-in project, so it is an exfiltration surface, and running it needs shell
access to the API pod — above any role an API token or agent can hold (ADR-1511
§Export). Only projects with ``forecast_calibration_capture`` on are emitted.

The first line is a header (``"record": "header"``, schema name and version);
every following line is one forecast record with its actual finish joined.

Usage::

    python manage.py export_forecast_calibration                  # stdout
    python manage.py export_forecast_calibration --output cal.jsonl
    python manage.py export_forecast_calibration --project <uuid> --project <uuid>
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.forecast_calibration import export_records


class Command(BaseCommand):
    help = "Export opted-in projects' forecast-vs-actual calibration records (ADR-1511)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--project",
            action="append",
            default=[],
            help="Limit the export to this project id (repeatable). Default: every opted-in one.",
        )
        parser.add_argument(
            "--output",
            default="",
            help="Write to this file instead of stdout.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        project_ids: list[str] = options["project"]
        for raw in project_ids:
            try:
                uuid.UUID(raw)
            except ValueError as exc:
                raise CommandError(f"--project {raw!r} is not a UUID") from exc

        output: str = options["output"]
        count = 0
        if output:
            with open(output, "w", encoding="utf-8") as fh:
                for record in export_records(project_ids or None):
                    fh.write(json.dumps(record) + "\n")
                    count += 1
            self.stderr.write(f"Wrote {count - 1} record(s) to {output}")
        else:
            for record in export_records(project_ids or None):
                self.stdout.write(json.dumps(record))
