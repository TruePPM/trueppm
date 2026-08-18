"""Tests for the EXTERNAL_TASK_SOURCES registry, DTO sanitization, and the OSS
Jira source — Cloud (REST v3 / Basic) and Data Center / Server (REST v2 / Bearer
PAT) — (ADR-0097 §1, ADR-0589).

The Jira HTTP calls are exercised against a stubbed egress layer — the SSRF
guard and transport are covered separately in ``test_http_ssrf.py``; here we
assert the source's request/response mapping and the untrusted-DTO hardening.
"""

from __future__ import annotations

import urllib.parse

import pytest

from trueppm_api.apps.integrations import external_sources, http
from trueppm_api.apps.integrations.external_sources import (
    EXTERNAL_TASK_SOURCES,
    ExternalSourceAuthError,
    ExternalSourceConfigError,
    ExternalSourceError,
    ExternalTaskSource,
    ExternalWorkItemDTO,
    JiraSource,
    JqlNotWellFormed,
    _jira_server_base,
    scan_jql,
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


# ---------------------------------------------------------------------------
# The "Projects" filter narrows the pull (#2888)
# ---------------------------------------------------------------------------
#
# ``config["project_keys"]`` used to be collected, validated, persisted, echoed
# back and documented as scoping the pull while nothing read it — so a contributor
# who named two keys to keep a third engagement out of a shared tool still mirrored
# every assigned issue from every project. These tests assert the *consumer*: the
# keys reach the JQL on the wire, and they cannot be widened away by a custom JQL.


def _captured_jql(url: str) -> str:
    """Pull the decoded ``jql`` parameter back off a captured search URL."""
    query = urllib.parse.urlparse(url).query
    return urllib.parse.parse_qs(query)["jql"][0]


def _stub_search(monkeypatch: pytest.MonkeyPatch, captured: dict[str, str]) -> None:
    def _get(
        url: str, *, headers: dict[str, str] | None = None, **k: object
    ) -> http.EgressResponse:
        captured["url"] = url
        return _resp(200, _SEARCH_BODY)

    monkeypatch.setattr(http, "get", _get)


def test_fetch_scopes_default_jql_to_selected_projects(monkeypatch: pytest.MonkeyPatch) -> None:
    """The keys land in the query Jira actually receives, ahead of the ORDER BY."""
    captured: dict[str, str] = {}
    _stub_search(monkeypatch, captured)

    JiraSource().fetch_assigned_items(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io", "project_keys": ["RIV", "BAY"]},
    )

    jql = _captured_jql(captured["url"])
    assert jql == (
        "(assignee = currentUser() AND statusCategory != Done) "
        'AND project IN ("RIV", "BAY") ORDER BY updated DESC'
    )


def test_fetch_ands_project_keys_onto_a_custom_jql(monkeypatch: pytest.MonkeyPatch) -> None:
    """A custom JQL cannot widen the project filter past what the owner selected.

    The user's own query is parenthesized, so an ``OR`` inside it cannot escape the
    ``AND project IN (...)`` — ``a OR b AND project IN (…)`` would otherwise bind
    the AND tighter and pull every ``a``.
    """
    captured: dict[str, str] = {}
    _stub_search(monkeypatch, captured)

    JiraSource().fetch_assigned_items(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={
            "account_email": "p@acme.io",
            "jql": "assignee = currentUser() OR reporter = currentUser()",
            "project_keys": ["RIV"],
        },
    )

    jql = _captured_jql(captured["url"])
    assert jql == ('(assignee = currentUser() OR reporter = currentUser()) AND project IN ("RIV")')


def test_fetch_without_project_keys_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    """ "Leave blank for all" — no keys means no clause, not an empty IN ()."""
    captured: dict[str, str] = {}
    _stub_search(monkeypatch, captured)

    JiraSource().fetch_assigned_items(
        base_url="https://acme.atlassian.net",
        secret="tok",
        config={"account_email": "p@acme.io", "project_keys": []},
    )

    assert _captured_jql(captured["url"]) == external_sources._DEFAULT_JIRA_JQL


def test_fetch_rejects_an_invalid_stored_project_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A key that cannot be a Jira project key fails the pull, loudly.

    Dropping it instead would silently *widen* what leaves Jira — the exact wrong
    belief #2888 was about. A stored row can carry one (it predates the serializer
    rule, or came from a direct API call), and the key is interpolated into JQL.
    """
    captured: dict[str, str] = {}
    _stub_search(monkeypatch, captured)

    with pytest.raises(ExternalSourceError):
        JiraSource().fetch_assigned_items(
            base_url="https://acme.atlassian.net",
            secret="tok",
            config={"account_email": "p@acme.io", "project_keys": ['RIV") OR project IN ("SECRET']},
        )
    # Nothing was requested — the guard runs before the token is on the wire.
    assert "url" not in captured


def test_compose_jql_ignores_an_order_by_inside_a_quoted_literal() -> None:
    """A quoted ``order by`` in the filter is data, not the sort clause.

    Splitting on it would move the project constraint after the user's text and
    produce a query Jira rejects.
    """
    composed = external_sources._compose_jql(
        'summary ~ "order by rank" ORDER BY created ASC', ["RIV"]
    )
    assert composed == '(summary ~ "order by rank") AND project IN ("RIV") ORDER BY created ASC'


def test_compose_jql_handles_a_sort_only_query() -> None:
    """A JQL that is nothing but a sort still gets a well-formed WHERE clause."""
    assert (
        external_sources._compose_jql("ORDER BY updated DESC", ["riv"])
        == 'project IN ("RIV") ORDER BY updated DESC'
    )


def test_compose_jql_dedupes_and_upper_cases() -> None:
    """Keys are canonicalized so the clause matches the echoed, stored value."""
    assert external_sources._compose_jql("assignee = currentUser()", ["riv", "RIV", " bay "]) == (
        '(assignee = currentUser()) AND project IN ("RIV", "BAY")'
    )


def test_compose_jql_ignores_a_non_list_config_value() -> None:
    """A malformed stored value is treated as "no selection", not as a crash."""
    assert external_sources._compose_jql("assignee = currentUser()", "RIV") == (
        "assignee = currentUser()"
    )
    assert external_sources._compose_jql("assignee = currentUser()", None) == (
        "assignee = currentUser()"
    )


# ---------------------------------------------------------------------------
# The narrowing wrap is only sound on a structurally balanced query (#2888)
# ---------------------------------------------------------------------------
#
# `_compose_jql` narrows by wrapping the WHERE part in ONE pair of parentheses and
# ANDing `project IN (...)` after it. That is only a narrowing if the thing being
# wrapped is a single group. Given an unbalanced query the wrap closes the user's
# own parenthesis instead, and because JQL binds AND tighter than OR the result is
# valid JQL that pulls a whole project the owner never selected — the same "the
# filter does not actually narrow" outcome #2888 exists to prevent, via grouping
# rather than via a dead field.


@pytest.mark.parametrize(
    "malformed",
    [
        # The bypass: the trailing wrap paren closes the user's group, leaving
        # `(A) OR (B) AND project IN (...)` == `A OR (B AND project IN (...))`.
        'project = "PUBLIC") OR (project = "SECRET"',
        "(assignee = currentUser()",
        "assignee = currentUser())",
        'summary ~ "unterminated',
    ],
)
def test_compose_jql_refuses_a_query_it_cannot_safely_wrap(malformed: str) -> None:
    with pytest.raises(ExternalSourceConfigError):
        external_sources._compose_jql(malformed, ["RIV"])


def test_a_malformed_jql_with_no_project_keys_is_left_alone() -> None:
    """No keys means no wrap, so there is nothing to be unsound about.

    Jira's own parser stays the authority there; validating would reject queries
    that are none of this function's business.
    """
    assert external_sources._compose_jql("(assignee = currentUser()", []) == (
        "(assignee = currentUser()"
    )


def test_fetch_refuses_to_pull_on_a_malformed_stored_jql(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}
    _stub_search(monkeypatch, captured)

    with pytest.raises(ExternalSourceConfigError):
        JiraSource().fetch_assigned_items(
            base_url="https://acme.atlassian.net",
            secret="tok",
            config={
                "account_email": "p@acme.io",
                "jql": 'project = "PUBLIC") OR (project = "SECRET"',
                "project_keys": ["RIV"],
            },
        )
    # Refused before the token reached the wire.
    assert "url" not in captured


def test_config_error_is_a_source_error_so_older_callers_degrade_safely() -> None:
    """Any caller that only knows the base class keeps its existing behavior."""
    assert issubclass(ExternalSourceConfigError, ExternalSourceError)


def test_scan_jql_accepts_balanced_nesting_and_quoted_parens() -> None:
    """A paren inside a quoted literal is data, not structure."""
    where, order_by = scan_jql('(a = 1 AND (b = 2 OR summary ~ "a) b")) ORDER BY updated DESC')
    assert where == '(a = 1 AND (b = 2 OR summary ~ "a) b"))'
    assert order_by == "ORDER BY updated DESC"


def test_scan_jql_ignores_an_order_by_inside_a_group() -> None:
    """ORDER BY cannot legally appear inside parentheses, so it is not the sort."""
    where, order_by = scan_jql('(summary ~ "order by rank")')
    assert where == '(summary ~ "order by rank")'
    assert order_by == ""


def test_scan_jql_raises_its_own_error_type() -> None:
    with pytest.raises(JqlNotWellFormed):
        scan_jql("(a = 1")
