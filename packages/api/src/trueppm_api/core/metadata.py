"""Fault-tolerant OPTIONS metadata class (#2229).

DRF's ``SimpleMetadata.determine_actions`` calls ``view.get_serializer()`` for
each writable method while building the ``OPTIONS`` response. On a
``GenericViewSet`` that defines no ``serializer_class`` (several action-only
viewsets here, e.g. ``SprintTaskOutcomeViewSet``), that call hits
``GenericAPIView.get_serializer_class``'s ``assert self.serializer_class is not
None`` and raises ``AssertionError`` — which the ``except (APIException,
PermissionDenied, Http404)`` guard inside ``determine_actions`` does not catch,
so an ``OPTIONS`` probe returns a 500.

This subclass degrades that path to empty action metadata (a clean 200) instead
of crashing. It is deliberately narrow: only the per-method serializer
introspection is guarded, so serializer-backed views keep their full field
metadata unchanged.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from rest_framework.metadata import SimpleMetadata

if TYPE_CHECKING:
    # Imported for annotations only. A runtime ``from rest_framework.views import
    # APIView`` here deadlocks: DRF resolves DEFAULT_METADATA_CLASS *while*
    # ``rest_framework.views`` is initializing, so importing this module back into
    # a half-built ``rest_framework.views`` is a circular import.
    from rest_framework.request import Request
    from rest_framework.views import APIView


class TolerantMetadata(SimpleMetadata):
    """``SimpleMetadata`` that tolerates serializer-less viewsets on ``OPTIONS``."""

    def determine_actions(self, request: Request, view: APIView) -> dict[str, Any]:
        try:
            return super().determine_actions(request, view)
        except AssertionError:
            # Serializer-less action viewset: no field metadata to expose, but the
            # OPTIONS request must still succeed rather than 500.
            return {}
