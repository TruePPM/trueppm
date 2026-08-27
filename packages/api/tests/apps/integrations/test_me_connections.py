"""End-to-end tests for ``/api/v1/me/connections/{source}/`` (ADR-0097 §3).

Covers the connection-management contract:
1. GET returns a summary; the encrypted secret is **never** returned.
2. PUT connects/updates, storing the PAT Fernet-encrypted, only after verify.
3. A non-Jira-Cloud ``base_url`` is rejected (SSRF allow-list) before the token
   is ever put on the wire.
4. A failed verify returns 422 and never persists the plaintext.
5. DELETE hard-removes the credential + cached items and is idempotent.
6. Every action is strictly personal — another user's connection is invisible.
"""

from __future__ import annotations

import urllib.parse

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http
from trueppm_api.apps.integrations.encryption import decrypt_secret
from trueppm_api.apps.integrations.models import ExternalWorkItem, IntegrationCredential

User = get_user_model()

pytestmark = pytest.mark.django_db

_JIRA_BASE = "https://acme.atlassian.net"


@pytest.fixture(autouse=True)
def _stub_verify(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make Jira ``/myself`` verification pass without the network by default.

    Tests that need a *failing* verify override ``http.get`` themselves."""
    monkeypatch.setattr(
        http, "get", lambda *a, **k: http.EgressResponse(200, b'{"displayName": "P"}', {})
    )


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="conn_user", password="pw")


@pytest.fixture
def other_user() -> AbstractBaseUser:
    return User.objects.create_user(username="conn_other", password="pw")


@pytest.fixture
def client(user: AbstractBaseUser) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _connect_body(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "secret": "jira-api-token",
        "base_url": _JIRA_BASE,
        "account_email": "priya@acme.io",
        "jql": "assignee = currentUser()",
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


def test_get_not_connected(client: APIClient) -> None:
    response = client.get("/api/v1/me/connections/jira/")
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is False
    assert body["status"] == "not_connected"
    assert "secret" not in body


def test_get_unknown_source_is_400(client: APIClient) -> None:
    assert client.get("/api/v1/me/connections/nope/").status_code == 400


def test_requires_authentication() -> None:
    assert APIClient().get("/api/v1/me/connections/jira/").status_code in (401, 403)


# ---------------------------------------------------------------------------
# PUT (connect / update)
# ---------------------------------------------------------------------------


def test_connect_stores_encrypted_secret(client: APIClient, user: AbstractBaseUser) -> None:
    response = client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is True
    assert body["status"] == "connected"
    assert body["account_email"] == "priya@acme.io"
    # No deployment in the payload defaults to Cloud (the pre-discriminant shape).
    assert body["deployment"] == "cloud"
    # Secret is never echoed.
    assert "secret" not in body
    assert "secret_ciphertext" not in body
    # Stored ciphertext round-trips to the plaintext — and is not the plaintext.
    row = IntegrationCredential.objects.get(user=user, provider="jira")
    assert bytes(row.secret_ciphertext) != b"jira-api-token"
    assert decrypt_secret(row.secret_ciphertext) == "jira-api-token"
    assert row.config["jql"] == "assignee = currentUser()"
    assert row.config["deployment"] == "cloud"


def test_connect_is_idempotent_upsert(client: APIClient, user: AbstractBaseUser) -> None:
    """Connecting twice rotates the one row, never appends (unique per user,provider)."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    client.put("/api/v1/me/connections/jira/", _connect_body(secret="rotated-token"), format="json")
    rows = IntegrationCredential.objects.filter(user=user, provider="jira")
    assert rows.count() == 1
    assert decrypt_secret(rows.first().secret_ciphertext) == "rotated-token"


def test_connect_rejects_non_jira_cloud_host(client: APIClient, user: AbstractBaseUser) -> None:
    """SSRF allow-list: only *.atlassian.net; a stored token to an attacker host
    is never minted (the row is not written)."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(base_url="https://attacker.example.com"),
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["code"] == "base_url_not_allowed"
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


def test_connect_rejects_non_https_base_url(client: APIClient, user: AbstractBaseUser) -> None:
    """https-only (ADR-0097 §Resolution #1): a personal token must not ride http."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(base_url="http://acme.atlassian.net"),
        format="json",
    )
    assert response.status_code == 400
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


def test_jira_connection_does_not_hijack_task_link_resolution(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """Cross-registry guard (#1418): a stored jira external-source connection must
    not make an atlassian.net task-link URL resolve to the ``jira`` TASK_LINK
    provider (which is Enterprise-reserved) — it stays ``generic`` as before, so
    ``TaskLink.clean()`` accepts the link instead of 400ing."""
    from trueppm_api.apps.integrations.providers import resolve_provider_key

    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    resolved = resolve_provider_key("https://acme.atlassian.net/browse/RIV-1", user=user)
    assert resolved == "generic"


def test_connect_verify_failure_is_422_and_persists_nothing(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(401, b"{}", {}))
    response = client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    assert response.status_code == 422
    assert response.json()["reason"] == "invalid_token"
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


# ---------------------------------------------------------------------------
# PUT — Jira Data Center / Server variant (deployment="server", ADR-0589)
# ---------------------------------------------------------------------------


def test_connect_server_stores_deployment_on_allowlisted_host(
    client: APIClient, user: AbstractBaseUser, settings: pytest.FixtureRequest
) -> None:
    """A self-hosted DC/Server host that the operator has allow-listed connects
    with deployment=server, needs no account email, and stores the discriminant."""
    settings.INTEGRATION_ALLOWED_HOSTS = ["jira.corp.example"]
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(
            base_url="https://jira.corp.example/jira",
            deployment="server",
            account_email="",
            secret="dc-pat-token",
        ),
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["deployment"] == "server"
    row = IntegrationCredential.objects.get(user=user, provider="jira")
    assert row.config["deployment"] == "server"
    assert row.base_url == "https://jira.corp.example/jira"
    assert decrypt_secret(row.secret_ciphertext) == "dc-pat-token"


def test_connect_server_rejects_non_allowlisted_host(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """The operator allow-list is the exfil gate for self-hosted hosts (#902): a
    Server host that is not allow-listed is rejected before the PAT is put on the
    wire, and no row is written. Relaxing this would let a socially-engineered
    user ship their real DC PAT to an arbitrary host."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(
            base_url="https://jira.corp.example/jira",
            deployment="server",
            account_email="",
        ),
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["code"] == "base_url_not_allowed"
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()


# ---------------------------------------------------------------------------
# DELETE (disconnect)
# ---------------------------------------------------------------------------


def test_delete_removes_credential_and_cached_items(
    client: APIClient, user: AbstractBaseUser
) -> None:
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="RIV-1", display_bucket="todo"
    )
    response = client.delete("/api/v1/me/connections/jira/")
    assert response.status_code == 204
    assert not IntegrationCredential.objects.filter(user=user, provider="jira").exists()
    assert not ExternalWorkItem.objects.filter(user=user, source="jira").exists()


def test_delete_is_idempotent(client: APIClient) -> None:
    resp = client.delete("/api/v1/me/connections/jira/")
    assert resp.status_code == 204


# ---------------------------------------------------------------------------
# Personal isolation (ADR-0097 §3)
# ---------------------------------------------------------------------------


def test_connection_is_strictly_personal(
    client: APIClient, user: AbstractBaseUser, other_user: AbstractBaseUser
) -> None:
    """Another user's connection is invisible; a caller only sees their own."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")

    other = APIClient()
    other.force_authenticate(user=other_user)
    # other_user has no connection of their own.
    assert other.get("/api/v1/me/connections/jira/").json()["exists"] is False
    # other_user's delete does not touch the first user's row.
    other.delete("/api/v1/me/connections/jira/")
    assert IntegrationCredential.objects.filter(user=user, provider="jira").exists()


def test_external_jira_row_absent_from_git_credentials_list(client: APIClient) -> None:
    """A jira EXTERNAL_TASK_SOURCES row must not leak into /me/credentials/
    (git-link PAT surface) — the two namespaces stay separate (ADR-0097 §1)."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    listed = {row["provider"] for row in client.get("/api/v1/me/credentials/").json()}
    assert "jira" not in listed


# ---------------------------------------------------------------------------
# project_keys — validated at mint, and live at pull time (#2888)
# ---------------------------------------------------------------------------


def test_connect_normalizes_project_keys(client: APIClient, user: AbstractBaseUser) -> None:
    """Keys are upper-cased and de-duplicated so the stored, echoed and queried
    values are the same string."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(project_keys=["riv", " BAY ", "RIV"]),
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["project_keys"] == ["RIV", "BAY"]
    row = IntegrationCredential.objects.get(user=user, provider="jira")
    assert row.config["project_keys"] == ["RIV", "BAY"]


def test_connect_rejects_a_project_key_that_is_not_a_project_key(client: APIClient) -> None:
    """The keys are composed into JQL, so a value carrying quotes or parentheses
    is refused at mint with an inline message rather than stored."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(project_keys=['RIV") OR project IN ("SECRET']),
        format="json",
    )
    assert response.status_code == 400
    assert "project_keys" in response.json()
    assert not IntegrationCredential.objects.filter(provider="jira").exists()


def test_stored_project_keys_reach_the_jira_query(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The consumer, end to end: what the wizard stored is what Jira is asked for.

    #2888 was that this assertion had no counterpart in the codebase — the field
    was persisted, echoed and documented as scoping the pull while
    ``JiraSource.fetch`` read only ``config["jql"]``.
    """
    client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(project_keys=["RIV"]),
        format="json",
    )
    row = IntegrationCredential.objects.get(user=user, provider="jira")

    captured: dict[str, str] = {}

    def _get(url: str, **k: object) -> http.EgressResponse:
        captured["url"] = url
        return http.EgressResponse(200, b'{"issues": []}', {})

    monkeypatch.setattr(http, "get", _get)
    from trueppm_api.apps.integrations.external_sources import JiraSource

    JiraSource().fetch_assigned_items(
        base_url=row.base_url, secret="jira-api-token", config=row.config
    )
    assert 'project IN ("RIV")' in urllib.parse.unquote_plus(captured["url"])


def test_connect_rejects_an_unbalanced_jql(client: APIClient) -> None:
    """#2888: the project filter narrows by wrapping this query, and the wrap is
    only a narrowing on a balanced one — so an unbalanced query is refused at
    connect with an inline message rather than stored and failed on first pull."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(jql='project = "PUBLIC") OR (project = "SECRET"', project_keys=["RIV"]),
        format="json",
    )
    assert response.status_code == 400
    assert "jql" in response.json()
    assert not IntegrationCredential.objects.filter(provider="jira").exists()


def test_connect_accepts_a_balanced_grouped_jql(client: APIClient) -> None:
    """The guard rejects only broken input — real grouping must still work."""
    response = client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(jql="(assignee = currentUser() OR reporter = currentUser())"),
        format="json",
    )
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# poll_enabled — the background-poll opt-in (#3104, ADR-0097 §4)
# ---------------------------------------------------------------------------


def _poll_flag(user: AbstractBaseUser) -> object:
    """Read the stored opt-in straight off the row, not off the echoed summary."""
    row = IntegrationCredential.objects.get(user=user, provider="jira")
    return (row.config or {}).get("poll_enabled")


def test_connect_defaults_polling_off(client: APIClient, user: AbstractBaseUser) -> None:
    """A connection nobody opted in is default-off (ADR-0097 §4) — both in the
    stored config the poll worker filters on, and in the summary the switch reads."""
    body = client.put("/api/v1/me/connections/jira/", _connect_body(), format="json").json()
    assert body["poll_enabled"] is False
    assert _poll_flag(user) is False


def test_connect_can_opt_in_at_connect_time(client: APIClient, user: AbstractBaseUser) -> None:
    response = client.put(
        "/api/v1/me/connections/jira/", _connect_body(poll_enabled=True), format="json"
    )
    assert response.status_code == 200
    assert response.json()["poll_enabled"] is True
    assert _poll_flag(user) is True


def test_reconnect_without_the_field_keeps_polling_on(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """Rotating a token must not silently stop a connection polling.

    The PUT rebuilds ``config`` wholesale, so an omitted ``poll_enabled`` that
    defaulted to False would switch the poll off on every re-connect — with
    nothing in the UI to say it had happened. The connect wizard does not carry
    the switch, so this is the *normal* re-connect path, not an edge case.
    """
    client.put("/api/v1/me/connections/jira/", _connect_body(poll_enabled=True), format="json")

    body = client.put("/api/v1/me/connections/jira/", _connect_body(), format="json").json()

    assert body["poll_enabled"] is True
    assert _poll_flag(user) is True


def test_reconnect_can_still_turn_polling_off_explicitly(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """Preserve-on-omit is not preserve-always — an explicit false still wins."""
    client.put("/api/v1/me/connections/jira/", _connect_body(poll_enabled=True), format="json")

    body = client.put(
        "/api/v1/me/connections/jira/", _connect_body(poll_enabled=False), format="json"
    ).json()

    assert body["poll_enabled"] is False
    assert _poll_flag(user) is False


def test_patch_round_trips_the_opt_in_without_the_secret(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """The whole point of the PATCH: flip the switch with no credential in hand."""
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")

    response = client.patch("/api/v1/me/connections/jira/", {"poll_enabled": True}, format="json")

    assert response.status_code == 200
    assert response.json()["poll_enabled"] is True
    assert _poll_flag(user) is True

    off = client.patch("/api/v1/me/connections/jira/", {"poll_enabled": False}, format="json")
    assert off.json()["poll_enabled"] is False
    assert _poll_flag(user) is False


def test_patch_leaves_the_credential_and_filter_untouched(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """The one-field serializer must not become a back door onto the connection.

    Anything besides ``poll_enabled`` in the body is ignored, so this endpoint can
    never rewrite a host, a token, or a filter — the fields the connect wizard
    verifies before storing.
    """
    client.put(
        "/api/v1/me/connections/jira/",
        _connect_body(jql="assignee = currentUser()", project_keys=["RIV"]),
        format="json",
    )
    before = IntegrationCredential.objects.get(user=user, provider="jira")
    before_secret, before_url = bytes(before.secret_ciphertext), before.base_url

    client.patch(
        "/api/v1/me/connections/jira/",
        {
            "poll_enabled": True,
            "base_url": "https://evil.example.com",
            "secret": "stolen",
            "jql": "project = SECRET",
            "project_keys": ["SECRET"],
        },
        format="json",
    )

    after = IntegrationCredential.objects.get(user=user, provider="jira")
    assert after.base_url == before_url
    assert bytes(after.secret_ciphertext) == before_secret
    assert after.config["jql"] == "assignee = currentUser()"
    assert after.config["project_keys"] == ["RIV"]
    assert after.config["poll_enabled"] is True


def test_patch_without_a_connection_is_404(client: APIClient) -> None:
    response = client.patch("/api/v1/me/connections/jira/", {"poll_enabled": True}, format="json")
    assert response.status_code == 404
    assert not IntegrationCredential.objects.filter(provider="jira").exists()


def test_patch_unknown_source_is_400(client: APIClient) -> None:
    assert (
        client.patch(
            "/api/v1/me/connections/nope/", {"poll_enabled": True}, format="json"
        ).status_code
        == 400
    )


@pytest.mark.parametrize("payload", [{}, {"poll_enabled": "sometimes"}, {"poll_enabled": None}])
def test_patch_rejects_a_missing_or_non_boolean_flag(
    client: APIClient, payload: dict[str, object]
) -> None:
    """Fail loudly rather than storing a value the poll's own filter cannot read.

    ``_do_poll`` filters on ``config__poll_enabled=True`` in the DB, so a stored
    string would drop the connection out of the poll while the switch rendered on.
    """
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    assert client.patch("/api/v1/me/connections/jira/", payload, format="json").status_code == 400


def test_patch_requires_authentication() -> None:
    assert APIClient().patch(
        "/api/v1/me/connections/jira/", {"poll_enabled": True}, format="json"
    ).status_code in (401, 403)


def test_patch_cannot_enable_polling_on_another_users_connection(
    client: APIClient, user: AbstractBaseUser, other_user: AbstractBaseUser
) -> None:
    """The IDOR boundary: polling is a spend against *someone else's* Jira quota.

    ``self._row`` filters ``(user, provider)`` like every other action here, so a
    connection another user owns simply does not exist for this caller — a 404
    that says "you have no such connection", never "someone else does".
    """
    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")

    other = APIClient()
    other.force_authenticate(user=other_user)
    response = other.patch("/api/v1/me/connections/jira/", {"poll_enabled": True}, format="json")

    assert response.status_code == 404
    assert _poll_flag(user) is False


def test_opted_in_connection_is_picked_up_by_the_poll(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """End-to-end on the seam this ticket exists to close.

    The poll task, the beat entry, and the ``poll_enabled`` filter all shipped in
    #1419 — but nothing in the product could write the key, so the task fanned out
    zero pulls on every install. Asserting the switch's write is *the* thing
    ``_do_poll`` selects on is what proves the wiring, not that the field persists.
    """
    from trueppm_api.apps.integrations.models import ExternalSyncRequest
    from trueppm_api.apps.integrations.tasks import _do_poll

    client.put("/api/v1/me/connections/jira/", _connect_body(), format="json")
    ExternalSyncRequest.objects.all().delete()

    _do_poll()
    assert not ExternalSyncRequest.objects.filter(user=user, source="jira").exists()

    client.patch("/api/v1/me/connections/jira/", {"poll_enabled": True}, format="json")
    _do_poll()

    assert ExternalSyncRequest.objects.filter(user=user, source="jira").exists()
