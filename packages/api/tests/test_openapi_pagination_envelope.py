"""The declared pagination envelope and the paginating handler must agree, both ways.

Two directions, two root causes, two tests. Forward (#2515): every declared
envelope must be backed by a paginating handler — the schema over-promises.
Reverse (#2583): every paginating handler must declare an envelope — the code
over-delivers. Neither subsumes the other; each walks a set the other cannot see.

## Forward — a declared envelope must be backed by a paginating handler (#2515)

``ProgramViewSet``, ``ProjectViewSet`` and friends set a ``pagination_class``, and
drf-spectacular wraps *any* ``many=True`` response on such a view in that
paginator's ``Paginated…List`` envelope. A custom ``@action`` that returns a bare
array therefore has to opt out with
:func:`trueppm_api.core.openapi.suppress_list_pagination`; forget it and the
committed schema promises ``{count, next, previous, results}`` while the endpoint
returns a list. Nothing in the per-MR gates notices: ``api:schema-drift`` only
proves the committed schema matches the generator that produced it, and both sides
are wrong together. It surfaces a night later as a ``response_schema_conformance``
failure in ``api:fuzz`` — that is how #2515 (`GET /programs/samples/`, regressed by
#2490) and #2213/#2127 before it were found.

This test closes that loop at MR time. It reads the generated schema for the
operations that *claim* an envelope, maps each back to the view and action that
serve it, and requires the handler to actually paginate. The check is deliberately
schema-first rather than code-first: the envelope in the schema is the promise
being made, so enumerating promises and demanding each be kept cannot miss a case
by failing to recognize some new way of declaring a list response.

## Reverse — a paginating handler must declare an envelope (#2583)

The forward test walks operations that already claim an envelope, so it is blind
to an operation that claims none. ``GET /workspace/audit-events/`` published
``type: array`` while returning ``{next, previous, results}``: a plain ``APIView``
building its paginator inline is invisible to drf-spectacular's auto-wrap
heuristic, which reads the *view's* ``pagination_class``. The reverse test starts
from the code instead — every handler that reaches ``get_paginated_response`` —
and demands the declaration be able to accept what that handler returns.
"""

from __future__ import annotations

import inspect
import re
from typing import Any

from drf_spectacular.generators import SchemaGenerator
from rest_framework.pagination import CursorPagination

# The envelope component names drf-spectacular mints per paginated serializer.
_ENVELOPE_NAME = re.compile(r"^Paginated\w*List$")

# Either call proves the handler runs the response through DRF pagination, so the
# envelope it declares is the shape it really returns.
_PAGINATING_CALLS = ("paginate_queryset", "get_paginated_response")

_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})


