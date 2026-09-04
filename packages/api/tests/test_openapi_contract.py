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

import functools
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
        ("post", "/api/v1/me/connections/{source}/sync/"),
        ("post", "/api/v1/me/timesheets/{week_start}/submit"),
        ("post", "/api/v1/paste-many-operations/{id}/undo/"),
        ("post", "/api/v1/projects/{id}/tasks/{task_id}/indent/"),
        ("post", "/api/v1/projects/{id}/tasks/{task_id}/outdent/"),
        ("post", "/api/v1/slip-conflicts/{id}/acknowledge/"),
        ("post", "/api/v1/template-applications/{id}/undo/"),
        ("post", "/api/v1/workspace/email-settings/send-test/"),
        # The six that predate #3319 and were already hand-declared. #3286's
        # `setdefault` leaves them alone; they are listed so this set is the whole
        # truth about bodyless writes carrying a 400, not just the new ones.
        #
        # Four entries LEFT this set in #3364 — the three api-token creates and the
        # git-webhook receiver. Nothing about their 400s changed; they stopped being
        # *bodyless*. All four were in the class #3364 fixed (a handler reading
        # `request.data` under an operation publishing no `requestBody`), so once
        # each declared its real request serializer the membership predicate above —
        # bodyless AND declares a 400 — stopped matching them. Their hand-written
        # `state_refusal_400` declarations are still in the views and still win over
        # #3286's `setdefault`; they are simply no longer *this* set's business.
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


# ---------------------------------------------------------------------------
# #3364 — the sweep: no write operation may hide the body it requires
#
# This section is the only one in the file that reads the **generated** schema
# rather than the committed `docs/api/openapi.json`, and the departure is
# deliberate. The predicate needs the route table and the handler source, which
# the committed artifact does not carry; and generating means the gate fires the
# moment the code drifts rather than one regenerate later. `api:schema-drift`
# already binds the committed file to what the code generates, so checking the
# generated document loses nothing and catches the defect earlier.
#
# Why a sweep and not another point fix. This class has been fixed at its
# instances five times (#2840, #3286, #3324, #3281, #3319) and recurred each time, for
# the reason `regression-check` calls the most dangerous case: a guard existed
# and was structurally incapable of matching the defect. #3286's injection keys
# off `requestBody` *present*; this defect lives exactly where that predicate is
# silent, so its green was evidence about the injection mechanism and not about
# the contract. #3319's own sweep then matched the *decorator*
# `@extend_schema(request=None)` and reported "exactly 2, the complete set" —
# while 7 more operations reached the same published state by a different route
# (an all-read-only `serializer_class`, or a plain `APIView` with no
# `serializer_class` at all, with `create`/`put`/`patch` reaching for a separate
# write serializer themselves). No `request=None` anywhere, so a decorator-shaped
# search could not see them.
#
# The lesson encoded below: **the predicate is on the generated operation, not on
# how the operation got that way.** There are at least four ways to publish "no
# request body" — `request=None`, an all-read-only `serializer_class`, a plain
# `APIView` with none at all, and a `request=` handed a bare schema dict it cannot
# parse — and enumerating them is how the previous sweeps went blind.
#
# The gate got this wrong itself, twice, before it shipped, which is the strongest
# evidence for the rule and the reason both corrections are pinned by tests rather
# than described here. It first accepted a malformed `requestBody` because it asked
# `"requestBody" in operation` (see `declares_a_usable_request_body`), and it first
# read only the handler's own frame, missing the two `WorkspaceEmailSettingsView`
# writes whose body read is one hop down in `_update` (see `_handler_source`). Each
# time the sweep reported zero offenders over a tree that contained the defect.
# ---------------------------------------------------------------------------

