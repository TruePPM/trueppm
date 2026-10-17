"""Tests for outbound webhook subscription management and delivery."""

from __future__ import annotations

import hashlib
import hmac
import urllib.error
import urllib.request
import uuid
from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL, ApiToken, Calendar, Project
from trueppm_api.apps.webhooks.models import (
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="wh_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WHProject", start_date=date(2026, 3, 1), calendar=calendar)


def _token_client(owner: object) -> APIClient:
    """A session-less client bearing a live ``legacy:full`` personal token for
    ``owner`` — the "leaked PAT belonging to a project Admin" shape #2939/#4461
    close. Mirrors ``test_share_links.py``'s helper of the same name.
    """
    raw = f"{TOKEN_PREFIX}{uuid.uuid4().hex}{uuid.uuid4().hex}"
    ApiToken.objects.create(
        owner=owner,
        name="leaked",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_LEGACY_FULL],
    )
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return c


@pytest.fixture
def admin_client(user: object, project: Project) -> APIClient:
    # update_or_create rather than create: the `webhook` fixture below also grants
    # `user` membership so dispatch_webhooks (#4325, #4330) sees a live Admin+
    # registrant, and either fixture may resolve first depending on which other
    # fixtures a given test also requests.
    ProjectMembership.objects.update_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    viewer = User.objects.create_user(username="wh_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def member_client(project: Project) -> APIClient:
    member = User.objects.create_user(username="wh_member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    return c


@pytest.fixture
def webhook(project: Project, user: object) -> Webhook:
    # dispatch_webhooks (#4325) only delivers to a live member's webhook, and
    # (#4330) that membership must be Admin+ — grant `user` an Admin row so the
    # pre-existing dispatch tests below still exercise a deliverable webhook.
    # get_or_create (not update_or_create): when `admin_client` also resolves for
    # this test, it must not downgrade that row regardless of fixture resolution
    # order (both now grant the same ADMIN role, so order no longer matters, but
    # get_or_create is kept to avoid re-introducing the hazard on a future edit).
    ProjectMembership.objects.get_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created", "task.updated"],
        created_by=user,
    )


# ---------------------------------------------------------------------------
# Model tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_webhook_create(project: Project, user: object) -> None:
    wh = Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s3cret",
        events=["task.created"],
        created_by=user,
    )
    assert wh.is_active is True
    assert wh.events == ["task.created"]


@pytest.mark.django_db
def test_delivery_create(webhook: Webhook) -> None:
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "abc"},
    )
    assert delivery.status == DeliveryStatus.PENDING
    assert delivery.attempt_count == 0


# ---------------------------------------------------------------------------
# API tests — CRUD
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_webhook_requires_admin(member_client: APIClient, project: Project) -> None:
    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "https://example.com/hook", "secret": "s", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_webhook_as_admin(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {
            "url": "https://example.com/hook",
            "secret": "a" * 40,  # >= 32-char minimum (#893)
            "events": ["task.created"],
        },
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["url"] == "https://example.com/hook"
    # Secret is echoed exactly once on create so the caller can record it (#893).
    assert resp.data["secret"] == "a" * 40


@pytest.mark.django_db
def test_create_webhook_refuses_a_token_caller_even_when_admin(
    user: object, project: Project
) -> None:
    """A leaked PAT must not be able to mint this durable HMAC-signing credential
    (#4461) — the same PAT-manages-PAT rule #2878 applied to ``/me/api-tokens/``
    and #2939 applied to share links and git-automation secrets.
    """
    ProjectMembership.objects.update_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    resp = _token_client(user).post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "https://example.com/hook", "secret": "a" * 40, "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert Webhook.objects.filter(project=project).count() == 0
    # Listing is unaffected: GET never carries the secret, so it is not the
    # reconnaissance step the create echo would be.
    assert _token_client(user).get(f"/api/v1/projects/{project.pk}/webhooks/").status_code == 200


@pytest.mark.django_db
def test_update_webhook_refuses_a_token_caller_even_when_admin(
    user: object, project: Project, webhook: Webhook
) -> None:
    """Same rule as create: a PATCH can repoint the delivery URL or rotate the
    signing secret, either of which is a durable grant a leaked PAT should not be
    able to extend itself with (#4461).
    """
    original_url = webhook.url
    resp = _token_client(user).patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"url": "https://attacker.example.com/exfil"},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    webhook.refresh_from_db()
    assert webhook.url == original_url


