"""OpenGraph / Twitter-Card scraping for cloud-file link previews (#571, ADR-0163).

A cloud-file ``TaskLinkProvider`` fetches a pasted file URL through the
SSRF-guarded :mod:`~trueppm_api.apps.integrations.http` helper and hands the
(already size-capped, redirect-disabled) response body here. This module turns
that HTML into a :class:`PreviewData` — the ``{title, description, thumbnail,
preview_type}`` the preview card renders.

Why the standard library and not BeautifulSoup/lxml: the job is "pull a handful
of ``<meta>`` tags and ``<title>`` out of an already-bounded (256 KB) body."
``html.parser.HTMLParser`` does that with zero new dependencies (no license/CVE
audit) and has no entity-expansion ("billion laughs") exposure the way an XML
parser would. The parser is deliberately lenient — malformed markup yields an
empty :class:`PreviewData`, never an exception, matching ``fetch_metadata``'s
"never raise for an unreachable/garbage provider" contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

from .registry import (
    PREVIEW_TYPE_DOCUMENT,
    PREVIEW_TYPE_FILE,
    PREVIEW_TYPE_FOLDER,
    PREVIEW_TYPE_IMAGE,
    PREVIEW_TYPE_PDF,
    PREVIEW_TYPE_PRESENTATION,
    PREVIEW_TYPE_SPREADSHEET,
)

# Cap each scraped string so a hostile page can't bloat a synced row. The model
# columns are 512 (title), 1024 (description), 2048 (thumbnail URL); trimming
# here keeps the row small and the sync delta cheap even before the DB truncates.
_MAX_TITLE = 512
_MAX_DESCRIPTION = 1024


@dataclass(frozen=True)
class PreviewData:
    """The scraped preview of a file URL.

    Every field is best-effort: a page with no OpenGraph tags and no ``<title>``
    yields ``PreviewData(None, None, None)`` and the caller still classifies a
    ``preview_type`` from the URL shape.
    """

    title: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None


class _MetaCollector(HTMLParser):
    """Collect ``<meta>`` property/name→content pairs and the ``<title>`` text.

    Only the ``<head>`` carries the tags we want, but we don't hard-stop at
    ``</head>`` — some providers emit OpenGraph tags late, and the body is
    already capped at 256 KB upstream, so scanning all of it is bounded work.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.metas: dict[str, str] = {}
        self.title: str | None = None
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
            return
        if tag != "meta":
            return
        attr = {k.lower(): (v or "") for k, v in attrs}
        # OpenGraph uses ``property=``; Twitter Cards and the legacy description
        # use ``name=``. Either key is fine — store under whichever is present.
        key = (attr.get("property") or attr.get("name") or "").strip().lower()
        content = attr.get("content")
        if key and content and key not in self.metas:
            # First occurrence wins — a page that repeats og:image keeps the first.
            self.metas[key] = content.strip()

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and self.title is None:
            text = data.strip()
            if text:
                self.title = text


def _first(metas: dict[str, str], *keys: str) -> str | None:
    """Return the first non-empty value among ``keys`` in priority order."""
    for key in keys:
        value = metas.get(key)
        if value:
            return value
    return None


def _safe_thumbnail(candidate: str | None, *, base_url: str) -> str | None:
    """Resolve a candidate image URL against ``base_url`` and keep it only if https.

    Relative ``og:image`` values are resolved against the page URL. We persist
    **only** ``https://`` thumbnails (ADR-0163): the stored URL is rendered
    client-side as ``<img src>``, so an ``http://`` value would be a mixed-content
    / downgrade vector and a ``data:``/``javascript:`` value must never reach the
    DOM. Anything that isn't https after resolution is dropped (the card falls
    back to a type glyph).
    """
    if not candidate:
        return None
    resolved = urljoin(base_url, candidate.strip())
    if urlparse(resolved).scheme != "https":
        return None
    return resolved[:2048]


