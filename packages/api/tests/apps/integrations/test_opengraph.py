"""Unit tests for the cloud-file OpenGraph scraper (#571, ADR-0163).

Covers ``parse_preview`` (OpenGraph → Twitter-Card → ``<title>`` precedence,
``meta name=description`` fallback, relative-image resolution, the https-only
thumbnail rule, length caps, and lenient handling of garbage/binary bodies) and
``classify_preview_type`` (folder / Google-editor / extension / content-type /
generic-file resolution order).
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.integrations.opengraph import (
    PreviewData,
    classify_preview_type,
    parse_preview,
)
from trueppm_api.apps.integrations.registry import (
    PREVIEW_TYPE_DOCUMENT,
    PREVIEW_TYPE_FILE,
    PREVIEW_TYPE_FOLDER,
    PREVIEW_TYPE_IMAGE,
    PREVIEW_TYPE_PDF,
    PREVIEW_TYPE_PRESENTATION,
    PREVIEW_TYPE_SPREADSHEET,
)

BASE = "https://docs.google.com/document/d/abc/edit"


def _html(*tags: str) -> bytes:
    return ("<html><head>" + "".join(tags) + "</head><body>x</body></html>").encode()


# ---------------------------------------------------------------------------
# parse_preview — title / description / thumbnail precedence
# ---------------------------------------------------------------------------


def test_opengraph_tags_extracted() -> None:
    preview = parse_preview(
        _html(
            '<meta property="og:title" content="Q3 Budget">',
            '<meta property="og:description" content="Quarterly projections">',
            '<meta property="og:image" content="https://cdn.example.com/t.png">',
        ),
        base_url=BASE,
    )
    assert preview.title == "Q3 Budget"
    assert preview.description == "Quarterly projections"
    assert preview.thumbnail_url == "https://cdn.example.com/t.png"


def test_twitter_card_is_fallback_when_no_opengraph() -> None:
    preview = parse_preview(
        _html(
            '<meta name="twitter:title" content="Tw Title">',
            '<meta name="twitter:description" content="Tw Desc">',
            '<meta name="twitter:image" content="https://cdn.example.com/tw.png">',
        ),
        base_url=BASE,
    )
    assert preview.title == "Tw Title"
    assert preview.description == "Tw Desc"
    assert preview.thumbnail_url == "https://cdn.example.com/tw.png"


def test_title_tag_is_last_resort_for_title() -> None:
    preview = parse_preview(_html("<title>  Plain Title  </title>"), base_url=BASE)
    assert preview.title == "Plain Title"
    assert preview.description is None
    assert preview.thumbnail_url is None


def test_meta_name_description_fallback() -> None:
    preview = parse_preview(
        _html('<meta name="description" content="Legacy description">'),
        base_url=BASE,
    )
    assert preview.description == "Legacy description"


def test_opengraph_wins_over_twitter_and_title() -> None:
    preview = parse_preview(
        _html(
            "<title>Title tag</title>",
            '<meta name="twitter:title" content="Twitter">',
            '<meta property="og:title" content="OpenGraph">',
        ),
        base_url=BASE,
    )
    assert preview.title == "OpenGraph"


# ---------------------------------------------------------------------------
# parse_preview — thumbnail safety (https-only, relative resolution)
# ---------------------------------------------------------------------------


def test_relative_image_resolved_against_base_url() -> None:
    preview = parse_preview(
        _html('<meta property="og:image" content="/thumbs/x.png">'),
        base_url="https://docs.google.com/document/d/abc/edit",
    )
    assert preview.thumbnail_url == "https://docs.google.com/thumbs/x.png"


@pytest.mark.parametrize(
    "image",
    [
        "http://cdn.example.com/insecure.png",  # non-https downgrade
        "data:image/png;base64,AAAA",  # data URI must never reach the DOM
        "javascript:alert(1)",  # script URI
        "ftp://cdn.example.com/x.png",  # non-web scheme
    ],
)
def test_unsafe_thumbnail_dropped(image: str) -> None:
    preview = parse_preview(
        _html(f'<meta property="og:image" content="{image}">'),
        base_url=BASE,
    )
    assert preview.thumbnail_url is None


def test_secure_url_variant_preferred() -> None:
    preview = parse_preview(
        _html(
            '<meta property="og:image" content="https://cdn.example.com/a.png">',
            '<meta property="og:image:secure_url" content="https://cdn.example.com/secure.png">',
        ),
        base_url=BASE,
    )
    assert preview.thumbnail_url == "https://cdn.example.com/secure.png"


# ---------------------------------------------------------------------------
# parse_preview — robustness
# ---------------------------------------------------------------------------


def test_empty_and_garbage_bodies_yield_empty_preview() -> None:
    # An empty body yields a fully-empty preview (every field None), not merely
    # something equal to itself.
    assert parse_preview(b"", base_url=BASE) == PreviewData()
    garbage = parse_preview(b"\x00\x01\x02not html at all", base_url=BASE)
    assert garbage.title is None
    assert garbage.description is None
    assert garbage.thumbnail_url is None


def test_title_and_description_are_length_capped() -> None:
    preview = parse_preview(
        _html(
            f'<meta property="og:title" content="{"T" * 900}">',
            f'<meta property="og:description" content="{"D" * 2000}">',
        ),
        base_url=BASE,
    )
    assert preview.title is not None and len(preview.title) == 512
    assert preview.description is not None and len(preview.description) == 1024


def test_first_image_occurrence_wins() -> None:
    preview = parse_preview(
        _html(
            '<meta property="og:image" content="https://cdn.example.com/first.png">',
            '<meta property="og:image" content="https://cdn.example.com/second.png">',
        ),
        base_url=BASE,
    )
    assert preview.thumbnail_url == "https://cdn.example.com/first.png"


# ---------------------------------------------------------------------------
# classify_preview_type
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "hint", "expected"),
    [
        # Google Docs editor paths
        ("https://docs.google.com/spreadsheets/d/x/edit", None, PREVIEW_TYPE_SPREADSHEET),
        ("https://docs.google.com/presentation/d/x/edit", None, PREVIEW_TYPE_PRESENTATION),
        ("https://docs.google.com/document/d/x/edit", None, PREVIEW_TYPE_DOCUMENT),
        # Folders take precedence over everything
        ("https://drive.google.com/drive/folders/abc", None, PREVIEW_TYPE_FOLDER),
        ("https://www.dropbox.com/sh/abc/team", None, PREVIEW_TYPE_FOLDER),
        # File extensions (Dropbox/Box/OneDrive direct files)
        ("https://www.dropbox.com/s/abc/report.xlsx?dl=0", None, PREVIEW_TYPE_SPREADSHEET),
        ("https://www.dropbox.com/s/abc/deck.pptx", None, PREVIEW_TYPE_PRESENTATION),
        ("https://app.box.com/s/abc/spec.pdf", None, PREVIEW_TYPE_PDF),
        ("https://onedrive.live.com/x/photo.png", None, PREVIEW_TYPE_IMAGE),
        ("https://www.dropbox.com/s/abc/notes.docx", None, PREVIEW_TYPE_DOCUMENT),
        # Content-type hint classes an extension-less image URL
        ("https://cdn.example.com/raw/12345", "image/png", PREVIEW_TYPE_IMAGE),
        # Unknown shape falls back to generic file
        ("https://drive.google.com/file/d/abc/view", None, PREVIEW_TYPE_FILE),
        ("https://app.box.com/s/abc/unknownthing", "text/html", PREVIEW_TYPE_FILE),
    ],
)
def test_classify_preview_type(url: str, hint: str | None, expected: str) -> None:
    assert classify_preview_type(url, hint) == expected