@pytest.mark.django_db
def test_update_records_an_editor_only_on_url_or_secret_change(
    admin_client: APIClient, project: Project, webhook: Webhook, user: object
) -> None:
    """A write that touches neither `url`/`secret` nor re-enables a disabled
    webhook must not record an editor row (#4461) — those are the only
    durable-grant-shaped writes, and `revoke_personal_durable_grants` sweeps
    on this set, so recording it on an unrelated write (relabeling `events`
    on an already-active webhook) would widen who the sweep contains for no
    reason. The re-enable case is covered separately in
    ``test_reenabling_a_disabled_webhook_records_an_editor`` and
    ``test_disabling_a_webhook_does_not_record_an_editor``.
    """
    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"events": ["task.created", "task.updated"]},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert not webhook.editors.exists()

    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"url": "https://example.com/repointed"},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert set(webhook.editors.values_list("user_id", flat=True)) == {user.pk}


@pytest.mark.django_db
def test_reenabling_a_disabled_webhook_records_an_editor(project: Project, user: object) -> None:
    """Round-3 GAP: re-enabling is durable-grant-shaped on its own, even with
    `url`/`secret` untouched. A webhook disabled by the containment sweep (or
    the auto-disable guard) still carries whatever `url`/`secret` it had; a
    SECOND hijacked session that does nothing but flip `is_active` back on
    restarts delivery to wherever it currently points. That re-enabler must
    be recorded, or their own future containment would miss the row even
    though they are the one who restarted the leak.
    """
    ProjectMembership.objects.update_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    coadmin = User.objects.create_user(username="wh_reenabler", password="pw")
    ProjectMembership.objects.create(project=project, user=coadmin, role=Role.ADMIN)

    wh = Webhook.objects.create(
        project=project,
        url="https://example.com/original",
        secret="original-secret-1234567890123456",
        events=["task.created"],
        created_by=user,
        is_active=False,
    )
    assert not wh.editors.exists()

    coadmin_client = APIClient()
    coadmin_client.force_authenticate(user=coadmin)
    resp = coadmin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{wh.pk}/",
        {"is_active": True},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert set(wh.editors.values_list("user_id", flat=True)) == {coadmin.pk}


@pytest.mark.django_db
def test_disabling_a_webhook_does_not_record_an_editor(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """Disabling is the opposite shape — it only shrinks what is live — so it
    must not record an editor (#4461), unlike re-enabling.
    """
    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"is_active": False},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert not webhook.editors.exists()


@pytest.mark.django_db
def test_patch_is_active_true_on_an_already_active_webhook_does_not_record_an_editor(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """Re-submitting `is_active: true` on an already-active webhook is a no-op,
    not a re-enable — it must not record an editor either.
    """
    assert webhook.is_active is True
    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"is_active": True},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert not webhook.editors.exists()


@pytest.mark.django_db
def test_repoint_by_a_different_admin_is_caught_by_that_admins_own_sweep(
    project: Project, user: object
) -> None:
    """#4461 BLOCKER: a project webhook's update has no registrant check — any
    project Admin may repoint any other project webhook's URL or rotate its
    secret (documented in webhooks.md's Containment section). Before this
    fix, the registrant (`created_by`) is who gets contained, not whoever
    actually holds the hijacked session that repointed the webhook — so a
    DIFFERENT admin's own password reset/off-boarding left the row untouched,
    and only an instance-wide `--all` sweep ever caught it. The repointing
    admin's own containment must catch it instead, because the sweep also
    matches ``webhook.editors``.

    The registrant here (`user`) is never contained in this test — proving
    the fix means the ADMIN WHO REPOINTED IT (not the creator) triggers
    deactivation, which `created_by` alone could never do.
    """
    from trueppm_api.apps.access.services import revoke_personal_durable_grants

    ProjectMembership.objects.update_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    coadmin = User.objects.create_user(username="wh_coadmin", password="pw")
    ProjectMembership.objects.create(project=project, user=coadmin, role=Role.ADMIN)

    wh = Webhook.objects.create(
        project=project,
        url="https://example.com/original",
        secret="original-secret-1234567890123456",
        events=["task.created"],
        created_by=user,
    )

    coadmin_client = APIClient()
    coadmin_client.force_authenticate(user=coadmin)
    resp = coadmin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{wh.pk}/",
        {"url": "https://attacker.example.com/exfil"},
        format="json",
    )
    assert resp.status_code == 200, resp.data

    wh.refresh_from_db()
    assert wh.created_by_id == user.pk
    assert set(wh.editors.values_list("user_id", flat=True)) == {coadmin.pk}

    # The repointing admin's own containment catches it — the fix. `user`
    # (the registrant) is never touched by this call, so a pre-fix sweep
    # that matched only `created_by` would have left `wh` active here.
    revoke_personal_durable_grants(coadmin)
    wh.refresh_from_db()
    assert wh.is_active is False
    assert wh.disabled_at is not None


