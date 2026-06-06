"""DB tests for the seed exporter and the round-trip guarantee (issue #616)."""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.seed import export_program, import_seed, validate_seed
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