def _envelope_operations(schema: dict[str, Any]) -> list[tuple[str, str, str]]:
    """``(path, METHOD, component_name)`` for every 200 that declares an envelope."""
    found = []
    for path, operations in schema.get("paths", {}).items():
        for method, operation in operations.items():
            if method.lower() not in _HTTP_METHODS:
                continue
            ref = (
                operation.get("responses", {})
                .get("200", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
                .get("$ref", "")
            )
            component = ref.rsplit("/", 1)[-1]
            if _ENVELOPE_NAME.match(component):
                found.append((path, method.upper(), component))
    return found


def _view_index() -> dict[tuple[str, str], Any]:
    """Map ``(path, METHOD)`` to the view instance drf-spectacular used, ``.action`` set.

    This is the same enumeration the schema generator itself walks, so the paths
    are already normalized (``{id}``, not ``<uuid:pk>``) and line up with the keys
    in the generated document without any re-derivation on our side.
    """
    generator = SchemaGenerator()
    generator.parse(None, public=True)
    return {
        (path, method.upper()): view
        for path, _regex, method, view in generator._get_paths_and_endpoints()
    }


def test_declared_pagination_envelopes_are_backed_by_a_paginating_handler() -> None:
    schema = SchemaGenerator().get_schema(request=None, public=True)
    views = _view_index()

    offenders = []
    for path, method, component in _envelope_operations(schema):
        view = views.get((path, method))
        if view is None:
            # An operation whose view can't be resolved is a mapping bug in this
            # test, not an API defect — surface it rather than passing silently.
            offenders.append(f"{method} {path} -> {component} (no view resolved)")
            continue

        action = getattr(view, "action", None)
        handler = getattr(type(view), action, None) if action else None
        if handler is None:
            continue

        # The stock list/mixin handler paginates by construction; only custom
        # ``@action`` methods (which carry the router's ``mapping``) can drift.
        if not hasattr(handler, "mapping"):
            continue

        try:
            source = inspect.getsource(handler)
        except (OSError, TypeError):  # pragma: no cover - handler without source
            continue

        if any(call in source for call in _PAGINATING_CALLS):
            continue

        offenders.append(
            f"{method} {path} -> {component} ({type(view).__name__}.{action} returns a bare body)"
        )

    assert not offenders, (
        "These operations declare a pagination envelope but their handler never "
        "paginates. Either paginate the response, or decorate the action with "
        "@suppress_list_pagination so the schema declares a plain array:\n  "
        + "\n  ".join(sorted(offenders))
    )


# ---------------------------------------------------------------------------
# The reverse direction: a paginating handler must DECLARE its envelope (#2583)
# ---------------------------------------------------------------------------

# A locally-constructed paginator — ``paginator = AuditEventCursorPagination()``
# inside the handler body. This is the shape drf-spectacular cannot see: its
# auto-wrap heuristic reads the *view's* ``pagination_class`` attribute, so a plain
# ``APIView`` that builds its paginator inline paginates for real while the
# generator believes the view has no paginator at all.
_LOCAL_PAGINATOR = re.compile(r"=\s*\w*Pagination\(\)")

# ``get_paginated_response`` is the discriminating call, not ``paginate_queryset``:
# the latter appears in the ``page = self.paginate_queryset(...); if page is not
# None:`` idiom, whose ``else`` branch legitimately returns a bare array when the
# view has no paginator configured. Reaching ``get_paginated_response`` at all
# means an envelope is what goes on the wire.
_ENVELOPE_CALL = "get_paginated_response"

# The paginator class name in ``paginator = WebhookDeliveryCursorPagination()``,
# so the rule can resolve the class and ask what envelope it really emits.
_LOCAL_PAGINATOR_NAME = re.compile(r"=\s*(\w*Pagination)\(\)")


def _local_paginator_class(handler: Any, source: str) -> type | None:
    """Resolve the paginator a handler instantiates inline, from its own module."""
    match = _LOCAL_PAGINATOR_NAME.search(source)
    if match is None:
        return None
    module = inspect.getmodule(handler)
    candidate = getattr(module, match.group(1), None)
    return candidate if isinstance(candidate, type) else None


def declares_a_count_no_cursor_can_produce(
    schema_node: dict[str, Any], components: dict[str, Any]
) -> bool:
    """Does this declaration REQUIRE a ``count`` field?

    A cursor paginator deliberately never computes a total — that is what makes it
    O(1) at any depth — so ``CursorPagination.get_paginated_response`` emits only
    ``{next, previous, results}``. An envelope that lists ``count`` in ``required``
    therefore cannot be satisfied, and a typed client that models ``count`` as
    non-optional breaks on the first call.

    ``count`` merely *present* in ``properties`` is not flagged: an optional field
    an endpoint never sends is thin documentation, not a broken contract. Only the
    ``required`` promise is a promise.
    """
    resolved = _resolve(schema_node, components)
    return "count" in resolved.get("required", [])


def _resolve(schema_node: dict[str, Any], components: dict[str, Any]) -> dict[str, Any]:
    """Follow ``$ref`` chains into ``components/schemas`` (bounded, so a cycle can't hang)."""
    for _ in range(5):
        ref = schema_node.get("$ref")
        if not ref:
            break
        schema_node = components.get(ref.rsplit("/", 1)[-1], {})
    return schema_node


def can_describe_an_envelope(schema_node: dict[str, Any], components: dict[str, Any]) -> bool:
    """Could a ``{…, results: [...]}`` body validate against this declared schema?

    Deliberately permissive: this guard exists to catch declarations that are
    *impossible*, not merely thin. A bare ``type: object`` with no properties (what
    ``OpenApiTypes.OBJECT`` emits) accepts an envelope, so it passes even though it
    tells an SDK little — under-specifying is a documentation-quality question, and
    conflating it with a contract violation would bury the real signal. What cannot
    accept an envelope: a declared array, and a declaration with no schema at all.
    """
    if not schema_node:
        return False
    resolved = _resolve(schema_node, components)
    if not resolved:
        return False
    if resolved.get("type") == "array":
        return False
    properties = resolved.get("properties")
    if properties is None:
        # An object with no declared properties accepts any object, envelope included.
        return resolved.get("type") in (None, "object")
    return "results" in properties


def test_every_paginating_handler_declares_its_envelope() -> None:
    """A handler that returns ``get_paginated_response`` must not publish a bare array.

    The mirror image of the test above, and a distinct root cause: there the
    schema over-promises an envelope the code does not produce, here the code
    produces an envelope the schema does not admit. ``GET /workspace/audit-events/``
    shipped ``type: array`` while returning ``{next, previous, results}``, so a
    generated SDK broke the moment it iterated the response (#2583). It went
    unnoticed because both existing gates are structurally blind to it:
    ``api:schema-drift`` only proves the committed file matches the generator (it
    did — the generator was faithfully wrong), and the forward test above only
    walks operations that *already* declare an envelope.

    ``@extend_schema`` was present and explicit on that view, so a static "every
    action must declare responses" rule would not have caught it either. The
    handler's own source is the only reliable witness that pagination happens.
    """
    schema = SchemaGenerator().get_schema(request=None, public=True)
    components = schema.get("components", {}).get("schemas", {})
    views = _view_index()

    offenders = []
    for path, operations in schema.get("paths", {}).items():
        for method, operation in operations.items():
            if method.lower() not in _HTTP_METHODS:
                continue
            view = views.get((path, method.upper()))
            if view is None:
                continue

            action = getattr(view, "action", None)
            handler = (
                getattr(type(view), action, None)
                if action
                else getattr(type(view), method.lower(), None)
            )
            if handler is None:
                continue
            try:
                source = inspect.getsource(handler)
            except (OSError, TypeError):  # pragma: no cover - handler without source
                continue

            if _ENVELOPE_CALL not in source:
                continue
            # Only when a paginator really exists: either the view declares one (so
            # DRF's mixin path paginates) or the handler builds its own.
            has_paginator = getattr(view, "pagination_class", None) is not None or bool(
                _LOCAL_PAGINATOR.search(source)
            )
            if not has_paginator:
                continue

            declared = (
                operation.get("responses", {})
                .get("200", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
            )
            shown = (
                declared.get("$ref", "").rsplit("/", 1)[-1] or declared.get("type") or "no schema"
            )
            where = f"{type(view).__name__}.{action or method.lower()}"

            if not can_describe_an_envelope(declared, components):
                offenders.append(f"{method.upper()} {path} -> {shown} ({where} paginates)")
                continue

            # The declaration admits *an* envelope — but is it the right one? A
            # handler that builds a cursor paginator inline is doubly invisible to
            # auto-wrap: the heuristic both misses that it paginates AND, when the
            # viewset separately declares a page-number pagination_class, wraps it
            # in that paginator's envelope instead. That publishes a required
            # ``count`` no cursor response can carry.
            paginator_class = _local_paginator_class(handler, source)
            if (
                paginator_class is not None
                and issubclass(paginator_class, CursorPagination)
                and declares_a_count_no_cursor_can_produce(declared, components)
            ):
                offenders.append(
                    f"{method.upper()} {path} -> {shown} "
                    f"({where} paginates with {paginator_class.__name__}, "
                    "which never emits the `count` this schema requires)"
                )

    assert not offenders, (
        "These handlers return a pagination envelope their declared 200 cannot "
        "describe. Declare the envelope explicitly with an inline_serializer — "
        "next/previous/results, plus count ONLY for page-number pagination — so a "
        "generated SDK is not handed a type the endpoint never returns:\n  "
        + "\n  ".join(sorted(offenders))
    )


def test_the_envelope_predicate_rejects_what_it_must() -> None:
    """The guard must actually fire — a guard that cannot fail guards nothing.

    Pins both #2583 instances' declared shapes plus the shapes that must keep
    passing, so a future "simplification" of the predicate cannot quietly widen it
    into a no-op.
    """
    components = {
        "AuditEvent": {"type": "object", "properties": {"id": {"type": "string"}}},
        "AuditEventCursorPage": {
            "type": "object",
            "properties": {
                "next": {"type": "string"},
                "previous": {"type": "string"},
                "results": {"type": "array"},
            },
        },
        "Sprint": {"type": "object", "properties": {"id": {"type": "string"}}},
    }

    # The two real #2583 declarations, and the "no annotation at all" case.
    assert not can_describe_an_envelope(
        {"type": "array", "items": {"$ref": "#/components/schemas/AuditEvent"}}, components
    ), "a declared array can never accept a {next, previous, results} body"
    assert not can_describe_an_envelope({"$ref": "#/components/schemas/Sprint"}, components), (
        "an object whose properties omit `results` cannot accept an envelope"
    )
    assert not can_describe_an_envelope({}, components), "an absent schema declares nothing"

    # The shapes that must keep passing.
    assert can_describe_an_envelope(
        {"$ref": "#/components/schemas/AuditEventCursorPage"}, components
    )
    assert can_describe_an_envelope({"type": "object", "additionalProperties": {}}, components), (
        "OpenApiTypes.OBJECT is thin but not false — do not fail it here"
    )


def test_the_cursor_count_predicate_rejects_what_it_must() -> None:
    """A cursor endpoint may not REQUIRE a ``count`` it structurally cannot send.

    The second half of the reverse rule, and the one that catches an envelope
    which is present and plausible but belongs to the wrong paginator — the shape
    ``GET /webhooks/{id}/deliveries/`` shipped, where a page-number
    ``pagination_class`` on the viewset wrapped a cursor-paginated action.
    """
    components = {
        "PaginatedWebhookDeliveryList": {
            "type": "object",
            "required": ["count", "results"],
            "properties": {
                "count": {"type": "integer"},
                "next": {"type": "string"},
                "previous": {"type": "string"},
                "results": {"type": "array"},
            },
        },
        "WebhookDeliveryCursorPage": {
            "type": "object",
            "required": ["next", "previous", "results"],
            "properties": {
                "next": {"type": "string"},
                "previous": {"type": "string"},
                "results": {"type": "array"},
            },
        },
    }

    assert declares_a_count_no_cursor_can_produce(
        {"$ref": "#/components/schemas/PaginatedWebhookDeliveryList"}, components
    ), "a page-number envelope on a cursor handler requires a count that never arrives"
    assert not declares_a_count_no_cursor_can_produce(
        {"$ref": "#/components/schemas/WebhookDeliveryCursorPage"}, components
    ), "the cursor envelope is the fix, not a finding"
    assert not declares_a_count_no_cursor_can_produce(
        {
            "type": "object",
            "properties": {"count": {"type": "integer"}, "results": {"type": "array"}},
        },
        components,
    ), "an OPTIONAL count is thin documentation, not a broken promise"
