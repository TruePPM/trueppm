"""Shared pk-lookup behavior for viewsets that declare ``search_fields``."""

from __future__ import annotations

from typing import TYPE_CHECKING, Generic, TypeVar

from django.db.models import Model
from rest_framework import filters

_M = TypeVar("_M", bound=Model)

if TYPE_CHECKING:
    from rest_framework.generics import GenericAPIView

    class _Base(GenericAPIView[_M]): ...

else:

    class _Base(Generic[_M]): ...


class DetailLookupIgnoresSearchMixin(_Base[_M]):
    """Resolve a detail route's object without SearchFilter/OrderingFilter (#3451).

    ``GenericAPIView.get_object()`` resolves through
    ``self.filter_queryset(self.get_queryset())``, so a viewset's ``search_fields``
    also ran against the *pk lookup*: ``GET /tasks/{id}/?search=zzz`` matched the term
    against the object's own name and 404'd when it did not contain it. That is a hard
    failure on every detail route (retrieve, update, destroy, ``detail=True`` actions).

    **Suppress the two backends by name; never bypass ``filter_queryset()`` and never
    empty ``filter_backends``.** ``McpReadableViewMixin`` enforces the ADR-0678 team
    MCP opt-out inside ``filter_queryset()`` because some MCP-readable viewsets build
    their queryset from scratch and never reach the mixin's ``get_queryset`` hook, so
    bypassing it fails the opt-out open. Emptying the list would likewise silently skip
    any narrowing backend added later. Subclasses of the two backends (for example a
    SearchFilter that gates searchable fields) are suppressed too.

    Must precede the viewset base classes in the MRO so ``super().get_object()``
    reaches DRF's implementation. ``filter_backends`` is rebound on the instance and
    restored in ``finally``; instances are per-request so there is no sharing.
    """

    _DETAIL_LOOKUP_SUPPRESSED = (filters.SearchFilter, filters.OrderingFilter)

    def get_object(self) -> _M:
        original = self.filter_backends
        self.filter_backends = [
            b for b in original if not issubclass(b, self._DETAIL_LOOKUP_SUPPRESSED)
        ]
        try:
            return super().get_object()
        finally:
            self.filter_backends = original
