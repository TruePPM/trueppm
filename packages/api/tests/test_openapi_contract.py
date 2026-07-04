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


def _param_format(op: dict, name: str) -> str | None:
    for p in op.get("parameters", []):
        if p.get("name") == name and p.get("in") == "query":
            return p.get("schema", {}).get("format")
    raise AssertionError(f"query param {name!r} not declared")


def test_since_until_use_date_format_consistently(schema: dict) -> None:
    """The new 0.3 computed analytics windows expose since/until as `date` (#1378).

    burn and forecast-snapshots are the project-grained computed reads that take a
    since/until window. Before the contract freezes they must agree on one type;
    we standardize on `date` (day-grained), so external codegen and MCP see one
    contract, not two. A regression to `date-time` on either path fails here."""
    burn = schema["paths"]["/api/v1/projects/{id}/burn/"]["get"]
    forecast = schema["paths"]["/api/v1/projects/{id}/forecast-snapshots/"]["get"]
    for op, label in ((burn, "burn"), (forecast, "forecast-snapshots")):
        for name in ("since", "until"):
            fmt = _param_format(op, name)
            assert fmt == "date", f"{label} {name} must be `date`, got {fmt!r} (#1378)."


def test_msproject_export_declares_xml_content(schema: dict) -> None:
    """The MS Project export 200 must declare its `application/xml` media type (#1381).

    Without it the response `content` is empty and codegen/MCP has no media type to
    bind the binary download to."""
    op = schema["paths"]["/api/v1/projects/{project_pk}/export/msproject.xml"]["get"]
    content = op["responses"]["200"].get("content", {})
    assert "application/xml" in content, (
        "msproject export must declare an application/xml 200 response body (#1381)."
    )


# ---------------------------------------------------------------------------
# SDK-quality guards (#1333)
#
# Operation summaries, meaningful tags, a global security scheme and 429
# documentation are the facets a generated SDK keys off. They are filled
# mechanically by the schema post-processing hook + custom AutoSchema
# (trueppm_api.core.openapi), so these tests are ratchets: if the hook is
# unwired or a facet regresses, coverage drops below threshold and CI fails.
# ---------------------------------------------------------------------------

_HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def _operations(schema: dict) -> list[tuple[str, str, dict]]:
    return [
        (path, method, op)
        for path, methods in schema["paths"].items()
        for method, op in methods.items()
        if method in _HTTP_METHODS
    ]


def test_summary_coverage_above_threshold(schema: dict) -> None:
    """At least 95% of operations must carry a human `summary` (#1333).

    Without a summary, SDK generators fall back to the raw operationId
    (`v1_calendars_exceptions_create`) as the method doc, which is unusable. The
    post-processing hook derives a summary for every operation, so coverage should
    be ~100%; the 95% floor leaves headroom without letting a whole app regress to
    bare operationIds.
    """
    ops = _operations(schema)
    assert ops, "schema must expose operations"
    with_summary = [op for _p, _m, op in ops if op.get("summary")]
    coverage = len(with_summary) / len(ops)
    assert coverage >= 0.95, (
        f"operation summary coverage {coverage:.1%} is below the 95% floor "
        f"({len(ops) - len(with_summary)} of {len(ops)} operations lack a summary). "
        "The post-processing hook (trueppm_api.core.openapi.postprocess_openapi) "
        "should derive one for every operation (#1333)."
    )


def test_no_operation_keeps_the_default_v1_tag(schema: dict) -> None:
    """No operation may keep the meaningless default `v1` tag (#1333).

    drf-spectacular tags every /api/v1/ path `v1` by default, collapsing a
    generated client into one API class. The hook must reassign each to a resource
    tag.
    """
    v1_tagged = [
        f"{method.upper()} {path}"
        for path, method, op in _operations(schema)
        if "v1" in op.get("tags", [])
    ]
    assert not v1_tagged, "these operations still carry the default `v1` tag: " + ", ".join(
        v1_tagged[:10]
    )


def test_top_level_tags_block_defines_every_used_tag(schema: dict) -> None:
    """Every tag used by an operation must be described in the top-level block (#1333)."""
    defined = {t["name"] for t in schema.get("tags", [])}
    assert defined, "schema must declare a top-level `tags` block (#1333)."
    used = {t for _p, _m, op in _operations(schema) for t in op.get("tags", [])}
    missing = used - defined
    assert not missing, f"tags used but not defined in the top-level block: {sorted(missing)}"


def test_global_security_scheme_declared(schema: dict) -> None:
    """A document-level `security` default advertises the baseline auth scheme (#1333)."""
    security = schema.get("security")
    assert security, "openapi.json must declare a top-level `security` requirement (#1333)."
    schemes = {name for requirement in security for name in requirement}
    assert {"jwtAuth", "cookieAuth"} <= schemes


def test_public_endpoints_declare_empty_security(schema: dict) -> None:
    """Unauthenticated endpoints must carry explicit `security: []` (#1333).

    Without it a generated client attaches a (non-existent) credential to a public
    call, or a consumer cannot tell the endpoint is open.
    """
    for path in ("/api/v1/health/", "/api/v1/edition/", "/api/v1/auth/token/"):
        for _method, op in ((m, o) for m, o in schema["paths"][path].items() if m in _HTTP_METHODS):
            assert op.get("security") == [], (
                f"{path} must declare `security: []` (public endpoint, #1333)."
            )


def test_throttled_endpoints_document_429(schema: dict) -> None:
    """Rate-limited endpoints must document the 429 response (#1333).

    The custom AutoSchema injects a 429 wherever a view declares
    `throttle_classes`; task-sync and acceptance-results are the canonical
    integrator-facing throttled write paths.
    """
    for path in (
        "/api/v1/projects/{id}/task-sync/",
        "/api/v1/projects/{id}/acceptance-results/",
        "/api/v1/ws/ticket/",
    ):
        op = schema["paths"][path]["post"]
        assert "429" in op["responses"], (
            f"{path} is throttled and must document a 429 response (#1333)."
        )