@pytest.mark.django_db
def test_sequence_a_later_secret_rotation_by_the_registrant_does_not_erase_attribution(
    project: Project, user: object
) -> None:
    """Round-2 BLOCKER, sequence (a): a mutable "last modified by" field broke on
    exactly this sequence — Admin B's hijacked session repoints `url`, then
    Admin A (the registrant) later does a routine, unrelated secret rotation.
    A single-field stamp would be overwritten to A, and B's own password
    reset/off-boarding would no longer match. The additive editors set must
    not have that failure: B's row stays, regardless of what A does afterward.
    """
    from trueppm_api.apps.access.services import revoke_personal_durable_grants

    ProjectMembership.objects.update_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    coadmin_b = User.objects.create_user(username="wh_seq_a_b", password="pw")
    ProjectMembership.objects.create(project=project, user=coadmin_b, role=Role.ADMIN)

    wh = Webhook.objects.create(
        project=project,
        url="https://example.com/original",
        secret="original-secret-1234567890123456",
        events=["task.created"],
        created_by=user,
    )

    # B's hijacked session repoints the URL.
    b_client = APIClient()
    b_client.force_authenticate(user=coadmin_b)
    resp = b_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{wh.pk}/",
        {"url": "https://attacker.example.com/exfil"},
        format="json",
    )
    assert resp.status_code == 200, resp.data

    # A — the registrant, acting legitimately and much later — rotates the
    # secret. This must NOT remove B from the editors set.
    a_client = APIClient()
    a_client.force_authenticate(user=user)
    resp = a_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{wh.pk}/",
        {"secret": "b" * 40},
        format="json",
    )
    assert resp.status_code == 200, resp.data

    wh.refresh_from_db()
    assert set(wh.editors.values_list("user_id", flat=True)) == {coadmin_b.pk, user.pk}

    # B's own containment still catches the row.
    revoke_personal_durable_grants(coadmin_b)
    wh.refresh_from_db()
    assert wh.is_active is False


