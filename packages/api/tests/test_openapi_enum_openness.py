"""Enum openness and the banded role ordinal in the published schema (#4593, ADR-1291).

``stability.md`` calls a new enum value an Additive change and tells clients to
tolerate one. Until #4593 every enum in ``docs/api/openapi.json`` was published
closed, and ``RoleEnum`` was closed over the very ordinals ADR-0072 reserves for
Enterprise custom roles. These tests pin the two halves of the fix: every enum
says whether it is open, the closed ones are exactly the reviewed allowlist, and
the role fields accept an ordinal outside the five OSS tiers.

The committed artifact is read, as in ``test_openapi_contract.py``: it is the
published contract, and ``api:schema-drift`` proves it matches the code. The hook
itself is also exercised on a synthetic document, so a broken hook fails here and
not only after a regenerate.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from trueppm_api.core.openapi import (
    ENUM_EXHAUSTIVE,
    ENUM_OPEN,
    ENUM_OPENNESS_KEY,
    EXHAUSTIVE_ENUMS,
    ROLE_ORDINAL,
    postprocess_openapi,
)

ROLE_REF = f"#/components/schemas/{ROLE_ORDINAL}"


def _load_schema() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            loaded: dict[str, Any] = json.loads(candidate.read_text())
            return loaded
    raise AssertionError("Could not locate docs/api/openapi.json above the test file.")


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    return _load_schema()


def _enum_nodes(node: Any, path: str = "") -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    if isinstance(node, dict):
        if "enum" in node:
            found.append((path, node))
        for key, value in node.items():
            found.extend(_enum_nodes(value, f"{path}/{key}"))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            found.extend(_enum_nodes(item, f"{path}/{index}"))
    return found


# ---------------------------------------------------------------------------
# Every enum carries the marker
# ---------------------------------------------------------------------------


def test_every_enum_in_the_document_declares_its_openness(schema: dict[str, Any]) -> None:
    """No enum is left for a client to guess about — components, inline and params."""
    nodes = _enum_nodes(schema)
    assert len(nodes) > 100, "the walk found almost no enums — it is not reading the document"
    unmarked = [path for path, node in nodes if node.get(ENUM_OPENNESS_KEY) is None]
    invalid = [
        path
        for path, node in nodes
        if node.get(ENUM_OPENNESS_KEY) not in (None, ENUM_OPEN, ENUM_EXHAUSTIVE)
    ]
    assert not unmarked, f"enums without {ENUM_OPENNESS_KEY}: {unmarked[:10]}"
    assert not invalid, f"enums with an unknown {ENUM_OPENNESS_KEY} value: {invalid[:10]}"


def test_exhaustive_components_are_exactly_the_reviewed_allowlist(schema: dict[str, Any]) -> None:
    """Closed components == ``EXHAUSTIVE_ENUMS``, in both directions.

    A component closed without an allowlist entry is a Breaking-on-growth promise
    nobody reviewed; an allowlist entry naming no component is a stale reason that
    would silently close whatever later takes the name.
    """
    components = schema["components"]["schemas"]
    closed = {
        name
        for name, node in components.items()
        if "enum" in node and node.get(ENUM_OPENNESS_KEY) == ENUM_EXHAUSTIVE
    }
    assert closed == set(EXHAUSTIVE_ENUMS)
    for name in EXHAUSTIVE_ENUMS:
        assert "enum" in components.get(name, {}), f"allowlisted {name} is not an enum component"


def test_the_open_default_holds_for_an_ordinary_vocabulary(schema: dict[str, Any]) -> None:
    components = schema["components"]["schemas"]
    for name in ("TaskStatusEnum", "TaskBulkRefusalCodeEnum", "ScopesEnum"):
        assert components[name][ENUM_OPENNESS_KEY] == ENUM_OPEN, name


# ---------------------------------------------------------------------------
# The role ordinal is a banded integer
# ---------------------------------------------------------------------------


def test_role_is_published_as_a_banded_integer_not_a_closed_enum(schema: dict[str, Any]) -> None:
    components = schema["components"]["schemas"]
    assert "RoleEnum" not in components
    role = components[ROLE_ORDINAL]
    assert role["type"] == "integer"
    assert "enum" not in role
    assert (role["minimum"], role["maximum"]) == (1, 400)
    for band in ("2-99", "101-199", "201-299", "301-399"):
        assert band in role["description"], f"band {band} is not documented"


@pytest.mark.parametrize(
    ("component", "field"),
    [
        ("ProjectMembershipRead", "role"),
        ("ProgramMembershipRead", "role"),
        ("ProgramMembershipWriteRequest", "role"),
        ("Project", "default_member_role"),
        ("ProjectDetail", "default_member_role"),
        ("Project", "my_role"),
        ("Program", "my_role"),
        ("ProgramProjectRow", "my_role"),
        # Bare `integer` fields carrying a project Role ordinal (the hook's
        # _BARE_ROLE_FIELDS). A rename that drops one out of the rewrite fails here.
        ("ProjectMembershipWriteRequest", "role"),
        ("PatchedProjectMembershipUpdateRequest", "role"),
        ("GroupProjectLink", "role"),
        ("GroupProjectWriteRequest", "role"),
        ("Me", "max_project_role"),
    ],
)
def test_role_fields_reference_the_ordinal(
    schema: dict[str, Any], component: str, field: str
) -> None:
    prop = schema["components"]["schemas"][component]["properties"][field]
    assert {"$ref": ROLE_REF} in prop.get("allOf", []), f"{component}.{field}: {prop}"


@pytest.mark.parametrize(
    ("ordinal", "valid"),
    [
        (1, True),
        (400, True),
        # An Enterprise custom role in the scheduler band (ADR-0072's own example).
        (250, True),
        (50, True),
        (0, False),
        (401, False),
    ],
)
def test_a_role_consumer_accepts_an_enterprise_band_ordinal(
    schema: dict[str, Any], ordinal: int, valid: bool
) -> None:
    """The issue's acceptance line: a ``role`` consumer validates an out-of-list ordinal.

    Against the pre-#4593 schema ``250`` and ``50`` fail ``enum`` — that is the
    negative control.
    """
    prop = schema["components"]["schemas"]["ProjectMembershipRead"]["properties"]["role"]
    validator = jsonschema.Draft202012Validator({**prop, "components": schema["components"]})
    assert validator.is_valid(ordinal) is valid


# ---------------------------------------------------------------------------
# The hook itself, on a synthetic document
# ---------------------------------------------------------------------------


def _synthetic() -> dict[str, Any]:
    return {
        "paths": {
            "/api/v1/x/": {
                "get": {
                    "parameters": [{"name": "kind", "schema": {"type": "string", "enum": ["a"]}}],
                    "responses": {
                        "400": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "sent": {"type": "boolean", "enum": [False]}
                                        },
                                    }
                                }
                            }
                        }
                    },
                }
            }
        },
        "components": {
            "schemas": {
                "Thing": {
                    "type": "object",
                    "properties": {
                        "role": {"allOf": [{"$ref": "#/components/schemas/RoleEnum"}]},
                        "my_role": {"type": "integer", "nullable": True, "readOnly": True},
                    },
                },
                "RoleEnum": {"type": "integer", "enum": [1, 100, 200, 300, 400]},
                "ColorEnum": {"type": "string", "enum": ["red"]},
                "NullEnum": {"enum": [None]},
            }
        },
    }


def test_the_hook_marks_and_rewrites_a_synthetic_document() -> None:
    doc = postprocess_openapi(_synthetic(), generator=None, request=None, public=True)
    components = doc["components"]["schemas"]

    assert components["ColorEnum"][ENUM_OPENNESS_KEY] == ENUM_OPEN
    assert components["NullEnum"][ENUM_OPENNESS_KEY] == ENUM_EXHAUSTIVE
    op = doc["paths"]["/api/v1/x/"]["get"]
    assert op["parameters"][0]["schema"][ENUM_OPENNESS_KEY] == ENUM_OPEN
    sent = op["responses"]["400"]["content"]["application/json"]["schema"]["properties"]["sent"]
    assert sent[ENUM_OPENNESS_KEY] == ENUM_EXHAUSTIVE

    assert "RoleEnum" not in components
    assert ENUM_OPENNESS_KEY not in components[ROLE_ORDINAL]
    thing = components["Thing"]["properties"]
    assert thing["role"] == {"allOf": [{"$ref": ROLE_REF}]}
    assert thing["my_role"] == {"allOf": [{"$ref": ROLE_REF}], "nullable": True, "readOnly": True}
    assert list(components) == sorted(components), "components must stay alphabetical"
