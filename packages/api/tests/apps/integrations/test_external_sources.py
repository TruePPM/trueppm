"""Tests for the EXTERNAL_TASK_SOURCES registry, DTO sanitization, and the OSS
Jira source — Cloud (REST v3 / Basic) and Data Center / Server (REST v2 / Bearer
PAT) — (ADR-0097 §1, ADR-0589).

The Jira HTTP calls are exercised against a stubbed egress layer — the SSRF
guard and transport are covered separately in ``test_http_ssrf.py``; here we
assert the source's request/response mapping and the untrusted-DTO hardening.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.integrations import external_sources, http
from trueppm_api.apps.integrations.external_sources import (
    EXTERNAL_TASK_SOURCES,
    ExternalSourceAuthError,
    ExternalSourceError,
    ExternalTaskSource,
    ExternalWorkItemDTO,
    JiraSource,
    _jira_server_base,
)


def _resp(status: int, body: bytes) -> http.EgressResponse:
    return http.EgressResponse(status=status, body=body, headers={})


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_jira_registered_as_external_source() -> None:
    """OSS owns ``jira`` in EXTERNAL_TASK_SOURCES (a distinct registry)."""
    assert "jira" in EXTERNAL_TASK_SOURCES
    source_cls = EXTERNAL_TASK_SOURCES.get("jira")
    assert source_cls is JiraSource
    assert issubclass(source_cls, ExternalTaskSource)


def test_external_sources_registry_is_distinct_from_task_links() -> None:
    """The two registries must not be the same object (ADR-0097 §1)."""
    from trueppm_api.apps.integrations.registry import TASK_LINK_PROVIDERS

    assert EXTERNAL_TASK_SOURCES is not TASK_LINK_PROVIDERS


# ---------------------------------------------------------------------------
# DTO sanitization (untrusted provider data — ADR-0097 §Resolution #4)
# ---------------------------------------------------------------------------


def test_dto_sanitized_drops_non_http_url() -> None:
    """A ``javascript:`` deep link is dropped rather than cached."""
    dto = ExternalWorkItemDTO(
        external_id="X-1",
        external_url="javascript:alert(1)",
        title="t",
        external_status="Open",
        display_bucket="todo",
    ).sanitized()
    assert dto.external_url == ""


def test_dto_sanitized_caps_field_lengths() -> None:
    """Over-long provider fields are truncated to the column widths."""
    dto = ExternalWorkItemDTO(
        external_id="k" * 999,
        external_url="https://example.atlassian.net/browse/" + "a" * 5000,
        title="t" * 5000,
        external_status="s" * 500,
        display_bucket="weird",
    ).sanitized()
    caps = external_sources.EXTERNAL_WORK_ITEM_FIELD_CAPS
    assert len(dto.external_id) == caps["external_id"]
    assert len(dto.title) == caps["title"]
    assert len(dto.external_status) == caps["external_status"]
    assert len(dto.external_url) <= caps["external_url"]
    # An unknown bucket falls back to a valid one rather than persisting garbage.
    assert dto.display_bucket in external_sources.DISPLAY_BUCKETS


# ---------------------------------------------------------------------------
# JiraSource.verify_credential
# ---------------------------------------------------------------------------


def test_verify_missing_email_fails_without_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """No account email → fail fast, never touch the network (Basic auth needs it)."""

    def _boom(*args: object, **kwargs: object) -> http.EgressResponse:
        raise AssertionError("verify must not call the network without an email")

    monkeypatch.setattr(http, "get", _boom)
    result = JiraSource().verify_credential(
        base_url="https://acme.atlassian.net", secret="tok", config={}
    )
    assert result.ok is False
    assert result.reason == "missing_email"


def test_verify_ok_on_200(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: _resp(200, b'{"displayName": "Priya"}'))
    result = JiraSource().verify_credential(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io"},
    )
    assert result.ok is True
    assert result.username == "Priya"


def test_verify_invalid_token_on_401(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: _resp(401, b"{}"))
    result = JiraSource().verify_credential(
        base_url="https://acme.atlassian.net",
        secret="bad",
        config={"account_email": "p@acme.io"},
    )
    assert result.ok is False
    assert result.reason == "invalid_token"


def test_verify_blocked_host_on_egress_block(monkeypatch: pytest.MonkeyPatch) -> None:
    def _blocked(*a: object, **k: object) -> http.EgressResponse:
        raise http.EgressBlocked("private range")

    monkeypatch.setattr(http, "get", _blocked)
    result = JiraSource().verify_credential(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io"},
    )
    assert result.ok is False
    assert result.reason == "blocked_host"


# ---------------------------------------------------------------------------
# JiraSource.fetch_assigned_items
# ---------------------------------------------------------------------------

_SEARCH_BODY = b"""
{"issues": [
  {"key": "RIV-482", "fields": {"summary": "Wire the pump",
    "status": {"name": "In Review", "statusCategory": {"key": "indeterminate"}},
    "duedate": "2026-08-01"}},
  {"key": "RIV-9", "fields": {"summary": "Ship it",
    "status": {"name": "Done", "statusCategory": {"key": "done"}}, "duedate": null}}
]}
"""


def test_fetch_maps_issues_to_dtos(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    def _get(
        url: str, *, headers: dict[str, str] | None = None, **k: object
    ) -> http.EgressResponse:
        captured["url"] = url
        captured["auth"] = (headers or {}).get("Authorization", "")
        return _resp(200, _SEARCH_BODY)

    monkeypatch.setattr(http, "get", _get)
    items = JiraSource().fetch_assigned_items(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io"},
    )
    assert [i.external_id for i in items] == ["RIV-482", "RIV-9"]
    assert items[0].display_bucket == "in_progress"
    assert items[1].display_bucket == "done"
    assert items[0].external_url == "https://acme.atlassian.net/browse/RIV-482"
    assert str(items[0].due_date) == "2026-08-01"
    assert items[1].due_date is None
    # Requests go to the tenant host over the search endpoint with Basic auth.
    assert captured["url"].startswith("https://acme.atlassian.net/rest/api/3/search?")
    assert captured["auth"].startswith("Basic ")


def test_fetch_auth_error_on_403(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 401/403 raises a distinct auth error so the worker flips to auth_failed
    rather than soft-removing every cached item on an empty list."""
    monkeypatch.setattr(http, "get", lambda *a, **k: _resp(403, b"{}"))
    with pytest.raises(ExternalSourceAuthError):
        JiraSource().fetch_assigned_items(
            base_url="https://acme.atlassian.net",
            secret="tok",
            config={"account_email": "p@acme.io"},
        )


