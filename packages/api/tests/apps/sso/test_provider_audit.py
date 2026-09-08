"""Audit-row tests for SSO provider administration and account linking (#3552, ADR-1120).

Before this, an SSO provider could be created, repointed, domain-widened, disabled or
torn down — and its client secret rotated — with nothing in the log naming who did it or
what the value had been. The serializer already refused an issuer repoint when linked
accounts existed, yet every *successful* policy change was invisible. SOC 2 CC7.2 and
CC8.1 both need this material.

Three properties matter more than the happy paths, and each has a test whose failure is
a real defect rather than a cosmetic drift:

* **the secret never appears** — not the plaintext, not the ciphertext, not a length or
  a hash, in any row this module writes;
* **no row on a refusal** — under ``ATOMIC_REQUESTS`` DRF's exception handler calls
  ``set_rollback()`` for every ``APIException``, so a row written on a 4xx path is
  issued and silently discarded (ADR-0902). Every row here is on a success path, and a
  refused request must therefore leave *nothing* — which is also the correct record;
* **the audited field list is the serializer's writable surface** — ``server_url``,
  ``client_id`` and ``display_name`` live on the linked ``SocialApp``, not on
  ``SsoProviderPolicy``, so a model-derived list would silently exempt the three fields
  that most change who can sign in.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from allauth.socialaccount.models import SocialAccount, SocialApp
from django.contrib.auth import get_user_model

from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.sso.views import _AUDITED_PROVIDER_FIELDS, _MAX_AUDITED_LIST
from trueppm_api.apps.workspace.models import AuditEvent, AuditEventType, WorkspaceRole

from .conftest import ISSUER, api_client

User = get_user_model()

COLLECTION = "/api/v1/workspace/sso/providers/"
DETAIL = COLLECTION + "generic/"

_SECRET = "rotate-me-please"
_NEW_SECRET = "rotated-to-this-value"


def _full_config() -> dict[str, Any]:
    return {
        "slug": "generic",
        "display_name": "Example IdP",
        "server_url": ISSUER,
        "client_id": "trueppm-web",
        "client_secret": _SECRET,
        "allowed_email_domains": ["example.com"],
        "enabled": True,
    }


def _rows(event_type: str) -> list[AuditEvent]:
    return list(AuditEvent.objects.filter(event_type=event_type).order_by("created_at"))


def _create(admin: Any) -> Any:
    client = api_client(admin)
    resp = client.post(COLLECTION, _full_config(), format="json")
    assert resp.status_code == 201, resp.data
    return client


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_writes_a_row_naming_the_admin_and_the_config(admin: Any) -> None:
    _create(admin)

    rows = _rows(AuditEventType.SSO_PROVIDER_CREATED)
    assert len(rows) == 1
    row = rows[0]
    assert row.actor_id == admin.pk
    assert row.target_type == "sso_provider"
    assert row.target_label == "generic"
    config = row.metadata["config"]
    assert config["server_url"] == ISSUER
    assert config["client_id"] == "trueppm-web"
    assert config["allowed_email_domains"] == ["example.com"]
    assert config["enabled"] is True
    # Whether a secret was supplied — never anything about its value.
    assert row.metadata["secret_set"] is True
    assert row.metadata["actor_kind"] == "session"


@pytest.mark.django_db
def test_a_refused_create_writes_no_row(admin: Any) -> None:
    """A 400 changes nothing, so it must record nothing.

    This is also the shape that would be silently broken if a row were ever written on
    the refusal path: ``set_rollback()`` would discard it and the test would pass for the
    wrong reason. Asserting *absence* is what keeps that honest.
    """
    client = api_client(admin)
    resp = client.post(COLLECTION, {"slug": "not-a-real-provider"}, format="json")

    assert resp.status_code == 400
    assert AuditEvent.objects.filter(event_type__startswith="sso_").count() == 0


@pytest.mark.django_db
def test_a_duplicate_slug_conflict_writes_no_row(admin: Any) -> None:
    """The 409 branch runs with the connection in an aborted-transaction state.

    Any statement issued there — an audit row included — would raise
    ``TransactionManagementError`` and turn a correct 409 into a 500.
    """
    client = _create(admin)
    before = AuditEvent.objects.count()

    resp = client.post(COLLECTION, _full_config(), format="json")

    assert resp.status_code == 409, resp.data
    assert AuditEvent.objects.count() == before


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_records_before_and_after_for_each_changed_field(admin: Any) -> None:
    client = _create(admin)

    resp = client.put(
        DETAIL,
        {
            "allowed_email_domains": ["example.com", "partner.example"],
            "auto_create_members": True,
            "default_role": int(WorkspaceRole.ADMIN),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.data

    rows = _rows(AuditEventType.SSO_PROVIDER_UPDATED)
    assert len(rows) == 1
    changed = rows[0].metadata["changed"]
    assert changed["allowed_email_domains"] == {
        "from": ["example.com"],
        "to": ["example.com", "partner.example"],
    }
    assert changed["auto_create_members"] == {"from": False, "to": True}
    assert changed["default_role"] == {
        "from": int(WorkspaceRole.MEMBER),
        "to": int(WorkspaceRole.ADMIN),
    }
    # Untouched fields are absent, not recorded as no-op diffs.
    assert "server_url" not in changed
    assert "enabled" not in changed


@pytest.mark.django_db
def test_disabling_a_provider_is_recorded_as_an_enabled_diff(admin: Any) -> None:
    """Enable/disable has no verb of its own — it is an ``enabled`` entry in the diff."""
    client = _create(admin)

    resp = client.put(DETAIL, {"enabled": False}, format="json")

    assert resp.status_code == 200, resp.data
    changed = _rows(AuditEventType.SSO_PROVIDER_UPDATED)[0].metadata["changed"]
    assert changed["enabled"] == {"from": True, "to": False}


@pytest.mark.django_db
def test_changing_only_the_client_id_is_recorded(admin: Any) -> None:
    """``client_id`` is outside #3552's proposed field list and inside ours.

    It determines which OAuth client the install presents itself as; paired with a secret
    rotation it is a complete credential swap. Without it the log would show "a secret was
    rotated" and never that the client identity moved underneath it.
    """
    client = _create(admin)

    resp = client.put(DETAIL, {"client_id": "trueppm-web-v2"}, format="json")

    assert resp.status_code == 200, resp.data
    changed = _rows(AuditEventType.SSO_PROVIDER_UPDATED)[0].metadata["changed"]
    assert changed["client_id"] == {"from": "trueppm-web", "to": "trueppm-web-v2"}


@pytest.mark.django_db
def test_a_no_op_save_writes_no_row(admin: Any) -> None:
    """The admin form re-submits every field on every save.

    A row per save, in a table with no OSS retention, accumulates entries that answer no
    question. Only a real change is recorded.
    """
    client = _create(admin)
    before = AuditEvent.objects.count()

    resp = client.put(DETAIL, {"display_name": "Example IdP"}, format="json")

    assert resp.status_code == 200, resp.data
    assert AuditEvent.objects.count() == before


@pytest.mark.django_db
def test_a_refused_update_writes_no_row(admin: Any) -> None:
    """An issuer repoint with linked accounts is refused; nothing changed, nothing logged."""
    client = _create(admin)
    user = User.objects.create_user(username="linked", email="linked@example.com")
    SocialAccount.objects.create(
        user=user, provider="generic", uid="sub-1", extra_data={"iss": ISSUER}
    )
    before = AuditEvent.objects.count()

    resp = client.put(DETAIL, {"server_url": "https://other.example.com"}, format="json")

    assert resp.status_code == 400, resp.data
    assert AuditEvent.objects.count() == before


@pytest.mark.django_db
def test_a_long_domain_list_is_truncated_in_the_diff(admin: Any) -> None:
    """``allowed_email_domains`` has no length cap and a diff stores it twice.

    Uncapped, a single admin request could write an arbitrarily large row into a table
    nothing prunes.
    """
    client = _create(admin)
    domains = [f"d{i}.example" for i in range(_MAX_AUDITED_LIST + 10)]

    resp = client.put(DETAIL, {"allowed_email_domains": domains}, format="json")

    assert resp.status_code == 200, resp.data
    entry = _rows(AuditEventType.SSO_PROVIDER_UPDATED)[0].metadata["changed"]
    after = entry["allowed_email_domains"]["to"]
    assert after["truncated"] is True
    assert after["total"] == len(domains)
    assert len(after["items"]) == _MAX_AUDITED_LIST


# ---------------------------------------------------------------------------
# Secret rotation — the property the whole feature is judged on
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_rotating_the_secret_writes_a_row_with_no_secret_material(admin: Any) -> None:
    client = _create(admin)

    resp = client.put(DETAIL, {"client_secret": _NEW_SECRET}, format="json")
    assert resp.status_code == 200, resp.data

    rows = _rows(AuditEventType.SSO_SECRET_ROTATED)
    assert len(rows) == 1
    row = rows[0]
    assert row.actor_id == admin.pk
    assert row.target_label == "generic"
    # The row says a rotation happened and nothing whatsoever about what it rotated to.
    assert set(row.metadata) == {"actor_kind"}

    # And no row anywhere in the log carries the secret in any form.
    blob = "".join(str(e.metadata) + e.target_label for e in AuditEvent.objects.all())
    assert _SECRET not in blob
    assert _NEW_SECRET not in blob
    # The rotation really happened — the test is not vacuous.
    assert SsoProviderPolicy.objects.get(slug="generic").get_client_secret() == _NEW_SECRET


@pytest.mark.django_db
def test_rotation_is_a_separate_verb_not_a_field_in_the_update_diff(admin: Any) -> None:
    client = _create(admin)

    resp = client.put(
        DETAIL, {"client_secret": _NEW_SECRET, "enabled": False}, format="json"
    )
    assert resp.status_code == 200, resp.data

    assert len(_rows(AuditEventType.SSO_SECRET_ROTATED)) == 1
    changed = _rows(AuditEventType.SSO_PROVIDER_UPDATED)[0].metadata["changed"]
    assert "client_secret" not in changed
    assert set(changed) == {"enabled"}


@pytest.mark.django_db
def test_a_save_that_omits_the_secret_writes_no_rotation_row(admin: Any) -> None:
    """The rotation flag keys on the field being *supplied*.

    That is correct only because the field is ``write_only`` with ``allow_blank=False``
    and the admin panel omits the key unless the admin typed a value. If the panel is ever
    changed to round-trip it, every save mints a spurious rotation row and silently
    re-encrypts the stored secret — and Fernet being non-deterministic, no ciphertext
    comparison could detect that no-op afterwards.
    """
    client = _create(admin)

    resp = client.put(DETAIL, {"enabled": False}, format="json")

    assert resp.status_code == 200, resp.data
    assert _rows(AuditEventType.SSO_SECRET_ROTATED) == []


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_delete_records_both_impact_counts_before_the_cascade(admin: Any) -> None:
    """Captured before the cascade, and carrying the wider count as well as the narrower.

    The delete destroys ``linked_accounts`` federated credentials, of which the locked-out
    set is a strict subset; recording only the smaller number understates the blast radius
    on the sole record of an unrecoverable action.
    """
    client = _create(admin)
    # One linked account that still has a password, so it is linked but not locked out.
    user = User.objects.create_user(
        username="has_password", email="hp@example.com", password="pw"
    )
    SocialAccount.objects.create(
        user=user, provider="generic", uid="sub-hp", extra_data={"iss": ISSUER}
    )

    resp = client.delete(DETAIL)
    assert resp.status_code == 204, getattr(resp, "data", None)

    rows = _rows(AuditEventType.SSO_PROVIDER_DELETED)
    assert len(rows) == 1
    row = rows[0]
    assert row.target_label == "generic"
    assert row.metadata["linked_accounts"] == 1
    assert row.metadata["locked_out_accounts"] == 0
    assert row.metadata["confirmed_lockout"] is False
    # The config the admin just destroyed is preserved, read before the cascade nulled it.
    assert row.metadata["config"]["server_url"] == ISSUER
    # The cascade really happened.
    assert not SsoProviderPolicy.objects.filter(slug="generic").exists()
    assert not SocialApp.objects.filter(provider_id="generic").exists()


@pytest.mark.django_db
def test_a_lockout_blocked_delete_writes_no_row(admin: Any) -> None:
    """The 409 informed-confirmation gate refuses; nothing was deleted, so nothing is logged."""
    client = _create(admin)
    sso_only = User.objects.create_user(username="sso_only", email="so@example.com")
    sso_only.set_unusable_password()
    sso_only.save(update_fields=["password"])
    SocialAccount.objects.create(
        user=sso_only, provider="generic", uid="sub-so", extra_data={"iss": ISSUER}
    )
    before = AuditEvent.objects.count()

    resp = client.delete(DETAIL)

    assert resp.status_code == 409, resp.data
    assert AuditEvent.objects.count() == before
    assert SsoProviderPolicy.objects.filter(slug="generic").exists()


@pytest.mark.django_db
def test_a_confirmed_lockout_delete_records_that_it_was_confirmed(admin: Any) -> None:
    client = _create(admin)
    sso_only = User.objects.create_user(username="sso_only2", email="so2@example.com")
    sso_only.set_unusable_password()
    sso_only.save(update_fields=["password"])
    SocialAccount.objects.create(
        user=sso_only, provider="generic", uid="sub-so2", extra_data={"iss": ISSUER}
    )

    resp = client.delete(DETAIL + "?confirm_lockout=true")

    assert resp.status_code == 204, getattr(resp, "data", None)
    row = _rows(AuditEventType.SSO_PROVIDER_DELETED)[0]
    assert row.metadata["confirmed_lockout"] is True
    assert row.metadata["locked_out_accounts"] == 1


# ---------------------------------------------------------------------------
# Account linking (resolve_user branch 3)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_linking_to_an_existing_account_writes_a_row(
    provider_ctx: services.ProviderContext,
) -> None:
    """Branch 4 (auto-create) has written ``member_added`` since the feature shipped.

    Branch 3 — a federated credential granted over an account that *already exists* —
    wrote nothing at all.
    """
    user = User.objects.create_user(username="bob", email="bob@example.com", password="pw")

    resolved, created = services.resolve_user(
        provider_ctx, {"sub": "sub-bob", "email": "bob@example.com", "email_verified": True}
    )

    assert resolved == user
    assert created is False
    rows = _rows(AuditEventType.SSO_ACCOUNT_LINKED)
    assert len(rows) == 1
    row = rows[0]
    # The actor is the linked user: this path is unauthenticated, so there is no admin in
    # the request to attribute it to (the ``member_added`` / ``invite_accepted`` idiom).
    assert row.actor_id == user.pk
    assert row.target_type == "user"
    assert row.target_id == user.pk
    assert row.metadata["provider"] == "generic"
    assert row.metadata["issuer"] == ISSUER
    assert row.metadata["subject"] == "sub-bob"
    assert row.metadata["via"] == "sso"


@pytest.mark.django_db
def test_the_link_row_carries_nothing_from_the_claims_dict_beyond_the_subject(
    provider_ctx: services.ProviderContext,
) -> None:
    """``metadata`` is written verbatim and an IdP signs whatever it likes.

    Groups, phone numbers, the nonce, sometimes an embedded token — none of it belongs in
    an audit row, and only an enumerated payload keeps it out.
    """
    User.objects.create_user(username="carol", email="carol@example.com", password="pw")

    services.resolve_user(
        provider_ctx,
        {
            "sub": "sub-carol",
            "email": "carol@example.com",
            "email_verified": True,
            "groups": ["secret-group"],
            "phone_number": "+15550100",
            "nonce": "n0nce",
        },
    )

    row = _rows(AuditEventType.SSO_ACCOUNT_LINKED)[0]
    assert set(row.metadata) == {"via", "provider", "issuer", "subject", "role"}
    blob = str(row.metadata)
    assert "secret-group" not in blob
    assert "+15550100" not in blob
    assert "n0nce" not in blob


@pytest.mark.django_db
def test_the_link_row_records_the_users_existing_workspace_role(
    provider_ctx: services.ProviderContext, member: Any
) -> None:
    """"What access did this federated identity just get?" must be answerable from the row."""
    member.email = "member@example.com"
    member.save(update_fields=["email"])

    services.resolve_user(
        provider_ctx,
        {"sub": "sub-member", "email": "member@example.com", "email_verified": True},
    )

    row = _rows(AuditEventType.SSO_ACCOUNT_LINKED)[0]
    assert row.metadata["role"] == int(WorkspaceRole.MEMBER)


@pytest.mark.django_db
def test_a_user_with_no_membership_records_a_null_role(
    provider_ctx: services.ProviderContext,
) -> None:
    """``None`` is a real answer, not a failure — an account can exist with no membership."""
    User.objects.create_user(username="dave", email="dave@example.com", password="pw")

    services.resolve_user(
        provider_ctx, {"sub": "sub-dave", "email": "dave@example.com", "email_verified": True}
    )

    assert _rows(AuditEventType.SSO_ACCOUNT_LINKED)[0].metadata["role"] is None


@pytest.mark.django_db
def test_a_second_login_with_the_same_subject_writes_no_second_row(
    provider_ctx: services.ProviderContext,
) -> None:
    """Branch 1's durable ``(issuer, subject)`` key short-circuits before branch 3."""
    User.objects.create_user(username="erin", email="erin@example.com", password="pw")
    claims = {"sub": "sub-erin", "email": "erin@example.com", "email_verified": True}

    services.resolve_user(provider_ctx, claims)
    services.resolve_user(provider_ctx, claims)

    assert len(_rows(AuditEventType.SSO_ACCOUNT_LINKED)) == 1


