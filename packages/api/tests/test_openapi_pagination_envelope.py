"""Every declared pagination envelope must be backed by a paginating handler (#2515).

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
"""

from __future__ import annotations

import inspect
import re
from typing import Any

from drf_spectacular.generators import SchemaGenerator

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
