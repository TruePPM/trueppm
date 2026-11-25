"""Generate the JSON Schema (draft 2020-12) for the project document (#4164).

The schema is derived by introspecting the dataclasses in
``trueppm_scheduler.models`` rather than hand-written, so a field added to
``Task``/``Calendar``/``Project`` reaches the schema through a regenerate, and a
model change without one fails the drift gate
(``tests/test_project_schema.py``, CI check ``scheduler:project-schema``).

Usage::

    python scripts/generate_project_schema.py           # rewrite the checked-in file
    python scripts/generate_project_schema.py --check   # exit 1 if it is stale

The output lives inside the package (``src/trueppm_scheduler/project.schema.json``)
so it ships in the wheel and the sdist.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import enum
import json
import sys
import types
import typing
from pathlib import Path
from typing import Any

from trueppm_scheduler import models

SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent / "src" / "trueppm_scheduler" / "project.schema.json"
)

# Four-digit year other than 0000 (the engine refuses year zero), zero-padded month and day.
_DATE_PATTERN = r"^(?!0000-)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"

_DESCRIPTION = (
    "The TruePPM scheduler project document: the JSON accepted by "
    "trueppm_scheduler.Project.from_json and produced by Project.to_json. This schema "
    "checks SHAPE only: property names, JSON types, enum values, required keys and "
    "numeric ranges. It cannot express the semantic rules the engine enforces "
    "(dependency cycles, duplicate task ids, edges naming an unknown task, calendar "
    "consistency, span and duration caps, date ordering), so a document that "
    "validates here can still be refused by the engine. A pass is not a promise "
    "that the engine will accept the document. Durations, float and lag are numbers "
    "of seconds; dates are strict ISO-8601 YYYY-MM-DD strings."
)

# Constraints the type hints cannot carry. Keyed by (class name, field name).
_OVERRIDES: dict[tuple[str, str], dict[str, Any]] = {
    ("Task", "percent_complete"): {"minimum": 0, "maximum": 100},
    ("Calendar", "working_days"): {"minimum": 0, "maximum": 127},
    ("Project", "sprint_length_days"): {"minimum": 1},
}

# Classes whose unknown keys the engine refuses (Task.from_dict passes the mapping to
# the constructor), as opposed to ones it ignores. Verified by the fixture gate.
_CLOSED = {"Task"}


def _date_schema() -> dict[str, Any]:
    return {"type": "string", "pattern": _DATE_PATTERN}


def _type_schema(hint: Any) -> dict[str, Any]:
    """Map one resolved type hint to its JSON Schema fragment."""
    origin = typing.get_origin(hint)
    args = typing.get_args(hint)
    if origin in (typing.Union, types.UnionType):
        non_null = [a for a in args if a is not type(None)]
        parts = [_type_schema(a) for a in non_null]
        if len(non_null) != len(args):
            parts.append({"type": "null"})
        return parts[0] if len(parts) == 1 else {"anyOf": parts}
    if origin in (list, typing.Sequence) or (
        origin is not None and getattr(origin, "__name__", "") == "Sequence"
    ):
        return {"type": "array", "items": _type_schema(args[0])}
    if origin is dict:
        return {"type": "object", "additionalProperties": _type_schema(args[1])}
    if hint is bool:
        return {"type": "boolean"}
    if hint is int:
        return {"type": "integer"}
    if hint is float:
        return {"type": "number"}
    if hint is str:
        return {"type": "string"}
    if hint is datetime.date:
        return _date_schema()
    if hint is datetime.timedelta:
        return {"type": "number", "description": "Seconds."}
    if isinstance(hint, type) and issubclass(hint, enum.Enum):
        return {"enum": [m.value for m in hint]}
    if dataclasses.is_dataclass(hint):
        return {"$ref": f"#/$defs/{hint.__name__}"}
    msg = f"no JSON Schema mapping for type hint {hint!r}"
    raise TypeError(msg)


def _class_schema(cls: type) -> dict[str, Any]:
    hints = typing.get_type_hints(cls)
    properties: dict[str, Any] = {}
    required: list[str] = []
    for f in dataclasses.fields(cls):
        if f.name.startswith("_") or not f.init:
            continue
        prop = _type_schema(hints[f.name])
        prop.update(_OVERRIDES.get((cls.__name__, f.name), {}))
        properties[f.name] = prop
        if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING:
            required.append(f.name)
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    if cls.__name__ in _CLOSED:
        schema["additionalProperties"] = False
    return schema


def build_schema() -> dict[str, Any]:
    """Return the project-document schema as a dict (deterministic key order)."""
    defs = {
        cls.__name__: _class_schema(cls)
        for cls in (models.DateRange, models.Task, models.Dependency, models.Calendar)
    }
    project = _class_schema(models.Project)
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "TruePPM scheduler project document",
        "description": _DESCRIPTION,
        **project,
        "$defs": defs,
    }


def render() -> str:
    """Return the schema as the exact text stored in the repository."""
    return json.dumps(build_schema(), indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    """Rewrite the checked-in schema, or with ``--check`` verify it is current."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the file is stale")
    args = parser.parse_args(argv)
    text = render()
    if args.check:
        current = SCHEMA_PATH.read_text() if SCHEMA_PATH.is_file() else ""
        if current != text:
            print(
                f"{SCHEMA_PATH} is stale: run "
                "`python packages/scheduler/scripts/generate_project_schema.py` and commit it.",
                file=sys.stderr,
            )
            return 1
        print("project.schema.json is current")
        return 0
    SCHEMA_PATH.write_text(text)
    print(f"wrote {SCHEMA_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