@pytest.mark.django_db
def test_a_refused_link_writes_no_row(provider_ctx: services.ProviderContext) -> None:
    """A deactivated account is refused before the binding is written (#2875).

    ``resolve_user`` is atomic, so the row unwinds with the refusal even though the write
    is issued inside it.
    """
    user = User.objects.create_user(
        username="frank", email="frank@example.com", password="pw", is_active=False
    )

    with pytest.raises(services.OIDCAccountDisabled):
        services.resolve_user(
            provider_ctx,
            {"sub": "sub-frank", "email": "frank@example.com", "email_verified": True},
        )

    assert _rows(AuditEventType.SSO_ACCOUNT_LINKED) == []
    assert not SocialAccount.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_auto_create_records_the_granted_role_on_member_added(
    provider_ctx: services.ProviderContext,
) -> None:
    """The sibling row was missing ``role`` while the docs had claimed it since it shipped."""
    provider_ctx.policy.auto_create_members = True
    provider_ctx.policy.save(update_fields=["auto_create_members"])

    _user, created = services.resolve_user(
        provider_ctx, {"sub": "sub-new", "email": "new@example.com", "email_verified": True}
    )

    assert created is True
    row = _rows(AuditEventType.MEMBER_ADDED)[0]
    assert row.metadata["role"] == int(WorkspaceRole.MEMBER)
    # And the auto-create branch still writes no link row — the two are distinct events.
    assert _rows(AuditEventType.SSO_ACCOUNT_LINKED) == []


