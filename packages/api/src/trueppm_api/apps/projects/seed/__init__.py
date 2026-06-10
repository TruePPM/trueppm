"""Canonical JSON seed data: validation, import, and export.

The seed format and its design rationale are specified in ADR-0109. This
subpackage owns the three consumers of that format:

- ``validation`` (#614) — ``validate_seed`` and the bundled JSON Schema.
- ``importer`` (#615) — load a seed document into a workspace.
- ``exporter`` (#616) — serialize a live program back to the seed format.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from trueppm_api.apps.projects.seed.validation import (
    SUPPORTED_MAJORS,
    SeedValidationError,
    validate_seed,
)

if TYPE_CHECKING:
    # Give type checkers the real callable signatures while runtime keeps the
    # lazy ``__getattr__`` loading below (so importing ``validate_seed`` stays
    # Django-free).
    from trueppm_api.apps.projects.seed.exporter import export_program as export_program
    from trueppm_api.apps.projects.seed.importer import import_seed as import_seed


def __getattr__(name: str) -> object:
    # Lazily expose the importer/exporter so importing ``validate_seed`` does
    # not pull in the Django ORM (validation is a pure function — ADR-0109).
    if name == "import_seed":
        from trueppm_api.apps.projects.seed.importer import import_seed

        return import_seed
    if name == "export_program":
        from trueppm_api.apps.projects.seed.exporter import export_program

        return export_program
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "SUPPORTED_MAJORS",
    "SeedValidationError",
    "export_program",
    "import_seed",
    "validate_seed",
]
