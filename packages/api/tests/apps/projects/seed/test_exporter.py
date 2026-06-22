"""DB tests for the seed exporter and the round-trip guarantee (issue #616)."""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.seed import (
    export_program,
    export_project,
    import_seed,
    validate_seed,
)
from trueppm_api.apps.projects.seed.exporter import dump_seed

from .test_importer import _seed  # reuse the two-project fixture

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="exporter-owner", email="o@example.com")


def test_export_validates_against_schema(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)
    # The exporter's output must itself be a valid seed document.
    validate_seed(exported)
    assert exported["schema_version"] == "1.0"
    assert exported["program"]["slug"] == "atlas"


def test_export_strips_derived_fields(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)
    task = exported["projects"][0]["tasks"][0]
    for derived in ("server_version", "short_id", "early_start", "early_finish", "is_critical"):
        assert derived not in task


def test_round_trip_is_stable(owner: Any) -> None:
    # #616 guarantee: export -> re-import -> re-export is byte-identical.
    program1 = import_seed(_seed(), owner=owner, create_users=True)
    export1 = export_program(program1)

    program2 = import_seed(export1, owner=owner, create_users=True)
    export2 = export_program(program2)

    assert dump_seed(export1) == dump_seed(export2)


def test_round_trip_preserves_key_facts(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)

    projects = {p["slug"]: p for p in exported["projects"]}
    assert set(projects) >= {"platform-core", "migration-tooling"}

    # cross-project dependency survives as a qualified ref
    mt = projects["migration-tooling"]
    dep = mt["dependencies"][0]
    assert dep["predecessor"].startswith("platform-core:")
    assert dep["dep_type"] == "FS" and dep["lag"] == 2

    # three-point estimate preserved
    etl = next(t for t in mt["tasks"] if t["name"] == "ETL")
    assert etl["estimate"] == {"optimistic": 3, "most_likely": 5, "pessimistic": 12}


# --- single-project export (#967) ------------------------------------------


def test_export_project_wraps_single_project(owner: Any) -> None:
    # A project export wraps exactly one project in a synthesized program block
    # derived from the project itself (ADR-0109 #967 addendum) — not the parent.
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    doc = export_project(project)

    validate_seed(doc)  # the project export must itself be a valid seed document
    assert doc["schema_version"] == "1.0"
    assert len(doc["projects"]) == 1
    assert doc["projects"][0]["name"] == "Platform Core"
    # synthesized wrapper: program name is the project's, not the parent's ("Atlas...")
    assert doc["program"]["name"] == "Platform Core"
    # tasks come along
    assert any(t["name"] == "Build auth" for t in doc["projects"][0]["tasks"])


def test_export_project_drops_cross_project_dependencies(owner: Any) -> None:
    # A single-project export cannot reference the sibling project, so a
    # cross-project dependency (predecessor in another project) is omitted —
    # keeping the doc self-contained and re-importable.
    program = import_seed(_seed(), owner=owner, create_users=True)
    migration = program.projects.get(name="Migration Tooling")
    doc = export_project(migration)

    validate_seed(doc)
    for dep in doc["projects"][0].get("dependencies", []):
        # No qualified "<other-project>:..." predecessor refs survive.
        assert ":" not in dep["predecessor"]


def test_export_project_round_trip_is_stable(owner: Any) -> None:
    # #616 guarantee at project grain: export -> re-import -> re-export is
    # byte-identical (re-export via the same project-export path).
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")

    doc1 = export_project(project)
    program2 = import_seed(doc1, owner=owner, create_users=True)
    project2 = program2.projects.get()
    doc2 = export_project(project2)

    assert dump_seed(doc1) == dump_seed(doc2)


def test_export_project_standalone_has_no_program(owner: Any) -> None:
    # A standalone project (Project.program is NULL, ADR-0070) still exports a
    # valid, round-trippable doc via the synthesized single-project wrapper.
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    project.program = None
    project.save(update_fields=["program"])

    doc = export_project(project)
    validate_seed(doc)
    assert doc["program"]["name"] == "Platform Core"
    assert len(doc["projects"]) == 1