#: Substrings that mean "this handler reads the client's request body".
#:
#: `object_body(` is the house helper (`trueppm_api.core.request_body`) and
#: `request.data` is DRF's raw accessor; `self.request.data` is the viewset form.
#: Deliberately a small literal set rather than an AST walk — a handler that
#: reaches the body through some fourth spelling is a handler this gate cannot
#: see, and widening the markers is the fix, not narrowing the assertion.
_BODY_READ_MARKERS: tuple[str, ...] = (
    "request.data",
    "self.request.data",
    "object_body(",
)

_WRITE_METHODS: tuple[str, ...] = ("post", "put", "patch", "delete")

#: Operations that read the request body but genuinely must publish no
#: `requestBody`, each with the reason. Same shape as the `# safe-constraint:`
#: escape on the migration gate, and the same honest accounting of what it buys:
#: an opt-out is a rubber stamp and cannot stop a wrong answer. What it removes is
#: the silence — before this gate, adding an eighth operation to this class
#: produced no signal anywhere in the pipeline.
#:
#: It is **empty**, and that is a finding rather than a placeholder: all 7
#: operations in the class at #3364 turned out to accept a perfectly ordinary
#: client-supplied body, including the Git webhook receiver, whose payload is the
#: provider's own event object and is now declared as such. If you are about to
#: add an entry, the bar is that the handler reads a body **no client supplies** —
#: not that declaring the shape is inconvenient.
_BODY_DECLARATION_EXEMPT: dict[tuple[str, str], str] = {}


def operation_hides_a_body_its_handler_reads(operation: dict, handler_source: str | None) -> bool:
    """The whole predicate, isolated so the negative control can drive it.

    Pure and side-effect free on purpose: the test below it plants each shape by
    hand and asserts this fires or does not. A predicate that only ever runs over
    the real tree is a predicate nobody has watched fail — which is precisely the
    standing that let #3286's green be read as evidence it was not.

    Args:
        operation: One generated OpenAPI operation object.
        handler_source: `inspect.getsource` of the method serving it, or None when
            it could not be resolved.

    Returns:
        True when the operation publishes no *usable* request body while its handler
        reads one. A handler whose source could not be read returns False — an
        unresolvable handler is reported separately rather than guessed at here.
    """
    if declares_a_usable_request_body(operation):
        return False
    if handler_source is None:
        return False
    return any(marker in handler_source for marker in _BODY_READ_MARKERS)


def declares_a_usable_request_body(operation: dict) -> bool:
    """A `requestBody` a client can actually send through, not merely a key.

    `"requestBody" in operation` is NOT this predicate, and the difference is the
    whole lesson of #3364 restated one level down. `@extend_schema(request=...)`
    accepts a serializer, an `OpenApiTypes`, an `OpenApiRequest`, or a
    `{media_type: schema}` mapping — but **not** a bare OpenAPI schema dict, which
    `responses=` does accept. Hand it one and drf-spectacular reads that dict's own
    top-level keys as media types: `{"type": ..., "additionalProperties": ...,
    "description": ...}` became three content entries named after schema keywords,
    each holding the "Unspecified request body" placeholder, and the authored schema
    was thrown away. No error, no warning.

    That shape passed the first draft of this gate. A generated client is no better
    off than with no `requestBody` at all — it is a differently-shaped absence, not a
    presence — so requiring a real media range is the only way the sweep measures the
    thing it claims to. Every media type contains a `/`; no OpenAPI schema keyword
    does, which is exactly what makes the malformed shape detectable.
    """
    body = operation.get("requestBody")
    if not isinstance(body, dict):
        return False
    content = body.get("content")
    if not isinstance(content, dict) or not content:
        return False
    return any("/" in media_type for media_type in content)