def parse_preview(body: bytes, *, base_url: str) -> PreviewData:
    """Scrape ``{title, description, thumbnail_url}`` from an HTML ``body``.

    Args:
        body: The raw response bytes (already capped at 256 KB by ``http.get``).
        base_url: The fetched URL — used to resolve a relative ``og:image``.

    Returns:
        A :class:`PreviewData`; any field the page doesn't provide is ``None``.
        Never raises — malformed/binary bodies decode with replacement and yield
        an empty result.
    """
    parser = _MetaCollector()
    try:
        parser.feed(body.decode("utf-8", errors="replace"))
        parser.close()
    except Exception:
        # A broken/hostile page must degrade to an empty preview, never 500 a
        # refresh — fetch_metadata's contract is "never raise for bad input".
        return PreviewData()

    metas = parser.metas
    title = _first(metas, "og:title", "twitter:title") or parser.title
    description = _first(metas, "og:description", "twitter:description", "description")
    image = _first(metas, "og:image:secure_url", "og:image", "twitter:image")

    return PreviewData(
        title=title[:_MAX_TITLE].strip() if title else None,
        description=description[:_MAX_DESCRIPTION].strip() if description else None,
        thumbnail_url=_safe_thumbnail(image, base_url=base_url),
    )


# File extensions → preview type. Covers the common office/file shapes that
# Dropbox/Box/OneDrive expose directly in the URL path.
_EXT_TYPES: dict[str, str] = {
    ".doc": PREVIEW_TYPE_DOCUMENT,
    ".docx": PREVIEW_TYPE_DOCUMENT,
    ".odt": PREVIEW_TYPE_DOCUMENT,
    ".rtf": PREVIEW_TYPE_DOCUMENT,
    ".txt": PREVIEW_TYPE_DOCUMENT,
    ".md": PREVIEW_TYPE_DOCUMENT,
    ".pages": PREVIEW_TYPE_DOCUMENT,
    ".xls": PREVIEW_TYPE_SPREADSHEET,
    ".xlsx": PREVIEW_TYPE_SPREADSHEET,
    ".csv": PREVIEW_TYPE_SPREADSHEET,
    ".ods": PREVIEW_TYPE_SPREADSHEET,
    ".numbers": PREVIEW_TYPE_SPREADSHEET,
    ".ppt": PREVIEW_TYPE_PRESENTATION,
    ".pptx": PREVIEW_TYPE_PRESENTATION,
    ".odp": PREVIEW_TYPE_PRESENTATION,
    ".key": PREVIEW_TYPE_PRESENTATION,
    ".pdf": PREVIEW_TYPE_PDF,
    ".png": PREVIEW_TYPE_IMAGE,
    ".jpg": PREVIEW_TYPE_IMAGE,
    ".jpeg": PREVIEW_TYPE_IMAGE,
    ".gif": PREVIEW_TYPE_IMAGE,
    ".webp": PREVIEW_TYPE_IMAGE,
    ".svg": PREVIEW_TYPE_IMAGE,
    ".bmp": PREVIEW_TYPE_IMAGE,
    ".heic": PREVIEW_TYPE_IMAGE,
}

# Google Docs editor path segments → preview type. Drive uses an editor host
# path (``/spreadsheets/d/…``) rather than a file extension.
_GOOGLE_PATH_TYPES: tuple[tuple[str, str], ...] = (
    ("/spreadsheets/", PREVIEW_TYPE_SPREADSHEET),
    ("/presentation/", PREVIEW_TYPE_PRESENTATION),
    ("/document/", PREVIEW_TYPE_DOCUMENT),
    ("/forms/", PREVIEW_TYPE_DOCUMENT),
)


def classify_preview_type(url: str, type_hint: str | None = None) -> str:
    """Classify ``url`` onto one of :data:`PREVIEW_TYPE_VALUES`.

    Resolution order, most specific first:

    1. A folder path (``/folders/`` — Drive, ``/sh/`` Dropbox shared folders).
    2. A Google Docs editor path segment (spreadsheets/presentation/document).
    3. A known file extension on the URL path.
    4. A ``type_hint`` of ``image``/``video`` — the caller passes the response
       ``Content-Type`` (e.g. ``image/png``) or an OpenGraph ``og:type``; both
       start with the class name, so a direct image URL with no path extension
       still classes as an image.
    5. The generic ``file`` fallback — a real file we just can't class further.

    Args:
        url: The file URL being classified.
        type_hint: Optional response ``Content-Type`` or OpenGraph ``og:type``.
    """
    path = urlparse(url).path.lower()

    if "/folders/" in path or path.endswith("/folder") or "/sh/" in path:
        return PREVIEW_TYPE_FOLDER

    for segment, ptype in _GOOGLE_PATH_TYPES:
        if segment in path:
            return ptype

    for ext, ptype in _EXT_TYPES.items():
        if path.endswith(ext):
            return ptype

    if type_hint and type_hint.lower().startswith("image"):
        return PREVIEW_TYPE_IMAGE

    return PREVIEW_TYPE_FILE
