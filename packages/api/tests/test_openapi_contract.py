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

import jsonschema
import pytest


def _load_schema() -> dict:
    """Locate and parse the committed `docs/api/openapi.json` from the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise AssertionError("Could not locate docs/api/openapi.json above the test file.")


#: The recursive component the 400's field-keyed values reference (#3324).
_ERROR_DETAIL = "ValidationErrorDetail"

#: Opening of the description `TruePPMAutoSchema` injects on every 400 it adds. The
#: only marker distinguishing an injected 400 from one an operation declared by hand.
_INJECTED_400 = "The request was rejected. Either a field failed validation"


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


def test_every_body_bearing_write_declares_a_400(schema: dict) -> None:
    """A request body that can be rejected must say so in the schema (#3286).

    The predicate is the one the injection uses: an unsafe method **with a
    `requestBody`**. That is exactly the condition under which DRF can raise
    ValidationError, and it is read off the generated operation rather than
    guessed from the view — so a serializer added tomorrow is covered without
    touching this.

    Asserted as a whole-schema sweep rather than a sample of paths, because the
    failure this guards is a *new* endpoint arriving undeclared, which a
    named-path list can never see.
    """
    WRITE = ("post", "put", "patch", "delete")
    missing = [
        f"{method.upper()} {path}"
        for path, ops in schema["paths"].items()
        for method, op in ops.items()
        if method in WRITE and "requestBody" in op and "400" not in op.get("responses", {})
    ]
    assert not missing, (
        "every write operation that accepts a request body must declare a 400 "
        f"(#3286); missing on {len(missing)}: {missing[:5]}"
    )


def test_the_400_is_not_advertised_where_there_is_no_body_to_reject(schema: dict) -> None:
    """The other direction, and the reason the predicate is not "every write".

    Advertising a refusal an endpoint cannot produce is the same defect as
    omitting one it can, pointing the other way — a generated client grows a
    branch that is unreachable. A bodyless write may still declare a 400 by hand
    (a state conflict is a real 400), so this asserts the *injection* did not
    invent one, by checking no bodyless operation carries the injected
    description.
    """
    invented = [
        f"{method.upper()} {path}"
        for path, ops in schema["paths"].items()
        for method, op in ops.items()
        if method in ("post", "put", "patch", "delete")
        and "requestBody" not in op
        and _INJECTED_400 in (op.get("responses", {}).get("400", {}).get("description") or "")
    ]
    assert not invented, (
        f"the 400 injection reached {len(invented)} operation(s) with no request "
        f"body to reject (#3286): {invented[:5]}"
    )


def test_the_declared_400_admits_the_shapes_the_api_actually_returns(schema: dict) -> None:
    """`errors.md` documents two shapes and DRF adds a third; all three must fit.

    A schema declaring only `detail` would type the uncommon case and mis-type
    field validation, which is the majority of real 400s.

    Every value in the body — the two envelope keys included — is the recursive
    `ValidationErrorDetail`. This assertion used to pin `detail` and `code` to
    `string`, which is what #3347 fixed: `additionalProperties` governs only keys
    *not* named in `properties`, so #3324's widening stopped at the envelope's own
    two names, and `code` is a name the API uses twice — the refusal code, and the
    serializer field `Program.code` / `Project.code`. The shapes themselves are
    asserted against real bodies in
    `test_declared_400_validates_the_bodies_drf_actually_returns`.
    """
    op = schema["paths"]["/api/v1/projects/"]["post"]
    body = op["responses"]["400"]["content"]["application/json"]["schema"]
    ref = {"$ref": f"#/components/schemas/{_ERROR_DETAIL}"}
    # Shapes 1 and 2 — a string is `ValidationErrorDetail`'s first `oneOf` branch, so
    # the envelope form still validates; `allOf` is how OpenAPI 3.0.3 carries the
    # description and example, which a bare `$ref` discards (#3347).
    assert body["properties"]["detail"]["allOf"] == [ref]
    assert body["properties"]["code"]["allOf"] == [ref]
    assert body["properties"]["code"]["example"] == "invalid_body"
    # DRF's field-keyed errors, flat or nested (#3324).
    assert body["additionalProperties"] == ref


# ---------------------------------------------------------------------------
# #3319 — the residue of #3286: bodies declared as absent, and refusals on state
# ---------------------------------------------------------------------------

#: Every bodyless write operation that declares a 400, and what makes it refuse.
#:
#: This list is the fix, not a description of it. #3286's rule is mechanical —
#: `requestBody` present ⇔ DRF can raise ValidationError — and there is no
#: equivalent signal for "this action refuses on the state of the thing it acts
#: on": a `HTTP_400_BAD_REQUEST` grep is a heuristic over control flow that both
#: misses refusals raised two calls down and fires on dead branches. So each entry
#: here was read out of the handler by hand and is pinned in both directions:
#: dropping a declaration fails, and adding one without reviewing this list fails
#: too. The second direction is the one that matters — advertising a refusal an
#: endpoint cannot produce grows an unreachable branch in every generated client,
#: which is the same defect as omitting one, pointing the other way.
_STATE_REFUSAL_OPERATIONS: frozenset[tuple[str, str]] = frozenset(
    {
        ("delete", "/api/v1/me/connections/{source}/"),
        ("delete", "/api/v1/me/credentials/{provider}/"),
        ("delete", "/api/v1/me/timesheets/{week_start}/submit"),
        ("delete", "/api/v1/programs/{program_pk}/members/{id}/"),
        ("delete", "/api/v1/projects/{id}/"),
        ("delete", "/api/v1/projects/{project_pk}/members/{id}/"),
        ("delete", "/api/v1/projects/{project_pk}/phases/{id}/"),
        ("delete", "/api/v1/projects/{project_pk}/tasks/{task_pk}/attachments/{id}/"),
        (
            "delete",
            "/api/v1/projects/{project_pk}/tasks/{task_pk}/comments/{comment_pk}/reactions/{id}/",
        ),
        ("delete", "/api/v1/projects/{project_pk}/tasks/{task_pk}/comments/{id}/"),
        ("delete", "/api/v1/projects/{project_pk}/tasks/{task_pk}/notes/{id}/"),
        ("delete", "/api/v1/sprints/{id}/"),
        ("delete", "/api/v1/workspace/"),
        ("delete", "/api/v1/workspace/members/{user_id}/"),
        ("post", "/api/v1/cascade-classification-operations/{id}/undo/"),
        ("post", "/api/v1/dependencies/{id}/accept/"),
        ("post", "/api/v1/dependencies/{id}/reject/"),
        ("post", "/api/v1/me/api-tokens/"),
        ("post", "/api/v1/me/connections/{source}/sync/"),
        ("post", "/api/v1/me/timesheets/{week_start}/submit"),
        ("post", "/api/v1/paste-many-operations/{id}/undo/"),
        ("post", "/api/v1/programs/{program_pk}/api-tokens/"),
        ("post", "/api/v1/projects/{id}/tasks/{task_id}/indent/"),
        ("post", "/api/v1/projects/{id}/tasks/{task_id}/outdent/"),
        ("post", "/api/v1/projects/{project_pk}/api-tokens/"),
        ("post", "/api/v1/slip-conflicts/{id}/acknowledge/"),
        ("post", "/api/v1/template-applications/{id}/undo/"),
        ("post", "/api/v1/workspace/email-settings/send-test/"),
        # The seven that predate #3319 and were already hand-declared. #3286's
        # `setdefault` leaves them alone; they are listed so this set is the whole
        # truth about bodyless writes carrying a 400, not just the new ones.
        ("post", "/api/v1/integrations/projects/{project_pk}/git-webhook/"),
        ("post", "/api/v1/programs/{id}/pin/"),
        ("delete", "/api/v1/programs/{id}/pin/"),
        ("post", "/api/v1/projects/{id}/pin/"),
        ("delete", "/api/v1/projects/{id}/pin/"),
        ("post", "/api/v1/projects/{project_pk}/import/csv/{id}/undo/"),
        ("post", "/api/v1/resources/{id}/restore/"),
    }
)


def test_bodyless_writes_declaring_a_400_are_exactly_the_reviewed_set(schema: dict) -> None:
    """Pin the hand-declared set in both directions (#3319).

    A missing entry means a state refusal a generated client has no typed branch
    for. An *extra* one means somebody blanket-declared a 400 on a write that
    cannot produce one, which is the failure mode #3286 deliberately avoided and
    the reason this could not be mechanized. Either way the list above is the
    thing to change, and changing it is the moment the handler gets re-read.
    """
    declared = {
        (method, path)
        for path, ops in schema["paths"].items()
        for method, op in ops.items()
        if method in ("post", "put", "patch", "delete")
        and "requestBody" not in op
        and "400" in op.get("responses", {})
    }
    missing = sorted(_STATE_REFUSAL_OPERATIONS - declared)
    unreviewed = sorted(declared - _STATE_REFUSAL_OPERATIONS)
    assert not missing, f"bodyless writes that lost their declared 400 (#3319): {missing}"
    assert not unreviewed, (
        "a bodyless write declares a 400 that nobody reviewed against the handler "
        f"(#3319) — read the handler, then add it to _STATE_REFUSAL_OPERATIONS: {unreviewed}"
    )


def test_every_state_refusal_400_uses_one_of_the_three_real_wire_shapes(schema: dict) -> None:
    """The declared body must be a shape the API actually puts on the wire (#3319).

    Three exist and they are not interchangeable. A flat ``{"detail"}`` object, a
    field-keyed object, and — the one that is easy to declare wrongly — a
    top-level **array**, which is what DRF emits for
    ``ValidationError("a bare string")``: it wraps a string detail in a list, so
    there is no enclosing object and no key to read the message under.

    Two operations are exempt because they answer with their own documented
    envelope rather than a refusal shape; both are asserted by name below rather
    than waved through by a wildcard.
    """
    bespoke = {
        # Answers {"sent": false, "error": "..."} on both its 400 and its 502 so a
        # client renders one banner for either.
        ("post", "/api/v1/workspace/email-settings/send-test/"),
        # Signature/payload rejection on the webhook ingest surface (pre-#3319).
        ("post", "/api/v1/integrations/projects/{project_pk}/git-webhook/"),
    }
    offenders = []
    for method, path in sorted(_STATE_REFUSAL_OPERATIONS - bespoke):
        response = schema["paths"][path][method]["responses"]["400"]
        content = response.get("content")
        if content is None:
            # A description-only declaration types nothing for a client, but it is
            # how the pre-#3319 pin/undo/restore sites were written; not a
            # regression to introduce, so it is tolerated only where it already is.
            continue
        body = content["application/json"]["schema"]
        # The pre-#3319 pin sites point at a named component; resolve it so the
        # shape check reads the same thing a client generator would.
        if "$ref" in body:
            body = schema["components"]["schemas"][body["$ref"].rsplit("/", 1)[-1]]
        is_messages = body.get("type") == "array" and body.get("items") == {"type": "string"}
        is_detail = body.get("type") == "object" and "detail" in body.get("properties", {})
        is_fields = body.get("type") == "object" and "additionalProperties" in body
        if not (is_messages or is_detail or is_fields):
            offenders.append(f"{method.upper()} {path}: {body}")
    assert not offenders, f"400 declared in a shape the API never returns (#3319): {offenders}"


def test_the_bare_array_refusal_shape_is_declared_where_drf_emits_it(schema: dict) -> None:
    """``ValidationError("string")`` puts a JSON **array** on the wire (#3319).

    Three view-level guards raise on a bare string, and DRF's exception handler
    passes a list detail through verbatim. A client typed against an object throws
    while parsing, before it can read the message — so this is the shape most worth
    pinning, and the one a copy-pasted ``{"detail"}`` declaration would get wrong.
    """
    array_sites = [
        ("post", "/api/v1/dependencies/{id}/accept/"),
        ("post", "/api/v1/dependencies/{id}/reject/"),
        ("post", "/api/v1/slip-conflicts/{id}/acknowledge/"),
    ]
    for method, path in array_sites:
        body = schema["paths"][path][method]["responses"]["400"]["content"]["application/json"][
            "schema"
        ]
        assert body == {"type": "array", "items": {"type": "string"}}, (
            f"{method.upper()} {path} returns a bare array of messages; declaring an "
            "object there would make a generated client throw on parse (#3319)."
        )


@pytest.mark.parametrize(
    ("path", "required_field"),
    [
        ("/api/v1/project-templates/publish/", "project"),
        ("/api/v1/project-templates/{id}/apply/", "project"),
    ],
)
def test_template_write_endpoints_declare_the_body_they_require(
    schema: dict, path: str, required_field: str
) -> None:
    """Both were ``request=None`` while requiring a body (#3319, Part A).

    Worse than a missing error branch: the contract said the endpoint accepts
    nothing, so a generated client could not send the required field *at all*, and
    ``apply`` answered ``{"project": "This field is required."}`` naming a field
    the schema had never mentioned. Declaring the body also brings both operations
    under #3286's automatic 400 injection, which is asserted here too — the 400
    arriving is what proves the declaration is wired to the mechanism rather than
    hand-written beside it.
    """
    op = schema["paths"][path]["post"]
    assert "requestBody" in op, f"POST {path} requires a body and must declare one (#3319)."
    ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    component = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]
    assert required_field in component["properties"], (
        f"POST {path} reads {required_field!r} off the body; the declared schema must name it."
    )
    assert required_field in component.get("required", []), (
        f"POST {path} refuses without {required_field!r}, so the schema must mark it required."
    )
    assert "400" in op["responses"], (
        f"POST {path} must inherit #3286's 400 once it declares a body (#3319)."
    )


def test_validation_error_detail_component_is_recursive(schema: dict) -> None:
    """The component must recurse, or it only describes the depth someone listed (#3324).

    The enumerate-the-known-shapes version is what #3286 shipped and what the first
    nightly after it broke: a `ListField` inside a `many=True` serializer nests one
    level past every shape anyone had seen. Recursion is what makes the declaration
    hold at a depth nobody has hit yet.
    """
    component = schema["components"]["schemas"][_ERROR_DETAIL]
    ref = {"$ref": f"#/components/schemas/{_ERROR_DETAIL}"}
    branches = component["oneOf"]
    assert {"type": "string"} in branches, "leaves are message strings"
    assert {"type": "array", "items": ref} in branches, "arrays nest into the same component"
    assert {"type": "object", "additionalProperties": ref} in branches, (
        "objects keyed by item index or subfield name nest into the same component"
    )


def test_no_operation_declares_a_flat_field_error_map(schema: dict) -> None:
    """No response may re-declare the flat `array<string>` this fix removed (#3324).

    The recurrence guard, and the reason it is a sweep rather than a spot check.
    #3286 introduced the flat form in one place and it reached 191 operations; a
    hand-written `@extend_schema` can reintroduce it in one more without touching
    `openapi.py`, and nothing else in the pipeline looks at the shape — `api:fuzz`
    would find it, but only on the night Hypothesis happens to generate a bad list
    item for that operation, and it is `allow_failure` besides.

    Stated denominator at the time of writing: 0 of 413 paths declare it, and the
    three response schemas `TruePPMAutoSchema` injects (400, 429, 403-token-refused)
    were each checked against the code that produces them — only the 400 was narrow.
    """
    flat = {"type": "array", "items": {"type": "string"}}
    offenders = [
        f"{method.upper()} {path} [{code}]"
        for path, ops in schema["paths"].items()
        for method, op in ops.items()
        if isinstance(op, dict)
        for code, response in (op.get("responses") or {}).items()
        if (response.get("content") or {})
        .get("application/json", {})
        .get("schema", {})
        .get("additionalProperties")
        == flat
    ]
    assert not offenders, (
        "a field-keyed error map must reference ValidationErrorDetail, not the flat "
        f"array<string> DRF outgrows the moment a list field is involved (#3324): {offenders[:5]}"
    )


def test_no_400_declares_an_envelope_key_narrower_than_its_field_map(schema: dict) -> None:
    """No named key in a 400 may reject what an unnamed key accepts (#3347).

    The class guard, and the reason it sweeps rather than spot-checks the one
    operation the nightly drew. `additionalProperties` governs only keys that
    `properties` does not name, so every name the envelope adds is a hole punched
    through the field-keyed map underneath it — silently, because a key named in
    `properties` looks *more* specified, not less. #3286 punched two (`detail`,
    `code`), #3324 widened the map and could not reach them, and `api:fuzz` found
    `code` eleven weeks later on the one night Hypothesis generated a `Program.code`
    over 40 characters.

    Asserted behaviorally: a field-keyed value is fed under *every* declared name,
    on every operation. A structural check ("each property must be an `allOf`
    `$ref`") would pass a third narrow-but-differently-shaped declaration; this
    cannot. The envelope's own string form is validated alongside it so that
    "widen it" is not satisfied by deleting the keys the vocabulary depends on.

    Denominator at the time of writing: 191 operations carry the injected 400, two
    envelope keys each, both previously narrow. 21 operations expose a writable
    serializer field named `code` (every `Program`/`Project` request body) and 0
    expose one named `detail` — so `code` was the live instance and `detail` the
    latent one, and both are covered here.
    """
    field_errors = ["Ensure this field has no more than 40 characters."]
    offenders: list[str] = []
    for path, ops in schema["paths"].items():
        for method, op in ops.items():
            if not isinstance(op, dict):
                continue
            response = (op.get("responses") or {}).get("400") or {}
            declared = (response.get("content") or {}).get("application/json", {}).get("schema", {})
            if _INJECTED_400 not in (response.get("description") or ""):
                continue
            validator = jsonschema.Draft202012Validator(
                {**declared, "components": schema["components"]}
            )
            bodies = [{name: field_errors} for name in declared.get("properties", {})]
            bodies.append({"detail": "Request body must be a JSON object.", "code": "invalid_body"})
            for body in bodies:
                if errors := sorted(validator.iter_errors(body), key=str):
                    offenders.append(f"{method.upper()} {path} {body}: {errors[0].message}")
    assert not offenders, (
        "a key named in a 400's `properties` must admit everything "
        f"`additionalProperties` does — DRF keys serializer errors by field name and "
        f"does not skip the names the envelope happens to use (#3347): {offenders[:5]}"
    )


@pytest.mark.parametrize(
    ("label", "body"),
    [
        # The three the 2026-09-02 nightly api:fuzz reported, verbatim in shape:
        # every one is a ListField whose per-item errors DRF keys by item index.
        (
            "projects.allowed_attachment_types",
            {"allowed_attachment_types": {"0": ["Not a valid string."]}},
        ),
        (
            "programs.allowed_attachment_types",
            {"allowed_attachment_types": {"0": ["Not a valid string."]}},
        ),
        (
            "profile.hidden_views",
            {"hidden_views": {"0": ["Not a valid string."], "9": ["Not a valid string."]}},
        ),
        # The two the 2026-09-04 nightly api:fuzz reported, verbatim in shape (#3347).
        # `code` is both the refusal envelope's key and a serializer field name, and
        # `properties.code` shadowed `additionalProperties` for the second meaning.
        ("programs.code", {"code": ["Ensure this field has no more than 40 characters."]}),
        ("projects.code", {"code": ["Ensure this field has no more than 12 characters."]}),
        # `detail` had the identical declaration bug. No serializer has a writable
        # field of that name today, so this is the latent half of the same class —
        # pinned here so the fix is not quietly narrowed back to the live half.
        ("detail as a field key", {"detail": ["This field is required."]}),
        # Shapes the flat declaration already admitted — kept so widening the
        # contract is not mistaken for abandoning it.
        ("flat field", {"name": ["This field is required."]}),
        ("bare refusal", {"detail": "Request body must be a JSON object.", "code": "invalid_body"}),
        # Reachable and undeclared before #3324, though no nightly has drawn them yet.
        ("nested serializer", {"calendar": {"overlays": ["Unknown role."]}}),
        ("many=True list serializer", {"tasks": [{}, {"name": ["This field is required."]}]}),
    ],
)
def test_declared_400_validates_the_bodies_drf_actually_returns(
    schema: dict, label: str, body: dict
) -> None:
    """Validate real 400 bodies against the committed 400 schema (#3324).

    This is the assertion the nightly was making and the suite was not. It fails
    against the pre-#3324 schema for the first three cases and passes for the rest,
    which is the negative control: reverting `additionalProperties` to
    `{"type": "array", "items": {"type": "string"}}` must turn this red.
    """
    op = schema["paths"]["/api/v1/programs/"]["post"]
    declared = op["responses"]["400"]["content"]["application/json"]["schema"]
    # `$ref` is document-absolute (`#/components/schemas/...`), so the validator
    # needs the components alongside the subschema it is resolving from.
    validator = jsonschema.Draft202012Validator({**declared, "components": schema["components"]})
    errors = sorted(validator.iter_errors(body), key=str)
    assert not errors, f"{label} violates the declared 400: {[e.message for e in errors]}"


# ---------------------------------------------------------------------------
# #2127 — response-schema conformance fixes. Schemathesis flagged read/write
# endpoints whose real response bodies violated the committed schema. Each
# assertion below pins one fix so a regenerate that loses the annotation fails.
# ---------------------------------------------------------------------------


def _response_2xx_schema(schema: dict, path: str, method: str) -> dict:
    """Return the JSON response schema for the first documented 2xx of an op."""
    op = schema["paths"][path][method]
    responses = op["responses"]
    for code in ("200", "201"):
        if code in responses:
            content = responses[code].get("content", {})
            return content.get("application/json", {}).get("schema", {})
    raise AssertionError(f"no 2xx JSON response for {method.upper()} {path}")


def test_nullable_scalar_fields_declared_nullable(schema: dict) -> None:
    """Runtime-nullable fields must be `nullable` so a null body conforms (#2127)."""
    comps = schema["components"]["schemas"]
    assert comps["Dependency"]["properties"]["accepted_by"].get("nullable") is True
    assert comps["ProjectDetail"]["properties"]["recalculated_at"].get("nullable") is True
    assert comps["Task"]["properties"]["baseline_finish"].get("nullable") is True
    assert comps["Task"]["properties"]["baseline_start"].get("nullable") is True


def test_nested_user_summary_fields_nullable(schema: dict) -> None:
    """`lead_detail` (nested _UserSummary) is null when unset — must be nullable (#2127)."""
    for comp in ("Project", "ProjectDetail", "Program"):
        lead = schema["components"]["schemas"][comp]["properties"]["lead_detail"]
        assert lead.get("nullable") is True, f"{comp}.lead_detail must be nullable (#2127)."


def test_task_external_link_summary_is_object(schema: dict) -> None:
    """external_link_summary emits {count, worst_status}, not a string (#2127)."""
    prop = schema["components"]["schemas"]["Task"]["properties"]["external_link_summary"]
    assert prop.get("type") == "object"
    assert set(prop.get("properties", {})) >= {"count", "worst_status"}


def test_resource_email_has_no_email_format(schema: dict) -> None:
    """Resource.email is blank-able; a "" response must not fail `format: email` (#2127)."""
    prop = schema["components"]["schemas"]["Resource"]["properties"]["email"]
    assert prop.get("type") == "string"
    assert prop.get("format") != "email", "blank Resource.email must not claim email format."


def test_bare_array_list_endpoints_are_arrays(schema: dict) -> None:
    """Endpoints returning a bare array must not advertise a pagination envelope (#2127)."""
    for path, method in (
        ("/api/v1/projects/trash/", "get"),
        ("/api/v1/tasks/search/", "get"),
        ("/api/v1/me/credentials/", "get"),
        ("/api/v1/me/active-sprints/", "get"),
        ("/api/v1/projects/health-summary/", "get"),
    ):
        sch = _response_2xx_schema(schema, path, method)
        assert sch.get("type") == "array", f"{method.upper()} {path} must be an array (#2127)."


def test_workspace_members_declares_pagination_envelope(schema: dict) -> None:
    """workspace/members manually paginates — schema must be the {results:[...]} object (#2127)."""
    sch = _response_2xx_schema(schema, "/api/v1/workspace/members/", "get")
    ref = sch.get("$ref", "")
    props = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]["properties"]
    assert "results" in props and props["results"].get("type") == "array"


def test_me_search_declares_pagination_envelope(schema: dict) -> None:
    """me/search manually paginates — schema must be the {results:[...]} object, not a
    bare array (#2267).

    The view returns ``get_paginated_response(...)`` (a ``{count, next, previous,
    results}`` envelope) but its ``@extend_schema`` declared
    ``OmniSearchResultSerializer(many=True)`` — a ``type: array``. The nightly fuzzer's
    ``response_schema_conformance`` check rejected the real object body against that
    array. Pin the envelope so a regenerate that reverts to a bare array fails here.
    """
    sch = _response_2xx_schema(schema, "/api/v1/me/search/", "get")
    ref = sch.get("$ref", "")
    assert ref, "me/search 200 must be an object envelope, not a bare array (#2267)."
    props = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]["properties"]
    assert "results" in props and props["results"].get("type") == "array"
    assert {"count", "next", "previous"} <= set(props)


def test_duration_events_response_is_event_not_task(schema: dict) -> None:
    """duration-events returns TaskDurationChangeEvent rows, not a Task (#2127)."""
    sch = _response_2xx_schema(schema, "/api/v1/tasks/{id}/duration-events/", "get")
    # Paginated: the results item ref must be the duration-change event component.
    dumped = json.dumps(sch)
    assert "TaskDurationChangeEvent" in dumped
    assert '/Task"' not in dumped, "duration-events must not reference the Task schema (#2127)."


def test_mark_all_read_returns_counter(schema: dict) -> None:
    """mark-all-read returns {updated: N}, not a Notification (#2127)."""
    sch = _response_2xx_schema(schema, "/api/v1/me/notifications/mark-all-read/", "post")
    ref = sch.get("$ref", "")
    props = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]["properties"]
    assert "updated" in props


def test_program_export_get_is_the_seed_document_not_a_program(schema: dict) -> None:
    """GET program export returns the canonical seed doc, not a Program row (#2455).

    The `pin` action was inserted between this action's stacked ``@extend_schema``
    blocks and ``def export``, so Python applied both to ``pin`` and the export
    path fell back to ``serializer_class`` — publishing ``Program``, whose
    required ``calendar_source`` the real ``{schema_version, program, projects,
    accounts}`` body has no reason to carry. That is what the nightly fuzzer's
    ``response_schema_conformance`` check caught.
    """
    op = schema["paths"]["/api/v1/programs/{id}/export/"]["get"]
    assert op.get("summary"), "GET program export must keep its summary (#2455)."
    sch = _response_2xx_schema(schema, "/api/v1/programs/{id}/export/", "get")
    assert "Program" not in json.dumps(sch), (
        "GET program export must not reference the Program schema — the body is a seed "
        "document (#2455)."
    )
    assert sch.get("type") == "object"


def test_program_export_post_returns_the_async_job(schema: dict) -> None:
    """POST program export queues a job: 202 ProgramExportJob, never 200 Program (#2455)."""
    op = schema["paths"]["/api/v1/programs/{id}/export/"]["post"]
    assert "202" in op["responses"], "POST program export must document its 202 (#2455)."
    assert "200" not in op["responses"], "POST program export never returns 200 (#2455)."
    ref = op["responses"]["202"]["content"]["application/json"]["schema"].get("$ref", "")
    assert ref.endswith("/ProgramExportJob"), f"expected ProgramExportJob, got {ref!r} (#2455)."


def test_program_pin_documents_the_pin_contract(schema: dict) -> None:
    """The program pin path documents pinning — not a program export bundle (#2455).

    While the export annotations were orphaned onto ``pin``, ``POST
    /programs/{id}/pin/`` publicly advertised "Queue a richer asynchronous program
    export bundle" with a ``202 ProgramExportJob`` body. Any integrator reading the
    schema was told the wrong thing about a write endpoint.
    """
    for method in ("post", "delete"):
        op = schema["paths"]["/api/v1/programs/{id}/pin/"][method]
        assert "export" not in op["summary"].lower(), (
            f"{method.upper()} program pin summary must describe pinning, not export (#2455)."
        )
        assert "202" not in op["responses"], f"{method.upper()} program pin has no 202 (#2455)."
        ref = op["responses"]["200"]["content"]["application/json"]["schema"].get("$ref", "")
        assert ref.endswith("/ProgramPinResponse"), f"expected ProgramPinResponse, got {ref!r}."
        assert "204" in op["responses"], f"{method.upper()} program pin must document 204."


# ---------------------------------------------------------------------------
# #2659 — `projectApiTokenAuth` must never appear on an operation the credentials
# unique to that scheme are refused. `McpReadableViewMixin` advertises the scheme
# at the view level; the schema must match runtime.
#
# The runtime rule changed shape in #2877 but not in outcome. It used to be
# `TokenReadOnlyMethods` refusing *every* token an unsafe method. A `legacy:full`
# personal token may now write on these views — but that credential is described by
# `personalApiTokenAuth`, which these operations already advertise via the default
# auth stack. The credentials unique to `projectApiTokenAuth` are the project- and
# program-scoped tokens, and `TokenIsOwnerScoped` still refuses those on the entire
# MCP surface (401), so the scheme stays unreachable here and the assertions below
# stand unchanged.
# ---------------------------------------------------------------------------

_UNSAFE_METHODS = ("post", "put", "patch", "delete")

# The two views that reference `ProjectApiTokenAuthentication` *directly*
# (not via `McpReadableViewMixin`) to accept a token write. They must keep
# advertising the scheme on their POST — the filter must not strip it here.
_DIRECT_TOKEN_WRITE_PATHS = frozenset(
    {
        "/api/v1/projects/{id}/task-sync/",
        "/api/v1/projects/{id}/acceptance-results/",
    }
)


def test_project_api_token_auth_absent_from_unsafe_operations(schema: dict) -> None:
    """No unsafe (write) operation may advertise `projectApiTokenAuth` (#2659).

    `McpReadableViewMixin.get_authenticators` prepends `ProjectApiTokenAuthentication`
    at the view level, so drf-spectacular's default per-view security resolution
    would attach the scheme to every method on the view, including the unsafe ones no
    project- or program-scoped token can reach (`TokenIsOwnerScoped` 401s them on this
    whole surface, #2877). `TruePPMAutoSchema.get_auth` (trueppm_api.core.openapi)
    filters those out; this is the regression pin — a scoped-token write op reappearing
    here means either that filter broke or a new MCP-readable view regained the same bug.
    """
    offenders = [
        f"{method.upper()} {path}"
        for path, methods in schema["paths"].items()
        if path not in _DIRECT_TOKEN_WRITE_PATHS
        for method, op in methods.items()
        if method in _UNSAFE_METHODS
        and isinstance(op, dict)
        and any("projectApiTokenAuth" in entry for entry in op.get("security", []))
    ]
    assert not offenders, (
        "these unsafe operations advertise `projectApiTokenAuth` though a token "
        "caller is refused at runtime (#2659): " + ", ".join(offenders[:15])
    )


def test_project_api_token_auth_still_advertised_on_safe_mcp_operation(schema: dict) -> None:
    """Sanity check the #2659 fix does not overshoot: a safe (GET) MCP-readable
    operation must keep advertising `projectApiTokenAuth`."""
    op = schema["paths"]["/api/v1/projects/{id}/"]["get"]
    schemes = {name for entry in op.get("security", []) for name in entry}
    assert "projectApiTokenAuth" in schemes, (
        "GET /api/v1/projects/{id}/ must still advertise `projectApiTokenAuth` (#2659)."
    )


@pytest.mark.parametrize("path", sorted(_DIRECT_TOKEN_WRITE_PATHS))
def test_project_api_token_auth_still_advertised_on_direct_write_views(
    schema: dict, path: str
) -> None:
    """The two direct-write token surfaces must keep the scheme on their POST (#2659).

    These reference `ProjectApiTokenAuthentication` directly rather than through
    `McpReadableViewMixin`, and pair it with `IsTokenForProject` rather than the MCP
    guards — a project/program token is exactly what they exist to accept. The #2659
    filter is scoped to the mixin and must not touch them.
    """
    op = schema["paths"][path]["post"]
    schemes = {name for entry in op.get("security", []) for name in entry}
    assert "projectApiTokenAuth" in schemes, f"{path} must keep `projectApiTokenAuth` (#2659)."


def test_pin_endpoints_document_the_limit_rejection(schema: dict) -> None:
    """Both pin paths document the 400 a client must handle (#2455).

    ``set_pin`` raises ``PinLimitReached`` -> ``400 {detail, code}``. Neither pin
    endpoint declared it, so a generated client had no typed branch for the one
    failure the endpoint actually has.
    """
    for path in ("/api/v1/projects/{id}/pin/", "/api/v1/programs/{id}/pin/"):
        op = schema["paths"][path]["post"]
        assert "400" in op["responses"], f"{path} must document the pin-limit 400 (#2455)."
        ref = op["responses"]["400"]["content"]["application/json"]["schema"].get("$ref", "")
        props = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]["properties"]
        assert {"detail", "code"} <= set(props), f"{path} 400 must carry detail + code (#2455)."
