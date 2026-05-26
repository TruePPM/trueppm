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
    GenericTaskLinkProvider,
    GitHubTaskLinkProvider,
    GitLabTaskLinkProvider,
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