@pytest.mark.django_db
def test_sequence_b_a_later_events_only_put_does_not_erase_attribution(
    project: Project, user: object
) -> None:
    """Round-2 BLOCKER, sequence (b): same repoint by B, but A's later write is a
    PUT that only means to change `events` — PUT requires `url` in the request
    body, so the unchanged, still-evil URL is present in `validated_data` too.
    A single-field stamp flipped to A on this write even though A touched
    neither field in substance; the additive editors set does not, because B's
    row is never removed, and A also lands in the set (A did re-submit `url`,
    so by WebhookViewSet.perform_update's "url or secret present" rule A is
    recorded too — harmless, since A's own containment already covers A).
    """
    from trueppm_api.apps.access.services import revoke_personal_durable_grants

    ProjectMembership.objects.update_or_create(
        project=project, user=user, defaults={"role": Role.ADMIN}
    )
    coadmin_b = User.objects.create_user(username="wh_seq_b_b", password="pw")
    ProjectMembership.objects.create(project=project, user=coadmin_b, role=Role.ADMIN)

    wh = Webhook.objects.create(
        project=project,
        url="https://example.com/original",
        secret="original-secret-1234567890123456",
        events=["task.created"],
        created_by=user,
    )

    b_client = APIClient()
    b_client.force_authenticate(user=coadmin_b)
    resp = b_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{wh.pk}/",
        {"url": "https://attacker.example.com/exfil"},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    evil_url = wh.url  # unchanged by A's PUT below

    # A sends a full PUT meaning only to add an event, but PUT requires `url`
    # in the body — the still-evil URL rides along, unchanged.
    a_client = APIClient()
    a_client.force_authenticate(user=user)
    resp = a_client.put(
        f"/api/v1/projects/{project.pk}/webhooks/{wh.pk}/",
        {
            "url": evil_url,
            "events": ["task.created", "task.updated"],
        },
        format="json",
    )
    assert resp.status_code == 200, resp.data

    wh.refresh_from_db()
    assert wh.url == evil_url  # still pointed at the attacker
    assert coadmin_b.pk in set(wh.editors.values_list("user_id", flat=True))

    # B's own containment still catches the row.
    revoke_personal_durable_grants(coadmin_b)
    wh.refresh_from_db()
    assert wh.is_active is False


@pytest.mark.django_db
def test_list_webhooks_as_viewer(
    viewer_client: APIClient, project: Project, webhook: Webhook
) -> None:
    resp = viewer_client.get(f"/api/v1/projects/{project.pk}/webhooks/")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 1
    # Secret is not exposed.
    assert "secret" not in resp.data["results"][0]


