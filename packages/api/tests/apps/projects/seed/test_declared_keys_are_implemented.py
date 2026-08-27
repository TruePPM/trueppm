"""Every key the seed schema declares is read by something (#3093).

``seed_v*.json`` sets ``additionalProperties: false`` everywhere, so it is a real
contract: an *unknown* key is already a validation error. What nothing caught was
the reverse — a key the schema **declares**, with an enum and a description, that
the importer never reads. Four shipped that way:

* ``task.dor`` — aurora authored 23 ``ready`` + 2 ``refine``; all landed on the
  model default because ``task.ac_met`` was the only writer.
* ``project.board_columns`` — a bare label array that could not express
  ``BoardColumnConfig.columns`` (keyed on canonical status) even if read.
* ``project.agile_features`` — the model field was dropped in migration 0123.
* ``baseline.captured_at`` — authored by all four packs; ``created_at`` is
  ``auto_now_add``, so every declared baseline recorded import day.

A fixture author validating against the schema got a green light for all four.
This test is the gate that keeps the contract honest in the direction the
validator cannot see.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

_APP = Path(__file__).resolve().parents[4] / "src" / "trueppm_api" / "apps" / "projects"
_SCHEMAS = _APP / "schemas"
_READERS = (
    _APP / "seed" / "importer.py",
    _APP / "seed" / "replay.py",
    _APP / "seed" / "forecast_backfill.py",
)

# Keys a literal grep cannot see. Every entry carries the reason it is not a
# defect — an unexplained exemption would let this gate be silenced by adding a
# line, which is the failure mode it exists to prevent.
_EXEMPT = {
    # Consumed by the loader itself, not looked up by name in a reader.
    "schema_version": "routes to a schema file; read in validation.py",
    "anchor": "resolved by reldates.resolve_anchor",
    # Built dynamically: forecast_backfill._mc_series(spec, pct) reads
    # f"{pct}_start" / f"{pct}_end", so no literal appears for the band keys.
    "p50_end": "read via _mc_series(spec, 'p50')",
    "p80_start": "read via _mc_series(spec, 'p80')",
    "p80_end": "read via _mc_series(spec, 'p80')",
    "p95_start": "read via _mc_series(spec, 'p95')",
    "p95_end": "read via _mc_series(spec, 'p95')",
    # Output-only. The exporter writes event.from so a reconstructed timeline
    # reads as "REVIEW -> IN_PROGRESS" rather than a bare destination; replay
    # needs only `to`, and re-importing an export must not depend on it.
    "from": "exporter-only, for timeline readability; replay reads only `to`",
    # Deliberately accepted-and-ignored rather than removed: dropping a key under
    # additionalProperties:false breaks any hand-authored document carrying it,
    # and the docs tell authors to start from a bundled fixture. Marked
    # `deprecated: true` in both schemas; no bundled pack authors it.
    "agile_features": (
        "accepted and ignored; derived from the project's sprints since migration 0123"
    ),
}


def _declared_keys(path: Path) -> set[str]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    defs = doc.get("$defs") or doc.get("definitions") or {}
    keys: set[str] = set(doc.get("properties", {}))
    for node in defs.values():
        keys |= set(node.get("properties", {}))
    return keys


@pytest.fixture(scope="module")
def reader_source() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in _READERS if p.exists())


@pytest.mark.parametrize("schema", sorted(p.name for p in _SCHEMAS.glob("seed_v*.json")))
def test_every_declared_key_is_read_by_the_importer(schema: str, reader_source: str) -> None:
    unread = sorted(
        key
        for key in _declared_keys(_SCHEMAS / schema) - set(_EXEMPT)
        if not re.search(rf"""["']{re.escape(key)}["']""", reader_source)
    )
    assert not unread, (
        f"{schema} declares {unread} but no seed reader mentions them. A declared key "
        "nobody implemented is worse than an undeclared one: the schema tells a fixture "
        "author it works. Implement it, or remove it from the schema."
    )
