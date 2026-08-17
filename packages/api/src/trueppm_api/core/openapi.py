"""OpenAPI / drf-spectacular customizations for SDK-quality schema output (#1333).

Generated clients (openapi-generator, Orval, openapi-typescript) key their method
names, doc comments, and API-class grouping off three schema facets that
drf-spectacular leaves thin by default:

* ``summary`` — the human label a client renders as the method doc comment. Without
  it, tools fall back to the raw ``operationId`` (``v1_calendars_exceptions_create``),
  which produces unreadable SDK docs.
* ``tags`` — the grouping key. drf-spectacular tags every ``/api/v1/`` operation
  ``"v1"`` by default, so a generated client collapses the whole API into a single
  ``V1Api`` class. Meaningful tags split it into ``ProjectsApi``, ``SprintsApi``,
  ``SchedulingApi``, … the way an SDK consumer expects.
* ``security`` — a global default plus explicit ``security: []`` on the public
  endpoints, so a client knows which calls need a credential and which do not.

Rather than hand-annotate ~300 view methods (error-prone, and every *new* endpoint
would silently regress coverage), the mechanical facets are filled by a single
post-processing hook that derives them from the request path — so coverage is
complete today and stays complete as endpoints are added. A view can still override
any facet with an explicit ``@extend_schema(...)``; the hook only fills what is
missing (summary) or still default (the ``"v1"`` tag).

The ``429`` documentation is injected by a custom :class:`AutoSchema` subclass
because throttling is a *view* attribute (``throttle_classes``) that is not visible
in the final schema dict — only the schema generator, which holds the view, can see
it.

The same subclass narrows ``security`` per-method on MCP-readable views (#2659):
``McpReadableViewMixin`` adds ``projectApiTokenAuth`` at the view level, but the
project/program-scoped credentials unique to that scheme are refused on the whole
MCP surface, so the unsafe methods must not advertise it. A ``legacy:full``
personal token *can* write there since #2877 and is described by
``personalApiTokenAuth``, which those operations already carry.
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.openapi import AutoSchema
from rest_framework.permissions import SAFE_METHODS

# ---------------------------------------------------------------------------
# Tag definitions
# ---------------------------------------------------------------------------

# The top-level ``tags`` block (name + description for each tag below) is declared
# in ``SPECTACULAR_SETTINGS["TAGS"]`` in settings/base.py — it is defined there
# rather than imported from here because Django settings must not import
# DRF-dependent app code. The two must stay in lockstep: every tag this module can
# assign is described in that block.

# Top-level path segment -> tag. Anything not listed falls through to the segment
# itself (which will already be a sensible resource name).
_TOP_TAG: dict[str, str] = {
    "acceptance-criteria": "tasks",
    "admin": "meta",
    "auth": "auth",
    "calendars": "calendars",
    "cascade-classification-operations": "projects",
    "dependencies": "tasks",
    "edition": "meta",
    "health": "meta",
    "import-templates": "import-export",
    "readyz": "meta",
    "integrations": "integrations",
    "me": "me",
    "paste-many-operations": "projects",
    "poker": "sprints",
    "programs": "programs",
    "project-resources": "resources",
    "project-templates": "projects",
    "projects": "projects",
    "recurrence-rules": "tasks",
    "resource-skills": "resources",
    "resources": "resources",
    "retro-items": "sprints",
    "scope-changes": "sprints",
    "share": "share",
    "skills": "resources",
    "slip-conflicts": "scheduling",
    "sprint-task-outcomes": "sprints",
    "sprints": "sprints",
    "task-resources": "resources",
    "task-runs": "tasks",
    "task-skill-requirements": "resources",
    "tasks": "tasks",
    "teams": "teams",
    "template-applications": "projects",
    "users": "workspace",
    "velocity-suggestions": "sprints",
    "workspace": "workspace",
    "ws": "sync",
    "workshops": "workshops",
}

# Second path segment under /projects/ or /programs/ -> tag, so nested resources
# land in their own SDK class instead of the umbrella Projects/Programs class.
_SUB_TAG: dict[str, str] = {
    "tasks": "tasks",
    "task": "tasks",
    "milestones": "tasks",
    "acceptance-results": "tasks",
    "acceptance-criteria": "tasks",
    "baseline": "scheduling",
    "baselines": "scheduling",
    "schedule": "scheduling",
    "scheduler": "scheduling",
    "monte-carlo": "scheduling",
    "forecast": "scheduling",
    "risk": "scheduling",
    "risks": "scheduling",
    "slip-conflicts": "scheduling",
    "critical-path": "scheduling",
    "sprints": "sprints",
    "sprint": "sprints",
    "sprint-health": "sprints",
    "velocity": "sprints",
    "retrospective": "sprints",
    "standup": "sprints",
    "burn": "sprints",
    "board": "sprints",
    "product-backlog": "sprints",
    "queue": "sprints",
    "ceremonies": "sprints",
    "backlog": "sprints",
    "resources": "resources",
    "resource-allocation": "resources",
    "resource-contention": "resources",
    "utilization": "resources",
    "members": "members",
    "teams": "teams",
    "webhooks": "webhooks",
    "integrations": "integrations",
    "integrations-summary": "integrations",
    "import": "import-export",
    "imports": "import-export",
    "export": "import-export",
    "share-links": "share",
}

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------

# The default requirement advertised at the document root: a caller authenticates
# with either a bearer JWT or the session cookie. Operations that accept a project
# API token additionally list ``projectApiTokenAuth`` on their own operation-level
# ``security`` (emitted by drf-spectacular from the view's authentication classes).
GLOBAL_SECURITY: list[dict[str, list[str]]] = [{"jwtAuth": []}, {"cookieAuth": []}]

# Endpoints that require no credential at all. They must carry an explicit
# ``security: []`` so a generated client does not attach a (non-existent) token.
PUBLIC_PATHS: frozenset[str] = frozenset(
    {
        "/api/v1/auth/logout/",
        "/api/v1/auth/oidc/callback/",
        "/api/v1/auth/oidc/discover/",
        "/api/v1/auth/oidc/login/",
        "/api/v1/auth/token/",
        "/api/v1/auth/token/refresh/",
        "/api/v1/edition/",
        "/api/v1/health/",
        "/api/v1/readyz",
        "/api/v1/integrations/projects/{project_pk}/git-webhook/",
        "/api/v1/workspace/invites/accept/",
        "/api/v1/workspace/logo/",
    }
)

_HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options", "trace")

# Attribute stamped on a viewset ``@action`` handler to opt its list response out
# of drf-spectacular's automatic pagination-envelope wrapping (see
# :func:`suppress_list_pagination` and :meth:`TruePPMAutoSchema._get_paginator`).
_SUPPRESS_PAGINATION_ATTR = "spectacular_suppress_pagination"


def suppress_list_pagination(view_func: Any) -> Any:
    """Mark a viewset ``@action``'s list response as NON-paginated for the schema.

    drf-spectacular auto-wraps any ``many=True`` response of a view whose
    ``pagination_class`` is set in that paginator's envelope
    (``Paginated…List``). Actions that deliberately return a **bare array** — a
    small, capped, or fixed-size list the client consumes directly — must opt out
    so the generated schema matches the real response body; otherwise the
    committed schema claims a paginated object and every such response fails
    ``response_schema_conformance`` (#2127). Pairs with
    :meth:`TruePPMAutoSchema._get_paginator`.
    """
    setattr(view_func, _SUPPRESS_PAGINATION_ATTR, True)
    return view_func


_IRREGULAR_SINGULAR = {
    "criteria": "criterion",
    "analyses": "analysis",
    "indices": "index",
    "people": "person",
}

# Verbs used for standard CRUD-style detail operations, keyed by HTTP method.
_DETAIL_VERB = {
    "get": "Retrieve",
    "put": "Update",
    "patch": "Partially update",
    "delete": "Delete",
    "post": "Update",
}


def _humanize(segment: str) -> str:
    """``acceptance-results`` -> ``acceptance results`` (lower, space-separated)."""
    return segment.replace("-", " ").replace("_", " ").strip().lower()


def _singularize(phrase: str) -> str:
    """Singularize the last word of a humanized phrase (naive, with irregulars)."""
    if not phrase:
        return phrase
    words = phrase.split()
    last = words[-1]
    if last in _IRREGULAR_SINGULAR:
        singular = _IRREGULAR_SINGULAR[last]
    elif last.endswith("ies") and len(last) > 3:
        singular = last[:-3] + "y"
    elif last.endswith(("ses", "xes", "ches", "shes")):
        singular = last[:-2]
    elif last.endswith("s") and not last.endswith("ss"):
        singular = last[:-1]
    else:
        singular = last
    words[-1] = singular
    return " ".join(words)


def _sentence_case(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def _path_segments(path: str) -> list[str]:
    """Path parts with the ``api``/``v1`` prefix stripped."""
    return [p for p in path.split("/") if p and p not in ("api", "v1")]


def _derive_tag(path: str) -> str:
    segments = _path_segments(path)
    literals = [p for p in segments if not (p.startswith("{") and p.endswith("}"))]
    if not literals:
        return "meta"
    top = literals[0]
    if top in ("projects", "programs") and len(literals) > 1:
        return _SUB_TAG.get(literals[1], top)
    return _TOP_TAG.get(top, top)


def _derive_summary(path: str, method: str, collection_paths: frozenset[str]) -> str:
    """Build a human ``summary`` from the request path and HTTP method.

    The path structure disambiguates the three shapes an SDK cares about:
    collection (``List``/``Create``), detail-by-id (``Retrieve``/``Update``/…) and
    custom action (``Accept``/``Close``/…). A trailing literal is a *collection*
    when a child ``.../{id}/`` path exists, otherwise it is treated as an action
    (POST) or a singleton sub-resource (GET/PUT/PATCH/DELETE).
    """
    method = method.lower()
    segments = _path_segments(path)
    if not segments:
        return _sentence_case(method)

    last = segments[-1]

    # Detail-by-id: the resource is the collection immediately above the id.
    if last.startswith("{") and last.endswith("}"):
        return _detail_summary(segments, method)

    # Trailing literal that owns a ``.../{id}/`` route -> a collection.
    normalized = path if path.endswith("/") else path + "/"
    if normalized in collection_paths:
        return _collection_summary(last, method)

    # Trailing literal with no child id route: a custom action (POST) or a
    # singleton sub-resource (safe/idempotent methods).
    return _action_summary(segments, method)


def _detail_summary(segments: list[str], method: str) -> str:
    """Summary for a detail-by-id path: ``<verb> <singular resource>``."""
    parent = segments[-2] if len(segments) > 1 else segments[-1]
    resource = _singularize(_humanize(parent))
    return f"{_DETAIL_VERB.get(method, 'Retrieve')} {resource}"


def _collection_summary(last: str, method: str) -> str:
    """Summary for a collection path: ``List``/``Create``/``<verb>`` the resource."""
    human = _humanize(last)
    if method == "get":
        return f"List {human}"
    if method == "post":
        return f"Create {_singularize(human)}"
    return f"{_DETAIL_VERB.get(method, 'Update')} {_singularize(human)}"


def _action_summary(segments: list[str], method: str) -> str:
    """Summary for a custom action (POST) or singleton sub-resource (safe methods)."""
    last = segments[-1]
    preceding_literals = [p for p in segments[:-1] if not (p.startswith("{") and p.endswith("}"))]
    owner_segment = preceding_literals[-1] if preceding_literals else last
    has_parent_id = any(p.startswith("{") and p.endswith("}") for p in segments[:-1])

    if method == "post":
        verb = _sentence_case(_humanize(last))
        owner_human = _humanize(owner_segment)
        owner = _singularize(owner_human) if has_parent_id else owner_human
        if owner_segment == last:
            return verb
        return f"{verb} {owner}"

    return f"{_DETAIL_VERB.get(method, 'Retrieve')} {_singularize(_humanize(last))}"


def _collection_paths(paths: dict[str, Any]) -> frozenset[str]:
    """Paths that own a child ``.../{param}/`` route (i.e. real collections)."""
    collections: set[str] = set()
    for path in paths:
        segments = path.rstrip("/").split("/")
        if not segments:
            continue
        tail = segments[-1]
        if tail.startswith("{") and tail.endswith("}"):
            parent = "/".join(segments[:-1]) + "/"
            collections.add(parent)
    return frozenset(collections)


def postprocess_openapi(
    result: dict[str, Any],
    generator: Any,
    request: Any,
    public: bool,
    **kwargs: Any,
) -> dict[str, Any]:
    """Fill SDK-quality facets the per-view annotations leave thin (#1333).

    * add a derived ``summary`` to every operation that lacks one;
    * replace the default ``"v1"`` tag with a meaningful resource tag;
    * set a document-level ``security`` default and mark public paths ``security: []``.

    Explicit ``@extend_schema`` values are never overwritten — a non-default tag is
    kept, and an existing summary is left untouched.
    """
    paths = result.get("paths", {})
    collection_paths = _collection_paths(paths)

    for path, operations in paths.items():
        is_public = path in PUBLIC_PATHS
        for method, operation in operations.items():
            if method not in _HTTP_METHODS or not isinstance(operation, dict):
                continue
            _annotate_operation(operation, path, method, collection_paths, is_public)

    # Document-level default so a client knows the baseline auth scheme.
    result["security"] = list(GLOBAL_SECURITY)
    return result


def _annotate_operation(
    operation: dict[str, Any],
    path: str,
    method: str,
    collection_paths: frozenset[str],
    is_public: bool,
) -> None:
    """Fill a single operation's ``summary``/``tags``/``security`` in place.

    Explicit ``@extend_schema`` values are preserved: an existing summary and a
    non-default tag are left untouched.
    """
    if not operation.get("summary"):
        operation["summary"] = _derive_summary(path, method, collection_paths)

    tags = operation.get("tags")
    if not tags or tags == ["v1"]:
        operation["tags"] = [_derive_tag(path)]

    if is_public:
        operation["security"] = []


# ---------------------------------------------------------------------------
# 429 documentation via a custom AutoSchema
# ---------------------------------------------------------------------------

# The 403 an API-token caller receives on the credential-management surface (#2878).
# Declared on every operation whose view carries ``IsNotTokenAuthenticated``, so an
# integrator scripting against a token learns from the contract that this refusal is
# by design rather than discovering it as an apparent permissions bug.
_TOKEN_REFUSED_RESPONSE = {
    "description": (
        "Refused because the caller authenticated with an API token. Managing API "
        "tokens requires a session or JWT — a token cannot mint, list, or revoke "
        "tokens, so that revoking a leaked credential is actual containment. The "
        "``refusal`` envelope carries ``reason: policy`` and ``constraint: "
        "capability_scope``. A token that is revoked, expired, or carries the wrong "
        "scope for this surface is rejected earlier, by the authenticator, and "
        "receives ``401`` with ``reason: identity`` instead."
    ),
    "content": {
        "application/json": {
            "schema": {
                "type": "object",
                "properties": {
                    "detail": {
                        "type": "string",
                        "example": (
                            "API tokens cannot manage API tokens. Sign in to create, "
                            "list, or revoke tokens."
                        ),
                    },
                    "refusal": {
                        "type": "object",
                        "properties": {
                            "verdict": {"type": "string", "example": "refused"},
                            "reason": {"type": "string", "example": "policy"},
                            "constraint": {"type": "string", "example": "capability_scope"},
                        },
                    },
                },
            }
        }
    },
}

_THROTTLE_RESPONSE = {
    "description": (
        "Rate limit exceeded. The client is issuing requests faster than the "
        "endpoint's throttle allows; retry after the interval in the "
        "``Retry-After`` response header."
    ),
    "content": {
        "application/json": {
            "schema": {
                "type": "object",
                "properties": {
                    "detail": {
                        "type": "string",
                        "example": "Request was throttled. Expected available in 42 seconds.",
                    }
                },
            }
        }
    },
}


class TruePPMAutoSchema(AutoSchema):
    """AutoSchema that documents a ``429`` response on rate-limited operations, and
    keeps the ``projectApiTokenAuth`` security scheme honest on MCP-readable views.

    Throttling is a view attribute (``throttle_classes``) invisible to the final
    schema dict, so 429 documentation has to happen here — where the generated
    operation and its view are both in hand — rather than in a post-processing hook.
    Only statically-declared ``throttle_classes`` are considered; that covers every
    scoped/dedicated throttle in the codebase (login, refresh, ws-ticket,
    user-search, credential rotation, Monte Carlo what-if, invite accept/resend,
    resource catalog, Git webhook, inbound task-sync and acceptance-result reporting).
    """

    def get_auth(self) -> list[dict[str, Any]]:
        """Drop ``projectApiTokenAuth`` from unsafe operations on MCP-readable views (#2659).

        ``McpReadableViewMixin.get_authenticators`` prepends
        ``ProjectApiTokenAuthentication`` at the *view* level (so a token is
        recognized on every action), but drf-spectacular's default ``get_auth()``
        reads ``view.get_authenticators()`` with no awareness of *which* method is
        being documented — so it attached ``projectApiTokenAuth`` to every method on
        the view, including the unsafe ones no credential unique to that scheme can
        reach. That made the schema advertise 82 write operations
        (POST/PUT/PATCH/DELETE) as project/program-token-writable when they are not.

        The rule the filter describes changed shape in #2877 but not in outcome.
        Before: ``TokenReadOnlyMethods`` refused *every* token an unsafe method on
        these views. Now a ``legacy:full`` personal access token may write here — but
        that credential is described by the **``personalApiTokenAuth``** scheme,
        which these operations already advertise through the default authentication
        stack. The credentials unique to ``projectApiTokenAuth`` are the project- and
        program-scoped tokens, and those are still refused on this whole surface by
        ``TokenIsOwnerScoped`` (401), so the scheme remains unreachable for an unsafe
        method and must not be advertised. Both schemes are ``http bearer`` with the
        same ``tppm_<64-hex>`` format, so a client reading the schema is told exactly
        the header it needs.

        This method and its view are the one place drf-spectacular hands both to the
        same call, so the filter belongs here rather than in the mixin (which has no
        reason to know about schema generation) or in a blanket post-processing hook
        (which would also strip the scheme from ``TaskSyncView`` /
        ``AcceptanceResultIngestView`` — two views that reference
        ``ProjectApiTokenAuthentication`` directly to *accept* a token write, and
        must keep advertising it).
        """
        auth = super().get_auth()
        if self._mcp_scoped_token_write_unreachable():
            auth = [entry for entry in auth if "projectApiTokenAuth" not in entry]
        if self._token_callers_refused():
            auth = [
                entry
                for entry in auth
                if "projectApiTokenAuth" not in entry and "personalApiTokenAuth" not in entry
            ]
        return auth

    def _token_callers_refused(self) -> bool:
        """Whether this view refuses every API token outright (``IsNotTokenAuthenticated``).

        The credential-management surface is session/JWT only since #2878, so neither
        token scheme is reachable on any of its operations and the schema must not
        advertise them — an integrator reading it would otherwise write a script that
        cannot possibly work, against the one surface where the failure looks like a
        permissions bug rather than a deliberate refusal.

        Read off ``permission_classes`` rather than ``get_permissions()`` because schema
        generation has no request to resolve per-action permissions against; every view
        carrying the guard declares it statically, which is also what makes the
        route-table tripwire in ``tests/apps/access/test_route_table_invariants.py``
        sound.
        """
        from trueppm_api.apps.access.permissions import IsNotTokenAuthenticated

        classes = getattr(self.view, "permission_classes", []) or []
        return any(cls is IsNotTokenAuthenticated for cls in classes)

    def _mcp_scoped_token_write_unreachable(self) -> bool:
        """Whether this operation is an unsafe method on an ``McpReadableViewMixin`` view.

        On such an operation the project/program-scoped credentials that
        ``projectApiTokenAuth`` uniquely describes are refused by
        ``TokenIsOwnerScoped``, which applies to every ``ApiToken`` on the MCP
        surface regardless of scope and regardless of method — so the predicate
        stays a plain "unsafe method on the mixin" and does not need to restate the
        scope logic (#2877).
        """
        from trueppm_api.apps.access.permissions import McpReadableViewMixin

        return isinstance(self.view, McpReadableViewMixin) and self.method not in SAFE_METHODS

    def get_operation(
        self,
        path: str,
        path_regex: str,
        path_prefix: str,
        method: str,
        registry: Any,
    ) -> dict[str, Any] | None:
        operation = super().get_operation(path, path_regex, path_prefix, method, registry)
        if operation is None:
            return operation

        throttle_classes = getattr(self.view, "throttle_classes", None)
        if throttle_classes:
            responses = operation.setdefault("responses", {})
            responses.setdefault("429", dict(_THROTTLE_RESPONSE))
        if self._token_callers_refused():
            # Declared here rather than by decorating each view for the same reason as
            # the 429 above: the fact lives in a view attribute the schema dict cannot
            # see, and one injection point cannot drift from the permission class the
            # way fifteen hand-written `@extend_schema` blocks would (#2878).
            responses = operation.setdefault("responses", {})
            responses.setdefault("403", dict(_TOKEN_REFUSED_RESPONSE))
        return operation

    def _get_paginator(self) -> Any:
        """Return ``None`` for actions marked with :func:`suppress_list_pagination`.

        drf-spectacular paginates a ``many=True`` response whenever the view has a
        ``pagination_class``. An ``@action`` that returns a bare array opts out via
        the marker so its schema is a plain array, not a pagination envelope
        (#2127). Every other action falls through to the default behaviour.
        """
        action = getattr(self.view, "action", None)
        if action:
            handler = getattr(self.view, action, None)
            if handler is not None and getattr(handler, _SUPPRESS_PAGINATION_ATTR, False):
                return None
        # drf-spectacular's AutoSchema is untyped; the base return is a paginator or None.
        return super()._get_paginator()  # type: ignore[no-untyped-call]