@functools.lru_cache(maxsize=1)
def _write_operation_index() -> list[tuple[str, str, dict, object]]:
    """`(path, METHOD, operation, view)` for every generated write operation.

    Cached: building this walks the whole route table twice (`get_schema` for the
    operations, `parse` for the views behind them) at ~0.8s a call, and both tests
    below want the same answer. The schema cannot change inside a session, so one
    build is the whole truth — the same reasoning as the module-scoped `schema`
    fixture at the top of this file.
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    generator = SchemaGenerator()
    generator.parse(None, public=True)
    views = {
        (path, method.upper()): view
        for path, _regex, method, view in generator._get_paths_and_endpoints()
    }
    return [
        (path, method.upper(), operation, views.get((path, method.upper())))
        for path, operations in schema.get("paths", {}).items()
        for method, operation in operations.items()
        if method.lower() in _WRITE_METHODS
    ]


def _handler_source(view: object, method: str) -> str | None:
    """Source of the method serving `method`, plus any `self._helper()` it delegates to.

    `view.action` is set by drf-spectacular for viewsets and is the only thing
    that distinguishes `create` from a custom `@action` sharing the verb; a plain
    `APIView` has no `action`, and there the verb *is* the method name.

    **The one-level hop is not a refinement — without it the sweep does not cover
    its own class.** `WorkspaceEmailSettingsView.put` is
    `return self._update(request, partial=False)`; the `request.data` read is in
    `_update`, so a handler-local search sees a body-free one-liner and reports the
    operation clean. Two such operations were live in the tree when this gate was
    written and the first draft, reading one frame, reported zero offenders over
    both. #2840 is the same shape from the other direction: its roster `@action`s
    are thin wrappers around `self._mutate_membership(...)`, so deleting their
    `request=` annotations would re-open that defect with this gate still green.

    One level, matching `_handler_and_helpers_source` in
    `test_openapi_response_conformance.py`. Two has no caller in this codebase, so
    the extra reach would be untested code — and the failure mode of stopping too
    early is a false *pass*, which is why this comment exists rather than a
    tempting `# good enough`.
    """
    import inspect
    import re

    action = getattr(view, "action", None) or method.lower()
    handler = getattr(type(view), action, None)
    if handler is None:
        return None
    try:
        sources = [inspect.getsource(handler)]
    except (OSError, TypeError):  # pragma: no cover - handler without source
        return None
    for helper_name in sorted(set(re.findall(r"self\.(_\w+)\(", sources[0]))):
        helper = getattr(type(view), helper_name, None)
        if helper is None:
            continue
        try:
            sources.append(inspect.getsource(helper))
        except (OSError, TypeError):  # pragma: no cover - builtin / C helper
            continue
    return "\n".join(sources)


def test_no_write_operation_hides_the_request_body_it_requires() -> None:
    """The sweep (#3364).

    An operation with no `requestBody` tells every generated client, every MCP
    tool definition and every reader of `docs/api/openapi.json` that the endpoint
    accepts nothing. When the handler then reads `request.data` and requires a
    field, the client has no parameter to send it through — `POST /me/api-tokens/`
    requires `name` and published no way to provide it.

    The fix at each site is `@extend_schema(request=<the write serializer the
    handler actually constructs>)` — read off the handler, not off the viewset's
    `serializer_class`, which in every #3364 case was a different (all-read-only)
    shape.
    """
    offenders = []
    unresolved = []
    for path, method, operation, view in _write_operation_index():
        key = (method.lower(), path)
        if key in _BODY_DECLARATION_EXEMPT:
            continue
        if view is None:
            unresolved.append(f"{method} {path}")
            continue
        source = _handler_source(view, method)
        if "requestBody" not in operation and source is None:
            unresolved.append(f"{method} {path} ({type(view).__name__})")
            continue
        if operation_hides_a_body_its_handler_reads(operation, source):
            action = getattr(view, "action", None) or method.lower()
            offenders.append(f"{method} {path}  [{type(view).__name__}.{action}]")

    # Reported, not skipped. Every bodyless write in the tree resolves today, so a
    # new unresolvable one means this gate has gone partially blind — which is the
    # failure mode the whole section exists to refuse, and a silent `continue` is
    # how the previous three sweeps acquired it.
    assert not unresolved, (
        "these write operations could not be traced back to a handler, so the "
        f"#3364 sweep cannot see them: {sorted(unresolved)}"
    )
    assert not offenders, (
        f"{len(offenders)} write operation(s) publish no `requestBody` while the "
        "handler reads the client's body — a generated client cannot send the "
        "fields these require (#3364). Declare the real write serializer with "
        "`@extend_schema(request=...)`, or add an entry to "
        "_BODY_DECLARATION_EXEMPT with the reason:\n  " + "\n  ".join(sorted(offenders))
    )


def test_the_body_declaration_rule_fires_on_the_shape_it_guards() -> None:
    """The gate must bite — a guard that cannot fail guards nothing.

    Reproduces each of the three routes to "no `requestBody`" that #3364 found in
    the tree, and pins the shapes that must keep passing so the rule cannot be
    widened into a no-op by a later simplification. Without this, a refactor that
    broke `_handler_source` would leave the sweep green over a tree it was no
    longer reading.
    """
    reads_body = "serializer = GitAutomationUpdateSerializer(data=request.data)"
    declared = {"requestBody": {"content": {"application/json": {"schema": {}}}}}
    bodyless: dict = {}
    # What `request=<bare schema dict>` actually generates. Included here because it
    # is the shape that passed the first draft of this gate — see
    # `declares_a_usable_request_body`.
    malformed = {
        "requestBody": {
            "content": {
                "type": {"schema": {"description": "Unspecified request body"}},
                "additionalProperties": {"schema": {}},
                "description": {"schema": {}},
            }
        }
    }

    # Fires: the three real routes into the class, plus the malformed declaration.
    assert operation_hides_a_body_its_handler_reads(bodyless, reads_body), (
        "a plain APIView reading request.data must be caught"
    )
    assert operation_hides_a_body_its_handler_reads(
        bodyless, "write_serializer = MyApiTokenCreateSerializer(data=request.data)"
    ), "a viewset create() reaching past an all-read-only serializer_class must be caught"
    assert operation_hides_a_body_its_handler_reads(
        bodyless, 'body = object_body(request)\nkey = body.get("x")'
    ), "the house object_body() helper must be caught"
    assert operation_hides_a_body_its_handler_reads(malformed, reads_body), (
        "a requestBody whose content keys are schema keywords rather than media "
        "types carries no shape a client can use — it must not read as declared"
    )
    assert operation_hides_a_body_its_handler_reads({"requestBody": {}}, reads_body), (
        "a requestBody with no content at all must not read as declared"
    )
    # The delegating shape, as `_handler_source` assembles it: a one-line handler
    # whose body read lives in the helper appended after it. Pinned because the
    # first draft read only the first frame and reported both
    # WorkspaceEmailSettingsView writes clean.
    assert operation_hides_a_body_its_handler_reads(
        bodyless,
        "def put(self, request):\n    return self._update(request, partial=False)\n"
        "\ndef _update(self, request, *, partial):\n"
        "    s = WorkspaceEmailSettingsSerializer(obj, data=request.data, partial=partial)",
    ), "a handler that delegates its body read to a helper must be caught"

    # Silent: a declared body is the fixed state, and a handler that never reads
    # the body is the majority of bodyless writes (an undo, a pin, a submit).
    assert not operation_hides_a_body_its_handler_reads(declared, reads_body), (
        "declaring the body is the fix — it must stop the rule firing"
    )
    assert not operation_hides_a_body_its_handler_reads(
        bodyless, "obj = self.get_object()\nobj.undo()\nreturn Response(status=204)"
    ), "a genuinely bodyless write must not be flagged"
    assert not operation_hides_a_body_its_handler_reads(bodyless, None), (
        "an unresolvable handler is reported by the sweep, not guessed at here"
    )


def test_no_request_body_declares_a_content_key_that_is_not_a_media_type() -> None:
    """Document-wide ratchet on the malformed-declaration shape (#3364).

    Scoped wider than the sweep above on purpose. That one only inspects operations
    whose handler reads the body, so a malformed `request=` on any other operation
    would still sail past it. This asserts the property directly, over every
    operation in the document, and needs no handler to do it: a `content` key
    without a `/` is not a media range, so drf-spectacular was handed something it
    read as one and silently discarded the real schema.
    """
    offenders = []
    for path, method, operation, _view in _write_operation_index():
        content = operation.get("requestBody", {}).get("content", {})
        bogus = sorted(key for key in content if "/" not in key)
        if bogus:
            offenders.append(f"{method} {path}: content keys {bogus} are not media types")
    assert not offenders, (
        "these operations declare a request body drf-spectacular could not parse — "
        "`request=` needs a serializer, an OpenApiTypes, an OpenApiRequest, or a "
        "{media_type: schema} mapping, NOT a bare schema dict (#3364):\n  " + "\n  ".join(offenders)
    )


def test_every_body_declaration_exemption_still_describes_a_real_operation() -> None:
    """Pin the opt-out in the other direction too (#3364).

    A stale exemption is worse than none: it reads as a reviewed decision about an
    operation that may have been renamed, fixed or deleted, and it silently
    subtracts that operation from the sweep for good. Same two-way discipline as
    `_STATE_REFUSAL_OPERATIONS` above — the list is the thing to change, and
    changing it is the moment somebody re-reads the handler.
    """
    live = {(method.lower(), path) for path, method, _operation, _view in _write_operation_index()}
    stale = sorted(key for key in _BODY_DECLARATION_EXEMPT if key not in live)
    assert not stale, (
        "these _BODY_DECLARATION_EXEMPT entries name no live write operation — "
        f"the operation moved or went away, so drop them (#3364): {stale}"
    )


#: The four operations that left `_STATE_REFUSAL_OPERATIONS` in #3364, and the
#: hand-written 400 each still declares.
#:
#: They left that set because they stopped being *bodyless*, not because their 400
#: changed — but `test_every_state_refusal_400_uses_one_of_the_three_real_wire_shapes`
#: iterates that set, so leaving it silently dropped the wire-shape assertion from
#: all four. Re-pinned here rather than left to be noticed later: a 400 declared in a
#: shape the API never returns makes a generated client throw while parsing the
#: error, before it can read the message, and that is exactly as true of an
#: operation with a request body as of one without.
_BODIED_HAND_DECLARED_400S: frozenset[tuple[str, str]] = frozenset(
    {
        ("post", "/api/v1/me/api-tokens/"),
        ("post", "/api/v1/programs/{program_pk}/api-tokens/"),
        ("post", "/api/v1/projects/{project_pk}/api-tokens/"),
    }
)


@pytest.mark.parametrize(("method", "path"), sorted(_BODIED_HAND_DECLARED_400S))
def test_token_create_400s_keep_a_real_wire_shape(schema: dict, method: str, path: str) -> None:
    """Each token-create 400 must stay a field-keyed object (#3319, #3364).

    All three answer with DRF's field-keyed body — `MyApiTokenCreateSerializer` /
    `ProjectApiTokenCreateSerializer` rejecting a field — and `/me/api-tokens/`
    additionally answers a flat `{"detail"}` when the active-token cap is reached.
    The field-keyed declaration admits both, because `additionalProperties` accepts
    the `detail` key too; a declaration narrowed to `detail` alone would mis-type
    the majority case.
    """
    op = schema["paths"][path][method]
    assert "requestBody" in op, (
        f"{method.upper()} {path} must keep the requestBody #3364 declared — "
        "losing it puts this operation back in the class the sweep exists to catch."
    )
    body = op["responses"]["400"]["content"]["application/json"]["schema"]
    assert body.get("type") == "object" and "additionalProperties" in body, (
        f"{method.upper()} {path} declares a 400 in a shape the API never returns (#3319): {body}"
    )
