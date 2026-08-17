"""An ``@action``'s inline ``permission_classes`` must actually take effect (#2852).

DRF's per-action ``@action(permission_classes=[...])`` works by having the router
bind the kwargs onto the view via ``as_view(**route.initkwargs)``, which the *default*
``get_permissions()`` then reads off ``self.permission_classes``. **38 viewsets in this
codebase override ``get_permissions()`` with a hand-written
``if self.action == "...": return [...]`` chain that never consults
``self.permission_classes``.** On those, an inline declaration is silently discarded:
the action falls through to the chain's ``else`` default, which on every viewset
checked is the *weakest* gate on the class — typically ``IsProjectMember``, i.e.
Viewer+.

**There is no live vulnerability.** Every current inline declaration was cross-checked
and is redundantly-but-correctly re-covered by its chain. What makes this a finding is
that the codebase *already knows* — ``projects/views.py`` carries a comment at the
``split`` action saying exactly this — and a comment does not fail CI. The next
addition that forgets the branch ships a Viewer-callable Admin endpoint, and the
author's manual test with an Admin account passes.

The check is deliberately **runtime, not AST**: it resolves the permissions the view
would really apply and asserts the declared ones are among them. An AST check would
have to recognize every way a chain can name an action (``==``, ``in (...)``, a dict
lookup, a helper method) and would silently stop covering a viewset that used a form
it did not know.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView
from rest_framework.viewsets import ViewSetMixin

# A viewset joining the hand-rolled pattern is a deliberate act. Pinning the count
# keeps the scan honest: a refactor that renames get_permissions, or a URLconf change
# that hides half the routes, would otherwise empty the discovery and pass vacuously.
_MIN_OVERRIDING_VIEWSETS = 30


def _routed_viewsets() -> dict[str, type]:
    """Every ViewSet class reachable from the URLconf, by class name."""
    found: dict[str, type] = {}

    def walk(patterns: list[Any]) -> None:
        for pattern in patterns:
            if isinstance(pattern, URLResolver):
                walk(pattern.url_patterns)
                continue
            if not isinstance(pattern, URLPattern):
                continue
            cls = getattr(getattr(pattern, "callback", None), "cls", None)
            if cls is not None and issubclass(cls, ViewSetMixin):
                found[cls.__name__] = cls

    walk(get_resolver().url_patterns)
    return found


def _overriding_viewsets() -> dict[str, type]:
    """Viewsets whose ``get_permissions`` is hand-rolled rather than DRF's default."""
    return {
        name: cls
        for name, cls in _routed_viewsets().items()
        if cls.get_permissions is not APIView.get_permissions
    }


def _inline_permission_actions() -> list[tuple[str, type, str, set[str]]]:
    """``(viewset_name, cls, action_name, declared_permission_names)`` for each
    ``@action`` that declares its own ``permission_classes`` on an overriding viewset."""
    found: list[tuple[str, type, str, set[str]]] = []
    for name, cls in sorted(_overriding_viewsets().items()):
        for attr in dir(cls):
            handler = getattr(cls, attr, None)
            kwargs = getattr(handler, "kwargs", None)
            if isinstance(kwargs, dict) and "permission_classes" in kwargs:
                declared = {p.__name__ for p in kwargs["permission_classes"]}
                found.append((name, cls, attr, declared))
    return found


def _effective_permission_names(cls: type, action: str) -> set[str]:
    """The permission classes ``get_permissions()`` really returns for ``action``."""
    handler = getattr(cls, action)
    methods = [m.upper() for m in getattr(handler, "mapping", {})] or ["POST"]
    view = cls()
    view.action = action
    view.format_kwarg = None
    view.request = Request(APIRequestFactory().generic(methods[0], "/"))
    return {type(permission).__name__ for permission in view.get_permissions()}


@pytest.mark.django_db
def test_the_scan_still_reaches_the_hand_rolled_viewsets() -> None:
    """Pin the discovery so the assertions below cannot pass over an empty set."""
    overriding = _overriding_viewsets()
    assert len(overriding) >= _MIN_OVERRIDING_VIEWSETS, (
        f"Only {len(overriding)} routed viewsets override get_permissions "
        f"(expected >= {_MIN_OVERRIDING_VIEWSETS}). The scan has stopped seeing them — "
        f"fix the discovery rather than lowering the floor."
    )


@pytest.mark.django_db
def test_every_inline_action_permission_actually_applies() -> None:
    """An ``@action``'s own ``permission_classes`` must survive the chain.

    This is the guard the ``split`` action's comment asks for. It fails the moment
    someone adds ``@action(..., permission_classes=[IsProjectAdmin])`` to one of these
    viewsets without adding the matching branch — the case that would otherwise ship a
    Viewer-callable Admin endpoint and pass the author's manual Admin-account test.
    """
    discarded: list[str] = []
    for viewset_name, cls, action, declared in _inline_permission_actions():
        effective = _effective_permission_names(cls, action)
        missing = declared - effective
        if missing:
            discarded.append(
                f"  {viewset_name}.{action} declares {sorted(declared)} inline, but "
                f"get_permissions() returns {sorted(effective)} — {sorted(missing)} is "
                f"silently discarded"
            )

    assert not discarded, (
        "These @action permission_classes are overridden away by a hand-rolled "
        "get_permissions():\n"
        + "\n".join(discarded)
        + "\n\nDRF's per-action mechanism only works when get_permissions() reads "
        'self.permission_classes. Add an `if self.action == "<name>"` branch to the '
        "chain — the inline kwarg alone does nothing, and the fall-through default is "
        "the weakest gate on the class."
    )


@pytest.mark.django_db
def test_the_known_inline_declarations_are_still_discovered() -> None:
    """Pin the three known instances by name.

    Without this, deleting the inline kwargs would make the test above pass over an
    empty list — technically true, and no longer guarding anything.
    """
    discovered = {(name, action) for name, _cls, action, _declared in _inline_permission_actions()}
    assert {
        ("TaskViewSet", "approve_estimates"),
        ("TaskViewSet", "split"),
        ("TaskViewSet", "withdraw_approval"),
    } <= discovered
