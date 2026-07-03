"""Guards for the interactive OpenAPI docs pages under the strict CSP (#1603).

The Swagger UI pages (`/api/docs/`, `/api/schema/swagger-ui/`) rendered blank
because our strict Content-Security-Policy (`script-src 'self'`, no CDN host)
blocked both the CDN-hosted UI bundle and drf-spectacular's inline bootstrap
`<script>`. The fix serves the assets from `drf-spectacular-sidecar` (same
origin) and uses `SpectacularSwaggerSplitView`, which delivers the bootstrap as
a separate same-origin JS request instead of inline.

These tests assert the CSP-compatible shape so a regression (reverting to the
inline view, or re-pointing the assets at a CDN) fails loudly instead of
shipping a blank page again. They read only settings + rendered templates, so no
database access is required.
"""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

# These views never query the database, but ATOMIC_REQUESTS wraps every request
# in a transaction, so the test client needs DB access enabled to render them.
pytestmark = pytest.mark.django_db

# The two routes wired to the Swagger UI in trueppm_api.urls.
DOCS_PATHS = ["/api/docs/", "/api/schema/swagger-ui/"]


@pytest.fixture
def client() -> APIClient:
    return APIClient()


@pytest.mark.parametrize("path", DOCS_PATHS)
def test_docs_page_renders(client: APIClient, path: str) -> None:
    """The docs HTML must return 200 and mount the Swagger UI container."""
    r = client.get(path)
    assert r.status_code == 200
    html = r.content.decode()
    assert '<div id="swagger-ui">' in html


@pytest.mark.parametrize("path", DOCS_PATHS)
def test_docs_assets_are_same_origin_not_cdn(client: APIClient, path: str) -> None:
    """Every script/style URL must be same-origin — no CDN host.

    Under `script-src 'self'` a CDN-hosted bundle is blocked and the page renders
    blank. The sidecar serves the bundle from `/static/...`, so no external host
    may appear in the rendered HTML.
    """
    html = client.get(path).content.decode()
    srcs = re.findall(r'src="([^"]+)"', html)
    csslinks = re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
    assets = srcs + csslinks
    assert assets, "expected the docs page to reference UI assets"
    for url in assets:
        # Same-origin assets are root-relative ('/static/...', '/api/...').
        # A scheme or protocol-relative host ('//cdn...', 'https://cdn...') is a CDN.
        assert not re.match(r"^(https?:)?//", url), f"{url} is a cross-origin (CDN) asset"
    # The default drf-spectacular CDN must not reappear.
    assert "jsdelivr" not in html and "cdn." not in html


@pytest.mark.parametrize("path", DOCS_PATHS)
def test_docs_has_no_inline_bootstrap_script(client: APIClient, path: str) -> None:
    """The UI bootstrap must be an external same-origin script, never inline.

    `script-src 'self'` (no `unsafe-inline`, no nonce) blocks an inline
    `<script>SwaggerUIBundle(...)</script>`. The split view moves it to a
    `?script=` request, so the initializer must not be inlined in the HTML.
    """
    html = client.get(path).content.decode()
    assert "SwaggerUIBundle(" not in html, "bootstrap must not be inline under CSP"
    # The split view references the bootstrap as a same-origin ?script= request.
    assert "script=" in html


@pytest.mark.parametrize("path", DOCS_PATHS)
def test_docs_script_request_serves_javascript(client: APIClient, path: str) -> None:
    """The split view's `?script=` request returns the JS bootstrap, not HTML."""
    r = client.get(path, {"script": ""})
    assert r.status_code == 200
    assert r["Content-Type"].startswith("application/javascript")
    assert "SwaggerUIBundle(" in r.content.decode()


def test_settings_use_sidecar_assets() -> None:
    """The spectacular settings must resolve assets from the sidecar, not a CDN."""
    from django.conf import settings

    spec = settings.SPECTACULAR_SETTINGS
    assert spec["SWAGGER_UI_DIST"] == "SIDECAR"
    assert spec["SWAGGER_UI_FAVICON_HREF"] == "SIDECAR"
    assert spec["REDOC_DIST"] == "SIDECAR"


def test_csp_header_is_present_on_docs(client: APIClient) -> None:
    """The docs page is served with the strict CSP header (regression sentinel).

    The whole point of the fix is that the page works *with* the CSP applied — so
    prove the header is actually attached to this response.
    """
    r = client.get("/api/docs/")
    csp = r["Content-Security-Policy"]
    assert "script-src 'self'" in csp
