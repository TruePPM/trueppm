"""Cursor-paginated operations must declare ``cursor`` and ``page_size`` (#4611).

The cursor endpoints build their ``CursorPagination`` inline, so drf-spectacular
cannot discover the paginator's query parameters. Without a hand declaration a
client generated from the schema has no way to ask for the next page or a page
size, although the server honors both.
"""

from __future__ import annotations

from typing import Any

import pytest
from drf_spectacular.generators import SchemaGenerator

CURSOR_OPERATIONS = [
    "/api/v1/workspace/members/",
    "/api/v1/workspace/audit-events/",
    "/api/v1/projects/{project_pk}/webhooks/{id}/deliveries/",
    "/api/v1/programs/{program_pk}/webhooks/{id}/deliveries/",
]


@pytest.fixture(scope="module")
def schema_paths() -> dict[str, Any]:
    schema = SchemaGenerator().get_schema(request=None, public=True)
    paths: dict[str, Any] = schema["paths"]
    return paths


@pytest.mark.parametrize("path", CURSOR_OPERATIONS)
def test_cursor_operation_declares_cursor_and_page_size(
    schema_paths: dict[str, Any], path: str
) -> None:
    operation = schema_paths[path]["get"]
    declared = {p["name"]: p for p in operation.get("parameters", []) if p["in"] == "query"}
    assert "cursor" in declared, f"{path} does not declare the `cursor` query parameter"
    assert "page_size" in declared, f"{path} does not declare the `page_size` query parameter"
    assert declared["page_size"]["schema"]["type"] == "integer"
