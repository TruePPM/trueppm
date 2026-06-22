"""Unit tests for TaskLink provider URL parsing + status fetch (#637).

Covers ``matches()`` host detection, the GitLab/GitHub URL parsers, the
``fetch_metadata`` status mapping (with the egress layer stubbed), and
``resolve_provider_key`` (SaaS match → self-hosted base_url match → generic).
"""

from __future__ import annotations

import json

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.integrations import http, providers
from trueppm_api.apps.integrations.models import IntegrationCredential
from trueppm_api.apps.integrations.providers import (
    BoxTaskLinkProvider,
    DropboxTaskLinkProvider,
    GenericTaskLinkProvider,
    GitHubTaskLinkProvider,
    GitLabTaskLinkProvider,
    GoogleDriveTaskLinkProvider,
    OneDriveTaskLinkProvider,
    _parse_github_url,
    _parse_gitlab_url,
    resolve_provider_key,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# matches()
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://github.com/acme/api/pull/5", True),
        ("https://www.github.com/acme/api/issues/5", True),
        ("https://gitlab.com/acme/api/-/merge_requests/5", False),
        ("https://ghe.internal.example.com/acme/api/pull/5", False),
    ],
)
def test_github_matches(url: str, expected: bool) -> None:
    assert GitHubTaskLinkProvider.matches(url) is expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://gitlab.com/acme/api/-/merge_requests/5", True),
        ("https://github.com/acme/api/pull/5", False),
        ("https://gitlab.example.com/acme/api/-/issues/5", False),
    ],
)
def test_gitlab_matches(url: str, expected: bool) -> None:
    assert GitLabTaskLinkProvider.matches(url) is expected


def test_generic_never_auto_matches() -> None:
    assert GenericTaskLinkProvider.matches("https://github.com/a/b/pull/1") is False
    assert GenericTaskLinkProvider.matches("https://anything.example.com/x") is False


# ---------------------------------------------------------------------------
# URL parsers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://github.com/acme/api/pull/42", ("acme", "api", "pull", "42")),
        ("https://github.com/acme/api/issues/7", ("acme", "api", "issues", "7")),
        ("https://github.com/acme/api/commit/abc123", None),  # no lifecycle status
        ("https://github.com/acme/api/tree/main", None),
        ("https://github.com/acme", None),
    ],
)
def test_parse_github_url(url: str, expected: tuple[str, str, str, str] | None) -> None:
    assert _parse_github_url(url) == expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "https://gitlab.com/grp/proj/-/merge_requests/42",
            ("grp/proj", "merge_requests", "42"),
        ),
        (
            "https://gitlab.com/grp/sub/proj/-/issues/9",  # nested groups
            ("grp/sub/proj", "issues", "9"),
        ),
        ("https://gitlab.com/grp/proj/-/commit/deadbeef", None),
        ("https://gitlab.com/grp/proj", None),  # no /-/ segment
    ],
)
def test_parse_gitlab_url(url: str, expected: tuple[str, str, str] | None) -> None:
    assert _parse_gitlab_url(url) == expected


# ---------------------------------------------------------------------------
# fetch_metadata — status mapping (egress stubbed)
# ---------------------------------------------------------------------------


@pytest.fixture
def _stub_response(monkeypatch: pytest.MonkeyPatch) -> object:
    """Return a helper that stubs ``http.get`` with a 200 JSON body."""

    def _install(payload: dict[str, object]) -> None:
        def _fake_get(
            url: str,
            *,
            headers: dict[str, str] | None = None,
            timeout: float = http.DEFAULT_TIMEOUT,
        ) -> http.EgressResponse:
            return http.EgressResponse(status=200, body=json.dumps(payload).encode(), headers={})

        monkeypatch.setattr(http, "get", _fake_get)

    return _install


class _FakeCredential:
    """A credential whose secret decrypts trivially (we patch the decryptor)."""

    base_url = ""
    secret_ciphertext = b"x"


