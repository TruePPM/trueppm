"""The role/membership permission family fails CLOSED on unresolvable scope (#3767).

Fourteen classes derived from ``_project_pk_from_view`` / ``_program_pk_from_view``
used to end ``has_permission`` with a bare ``return True`` when the URL kwarg did not
resolve. Only ``has_object_permission`` failed closed. That was never a live
vulnerability — every call site compensated — but it made the *permission layer* the
wrong place to look for the answer, and it meant a newly added ``detail=False`` write
action reopened the hole by simply existing.

Every assertion in this file is written to FAIL against the pre-#3767 code. The
route-table invariant in ``test_route_table_invariants.py`` asserts the same property
over the real URLconf; this one asserts it over the shapes a route table does not yet
contain, which is the half that catches the next one.

No database is touched by the flip itself: ``_unresolved_scope_allows`` returns before
any membership query on every path it decides. The one case that does query is the
``UNKNOWN_ID`` stand-down, which needs a real project row to prove it is a stand-down
rather than a coincidence, so those two tests carry ``django_db``.
"""

from __future__ import annotations

from typing import Any

import pytest
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    IsProgramAdmin,
    IsProgramEditor,
    IsProgramMember,
    IsProgramOwner,
    IsProgramScheduler,
    IsProjectAdmin,
    IsProjectBacklogManager,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectOwner,
    IsProjectPlanAuthor,
    IsProjectScheduler,
    IsProjectScopeManager,
    ScopeResolution,
    _resolve_project_scope,
    declare_scope_in_body,
)

#: The full family named in #3767. Listed rather than discovered on purpose — the
#: route-table invariant does the discovery, and a second discoverer here would go
#: vacuous by the same rename that broke the first one.
PROJECT_FAMILY = [
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectPlanAuthor,
    IsProjectScheduler,
    IsProjectAdmin,
    IsProjectBacklogManager,
    IsProjectScopeManager,
    IsProjectOwner,
    CanAssignResource,
]
PROGRAM_FAMILY = [
    IsProgramMember,
    IsProgramScheduler,
    IsProgramEditor,
    IsProgramAdmin,
    IsProgramOwner,
]
FAMILY = PROJECT_FAMILY + PROGRAM_FAMILY

UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]


class _NewWriteEndpoint(APIView):
    """The shape this issue is about: a flat-routed write with nothing to resolve.

    Deliberately declares no ``project_url_kwarg`` and no ``resolves_scope_in_body`` —
    it is the endpoint somebody adds next week without reading any of this.
    """


class _NewWriteViewSet(GenericViewSet):  # type: ignore[type-arg]
    """The viewset twin: a ``detail=False`` action on a top-level route."""


def _request(method: str, user: Any) -> Any:
    request = APIRequestFactory().generic(method, "/")
    request.user = user
    from rest_framework.request import Request

    drf_request = Request(request)
    drf_request.user = user
    return drf_request


def _view(cls: type, **kwargs: Any) -> Any:
    view = cls()
    view.kwargs = kwargs.pop("url_kwargs", {})
    for key, value in kwargs.items():
        setattr(view, key, value)
    return view


@pytest.fixture
def member(django_user_model: Any) -> Any:
    return django_user_model.objects.create_user(username="scope-probe", password="x")


# ---------------------------------------------------------------------------
# The flip itself
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("permission_class", FAMILY, ids=lambda c: c.__name__)
@pytest.mark.parametrize("method", UNSAFE_METHODS)
def test_unsafe_write_with_no_resolvable_scope_is_denied(
    permission_class: type, method: str, member: Any
) -> None:
    """The headline assertion. Pre-#3767 every one of these returned True.

    An authenticated caller, an unsafe method, a route that names no project or
    program, and a view that declares nothing: there is no membership check anywhere
    in this request, so the only safe answer is no.
    """
    view = _view(_NewWriteEndpoint, url_kwargs={})
    assert permission_class().has_permission(_request(method, member), view) is False


@pytest.mark.parametrize("permission_class", FAMILY, ids=lambda c: c.__name__)
def test_a_detail_false_viewset_action_is_denied_too(permission_class: type, member: Any) -> None:
    """A ``detail=False`` action is the exact shape the issue names as the generator.

    ``get_object()`` never runs, so no object check compensates — and unlike a list
    route there is no membership-filtered queryset standing between the caller and
    the write.
    """
    view = _view(_NewWriteViewSet, url_kwargs={}, action="bulk_frobnicate")
    assert permission_class().has_permission(_request("POST", member), view) is False


# ---------------------------------------------------------------------------
# The three arms that must stay open
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("permission_class", FAMILY, ids=lambda c: c.__name__)
@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_safe_methods_on_an_unscoped_route_are_still_allowed(
    permission_class: type, method: str, member: Any
) -> None:
    """Reads keep falling through — denying them would 403 every top-level list.

    A read on an unscoped route is narrowed by ``ProjectScopedViewSet``'s
    membership-filtered queryset and by ``has_object_permission`` on detail routes.
    Closing this arm would not be a tightening, it would be an outage.
    """
    view = _view(_NewWriteEndpoint, url_kwargs={})
    assert permission_class().has_permission(_request(method, member), view) is True


@pytest.mark.parametrize("permission_class", PROJECT_FAMILY, ids=lambda c: c.__name__)
def test_a_viewset_detail_route_is_allowed_because_the_object_check_runs(
    permission_class: type, member: Any
) -> None:
    """``get_object()`` calls ``check_object_permissions``, so the gate fires one hop later.

    This is the same reasoning ``test_route_table_invariants`` records as
    ``ENFORCED_BY_VIEWSET``; the two must agree or the invariant would certify an
    enforcement path the running code does not take.
    """
    view = _view(_NewWriteViewSet, url_kwargs={"pk": "abc"}, action="partial_update")
    assert permission_class().has_permission(_request("PATCH", member), view) is True


