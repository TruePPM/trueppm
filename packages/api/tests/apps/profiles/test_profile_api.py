"""Tests for GET/PATCH /api/v1/auth/me/profile/ (ADR-0129)."""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.profiles.models import (
    DateFormat,
    DefaultLanding,
    RoleContext,
    UserProfile,
)

User = get_user_model()

URL = "/api/v1/auth/me/profile/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_profile_unauthenticated_returns_401() -> None:
    assert APIClient().get(URL).status_code == 401
    assert APIClient().patch(URL, {"default_landing": "my_work"}).status_code == 401


@pytest.mark.django_db
def test_get_profile_lazily_returns_auto_default() -> None:
    user = User.objects.create_user(username="lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["default_landing"] == DefaultLanding.AUTO


@pytest.mark.django_db
def test_patch_sets_preference() -> None:
    user = User.objects.create_user(username="setter", password="pw")
    resp = _client(user).patch(URL, {"default_landing": "my_work"})
    assert resp.status_code == 200
    assert resp.data["default_landing"] == "my_work"
    assert UserProfile.objects.get(user=user).default_landing == "my_work"


@pytest.mark.django_db
def test_patch_rejects_invalid_choice() -> None:
    user = User.objects.create_user(username="bad", password="pw")
    resp = _client(user).patch(URL, {"default_landing": "not_a_surface"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_patch_is_idempotent() -> None:
    user = User.objects.create_user(username="twice", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "project_overview"})
    resp = c.patch(URL, {"default_landing": "project_overview"})
    assert resp.status_code == 200
    assert UserProfile.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_user_can_only_touch_own_profile() -> None:
    """No :id in the path — a user's PATCH only ever writes their own row."""
    alice = User.objects.create_user(username="alice", password="pw")
    bob = User.objects.create_user(username="bob", password="pw")
    _client(alice).patch(URL, {"default_landing": "my_work"})

    # Bob's profile is untouched (defaults to auto), Alice's is my_work.
    assert _client(bob).get(URL).data["default_landing"] == DefaultLanding.AUTO
    assert UserProfile.objects.get(user=alice).default_landing == "my_work"


# --- hidden_views (ADR-0139) -----------------------------------------------


@pytest.mark.django_db
def test_get_profile_lazily_returns_empty_hidden_views() -> None:
    user = User.objects.create_user(username="hv_lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == []


@pytest.mark.django_db
def test_patch_sets_hidden_views() -> None:
    user = User.objects.create_user(username="hv_set", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": ["schedule", "calendar"]}, format="json")
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == ["schedule", "calendar"]
    assert UserProfile.objects.get(user=user).hidden_views == ["schedule", "calendar"]


@pytest.mark.django_db
def test_patch_hidden_views_does_not_clobber_default_landing() -> None:
    """A partial PATCH of one preference field leaves the other untouched."""
    user = User.objects.create_user(username="hv_partial", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "my_work"}, format="json")
    c.patch(URL, {"hidden_views": ["board"]}, format="json")
    profile = UserProfile.objects.get(user=user)
    assert profile.default_landing == "my_work"
    assert profile.hidden_views == ["board"]


@pytest.mark.django_db
def test_reset_clears_hidden_views() -> None:
    """'Reset to default' is PATCH hidden_views: []."""
    user = User.objects.create_user(username="hv_reset", password="pw")
    c = _client(user)
    c.patch(URL, {"hidden_views": ["schedule", "grid"]}, format="json")
    resp = c.patch(URL, {"hidden_views": []}, format="json")
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == []
    assert UserProfile.objects.get(user=user).hidden_views == []


@pytest.mark.django_db
def test_patch_rejects_unknown_view_key() -> None:
    user = User.objects.create_user(username="hv_bad", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": ["schedule", "bogus"]}, format="json")
    assert resp.status_code == 400
    assert "hidden_views" in resp.data


@pytest.mark.django_db
def test_patch_rejects_overview_as_non_hideable() -> None:
    """overview is the always-on landing — never hideable (ADR-0139)."""
    user = User.objects.create_user(username="hv_overview", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": ["overview"]}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_patch_deduplicates_hidden_views() -> None:
    user = User.objects.create_user(username="hv_dupe", password="pw")
    resp = _client(user).patch(
        URL, {"hidden_views": ["schedule", "schedule", "grid"]}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == ["schedule", "grid"]


# --- role_context (#412) ----------------------------------------------------


@pytest.mark.django_db
def test_role_context_unauthenticated_returns_401() -> None:
    assert APIClient().patch(URL, {"role_context": "pm"}).status_code == 401


@pytest.mark.django_db
def test_get_profile_lazily_returns_unified_role_context() -> None:
    """A fresh profile defaults to the dual-hat 'Unified Today' lens (#412)."""
    user = User.objects.create_user(username="rc_lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["role_context"] == RoleContext.UNIFIED


@pytest.mark.django_db
@pytest.mark.parametrize("choice", ["pm", "scrum_master", "unified"])
def test_patch_role_context_round_trips_every_choice(choice: str) -> None:
    user = User.objects.create_user(username=f"rc_{choice}", password="pw")
    resp = _client(user).patch(URL, {"role_context": choice})
    assert resp.status_code == 200
    assert resp.data["role_context"] == choice
    assert UserProfile.objects.get(user=user).role_context == choice


@pytest.mark.django_db
def test_patch_rejects_invalid_role_context() -> None:
    user = User.objects.create_user(username="rc_bad", password="pw")
    resp = _client(user).patch(URL, {"role_context": "not_a_role"})
    assert resp.status_code == 400
    assert "role_context" in resp.data


@pytest.mark.django_db
def test_patch_role_context_does_not_clobber_other_prefs() -> None:
    """A partial PATCH of role_context leaves default_landing/hidden_views alone."""
    user = User.objects.create_user(username="rc_partial", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "my_work"}, format="json")
    c.patch(URL, {"hidden_views": ["board"]}, format="json")
    c.patch(URL, {"role_context": "scrum_master"}, format="json")
    profile = UserProfile.objects.get(user=user)
    assert profile.default_landing == "my_work"
    assert profile.hidden_views == ["board"]
    assert profile.role_context == "scrum_master"


@pytest.mark.django_db
def test_user_can_only_touch_own_role_context() -> None:
    """No :id in the path — a user's PATCH only ever writes their own row."""
    alice = User.objects.create_user(username="rc_alice", password="pw")
    bob = User.objects.create_user(username="rc_bob", password="pw")
    _client(alice).patch(URL, {"role_context": "pm"})

    # Bob's profile is untouched (defaults to unified), Alice's is pm.
    assert _client(bob).get(URL).data["role_context"] == RoleContext.UNIFIED
    assert UserProfile.objects.get(user=alice).role_context == "pm"


# --- schedule_in_deliver is retired (ADR-0942 §3, #3137) --------------------


@pytest.mark.django_db
def test_profile_payload_omits_retired_schedule_in_deliver() -> None:
    """The placement opt-in is gone from the read payload, not defaulted to False.

    ADR-0942 §3 rejected keeping it as an ignored no-op: a documented, writable field
    that changes nothing is the dead-control class this codebase already carries scars
    from. "Absent" and "present but always False" are different contracts to an API/MCP
    client, so this asserts absence.
    """
    user = User.objects.create_user(username="sid_gone", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert "schedule_in_deliver" not in resp.data


@pytest.mark.django_db
def test_patch_schedule_in_deliver_is_refused_with_a_400_naming_the_key() -> None:
    """A stale client PATCHing the retired field gets a visible refusal, not a no-op.

    This is ADR-0942 §3's "deletion and a 400 on a stale write", and it does not come
    for free: DRF's ``to_internal_value`` iterates *declared fields* and pulls each out
    of the payload, so a key matching no field is never enumerated and the default
    behaviour is ``200`` with the key silently discarded. An agent reads ``200`` on a
    PATCH as "my write landed" — the same lie the no-op field told by echoing ``true``,
    with the mechanism inverted. ``UserProfileSerializer.RETIRED_FIELDS`` is what makes
    the refusal real.

    The error is keyed by field name so a client can attribute it without parsing prose.
    """
    user = User.objects.create_user(username="sid_stale", password="pw")
    resp = _client(user).patch(URL, {"schedule_in_deliver": True}, format="json")
    assert resp.status_code == 400
    assert "schedule_in_deliver" in resp.data
    assert "ADR-0942" in str(resp.data["schedule_in_deliver"][0])


@pytest.mark.django_db
def test_retired_key_refusal_rejects_the_whole_body() -> None:
    """The refusal is all-or-nothing — sibling prefs in the same PATCH do not land.

    This is the deliberate trade-off in ADR-0942 §3's choice of a visible failure. A
    stale onboarding script that sets every profile field in one body gets a ``400``
    and writes none of it, rather than a ``200`` that quietly applied four of five
    fields and dropped the one it was told nothing about. Partial success is the
    harder failure to debug: the script's author has no signal at all.

    Asserted explicitly because "the other fields still land" was the previous
    behaviour and is the thing a reader is most likely to assume still holds.
    """
    user = User.objects.create_user(username="sid_atomic", password="pw")
    resp = _client(user).patch(
        URL,
        {"schedule_in_deliver": True, "default_landing": "my_work"},
        format="json",
    )
    assert resp.status_code == 400
    profile = UserProfile.objects.filter(user=user).first()
    # Either no row was created, or it kept the default — never the requested value.
    assert profile is None or profile.default_landing != "my_work"


@pytest.mark.django_db
def test_unknown_but_not_retired_keys_are_still_ignored() -> None:
    """The denylist is narrow: only *retired* keys refuse, not every unknown one.

    General strict mode would make any additive client change a hard failure and break
    forward-compatibility, which is why `RETIRED_FIELDS` is a named list rather than a
    "reject anything undeclared" switch. This is the assertion that keeps the two apart.
    """
    user = User.objects.create_user(username="sid_forward", password="pw")
    resp = _client(user).patch(
        URL,
        {"some_future_preference": True, "default_landing": "my_work"},
        format="json",
    )
    assert resp.status_code == 200
    assert "some_future_preference" not in resp.data
    assert UserProfile.objects.get(user=user).default_landing == "my_work"


# --- timezone + date_format (#1953, ADR-0410) -------------------------------


@pytest.mark.django_db
def test_get_profile_lazily_returns_auto_timezone_and_date_format() -> None:
    """A fresh profile defaults both display prefs to the 'auto' sentinel."""
    user = User.objects.create_user(username="tz_lazy", password="pw")
    resp = _client(user).get(URL)
    assert resp.status_code == 200
    assert resp.data["timezone"] == "auto"
    assert resp.data["date_format"] == DateFormat.AUTO


@pytest.mark.django_db
def test_patch_sets_concrete_iana_timezone() -> None:
    user = User.objects.create_user(username="tz_set", password="pw")
    resp = _client(user).patch(URL, {"timezone": "America/Chicago"})
    assert resp.status_code == 200
    assert resp.data["timezone"] == "America/Chicago"
    assert UserProfile.objects.get(user=user).timezone == "America/Chicago"


@pytest.mark.django_db
def test_patch_accepts_auto_timezone_sentinel() -> None:
    """'auto' is a valid value — it resolves to the browser zone client-side."""
    user = User.objects.create_user(username="tz_auto", password="pw")
    c = _client(user)
    c.patch(URL, {"timezone": "Europe/London"})
    resp = c.patch(URL, {"timezone": "auto"})
    assert resp.status_code == 200
    assert resp.data["timezone"] == "auto"
    assert UserProfile.objects.get(user=user).timezone == "auto"


@pytest.mark.django_db
def test_patch_rejects_unknown_timezone() -> None:
    user = User.objects.create_user(username="tz_bad", password="pw")
    resp = _client(user).patch(URL, {"timezone": "Mars/Olympus_Mons"})
    assert resp.status_code == 400
    assert "timezone" in resp.data


@pytest.mark.django_db
@pytest.mark.parametrize("choice", ["auto", "iso", "us", "eu"])
def test_patch_date_format_round_trips_every_choice(choice: str) -> None:
    user = User.objects.create_user(username=f"df_{choice}", password="pw")
    resp = _client(user).patch(URL, {"date_format": choice})
    assert resp.status_code == 200
    assert resp.data["date_format"] == choice
    assert UserProfile.objects.get(user=user).date_format == choice


@pytest.mark.django_db
def test_patch_rejects_invalid_date_format() -> None:
    user = User.objects.create_user(username="df_bad", password="pw")
    resp = _client(user).patch(URL, {"date_format": "dd/mm/yy"})
    assert resp.status_code == 400
    assert "date_format" in resp.data


@pytest.mark.django_db
def test_patch_display_prefs_do_not_clobber_other_prefs() -> None:
    """A partial PATCH of timezone/date_format leaves the other prefs alone."""
    user = User.objects.create_user(username="tz_partial", password="pw")
    c = _client(user)
    c.patch(URL, {"default_landing": "my_work"}, format="json")
    c.patch(URL, {"role_context": "scrum_master"}, format="json")
    c.patch(URL, {"timezone": "Asia/Tokyo", "date_format": "eu"}, format="json")
    profile = UserProfile.objects.get(user=user)
    assert profile.default_landing == "my_work"
    assert profile.role_context == "scrum_master"
    assert profile.timezone == "Asia/Tokyo"
    assert profile.date_format == "eu"


@pytest.mark.django_db
def test_user_can_only_touch_own_display_prefs() -> None:
    """No :id in the path — a user's PATCH only ever writes their own row."""
    alice = User.objects.create_user(username="tz_alice", password="pw")
    bob = User.objects.create_user(username="tz_bob", password="pw")
    _client(alice).patch(URL, {"timezone": "Australia/Sydney", "date_format": "iso"})

    bob_data = _client(bob).get(URL).data
    assert bob_data["timezone"] == "auto"
    assert bob_data["date_format"] == "auto"
    alice_profile = UserProfile.objects.get(user=alice)
    assert alice_profile.timezone == "Australia/Sydney"
    assert alice_profile.date_format == "iso"


# ---------------------------------------------------------------------------
# #3324 — the shape a rejected ListField actually returns.
#
# The contract half of this lives in tests/test_openapi_contract.py, which
# validates hand-written bodies against the committed 400 schema. That alone
# would keep passing if DRF ever changed the shape it emits, because nothing in
# it asks the API. This is the other half: drive a real rejection and pin what
# comes back, so the two can only agree by being right.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_rejected_list_field_errors_are_keyed_by_item_index() -> None:
    """A bad `hidden_views` item yields `{"hidden_views": {"<index>": [...]}}` (#3324).

    `ListField.to_internal_value` collects per-item errors into a dict keyed by
    item index — the index is what lets a client point at the offending element —
    so the value under the field key is an OBJECT, not the flat `array<string>`
    the schema declared until #3324. The 2026-09-02 nightly `api:fuzz` failed
    `POST /projects/`, `POST /programs/` and `PATCH /auth/me/profile/` on exactly
    this, one per `ListField` on those payloads.
    """
    user = User.objects.create_user(username="listerr", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": [{"not": "a string"}]}, format="json")

    assert resp.status_code == 400
    errors = resp.data["hidden_views"]
    assert isinstance(errors, dict), (
        f"expected per-index dict from ListField, got {type(errors).__name__}: {errors!r}"
    )
    assert set(errors) == {0}, f"keys must be item indices, got {sorted(errors)}"
    assert errors[0], "the offending index must carry at least one message"


@pytest.mark.django_db
def test_that_rejection_conforms_to_the_committed_400_schema() -> None:
    """The live body must validate against what `openapi.json` promises (#3324).

    Reading the committed artifact rather than regenerating: it is the published
    contract and the thing a generated client is built from. Reverting
    `additionalProperties` to `{"type": "array", "items": {"type": "string"}}`
    must turn this red — that is the negative control, and it is why this asserts
    against the file rather than against a literal copied from the fix.
    """
    user = User.objects.create_user(username="listconform", password="pw")
    resp = _client(user).patch(URL, {"hidden_views": [{"not": "a string"}]}, format="json")
    assert resp.status_code == 400

    for parent in Path(__file__).resolve().parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            schema = json.loads(candidate.read_text())
            break
    else:  # pragma: no cover - the repo always has one
        raise AssertionError("Could not locate docs/api/openapi.json above the test file.")

    op = schema["paths"][URL]["patch"]
    declared = op["responses"]["400"]["content"]["application/json"]["schema"]
    validator = jsonschema.Draft202012Validator({**declared, "components": schema["components"]})
    errors = sorted(validator.iter_errors(json.loads(resp.content)), key=str)
    assert not errors, (
        "the live 400 body violates the declared 400 schema — the same failure the "
        f"nightly api:fuzz reports: {[e.message for e in errors]}"
    )