def test_fetch_error_on_transport_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _err(*a: object, **k: object) -> http.EgressResponse:
        raise http.EgressError("dns")

    monkeypatch.setattr(http, "get", _err)
    with pytest.raises(ExternalSourceError):
        JiraSource().fetch_assigned_items(
            base_url="https://acme.atlassian.net",
            secret="tok",
            config={"account_email": "p@acme.io"},
        )


# ---------------------------------------------------------------------------
# Jira Data Center / Server variant (deployment="server") — ADR-0589
# ---------------------------------------------------------------------------

_SERVER_CONFIG = {"deployment": "server"}


def test_server_base_preserves_context_path_and_port() -> None:
    """A DC/Server host deployed under a context path (and/or non-standard port)
    keeps both — dropping them (as Cloud does) would 404 every REST call."""
    assert _jira_server_base("https://jira.corp.example/jira") == "https://jira.corp.example/jira"
    assert (
        _jira_server_base("https://jira.corp.example:8443/jira/")
        == "https://jira.corp.example:8443/jira"
    )
    assert _jira_server_base("https://jira.corp.example") == "https://jira.corp.example"


def test_server_verify_uses_v2_and_bearer_without_email(monkeypatch: pytest.MonkeyPatch) -> None:
    """Server pings ``/rest/api/2/myself`` with a Bearer PAT and needs no email
    (unlike Cloud Basic auth, which fails fast on a missing email)."""
    captured: dict[str, str] = {}

    def _get(
        url: str, *, headers: dict[str, str] | None = None, **k: object
    ) -> http.EgressResponse:
        captured["url"] = url
        captured["auth"] = (headers or {}).get("Authorization", "")
        return _resp(200, b'{"displayName": "Sam"}')

    monkeypatch.setattr(http, "get", _get)
    result = JiraSource().verify_credential(
        base_url="https://jira.corp.example/jira", secret="pat-token", config=_SERVER_CONFIG
    )
    assert result.ok is True
    assert result.username == "Sam"
    assert captured["url"] == "https://jira.corp.example/jira/rest/api/2/myself"
    assert captured["auth"] == "Bearer pat-token"


def test_server_fetch_uses_v2_bearer_and_context_path_browse_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Server fetch hits REST v2 with a Bearer PAT; the browse deep link carries
    the context path so it opens the right issue on a path-hosted DC install."""
    captured: dict[str, str] = {}

    def _get(
        url: str, *, headers: dict[str, str] | None = None, **k: object
    ) -> http.EgressResponse:
        captured["url"] = url
        captured["auth"] = (headers or {}).get("Authorization", "")
        return _resp(200, _SEARCH_BODY)

    monkeypatch.setattr(http, "get", _get)
    items = JiraSource().fetch_assigned_items(
        base_url="https://jira.corp.example/jira", secret="pat-token", config=_SERVER_CONFIG
    )
    assert [i.external_id for i in items] == ["RIV-482", "RIV-9"]
    assert items[0].external_url == "https://jira.corp.example/jira/browse/RIV-482"
    assert captured["url"].startswith("https://jira.corp.example/jira/rest/api/2/search?")
    assert captured["auth"] == "Bearer pat-token"


def test_server_verify_invalid_token_on_401(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead/expired PAT is reported as an invalid token, not a transport error."""
    monkeypatch.setattr(http, "get", lambda *a, **k: _resp(401, b"{}"))
    result = JiraSource().verify_credential(
        base_url="https://jira.corp.example", secret="bad", config=_SERVER_CONFIG
    )
    assert result.ok is False
    assert result.reason == "invalid_token"