@pytest.mark.django_db
def test_delete_webhook_requires_admin(
    viewer_client: APIClient, project: Project, webhook: Webhook
) -> None:
    resp = viewer_client.delete(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_delete_webhook_as_admin(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    resp = admin_client.delete(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/")
    assert resp.status_code == 204
    assert not Webhook.objects.filter(pk=webhook.pk).exists()


# ---------------------------------------------------------------------------
# deliveries audit log — payload is Admin-only (#903)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_deliveries_payload_denied_to_member(
    member_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """A plain project Member must not read the delivery audit log: its payloads
    carry task notes / comment snippets / assignee emails (#903)."""
    WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.updated",
        payload={"task": {"notes": "secret internal note", "assignee_email": "a@b.example"}},
    )
    resp = member_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_deliveries_payload_readable_by_admin(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """An Admin can read the deliveries (and their payloads)."""
    WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.updated",
        payload={"task": {"notes": "secret internal note"}},
    )
    resp = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/")
    assert resp.status_code == 200
    rows = resp.json()["results"]  # cursor-paginated (#1317)
    assert len(rows) == 1
    assert rows[0]["payload"]["task"]["notes"] == "secret internal note"


def test_deliveries_list_is_cursor_paginated(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """200 deliveries return a single bounded page newest-first (#1317).

    Replaces the old hard ``[:50]`` slice — a cursor lets an admin page back
    through history instead of only ever seeing the newest 50.
    """
    WebhookDelivery.objects.bulk_create(
        [
            WebhookDelivery(webhook=webhook, event_type="task.updated", payload={})
            for _ in range(200)
        ]
    )
    resp = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == 50  # WebhookDeliveryCursorPagination.page_size
    assert body["next"] is not None  # a cursor to page back through history
    assert "count" not in body  # cursor pagination omits the total COUNT


# ---------------------------------------------------------------------------
# Secret validation + one-time echo (#893)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWebhookSecret:
    """The signing secret must meet a minimum length/entropy floor and is only
    ever echoed once, in the create response."""

    def _create(self, client: APIClient, project: Project, **overrides: object) -> object:
        body: dict[str, object] = {
            "url": "https://example.com/hook",
            "events": ["task.created"],
        }
        body.update(overrides)
        return client.post(f"/api/v1/projects/{project.pk}/webhooks/", body, format="json")

    def test_short_secret_rejected(self, admin_client: APIClient, project: Project) -> None:
        resp = self._create(admin_client, project, secret="short")
        assert resp.status_code == 400
        assert "secret" in resp.data

    def test_whitespace_only_secret_rejected(
        self, admin_client: APIClient, project: Project
    ) -> None:
        resp = self._create(admin_client, project, secret=" " * 40)
        assert resp.status_code == 400
        assert "secret" in resp.data

    def test_omitted_secret_is_autogenerated(
        self, admin_client: APIClient, project: Project
    ) -> None:
        """A blank/omitted secret triggers a strong auto-generated value."""
        resp = self._create(admin_client, project)
        assert resp.status_code == 201, resp.data
        # Echoed once and long enough to be a real secret.
        generated = resp.data["secret"]
        assert isinstance(generated, str)
        assert len(generated) >= 32
        wh = Webhook.objects.get(pk=resp.data["id"])
        assert wh.secret == generated

    def test_empty_string_secret_is_autogenerated(
        self, admin_client: APIClient, project: Project
    ) -> None:
        resp = self._create(admin_client, project, secret="")
        assert resp.status_code == 201, resp.data
        assert len(resp.data["secret"]) >= 32

    def test_valid_secret_accepted(self, admin_client: APIClient, project: Project) -> None:
        resp = self._create(admin_client, project, secret="x" * 32)
        assert resp.status_code == 201, resp.data
        assert resp.data["secret"] == "x" * 32

    def test_secret_never_echoed_on_read(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """Retrieve/list never expose the secret — only the create response does."""
        detail = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/")
        assert detail.status_code == 200
        assert "secret" not in detail.data
        listing = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/")
        assert listing.status_code == 200
        assert "secret" not in listing.data["results"][0]

    def test_patch_blank_secret_rejected(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """A PATCH with an empty secret must not silently disable HMAC (#893).

        On CREATE a blank secret auto-generates; on UPDATE it must be rejected so
        an existing webhook can never be left with an empty (verification-off)
        secret.
        """
        original = webhook.secret
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"secret": ""},
            format="json",
        )
        assert resp.status_code == 400
        assert "secret" in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == original

    def test_patch_whitespace_secret_rejected(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        original = webhook.secret
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"secret": " " * 40},
            format="json",
        )
        assert resp.status_code == 400
        assert "secret" in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == original

    def test_patch_omitting_secret_leaves_it_unchanged(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """Omitting `secret` on a PATCH must not overwrite the existing one."""
        original = webhook.secret
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"events": ["task.created"]},
            format="json",
        )
        assert resp.status_code == 200, resp.data
        # Secret is write-only — never echoed on a non-create response.
        assert "secret" not in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == original

    def test_patch_valid_secret_rotates(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """A PATCH with a valid ≥32-char secret rotates it (write-only, not echoed)."""
        new_secret = "z" * 40
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"secret": new_secret},
            format="json",
        )
        assert resp.status_code == 200, resp.data
        # Rotation is a write — the new secret is never echoed back.
        assert "secret" not in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == new_secret


# ---------------------------------------------------------------------------
# Dispatch tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dispatch_creates_delivery_and_enqueues(project: Project, webhook: Webhook) -> None:
    """dispatch_webhooks creates a WebhookDelivery and enqueues deliver_webhook."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})

        assert WebhookDelivery.objects.count() == 1
        delivery = WebhookDelivery.objects.first()
        assert delivery.event_type == "task.created"
        mock_task.delay.assert_called_once_with(str(delivery.pk))


@pytest.mark.django_db
def test_dispatch_skips_inactive_webhook(project: Project, webhook: Webhook) -> None:
    webhook.is_active = False
    webhook.save()
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})

        assert WebhookDelivery.objects.count() == 0
        mock_task.delay.assert_not_called()


@pytest.mark.django_db
def test_dispatch_skips_a_webhook_deactivated_by_the_durable_grants_sweep(
    project: Project, webhook: Webhook
) -> None:
    """#4461 end-to-end: the containment sweep's effect on ``is_active`` is what
    actually stops dispatch, not just a documented claim. Exercises
    ``revoke_personal_durable_grants`` directly (the function every one of the
    three compromise-response levers — password reset, off-boarding,
    ``revoke_api_tokens --all`` — calls) rather than re-asserting the generic
    ``is_active=False`` behavior ``test_dispatch_skips_inactive_webhook`` already
    covers.
    """
    from trueppm_api.apps.access.services import revoke_personal_durable_grants
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    revoked = revoke_personal_durable_grants(webhook.created_by)
    assert revoked == (0, 0, 1)
    webhook.refresh_from_db()
    assert webhook.is_active is False

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})

        assert WebhookDelivery.objects.count() == 0
        mock_task.delay.assert_not_called()


@pytest.mark.django_db
def test_dispatch_skips_unsubscribed_event(project: Project, webhook: Webhook) -> None:
    """Webhook subscribes to task.created/updated but not dependency.created."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "dependency.created", {"id": "d1"})

        assert WebhookDelivery.objects.count() == 0
        mock_task.delay.assert_not_called()


