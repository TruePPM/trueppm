"""Contract guards for the committed OpenAPI schema (issue #1329).

`docs/api/openapi.json` ships at 0.3 as the integrator contract. The CI
``api:schema-drift`` job proves the committed schema matches what the code
generates, but that alone does not stop someone from *removing* an
``@extend_schema`` annotation and regenerating — both the code and the committed
file would change together and drift would still pass. These tests read the
committed artifact and assert the schema-accuracy fixes from #1329 are present,
so a silent regression fails loudly instead.

They intentionally read the file rather than regenerate it: the committed JSON is
the published contract, and asserting structure (paths / methods / parameter
names) keeps the test robust across drf-spectacular versions.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _load_schema() -> dict:
    """Locate and parse the committed `docs/api/openapi.json` from the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise AssertionError("Could not locate docs/api/openapi.json above the test file.")


@pytest.fixture(scope="module")
def schema() -> dict:
    return _load_schema()


def test_schema_declares_servers(schema: dict) -> None:
    """A non-empty `servers` array — without it codegen emits base-URL-less clients."""
    servers = schema.get("servers")
    assert servers, "openapi.json must declare a top-level `servers` array (#1329)."
    assert any(s.get("url") for s in servers)


def test_task_sync_declares_201_and_request_body(schema: dict) -> None:
    """task-sync returns 201 on create and accepts the inbound payload (#1329)."""
    op = schema["paths"]["/api/v1/projects/{id}/task-sync/"]["post"]
    assert "201" in op["responses"], "task-sync must document the 201 (create) response."
    assert "200" in op["responses"], "task-sync must keep the 200 (idempotent update) response."
    assert "requestBody" in op, "task-sync must declare its requestBody (InboundTaskSyncPayload)."


def test_sync_pull_declares_since_param(schema: dict) -> None:
    """The offline-sync delta `?since=` param must be discoverable (#1329)."""
    op = schema["paths"]["/api/v1/projects/{id}/sync/"]["get"]
    query_params = {p["name"] for p in op.get("parameters", []) if p.get("in") == "query"}
    assert "since" in query_params, "sync pull must declare the `since` query parameter."


def test_resource_contention_declares_filter_params(schema: dict) -> None:
    """resource-contention must declare its window + filter params (#1329)."""
    op = schema["paths"]["/api/v1/programs/{id}/resource-contention/"]["get"]
    query_params = {p["name"] for p in op.get("parameters", []) if p.get("in") == "query"}
    assert {"start", "end", "resource", "status"} <= query_params
