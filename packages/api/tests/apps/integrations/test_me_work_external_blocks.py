"""Tests for the My Work external-item side-blocks (#1422, ADR-0097 §4).

``GET /api/v1/me/work/`` surfaces the caller's read-only external work items
(their assigned Jira issues) and per-source freshness as first-page-only blocks
alongside native tasks. These cover the contract the web binds:

* ``external_items`` / ``external_sources`` are present on page 1 (possibly
  empty), never on later pages;
* items are strictly personal (``user=request.user``), hide stale rows, and
  expose only read-only display fields under the My Work field names;
* ordering is ``due_date`` asc nulls-last → bucket rank → most-recent sync;
* ``external_sources`` reflects the connected credential's status + freshness.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http
from trueppm_api.apps.integrations.me_work import (
    external_items_queryset,
    external_source_summaries,
    me_work_external_blocks,
)
from trueppm_api.apps.integrations.models import (
    ExternalSyncRequest,
    ExternalSyncRequestReason,
    ExternalSyncRequestStatus,
    ExternalWorkItem,
    IntegrationCredential,
)

User = get_user_model()

pytestmark = pytest.mark.django_db


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _item(user: object, external_id: str, **kwargs: object) -> ExternalWorkItem:
    defaults: dict[str, object] = {
        "source": "jira",
        "title": f"Issue {external_id}",
        "external_status": "In Review",
        "display_bucket": "todo",
        "external_url": f"https://acme.atlassian.net/browse/{external_id}",
    }
    defaults.update(kwargs)
    return ExternalWorkItem.objects.create(user=user, external_id=external_id, **defaults)


def _jira_cred(
    user: object, *, status: str = "connected", last_used_at: object = None
) -> IntegrationCredential:
    return IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=b"x",
        base_url="https://acme.atlassian.net",
        config={"account_email": "priya@acme.io", "status": status},
        last_used_at=last_used_at,
    )


# ---------------------------------------------------------------------------
# Endpoint contract
# ---------------------------------------------------------------------------


def test_blocks_present_and_empty_when_nothing_connected() -> None:
    """Both keys are always on page 1 — an empty list means "no source"."""
    user = User.objects.create_user(username="priya", password="pw")
    resp = _client(user).get("/api/v1/me/work/")
    assert resp.status_code == 200
    assert resp.data["external_items"] == []
    assert resp.data["external_sources"] == []


def test_external_item_contract_fields() -> None:
    """The item exposes the My Work field names, read-only, mapped from the model."""
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user)
    _item(
        user,
        "RIV-482",
        display_bucket="in_progress",
        external_status="In Review",
        due_date=date(2026, 8, 1),
    )
    resp = _client(user).get("/api/v1/me/work/")
    assert resp.status_code == 200
    (item,) = resp.data["external_items"]
    assert item["source_type"] == "jira"
    assert item["key"] == "RIV-482"
    assert item["title"] == "Issue RIV-482"
    assert item["external_status"] == "In Review"
    assert item["status_category"] == "in_progress"
    assert str(item["due_date"]) == "2026-08-01"
    assert item["url"] == "https://acme.atlassian.net/browse/RIV-482"
    assert "synced_at" in item
    # No write/schedule/secret fields leak onto a read-only row.
    for leaked in ("server_version", "secret_ciphertext", "user", "is_stale"):
        assert leaked not in item


def test_items_are_user_scoped() -> None:
    """Alice never sees Bob's external items, even sharing a source provider."""
    alice = User.objects.create_user(username="alice", password="pw")
    bob = User.objects.create_user(username="bob", password="pw")
    _item(alice, "A-1")
    _item(bob, "B-1")
    resp = _client(alice).get("/api/v1/me/work/")
    keys = [i["key"] for i in resp.data["external_items"]]
    assert keys == ["A-1"]


def test_stale_items_hidden() -> None:
    """Soft-removed (is_stale) rows never surface in the feed."""
    user = User.objects.create_user(username="priya", password="pw")
    _item(user, "LIVE-1")
    _item(user, "GONE-1", is_stale=True)
    resp = _client(user).get("/api/v1/me/work/")
    keys = [i["key"] for i in resp.data["external_items"]]
    assert keys == ["LIVE-1"]


def test_blocks_absent_on_second_page() -> None:
    """First-page-only, like signals — page 2 pays nothing for the blocks."""
    user = User.objects.create_user(username="priya", password="pw")
    _item(user, "RIV-1")
    resp = _client(user).get("/api/v1/me/work/?limit=1&offset=1")
    assert resp.status_code == 200
    assert "external_items" not in resp.data
    assert "external_sources" not in resp.data


# ---------------------------------------------------------------------------
# Ordering (helper)
# ---------------------------------------------------------------------------


def test_ordering_due_date_then_bucket_then_recency() -> None:
    """due_date asc nulls-last, then in_progress→todo→done, then newest sync."""
    from django.utils import timezone

    user = User.objects.create_user(username="priya", password="pw")
    now = timezone.now()
    # Undated in_progress — sorts after all dated items (nulls last).
    _item(user, "NODATE", display_bucket="in_progress", due_date=None, last_synced_at=now)
    # Earliest due date wins regardless of bucket.
    _item(user, "EARLY", display_bucket="todo", due_date=date(2026, 8, 1), last_synced_at=now)
    # Same later due date; in_progress ranks before todo.
    _item(
        user, "LATE-IP", display_bucket="in_progress", due_date=date(2026, 8, 5), last_synced_at=now
    )
    _item(user, "LATE-TODO", display_bucket="todo", due_date=date(2026, 8, 5), last_synced_at=now)

    ordered = [i.external_id for i in external_items_queryset(user)]
    assert ordered == ["EARLY", "LATE-IP", "LATE-TODO", "NODATE"]