# ---------------------------------------------------------------------------
# Delivery task tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_deliver_webhook_success(webhook: Webhook) -> None:
    """Successful delivery marks status=success and records response_status."""
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "t1"},
    )

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen —
        # patch that or the test hits the real example.com URL.
        patch.object(wh_tasks._no_redirect_opener, "open", return_value=mock_resp),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.SUCCESS
    assert delivery.response_status == 200
    assert delivery.attempt_count == 1
    assert delivery.completed_at is not None


@pytest.mark.django_db
def test_deliver_webhook_hmac_signature(webhook: Webhook) -> None:
    """The delivery includes a valid HMAC-SHA256 signature header."""
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "t1"},
    )

    captured_req: list[urllib.request.Request] = []

    def capture_open(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured_req.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen.
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture_open),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    assert len(captured_req) == 1
    req = captured_req[0]
    body = req.data
    expected_sig = hmac.new(
        webhook.secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()
    assert req.get_header("X-trueppm-signature") == f"sha256={expected_sig}"
    assert req.get_header("X-trueppm-event") == "task.created"


@pytest.mark.django_db
def test_deliver_webhook_non_2xx_retries(webhook: Webhook) -> None:
    """Non-2xx response triggers retry (via self.retry)."""
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "t1"},
    )

    # Simulate HTTP 500 via HTTPError.
    error = urllib.error.HTTPError(
        url="https://example.com/hook",
        code=500,
        msg="Internal Server Error",
        hdrs=MagicMock(),
        fp=None,
    )

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    retry_exc = Exception("Retry!")
    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen —
        # patch that or the test hits the real example.com URL.
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=error),
        patch.object(wh_tasks.deliver_webhook, "retry", side_effect=retry_exc) as mock_retry,
        pytest.raises(Exception, match="Retry"),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.attempt_count == 1
    assert delivery.status == DeliveryStatus.PENDING  # Not yet failed — retry pending
    mock_retry.assert_called_once()


# ---------------------------------------------------------------------------
# Test ping
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_test_ping(admin_client: APIClient, project: Project, webhook: Webhook) -> None:
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    # Patch `delay` ON the task object, never rebind the module attribute. Both this
    # module and `webhooks.views` reach the task through the same `shared_task` proxy,
    # so patching the attribute is what actually intercepts the view's dispatch.
    # Replacing `wh_tasks.deliver_webhook` instead does not — views did
    # `from ...tasks import deliver_webhook` and holds its own reference — and it
    # permanently poisons any module that first imports the symbol inside the patch
    # window: the import binds the MagicMock and keeps it after the patch exits. When
    # this test ran before `test_test_ping_deferred_via_on_commit` on a cold worker,
    # views bound the mock here and that test's own patch could never be reached (#2877).
    with patch.object(wh_tasks.deliver_webhook, "delay"):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")
    assert resp.status_code == 202
    assert "delivery_id" in resp.data


