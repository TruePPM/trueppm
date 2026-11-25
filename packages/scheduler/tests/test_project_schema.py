"""The published project-document JSON Schema stays in step with the models (#4164).

Two gates:

* **Drift** — ``src/trueppm_scheduler/project.schema.json`` must equal what
  ``scripts/generate_project_schema.py`` derives from ``trueppm_scheduler.models``,
  so a model change without a regenerate fails.
* **Corpus** — every valid conformance fixture validates; every rejected fixture is
  classified as either rejected for *shape* (the schema must reject it too) or
  *semantic-only* (the schema cannot express the rule, and must accept it). An
  unclassified new fixture fails, forcing the decision.

The schema describes shape only; passing it never means the engine accepts a document.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

# In CI a missing jsonschema must fail the job, not skip the whole gate silently.
if os.environ.get("CI"):
    import jsonschema
else:
    jsonschema = pytest.importorskip("jsonschema")

_PKG = Path(__file__).resolve().parent.parent
_GENERATOR = _PKG / "scripts" / "generate_project_schema.py"
_SCHEMA = _PKG / "src" / "trueppm_scheduler" / "project.schema.json"
_FIXTURES = _PKG.parent / "wasm-scheduler" / "fixtures"

_spec = importlib.util.spec_from_file_location("generate_project_schema", _GENERATOR)
assert _spec is not None and _spec.loader is not None
_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gen)

# Rejected by the engine for a reason a JSON Schema cannot state (graph structure,
# cross-field ordering, magnitude caps, referential integrity), or by a numeric-kind
# distinction JSON itself erases (10.0 vs 10). The schema must ACCEPT these.
_SEMANTIC_ONLY = {
    "invalid": {
        "actual_finish_over_span",
        "actual_start_after_finish",
        "blanket_exceptions",
        "cycle",
        "cycle_over_span_serial_sum",
        "duplicate_edge",
        "duplicate_task_id",
        "duration_over_max",
        "far_future_start",
        "fractional_duration",
        "fractional_lag",
        "inverted_exception_range",
        "isolated_working_day_then_blanket",
        "lag_over_max",
        "negative_duration",
        "pert_ordering_inconsistent",
        "planned_start_over_span",
        "project_span_over_max",
        "project_work_over_max",
        "sf_below_min_date",
        "status_date_over_span",
        "unknown_dependency_task",
        "unknown_task_calendar_id",
        "zero_working_days",
    },
    "parse_rejects": {
        "project_sprint_length_days_float_integral",
        "task_duration_out_of_range",
    },
    "cycle_errors": {
        "long_escaped_ring",
        "scc_shortest_through_start",
        "two_cycles_smallest_wins",
    },
}


def _in_monorepo() -> bool:
    return (
        os.environ.get("TRUEPPM_MONOREPO") == "1"
        or (_PKG.parent.parent / ".gitlab-ci.yml").is_file()
    )


def _fixtures(sub: str) -> list[Path]:
    root = _FIXTURES / sub if sub else _FIXTURES
    return sorted(p for p in root.glob("*.json") if p.name != "PROVENANCE.json")


@pytest.fixture(scope="module")
def validator() -> jsonschema.Draft202012Validator:
    schema = json.loads(_SCHEMA.read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema)


def test_schema_is_current() -> None:
    assert _SCHEMA.read_text() == _gen.render(), (
        "project.schema.json is stale: run `python packages/scheduler/scripts/"
        "generate_project_schema.py` and commit the result."
    )


def test_schema_ships_in_package_and_states_its_limits() -> None:
    schema = json.loads(_SCHEMA.read_text())
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert "SHAPE only" in schema["description"]
    assert set(schema["$defs"]) == {"DateRange", "Task", "Dependency", "Calendar"}


needs_fixtures = pytest.mark.skipif(
    not _FIXTURES.is_dir() and not _in_monorepo(),
    reason="conformance fixtures live in the monorepo, not the sdist",
)


@needs_fixtures
def test_fixture_tree_present() -> None:
    assert _FIXTURES.is_dir(), f"conformance fixtures not found at {_FIXTURES}"
    assert _fixtures("")


@needs_fixtures
@pytest.mark.parametrize("path", _fixtures(""), ids=lambda p: p.stem)
def test_valid_fixture_validates(validator: jsonschema.Draft202012Validator, path: Path) -> None:
    errors = list(validator.iter_errors(json.loads(path.read_text())))
    assert not errors, errors[0].message


@needs_fixtures
@pytest.mark.parametrize(
    ("sub", "path"),
    [(s, p) for s in _SEMANTIC_ONLY for p in _fixtures(s)],
    ids=lambda v: v.stem if isinstance(v, Path) else v,
)
def test_rejected_fixture_is_classified(
    validator: jsonschema.Draft202012Validator, sub: str, path: Path
) -> None:
    valid = not list(validator.iter_errors(json.loads(path.read_text())))
    if path.stem in _SEMANTIC_ONLY[sub]:
        assert valid, (
            f"{sub}/{path.name} is listed semantic-only but the schema rejects it; delist it"
        )
    else:
        assert not valid, (
            f"{sub}/{path.name} is rejected by the engines but accepted by the schema: either "
            "tighten the schema or add it to _SEMANTIC_ONLY with the reason it is not a shape rule"
        )


@needs_fixtures
def test_semantic_only_entries_exist() -> None:
    for sub, names in _SEMANTIC_ONLY.items():
        assert names <= {p.stem for p in _fixtures(sub)}, f"stale _SEMANTIC_ONLY entry in {sub}"