# ---------------------------------------------------------------------------
# Source summaries (helper)
# ---------------------------------------------------------------------------


def test_source_summary_reflects_connection() -> None:
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user, status="connected")
    (summary,) = external_source_summaries(user)
    assert summary["source_type"] == "jira"
    assert summary["label"] == "Jira"
    assert summary["site_url"] == "acme.atlassian.net"
    assert summary["status"] == "connected"
    # No secret material in the summary.
    assert "secret_ciphertext" not in summary
    assert "account_email" not in summary


def test_source_summary_surfaces_auth_failed() -> None:
    """A dead token flips status so the UI can prompt a reconnect."""
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user, status="auth_failed")
    (summary,) = external_source_summaries(user)
    assert summary["status"] == "auth_failed"


def test_summaries_are_user_scoped() -> None:
    alice = User.objects.create_user(username="alice", password="pw")
    bob = User.objects.create_user(username="bob", password="pw")
    _jira_cred(bob)
    assert external_source_summaries(alice) == []


def test_blocks_helper_shape() -> None:
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user)
    _item(user, "RIV-1")
    blocks = me_work_external_blocks(user)
    assert set(blocks) == {"external_items", "external_sources"}
    assert len(blocks["external_items"]) == 1
    assert len(blocks["external_sources"]) == 1


# ---------------------------------------------------------------------------
# On-open refresh-if-stale (#1921, ADR-0097 §4)
# ---------------------------------------------------------------------------
#
# ExternalSyncRequestReason.ON_OPEN was defined but never invoked (#1433 left
# it wired-but-dormant). These cover that opening My Work enqueues a pull only
# when the connection's cache has actually gone stale, that the enqueue never
# blocks the response on an external fetch, and that the existing outbox
# throttle (the per-(user, source) PENDING coalescing `enqueue_external_sync`
# already provides) keeps rapid repeat opens from stacking pulls.

_STALE_SECONDS = 60


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly if My Work's on-open refresh ever touches the network.

    The enqueue must be a same-request DB write only — the actual Jira fetch
    is handed to Celery. Stubbing the single egress chokepoint to raise proves
    the ``GET /me/work/`` response is never gated on an external HTTP call.
    """
    monkeypatch.setattr(
        http, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("network touched"))
    )


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_enqueues_when_stale() -> None:
    """A connection whose cache is past the staleness floor gets an ON_OPEN pull."""
    user = User.objects.create_user(username="priya", password="pw")
    stale_at = timezone.now() - timedelta(seconds=_STALE_SECONDS * 5)
    _jira_cred(user, last_used_at=stale_at)

    resp = _client(user).get("/api/v1/me/work/")

    assert resp.status_code == 200
    (req,) = ExternalSyncRequest.objects.filter(user=user, source="jira")
    assert req.reason == ExternalSyncRequestReason.ON_OPEN
    assert req.status == ExternalSyncRequestStatus.PENDING


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_enqueues_nothing_when_fresh() -> None:
    """A recently-synced connection is not re-triggered on every My Work load."""
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user, last_used_at=timezone.now())

    resp = _client(user).get("/api/v1/me/work/")

    assert resp.status_code == 200
    assert ExternalSyncRequest.objects.filter(user=user).count() == 0


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_enqueues_when_never_synced() -> None:
    """A connected source that has never completed a pull (``last_used_at`` is
    null) counts as stale — otherwise a brand-new connection would never
    on-open-refresh until someone hits manual refresh."""
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user, last_used_at=None)

    resp = _client(user).get("/api/v1/me/work/")

    assert resp.status_code == 200
    on_open_requests = ExternalSyncRequest.objects.filter(
        user=user, reason=ExternalSyncRequestReason.ON_OPEN
    )
    assert on_open_requests.count() == 1


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_skips_auth_failed_connection() -> None:
    """A dead token gets a Reconnect prompt, not a doomed retry pull."""
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user, status="auth_failed", last_used_at=None)

    resp = _client(user).get("/api/v1/me/work/")

    assert resp.status_code == 200
    assert ExternalSyncRequest.objects.filter(user=user).count() == 0


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_never_enqueues_another_users_connection() -> None:
    """The enqueue is strictly scoped to the requesting user's own sources."""
    alice = User.objects.create_user(username="alice", password="pw")
    bob = User.objects.create_user(username="bob", password="pw")
    _jira_cred(bob, last_used_at=None)

    resp = _client(alice).get("/api/v1/me/work/")

    assert resp.status_code == 200
    assert ExternalSyncRequest.objects.count() == 0


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_repeat_opens_do_not_stack_pulls() -> None:
    """Throttle: an in-flight pull is adopted, not duplicated, by a second stale open.

    Mirrors the manual-refresh coalescing `enqueue_external_sync` already does
    via the outbox's partial-unique-PENDING constraint — opening My Work twice
    in a row while a source is stale (and its first pull hasn't landed yet)
    must not hammer Jira with a second fetch.
    """
    user = User.objects.create_user(username="priya", password="pw")
    _jira_cred(user, last_used_at=None)

    first = _client(user).get("/api/v1/me/work/")
    second = _client(user).get("/api/v1/me/work/")

    assert first.status_code == 200
    assert second.status_code == 200
    assert ExternalSyncRequest.objects.filter(user=user).count() == 1


@override_settings(TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS=_STALE_SECONDS)
def test_on_open_no_op_without_a_connection() -> None:
    """No connected source at all: nothing to enqueue, no crash."""
    user = User.objects.create_user(username="priya", password="pw")

    resp = _client(user).get("/api/v1/me/work/")

    assert resp.status_code == 200
    assert ExternalSyncRequest.objects.count() == 0
