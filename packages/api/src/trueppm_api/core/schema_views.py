"""OpenAPI schema view that renders once per process, behind its own throttle (#4315).

``SpectacularAPIView`` regenerates the whole schema (hundreds of operations) on every
GET. The route stays anonymous on purpose -- ``generate:types``, the smoke tests, the
Helm install drill and integrators fetch it with no credential, and on OSS it is the
same document committed in the public repo -- so the cost, not the access, is what gets
bounded here: the rendered document is cached per process and a dedicated ``schema``
throttle scope keys on the client IP.
"""

from __future__ import annotations

import threading
from typing import Any, ClassVar

from drf_spectacular.views import SpectacularAPIView
from rest_framework.response import Response
from rest_framework.settings import api_settings
from rest_framework.throttling import AnonRateThrottle


class SchemaRateThrottle(AnonRateThrottle):
    """Per-client-IP bucket for unauthenticated schema callers, stacked with the global defaults.

    Its own scope (``DEFAULT_THROTTLE_RATES["schema"]``) rather than the shared ``anon``
    one so a client polling the schema cannot spend an interactive user's budget, and so
    the operator kill switch (which nulls every rate) reaches it. Inherits DRF's
    ``NUM_PROXIES``-aware IP extraction so a rotated ``X-Forwarded-For`` does not mint a
    fresh bucket.
    """

    scope = "schema"


class CachedSpectacularAPIView(SpectacularAPIView):
    """``SpectacularAPIView`` that generates the schema once per process and version.

    Safe because the view serves ``SERVE_PUBLIC`` (the default): the generator ignores
    the requesting user, so every caller gets the same document. The key carries the
    API version, the ``lang`` override and the package version, so a different language
    or a new build never reads a stale entry. A process restarts on every deploy, which
    is the only time the routes change, so there is no invalidation path to get wrong.
    """

    throttle_classes = [  # noqa: RUF012 -- DRF declares this per-class, not ClassVar
        *api_settings.DEFAULT_THROTTLE_CLASSES,  # type: ignore[list-item]
        SchemaRateThrottle,
    ]

    _cache: ClassVar[dict[tuple[str, str, str], Any]] = {}
    _lock = threading.Lock()

    def _get_schema_response(self, request: Any) -> Response:
        from django.conf import settings
        from drf_spectacular.settings import spectacular_settings

        version = self.api_version or request.version or self._get_version_parameter(request)  # type: ignore[no-untyped-call]
        key = (
            str(spectacular_settings.VERSION),
            str(version or ""),
            str(request.GET.get("lang", "")) if settings.USE_I18N else "",
        )
        with self._lock:
            data = self._cache.get(key)
        if data is None:
            generator = self.generator_class(
                urlconf=self.urlconf, api_version=version, patterns=self.patterns
            )
            data = generator.get_schema(  # type: ignore[no-untyped-call]
                request=request, public=self.serve_public
            )
            with self._lock:
                self._cache[key] = data
        return Response(
            data=data,
            headers={
                "Content-Disposition": (
                    f'inline; filename="{self._get_filename(request, version)}"'  # type: ignore[no-untyped-call]
                )
            },
        )
