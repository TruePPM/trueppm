"""Tests for the EXTERNAL_TASK_SOURCES registry, DTO sanitization, and the OSS
Jira Cloud source (ADR-0097 §1).

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
    JiraCloudSource,
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
    assert source_cls is JiraCloudSource
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
# JiraCloudSource.verify_credential
# ---------------------------------------------------------------------------


def test_verify_missing_email_fails_without_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """No account email → fail fast, never touch the network (Basic auth needs it)."""

    def _boom(*args: object, **kwargs: object) -> http.EgressResponse:
        raise AssertionError("verify must not call the network without an email")

    monkeypatch.setattr(http, "get", _boom)
    result = JiraCloudSource().verify_credential(
        base_url="https://acme.atlassian.net", secret="tok", config={}
    )
    assert result.ok is False
    assert result.reason == "missing_email"


def test_verify_ok_on_200(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: _resp(200, b'{"displayName": "Priya"}'))
    result = JiraCloudSource().verify_credential(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io"},
    )
    assert result.ok is True
    assert result.username == "Priya"


def test_verify_invalid_token_on_401(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: _resp(401, b"{}"))
    result = JiraCloudSource().verify_credential(
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
    result = JiraCloudSource().verify_credential(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io"},
    )
    assert result.ok is False
    assert result.reason == "blocked_host"


# ---------------------------------------------------------------------------
# JiraCloudSource.fetch_assigned_items
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
    items = JiraCloudSource().fetch_assigned_items(
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
        JiraCloudSource().fetch_assigned_items(
            base_url="https://acme.atlassian.net",
            secret="tok",
            config={"account_email": "p@acme.io"},
        )


def test_fetch_error_on_transport_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _err(*a: object, **k: object) -> http.EgressResponse:
        raise http.EgressError("dns")

    monkeypatch.setattr(http, "get", _err)
    with pytest.raises(ExternalSourceError):
        JiraCloudSource().fetch_assigned_items(
            base_url="https://acme.atlassian.net",
            secret="tok",
            config={"account_email": "p@acme.io"},
        )