@pytest.mark.django_db
def test_test_ping_deferred_via_on_commit(
    admin_client: APIClient,
    project: Project,
    webhook: Webhook,
    django_capture_on_commit_callbacks: object,
) -> None:
    """deliver_webhook.delay is called inside transaction.on_commit, not immediately."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    calls: list[str] = []

    def record_delay(delivery_id: str) -> None:
        calls.append(delivery_id)

    with (
        patch.object(wh_tasks.deliver_webhook, "delay", side_effect=record_delay),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")

    assert resp.status_code == 202
    delivery_id = resp.data["delivery_id"]
    assert len(calls) == 1
    assert calls[0] == delivery_id
    delivery = WebhookDelivery.objects.get(pk=delivery_id)
    assert delivery.event_type == "ping"


@pytest.mark.django_db
def test_test_ping_renders_through_the_subscription_format(
    admin_client: APIClient, project: Project, user: object
) -> None:
    """A slack-format ping is a Slack message, not the inline stub body (#2884).

    The modal defaults ``format`` to ``slack``, so this was the *default* path:
    Slack requires ``text``/``blocks``/``attachments`` and answers 400
    ``invalid_payload`` to ``{"event": "ping", "webhook_id": ...}``. The test
    therefore "passed" on the 202 while the equivalent real delivery failed.
    """
    slack_hook = Webhook.objects.create(
        project=project,
        url="https://hooks.slack.com/services/x",
        secret="s" * 40,
        events=["task.created"],
        format="slack",
        created_by=user,
    )
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{slack_hook.pk}/test/")

    assert resp.status_code == 202
    delivery = WebhookDelivery.objects.get(pk=resp.data["delivery_id"])
    assert "text" in delivery.payload
    assert "Test ping" in delivery.payload["text"]
    assert len(delivery.payload["attachments"]) == 1
    assert "event" not in delivery.payload


@pytest.mark.django_db
def test_test_ping_carries_the_meta_envelope(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """The ping's ``_meta.sequence`` equals its ``sequence_number`` (#2884 §4).

    The documented contract is that the header, ``_meta.sequence``, and the delivery
    record's ``sequence_number`` are always identical. The ping used to allocate a
    real sequence number with no ``_meta`` at all, so a consumer doing the
    documented in-body gap detection saw the counter jump on every Test click —
    phantom lost-event alarms.
    """
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")

    delivery = WebhookDelivery.objects.get(pk=resp.data["delivery_id"])
    assert delivery.sequence_number >= 1
    assert delivery.payload["_meta"]["sequence"] == delivery.sequence_number


@pytest.mark.django_db
def test_test_ping_does_not_skip_a_sequence_number(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """Consecutive pings are contiguous — one allocation per delivery, not two."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    sequences = []
    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        for _ in range(3):
            resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")
            sequences.append(
                WebhookDelivery.objects.get(pk=resp.data["delivery_id"]).sequence_number
            )

    assert sequences == [1, 2, 3]


@pytest.mark.django_db
def test_test_ping_broker_unavailable_delivery_stays_pending(
    admin_client: APIClient,
    project: Project,
    webhook: Webhook,
    django_capture_on_commit_callbacks: object,
) -> None:
    """Broker down: delivery row committed but not enqueued; drain can recover it."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(
            wh_tasks.deliver_webhook,
            "delay",
            side_effect=ConnectionError("broker down"),
        ),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")

    assert resp.status_code == 202
    delivery_id = resp.data["delivery_id"]
    delivery = WebhookDelivery.objects.get(pk=delivery_id)
    # Row was committed; attempt_count stays 0 so drain can re-enqueue it.
    assert delivery.attempt_count == 0


# ---------------------------------------------------------------------------
# dispatch_webhooks — broker failure coverage
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dispatch_webhooks_broker_unavailable_swallowed(project: Project, webhook: Webhook) -> None:
    """Broker failure in dispatch_webhooks is swallowed; delivery row stays PENDING."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    with patch.object(
        wh_tasks.deliver_webhook, "delay", side_effect=ConnectionError("broker down")
    ):
        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})  # must not raise

    assert WebhookDelivery.objects.count() == 1
    delivery = WebhookDelivery.objects.first()
    # attempt_count 0 means the drain can pick it up.
    assert delivery.attempt_count == 0
    assert delivery.status == DeliveryStatus.PENDING


# ---------------------------------------------------------------------------
# deliver_webhook task attributes
# ---------------------------------------------------------------------------


def test_deliver_webhook_reject_on_worker_lost() -> None:
    """deliver_webhook must have reject_on_worker_lost=True for at-least-once delivery."""
    from trueppm_api.apps.webhooks.tasks import deliver_webhook

    assert getattr(deliver_webhook, "reject_on_worker_lost", False) is True