@pytest.mark.parametrize("permission_class", FAMILY, ids=lambda c: c.__name__)
def test_a_declared_scope_in_body_view_is_allowed(permission_class: type, member: Any) -> None:
    """The opt-in marker is what lets a legitimate body-scoped write through."""

    class _Declared(APIView):
        resolves_scope_in_body = (
            "The project arrives in the request body; perform_create resolves it and "
            "applies the role floor before writing."
        )

    view = _view(_Declared, url_kwargs={})
    assert permission_class().has_permission(_request("POST", member), view) is True


def test_a_per_action_declaration_only_covers_the_action_it_names(member: Any) -> None:
    """The mapping form must not become a whole-view exemption.

    ``TaskViewSet`` needs one for ``create`` and must not get one for every other
    unsafe action it serves — a string would have handed it exactly that.
    """

    class _PartlyDeclared(GenericViewSet):  # type: ignore[type-arg]
        resolves_scope_in_body = {  # noqa: RUF012
            "create": (
                "The project arrives in the request body; perform_create resolves it "
                "and applies the role floor before writing."
            )
        }

    allowed = _view(_PartlyDeclared, url_kwargs={}, action="create")
    denied = _view(_PartlyDeclared, url_kwargs={}, action="some_other_write")
    assert IsProjectMemberWrite().has_permission(_request("POST", member), allowed) is True
    assert IsProjectMemberWrite().has_permission(_request("POST", member), denied) is False


@pytest.mark.parametrize("declaration", [True, 1, object(), "", "   ", {"create": True}])
def test_a_declaration_that_is_not_a_real_sentence_does_not_count(
    declaration: Any, member: Any
) -> None:
    """A truthy non-string must read as "no declaration" and therefore deny.

    Same guard, same reason as ``_project_pk_from_view``'s non-string check: a bare
    ``MagicMock`` view synthesizes a truthy value for any attribute, and a view that
    set the flag to ``True`` would be claiming an exemption nobody wrote a reason for.
    Letting either count is #2745's own defect re-entering through this fix.
    """

    class _Bogus(APIView):
        pass

    _Bogus.resolves_scope_in_body = declaration  # type: ignore[attr-defined]
    view = _view(_Bogus, url_kwargs={}, action="create")
    assert IsProjectMember().has_permission(_request("POST", member), view) is False


def test_the_decorator_declares_on_an_api_view_function(member: Any) -> None:
    """``declare_scope_in_body`` reaches the generated ``WrappedAPIView``.

    ``@api_view`` hands back a plain function; the class is only reachable through its
    ``cls`` attribute, which is why the two scheduling function views could not simply
    assign the attribute.
    """

    class _Fake:
        pass

    def fake_api_view() -> None: ...

    fake_api_view.cls = _Fake  # type: ignore[attr-defined]
    declare_scope_in_body("A sentence long enough to say which in-body call gates it.")(
        fake_api_view
    )
    assert _Fake.resolves_scope_in_body.startswith("A sentence")  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# The UNKNOWN_ID stand-down must survive the flip (#2745, #3129)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_declared_kwarg_naming_an_unknown_project_still_stands_down(member: Any) -> None:
    """An unknown project id resolves to UNKNOWN_ID, not ABSENT, and is still allowed.

    Turning this into a 403 would rebuild the membership-scoped existence oracle #3129
    closed: a real project the caller cannot see would answer 403 while an unknown id
    answered 404, from the same endpoint. The view's own ``get_object_or_404`` is the
    right answer here, and it can only give it if the permission layer lets the request
    reach the body.
    """

    class _DeclaringView(APIView):
        project_url_kwarg = "pk"

    view = _view(_DeclaringView, url_kwargs={"pk": "00000000-0000-0000-0000-000000000000"})
    project_pk, state = _resolve_project_scope(view)
    assert project_pk is None
    assert state is ScopeResolution.UNKNOWN_ID
    assert IsProjectAdmin().has_permission(_request("POST", member), view) is True


@pytest.mark.django_db
def test_a_declared_kwarg_naming_a_real_project_resolves_and_is_role_checked(
    member: Any,
) -> None:
    """The negative control for the test above.

    Without it, a bug that made ``_project_exists`` always return False would make the
    stand-down test pass while the whole declaring-route family silently stopped
    enforcing anything — the exact "passes on the broken build" shape.
    """
    from datetime import date

    from trueppm_api.apps.projects.models import Project

    project = Project.objects.create(name="scope probe", start_date=date(2026, 1, 1))

    class _DeclaringView(APIView):
        project_url_kwarg = "pk"

    view = _view(_DeclaringView, url_kwargs={"pk": str(project.pk)})
    project_pk, state = _resolve_project_scope(view)
    assert project_pk == str(project.pk)
    assert state is ScopeResolution.RESOLVED
    # `member` holds no ProjectMembership on it, so the role check must refuse.
    assert IsProjectAdmin().has_permission(_request("POST", member), view) is False


# ---------------------------------------------------------------------------
# Unauthenticated callers are unaffected
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("permission_class", FAMILY, ids=lambda c: c.__name__)
def test_anonymous_callers_are_denied_before_scope_is_considered(
    permission_class: type,
) -> None:
    """The authentication gate still runs first — the flip changes nothing here."""
    from django.contrib.auth.models import AnonymousUser

    view = _view(_NewWriteEndpoint, url_kwargs={})
    assert permission_class().has_permission(_request("POST", AnonymousUser()), view) is False