# ---------------------------------------------------------------------------
# The audited field list is bound to the serializer, not to the model
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_audited_fields_are_exactly_the_serializers_writable_surface_minus_the_secret() -> None:
    """Adding a writable provider field without deciding its audit treatment fails here.

    Enumerating ``SsoProviderPolicy._meta.fields`` instead would silently exempt
    ``server_url``, ``client_id`` and ``display_name``, which live on the ``SocialApp``.

    ``allow_password_signin`` is excluded on purpose: the OSS write serializer rejects it
    outright, so in this edition it cannot change. Note what that costs — the field is
    already declared, so this test passes with it unlisted, and whoever makes it writable
    in Enterprise must add it to the audited set by hand.
    """
    from trueppm_api.apps.sso.serializers import SsoProviderWriteSerializer

    writable = {
        name
        for name, field in SsoProviderWriteSerializer().get_fields().items()
        if not field.read_only
    }
    expected = writable - {"client_secret", "slug", "allow_password_signin"}

    assert set(_AUDITED_PROVIDER_FIELDS) == expected


@pytest.mark.django_db
def test_the_write_throttle_does_not_apply_to_reads(admin: Any) -> None:
    """The list GET backs the admin page and must not be capped at the write rate."""
    from trueppm_api.apps.sso.views import _SsoProviderWriteThrottle

    client = api_client(admin)
    throttle = _SsoProviderWriteThrottle()
    # More requests than the 20/min write allowance would permit.
    for _ in range(25):
        resp = client.get(COLLECTION)
        assert resp.status_code == 200

    assert throttle.scope == "sso_provider_write"


@pytest.mark.django_db
def test_a_token_authenticated_write_is_recorded_as_such(
    admin: Any, caplog: pytest.LogCaptureFixture
) -> None:
    """These views inherit token authentication, and the row must say so.

    Without it a machine-driven credential-path change is attributed to the token's human
    owner and is indistinguishable from that human sitting at a browser — on the one row
    that exists to answer *who did this*.
    """
    caplog.set_level(logging.INFO)
    from trueppm_api.apps.sso.views import _actor_kind

    class _FakeRequest:
        auth: Any = None

    from trueppm_api.apps.projects.models import ApiToken

    req = _FakeRequest()
    assert _actor_kind(req) == "session"  # type: ignore[arg-type]
    req.auth = ApiToken()
    assert _actor_kind(req) == "token"  # type: ignore[arg-type]
