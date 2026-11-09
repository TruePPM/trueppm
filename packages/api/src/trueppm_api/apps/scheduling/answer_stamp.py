"""The ``_provenance`` answer stamp for a computed schedule response (ADR-0112 §2.1, ADR-1381).

ADR-0112 specifies one ``stamp_answer`` helper in an ``apps/provenance`` app; that app
does not exist yet (#2642). ADR-1381 ships this local helper with the §2.1 envelope
shape copied verbatim so #2642 can move it without a wire change. Deliberately absent
until then: the ``actor`` field and the ``signed_answer_emitted`` signal — an
Enterprise extension point needs its own threat model, not a side effect of one
endpoint.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

#: Additive-only contract version of the ``_provenance`` envelope (ADR-0112 §2.1).
STAMP_SCHEMA_VERSION = 1


def _engine_version() -> str:
    """The installed ``trueppm-scheduler`` version, or ``"unknown"``.

    Same resolution as ``agents.services.engine_version()``; not imported from there
    because ``scheduling`` sits below ``agents`` in ``app-layering.toml``.
    """
    try:
        from trueppm_scheduler import __version__

        return str(__version__)
    except Exception:
        return "unknown"


def _api_version() -> str:
    from trueppm_api import __version__

    return str(__version__)


def canonical_input_hash(engine_inputs: dict[str, Any]) -> str:
    """``sha256:<hex>`` over the canonical JSON of the engine inputs (ADR-0112 §2.2).

    Sorted keys and no insignificant whitespace, so identical inputs hash identically
    across processes. ``default=str`` covers dates/timedeltas a ``to_dict`` may leave.
    """
    canonical = json.dumps(engine_inputs, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stamp_answer(payload: dict[str, Any], *, engine_inputs: dict[str, Any]) -> dict[str, Any]:
    """Return ``payload`` with a ``_provenance`` envelope attached.

    Args:
        payload: The computed response body. Not mutated.
        engine_inputs: The exact inputs the engine received (a scheduler
            ``Project.to_dict()``), hashed into ``input_hash``.

    Returns:
        A new dict: ``payload`` plus ``_provenance`` = ``{schema_version,
        engine_version, api_version, input_hash, computed_at}``.
    """
    stamped = dict(payload)
    stamped["_provenance"] = {
        "schema_version": STAMP_SCHEMA_VERSION,
        "engine_version": _engine_version(),
        "api_version": _api_version(),
        "input_hash": canonical_input_hash(engine_inputs),
        "computed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    return stamped
