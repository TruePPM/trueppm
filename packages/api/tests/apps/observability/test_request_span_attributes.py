"""HTTP request-span ``trueppm.*`` attributes (#2880).

The emitter's contract is narrower than "put ids on the span", and each clause here
guards a way it could go quietly wrong:

* **Absent beats wrong** — ``project-templates/<pk>`` is not a project and
  ``task-relations/<pk>`` is not a task, so a prefix match would mislabel a large
  slice of the API. Those cases must contribute nothing.
* **Well-defined beats populated** — TruePPM roles are project-scoped (ADR-0072), so
  ``trueppm.user.role`` is set only when exactly one project was authorized. A list
  endpoint that checked forty projects must carry no role rather than an arbitrary one.
* **No extra query** — an unevaluated ``SimpleLazyObject`` user is left alone. If the
  annotator dereferenced it, turning telemetry on would add a session round trip to
  requests that never needed one.
* **Never raises** — this runs in the response path.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from django.test import RequestFactory, override_settings
from django.utils.functional import SimpleLazyObject
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    PROGRAM_RBAC_ROLE_CACHE_ATTR,
    RBAC_ROLE_CACHE_ATTR,
)
from trueppm_api.apps.observability.otel import attributes
from trueppm_api.apps.observability.otel.request_attributes import annotate_request_span

PROJECT_ROUTE = "api/v1/^projects/(?P<pk>[^/.]+)/$"
TASK_ROUTE = "api/v1/^tasks/(?P<pk>[^/.]+)/$"
PROGRAM_ROUTE = "api/v1/^programs/(?P<pk>[^/.]+)/$"


@pytest.fixture
def exporter() -> Iterator[InMemorySpanExporter]:
    exp = InMemorySpanExporter()
    yield exp
    exp.clear()


@pytest.fixture
def tracer(exporter: InMemorySpanExporter) -> Any:
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("test")


def make_request(
    *,
    route: str = "",
    kwargs: dict[str, Any] | None = None,
    user: Any = None,
    has_resolver_match: bool = True,
) -> Any:
    request = RequestFactory().get("/api/v1/")
    if has_resolver_match:
        request.resolver_match = type("Match", (), {"route": route, "kwargs": kwargs or {}})()
    if user is not None:
        request.user = user
    return request


def make_user(pk: Any = None) -> Any:
    return type("U", (), {"pk": pk or uuid.uuid4(), "is_authenticated": True})()


def annotate(tracer: Any, exporter: InMemorySpanExporter, request: Any) -> dict[str, Any]:
    span = tracer.start_span("GET /api/v1/")
    annotate_request_span(span, request, None)
    span.end()
    spans = exporter.get_finished_spans()
    return dict(spans[-1].attributes or {})


class TestResourceIds:
    def test_project_detail_route_sets_project_id(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        pid = str(uuid.uuid4())
        attrs = annotate(tracer, exporter, make_request(route=PROJECT_ROUTE, kwargs={"pk": pid}))
        assert attrs[attributes.PROJECT_ID] == pid

    def test_task_and_program_detail_routes(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        tid, gid = str(uuid.uuid4()), str(uuid.uuid4())
        assert (
            annotate(tracer, exporter, make_request(route=TASK_ROUTE, kwargs={"pk": tid}))[
                attributes.TASK_ID
            ]
            == tid
        )
        assert (
            annotate(tracer, exporter, make_request(route=PROGRAM_ROUTE, kwargs={"pk": gid}))[
                attributes.PROGRAM_ID
            ]
            == gid
        )

    def test_path_converter_routes_are_recognized_too(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        """Not every project route is a DRF router regex — `path()` routes exist.

        `projects/<pk>/board-config/` is registered with `path()`, so the pk capture
        renders as `<pk>` rather than `(?P<pk>…)`. A regex that only knew the router
        form would drop the attribute on every hand-registered route.
        """
        pid = str(uuid.uuid4())
        attrs = annotate(
            tracer,
            exporter,
            make_request(route="api/v1/projects/<pk>/board-config/", kwargs={"pk": pid}),
        )
        assert attrs[attributes.PROJECT_ID] == pid

    @pytest.mark.parametrize(
        "route",
        [
            "api/v1/^project-templates/(?P<pk>[^/.]+)/$",
            "api/v1/^project-resources/(?P<pk>[^/.]+)/$",
            "api/v1/^task-relations/(?P<pk>[^/.]+)/$",
            "api/v1/^task-resources/(?P<pk>[^/.]+)/$",
            "api/v1/^task-runs/(?P<pk>[^/.]+)/$",
        ],
    )
    def test_lookalike_collections_contribute_nothing(
        self, tracer: Any, exporter: InMemorySpanExporter, route: str
    ) -> None:
        """A `project-templates` pk is a template id, not a project id.

        These five collections all start with `project`/`task`, which is exactly why
        the mapping matches the whole segment rather than a prefix: labelling a
        template id as `trueppm.project.id` would send a backend looking up a project
        that does not exist, and the wrongness would be invisible in the trace.
        """
        attrs = annotate(tracer, exporter, make_request(route=route, kwargs={"pk": "x"}))
        assert attributes.PROJECT_ID not in attrs
        assert attributes.TASK_ID not in attrs

    def test_nested_project_pk_is_used_and_not_overwritten_by_the_bare_pk(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        project_id, view_pk = str(uuid.uuid4()), str(uuid.uuid4())
        attrs = annotate(
            tracer,
            exporter,
            make_request(
                route="api/v1/projects/<project_pk>/webhooks/<pk>/",
                kwargs={"project_pk": project_id, "pk": view_pk},
            ),
        )
        assert attrs[attributes.PROJECT_ID] == project_id

    def test_a_list_route_carries_no_resource_id(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        attrs = annotate(tracer, exporter, make_request(route="api/v1/^projects/$", kwargs={}))
        assert attributes.PROJECT_ID not in attrs

    def test_no_resolver_match_is_a_no_op(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        attrs = annotate(tracer, exporter, make_request(has_resolver_match=False))
        assert not [k for k in attrs if k.startswith("trueppm.")]


class TestUserAndRole:
    def test_user_id_is_the_opaque_pk(self, tracer: Any, exporter: InMemorySpanExporter) -> None:
        pk = uuid.uuid4()
        attrs = annotate(tracer, exporter, make_request(user=make_user(pk)))
        assert attrs[attributes.USER_ID] == str(pk)

    def test_anonymous_request_carries_no_user_attributes(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        anon = type("Anon", (), {"pk": None, "is_authenticated": False})()
        attrs = annotate(tracer, exporter, make_request(user=anon))
        assert attributes.USER_ID not in attrs

    def test_an_unevaluated_lazy_user_is_never_dereferenced(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        """The no-extra-query invariant, asserted the only way that proves it.

        `AuthenticationMiddleware` installs `request.user` as a SimpleLazyObject that
        hits the session store on first access. If the annotator touched it, enabling
        telemetry would add a round trip to every request whose view never looked at
        the user — a cost that exists only because someone turned observability on.
        The factory below fails the test if it is ever called.
        """
        calls: list[int] = []

        def _boom() -> Any:
            calls.append(1)
            raise AssertionError("request.user was dereferenced by the span annotator")

        attrs = annotate(tracer, exporter, make_request(user=SimpleLazyObject(_boom)))
        assert calls == []
        assert attributes.USER_ID not in attrs

    def test_role_is_read_from_the_rbac_cache(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        request = make_request(user=make_user())
        setattr(request, RBAC_ROLE_CACHE_ATTR, {str(uuid.uuid4()): int(Role.SCHEDULER)})
        assert annotate(tracer, exporter, request)[attributes.USER_ROLE] == "SCHEDULER"

    def test_program_role_is_used_when_no_project_was_authorized(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        request = make_request(user=make_user())
        setattr(request, PROGRAM_RBAC_ROLE_CACHE_ATTR, {str(uuid.uuid4()): int(Role.OWNER)})
        assert annotate(tracer, exporter, request)[attributes.USER_ROLE] == "OWNER"

    def test_multi_project_request_carries_no_role(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        """A list endpoint has as many roles as it has projects, so it has none.

        Picking one would be worse than absent: the span would assert a permission
        level the request was not uniformly authorized at.
        """
        request = make_request(user=make_user())
        setattr(
            request,
            RBAC_ROLE_CACHE_ATTR,
            {str(uuid.uuid4()): int(Role.ADMIN), str(uuid.uuid4()): int(Role.VIEWER)},
        )
        assert attributes.USER_ROLE not in annotate(tracer, exporter, request)

    def test_a_non_member_lookup_carries_no_role(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        """`None` in the cache means "checked, not a member" — not a role."""
        request = make_request(user=make_user())
        setattr(request, RBAC_ROLE_CACHE_ATTR, {str(uuid.uuid4()): None})
        assert attributes.USER_ROLE not in annotate(tracer, exporter, request)

    def test_an_enterprise_band_ordinal_degrades_to_a_marked_band_label(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        """ADR-0072 reserves the 100-unit gaps for Enterprise custom roles.

        Dropping the attribute for those users would recreate this issue's failure
        inside the fix; naming them ADMIN outright would be a lie. The `+` marks the
        approximation while keeping the dimension bounded at ten values.
        """
        request = make_request(user=make_user())
        setattr(request, RBAC_ROLE_CACHE_ATTR, {str(uuid.uuid4()): 250})
        assert annotate(tracer, exporter, request)[attributes.USER_ROLE] == "SCHEDULER+"


class TestPrivacyLever:
    @override_settings(TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED=False)
    def test_actor_attributes_are_suppressed_but_resource_ids_survive(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        pid = str(uuid.uuid4())
        request = make_request(route=PROJECT_ROUTE, kwargs={"pk": pid}, user=make_user())
        setattr(request, RBAC_ROLE_CACHE_ATTR, {pid: int(Role.ADMIN)})
        attrs = annotate(tracer, exporter, request)
        assert attributes.USER_ID not in attrs
        assert attributes.USER_ROLE not in attrs
        assert attrs[attributes.PROJECT_ID] == pid

    def test_no_key_beyond_the_documented_set_is_written(
        self, tracer: Any, exporter: InMemorySpanExporter
    ) -> None:
        """The actor-attribute policy is "opaque pk + symbolic role, nothing else".

        A future edit that reached for an email or a client IP would show up here as
        an unexpected key rather than as a support ticket.
        """
        pid = str(uuid.uuid4())
        request = make_request(route=PROJECT_ROUTE, kwargs={"pk": pid}, user=make_user())
        setattr(request, RBAC_ROLE_CACHE_ATTR, {pid: int(Role.ADMIN)})
        attrs = annotate(tracer, exporter, request)
        written = {k for k in attrs if k.startswith("trueppm.")}
        assert written == {attributes.PROJECT_ID, attributes.USER_ID, attributes.USER_ROLE}


class TestNeverRaises:
    def test_a_non_recording_span_is_a_no_op(self) -> None:
        from opentelemetry.trace import INVALID_SPAN

        annotate_request_span(INVALID_SPAN, make_request(), None)

    def test_a_none_span_is_a_no_op(self) -> None:
        annotate_request_span(None, make_request(), None)

    def test_a_hostile_request_object_does_not_propagate(self) -> None:
        """This runs in the response path, so a raise here would be a latent 500."""

        class Hostile:
            @property
            def resolver_match(self) -> Any:
                raise RuntimeError("boom")

        span = type(
            "S", (), {"is_recording": lambda self: True, "set_attribute": lambda *a: None}
        )()
        annotate_request_span(span, Hostile(), None)