@pytest.fixture(autouse=True)
def _stub_decrypt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(providers, "decrypt_secret", lambda _ct: "pat-token")


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"state": "open", "merged": False, "draft": False, "title": "T"}, "open"),
        ({"state": "open", "merged": False, "draft": True, "title": "T"}, "draft"),
        ({"state": "closed", "merged": True, "title": "T"}, "merged"),
        ({"state": "closed", "merged": False, "title": "T"}, "closed"),
    ],
)
def test_github_pr_status_mapping(
    _stub_response: object, payload: dict[str, object], expected: str
) -> None:
    _stub_response(payload)  # type: ignore[operator]
    meta = GitHubTaskLinkProvider().fetch_metadata(
        "https://github.com/a/b/pull/1", _FakeCredential()
    )
    assert meta.status == expected
    assert meta.title == "T"


def test_github_issue_status_mapping(_stub_response: object) -> None:
    _stub_response({"state": "closed", "title": "Bug"})  # type: ignore[operator]
    meta = GitHubTaskLinkProvider().fetch_metadata(
        "https://github.com/a/b/issues/3", _FakeCredential()
    )
    assert meta.status == "closed"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"state": "opened", "draft": False, "title": "T"}, "open"),
        ({"state": "opened", "work_in_progress": True, "title": "T"}, "draft"),
        ({"state": "merged", "title": "T"}, "merged"),
        ({"state": "closed", "title": "T"}, "closed"),
    ],
)
def test_gitlab_mr_status_mapping(
    _stub_response: object, payload: dict[str, object], expected: str
) -> None:
    _stub_response(payload)  # type: ignore[operator]
    meta = GitLabTaskLinkProvider().fetch_metadata(
        "https://gitlab.com/a/b/-/merge_requests/1", _FakeCredential()
    )
    assert meta.status == expected


def test_fetch_without_credential_is_unknown() -> None:
    meta = GitHubTaskLinkProvider().fetch_metadata("https://github.com/a/b/pull/1", None)
    assert meta.status == "unknown"


def test_fetch_unparseable_url_is_unknown(_stub_response: object) -> None:
    _stub_response({"state": "open"})  # type: ignore[operator]
    meta = GitHubTaskLinkProvider().fetch_metadata(
        "https://github.com/a/b/commit/sha", _FakeCredential()
    )
    assert meta.status == "unknown"


def test_fetch_transport_failure_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*args: object, **kwargs: object) -> object:
        raise http.EgressError("boom")

    monkeypatch.setattr(http, "get", _raise)
    meta = GitLabTaskLinkProvider().fetch_metadata(
        "https://gitlab.com/a/b/-/issues/1", _FakeCredential()
    )
    assert meta.status == "unknown"


def test_generic_fetch_is_always_unknown() -> None:
    meta = GenericTaskLinkProvider().fetch_metadata("https://example.com/x", None)
    assert meta.status == "unknown"


# ---------------------------------------------------------------------------
# resolve_provider_key
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolve_saas_hosts() -> None:
    user = User.objects.create_user(username="rk", password="pw")
    assert resolve_provider_key("https://github.com/a/b/pull/1", user=user) == "github"
    assert resolve_provider_key("https://gitlab.com/a/b/-/issues/1", user=user) == "gitlab"


@pytest.mark.django_db
def test_resolve_self_hosted_via_base_url() -> None:
    user = User.objects.create_user(username="rk2", password="pw")
    IntegrationCredential.upsert(
        user=user, provider="gitlab", secret="glpat-x", base_url="https://git.internal.example.com"
    )
    key = resolve_provider_key("https://git.internal.example.com/a/b/-/merge_requests/3", user=user)
    assert key == "gitlab"


@pytest.mark.django_db
def test_resolve_unmatched_is_generic() -> None:
    user = User.objects.create_user(username="rk3", password="pw")
    assert resolve_provider_key("https://bitbucket.org/a/b/pull-requests/1", user=user) == "generic"


# ---------------------------------------------------------------------------
# Cloud-file preview providers (#571, ADR-0163)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("provider_cls", "url", "expected"),
    [
        (GoogleDriveTaskLinkProvider, "https://drive.google.com/file/d/x/view", True),
        (GoogleDriveTaskLinkProvider, "https://docs.google.com/document/d/x/edit", True),
        (GoogleDriveTaskLinkProvider, "https://sheets.google.com/x", True),
        (GoogleDriveTaskLinkProvider, "https://github.com/a/b", False),
        (DropboxTaskLinkProvider, "https://www.dropbox.com/s/abc/f.pdf", True),
        (DropboxTaskLinkProvider, "https://dropbox.com/s/abc/f.pdf", True),
        (BoxTaskLinkProvider, "https://app.box.com/s/abc", True),
        (BoxTaskLinkProvider, "https://box.com/s/abc", True),
        (OneDriveTaskLinkProvider, "https://onedrive.live.com/x", True),
        (OneDriveTaskLinkProvider, "https://acme.sharepoint.com/:f:/x", True),
        (OneDriveTaskLinkProvider, "https://1drv.ms/x", True),
    ],
)
def test_file_provider_matches(provider_cls: type, url: str, expected: bool) -> None:
    assert provider_cls.matches(url) is expected


