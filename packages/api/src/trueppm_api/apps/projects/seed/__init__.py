"""Canonical JSON seed data: validation, import, and export.

The seed format and its design rationale are specified in ADR-0109. This
subpackage owns the three consumers of that format:

- ``validation`` (#614) — ``validate_seed`` and the bundled JSON Schema.
- ``importer`` (#615) — load a seed document into a workspace.
- ``exporter`` (#616) — serialize a live program back to the seed format.
"""

from __future__ import annotations

from trueppm_api.apps.projects.seed.validation import (
    SUPPORTED_SCHEMA_VERSION,
    SeedValidationError,
    validate_seed,
)

__all__ = [
    "SUPPORTED_SCHEMA_VERSION",
    "SeedValidationError",
    "validate_seed",
]