@pytest.mark.parametrize(
    "url",
    [
        "https://box.com.evil.com/s/abc",  # suffix-spoof must not match box.com
        "https://notdropbox.com/s/abc",
        "https://drive.google.com.attacker.test/x",
    ],
)
def test_file_provider_rejects_host_spoof(url: str) -> None:
    assert BoxTaskLinkProvider.matches("https://box.com.evil.com/s/abc") is False
    assert DropboxTaskLinkProvider.matches(url) is False
    assert GoogleDriveTaskLinkProvider.matches(url) is False


def _stub_html(
    monkeypatch: pytest.MonkeyPatch, *, status: int, body: bytes, content_type: str
) -> None:
    def _fake_get(url: str, **kwargs: object) -> http.EgressResponse:
        return http.EgressResponse(status=status, body=body, headers={"content-type": content_type})

    monkeypatch.setattr(http, "get", _fake_get)


def test_file_provider_unfurls_opengraph(monkeypatch: pytest.MonkeyPatch) -> None:
    body = (
        b"<html><head>"
        b'<meta property="og:title" content="Q3 Budget">'
        b'<meta property="og:description" content="Quarterly projections">'
        b'<meta property="og:image" content="https://cdn.example.com/t.png">'
        b"</head></html>"
    )
    _stub_html(monkeypatch, status=200, body=body, content_type="text/html")
    meta = GoogleDriveTaskLinkProvider().fetch_metadata(
        "https://docs.google.com/spreadsheets/d/x/edit", None
    )
    # A file has no PR/MR lifecycle — status stays unknown; the preview carries the signal.
    assert meta.status == "unknown"
    assert meta.title == "Q3 Budget"
    assert meta.description == "Quarterly projections"
    assert meta.thumbnail_url == "https://cdn.example.com/t.png"
    assert meta.preview_type == "spreadsheet"


def test_file_provider_direct_image_is_its_own_thumbnail(monkeypatch: pytest.MonkeyPatch) -> None:
    # A raw image URL returns no OpenGraph markup; the https URL itself is the thumb.
    _stub_html(monkeypatch, status=200, body=b"\x89PNG\r\n", content_type="image/png")
    url = "https://www.dropbox.com/s/abc/diagram.png"
    meta = DropboxTaskLinkProvider().fetch_metadata(url, None)
    assert meta.preview_type == "image"
    assert meta.thumbnail_url == url


def test_file_provider_non_200_is_unknown_without_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    # A private file returns a login wall (e.g. 403) — no preview is written.
    _stub_html(monkeypatch, status=403, body=b"denied", content_type="text/html")
    meta = BoxTaskLinkProvider().fetch_metadata("https://app.box.com/s/private", None)
    assert meta.status == "unknown"
    assert meta.title is None
    assert meta.description is None
    assert meta.thumbnail_url is None
    assert meta.preview_type is None


def test_file_provider_transport_failure_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*args: object, **kwargs: object) -> object:
        raise http.EgressBlocked("ssrf")

    monkeypatch.setattr(http, "get", _raise)
    meta = OneDriveTaskLinkProvider().fetch_metadata("https://onedrive.live.com/x", None)
    assert meta.status == "unknown"
    assert meta.preview_type is None


@pytest.mark.django_db
def test_resolve_file_hosts() -> None:
    user = User.objects.create_user(username="rkf", password="pw")
    cases = {
        "https://drive.google.com/file/d/x/view": "google_drive",
        "https://www.dropbox.com/s/abc/f.pdf": "dropbox",
        "https://app.box.com/s/abc": "box",
        "https://onedrive.live.com/x": "onedrive",
    }
    for url, expected in cases.items():
        assert resolve_provider_key(url, user=user) == expected
