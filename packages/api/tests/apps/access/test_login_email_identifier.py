"""Email-as-login-identifier tests for ``POST /api/v1/auth/token/`` (#3468).

The sign-in form asks for an **Email** and invited users choose a *username* at
accept time, so a user typing exactly what the label asked for was refused: the
token view authenticated on username only. The view now retries once with the
submitted identifier resolved as an email address.

These tests pin the security properties of that fallback, not just the happy
path. In order of how badly each one would hurt if it regressed:

* an email carried by **two** accounts must be refused, never resolved to either
  (``User.email`` has no uniqueness constraint on Django's default model);
* every refusal must be **indistinguishable** — same status, same body — so the
  endpoint is not an account-existence oracle;
* the **username path must be unchanged**, including for an account whose
  username is itself email-shaped;
* an identifier that is empty or has no ``@`` must never reach ``email__iexact``
  (``User.email`` is ``blank=True``, so ``email__iexact=""`` would match every
  account with no email at all).
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

User = get_user_model()

_LOGIN_URL = "/api/v1/auth/token/"
_PASSWORD = "correct-horse-battery-staple"
#: A second, different password. Spelled from dictionary words like the first
#: so the secret scanner does not read a high-entropy test fixture as a leak.
_OTHER_PASSWORD = "another-correct-horse-battery"


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """Isolate the LocMem throttle history between tests.

    Both login throttles are cache-backed, and several tests here deliberately
    submit repeated failures against one account — without this they would trip
    the per-account cap and start returning 429 instead of the 401 under test.
    """
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def invited_user():
    """The issue's actual user: a username that is NOT their email address."""
    return User.objects.create_user(
        username="skhoury", email="sarah.khoury@example.com", password=_PASSWORD
    )


def _login(client: APIClient, identifier: str, password: str = _PASSWORD):
    return client.post(_LOGIN_URL, {"username": identifier, "password": password}, format="json")


# --------------------------------------------------------------------------
# The fix itself
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_login_by_username_is_unchanged(invited_user) -> None:
    """The pre-existing path must keep working exactly as before.

    This is the negative half of the whole change: the email fallback runs only
    *after* a failed username attempt, so a regression here would mean the
    fallback had displaced the primary path rather than extending it.
    """
    resp = _login(APIClient(), "skhoury")
    assert resp.status_code == 200
    assert "access" in resp.data


@pytest.mark.django_db
def test_login_by_email_succeeds(invited_user) -> None:
    """The acceptance criterion: sign in with the identifier the label asks for."""
    resp = _login(APIClient(), "sarah.khoury@example.com")
    assert resp.status_code == 200
    assert "access" in resp.data


@pytest.mark.django_db
def test_login_by_email_is_case_insensitive(invited_user) -> None:
    """Email is case-insensitive in practice; the lookup is ``email__iexact``."""
    resp = _login(APIClient(), "Sarah.Khoury@Example.COM")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_login_by_email_sets_the_refresh_cookie_like_any_other_login(
    invited_user, settings
) -> None:
    """The email path re-runs the SAME serializer, so everything downstream fires.

    A resolution that short-circuited the view body would mint an access token
    with no refresh cookie — a second, weaker login path wearing the first one's
    name. Asserting the cookie is the cheapest proof the retry went through the
    ordinary code path rather than around it.
    """
    resp = _login(APIClient(), "sarah.khoury@example.com")
    assert resp.status_code == 200
    assert resp.cookies[settings.AUTH_REFRESH_COOKIE_NAME].value


# --------------------------------------------------------------------------
# Ambiguity — the takeover risk
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_email_shared_by_two_accounts_is_refused_not_resolved() -> None:
    """Fail closed on an ambiguous email, mirroring ``apps.sso.services``.

    ``User.email`` carries no uniqueness constraint, so two accounts may hold the
    same address. Picking either would sign the caller in as an account they did
    not name — so both correct passwords are refused here, which is the point:
    the refusal is not about the password.
    """
    User.objects.create_user(username="first", email="shared@example.com", password=_PASSWORD)
    User.objects.create_user(
        username="second", email="shared@example.com", password=_OTHER_PASSWORD
    )

    client = APIClient()
    assert _login(client, "shared@example.com").status_code == 401
    assert _login(client, "shared@example.com", _OTHER_PASSWORD).status_code == 401

    # ...and each account is still reachable by its own username, so the refusal
    # locks nobody out — it only refuses the ambiguous identifier.
    assert _login(APIClient(), "first").status_code == 200
    assert _login(APIClient(), "second", _OTHER_PASSWORD).status_code == 200


# --------------------------------------------------------------------------
# The username path must not be weakened
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_email_shaped_username_is_not_shadowed_by_another_accounts_email() -> None:
    """Username wins. An account whose *username* is email-shaped keeps working.

    The collision that matters: account A's username is ``bob@example.com`` and
    account B's *email* is the same string. Running the email branch first would
    authenticate B when A was named.
    """
    User.objects.create_user(username="bob@example.com", password=_PASSWORD)
    User.objects.create_user(username="bee", email="bob@example.com", password=_OTHER_PASSWORD)

    # A's password reaches A, via the username path, first.
    assert _login(APIClient(), "bob@example.com").status_code == 200
    # B's password falls through to the email branch and reaches B.
    assert _login(APIClient(), "bob@example.com", _OTHER_PASSWORD).status_code == 200


@pytest.mark.django_db
def test_account_whose_username_is_its_own_email_still_logs_in() -> None:
    """The 3-of-46 dev-DB case: username == email. One attempt, one answer."""
    User.objects.create_user(
        username="solo@example.com", email="solo@example.com", password=_PASSWORD
    )
    assert _login(APIClient(), "solo@example.com").status_code == 200
    assert _login(APIClient(), "solo@example.com", "wrong").status_code == 401


# --------------------------------------------------------------------------
# No account enumeration
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_every_refusal_is_indistinguishable(invited_user) -> None:
    """A wrong password, an unknown email and an ambiguous email look identical.

    If any of these differed in status or body the endpoint would be an
    account-existence oracle at the unauthenticated boundary — an attacker could
    confirm which addresses have accounts without ever guessing a password.
    """
    User.objects.create_user(username="dup_a", email="dup@example.com", password=_PASSWORD)
    User.objects.create_user(username="dup_b", email="dup@example.com", password=_PASSWORD)

    refusals = [
        _login(APIClient(), "sarah.khoury@example.com", "wrong-password"),  # right email, wrong pw
        _login(APIClient(), "nobody@example.com"),  # no such email
        _login(APIClient(), "dup@example.com"),  # ambiguous email
        _login(APIClient(), "no-such-username"),  # no such username (pre-existing path)
    ]

    statuses = {r.status_code for r in refusals}
    bodies = {str(r.data) for r in refusals}
    assert statuses == {401}, statuses
    assert len(bodies) == 1, bodies


@pytest.mark.django_db
def test_wrong_password_for_a_known_email_does_not_leak_the_username(invited_user) -> None:
    """The resolved username must never appear in the response body."""
    resp = _login(APIClient(), "sarah.khoury@example.com", "wrong-password")
    assert resp.status_code == 401
    assert "skhoury" not in str(resp.data)


# --------------------------------------------------------------------------
# The blank-email trap
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_blank_identifier_never_matches_an_emailless_account() -> None:
    """``User.email`` is ``blank=True``; ``email__iexact=""`` must never run.

    SSO- and admin-created accounts routinely carry ``""``. On an install with
    exactly one such account, an unguarded lookup would resolve the empty string
    to it and hand an attacker a working identifier.
    """
    User.objects.create_user(username="emailless", password=_PASSWORD)
    assert User.objects.get(username="emailless").email == ""

    for identifier in ("", "   "):
        resp = _login(APIClient(), identifier)
        # A blank username is a serializer field error (400), not a 401 — either
        # way it must not authenticate.
        assert resp.status_code in (400, 401), (identifier, resp.status_code)
        assert "access" not in (resp.data or {})


@pytest.mark.django_db
def test_identifier_without_an_at_sign_never_takes_the_email_branch() -> None:
    """A username miss stays a username miss — no email lookup, no second attempt."""
    User.objects.create_user(username="carol", email="carol@example.com", password=_PASSWORD)
    assert _login(APIClient(), "carol.example.com").status_code == 401


# --------------------------------------------------------------------------
# Inactive accounts
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_inactive_account_cannot_be_reached_through_the_email_branch() -> None:
    """The retry runs the same backend, so ``is_active`` still gates it.

    Worth pinning explicitly: the fallback resolves an identifier by a direct ORM
    query, and a resolution that authenticated the user itself (rather than
    handing the username back to the serializer) would have skipped this check.
    """
    user = User.objects.create_user(
        username="dormant", email="dormant@example.com", password=_PASSWORD
    )
    user.is_active = False
    user.save(update_fields=["is_active"])

    assert _login(APIClient(), "dormant@example.com").status_code == 401
    assert _login(APIClient(), "dormant").status_code == 401


# --------------------------------------------------------------------------
# The per-account throttle must not split into two buckets
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_email_login_charges_the_canonical_accounts_throttle_bucket(invited_user) -> None:
    """One account, one per-account bucket — whichever identifier was typed.

    ``LoginAccountRateThrottle`` runs in ``check_throttles``, before the view, so
    it can only key on the identifier as *submitted*. Once one account answers to
    two identifiers, an attacker alternating between them would get two
    independent buckets and double the guess allowance against that account —
    defeating the cross-IP protection #1717 exists for. The view therefore
    charges the resolved account's own bucket after resolving an email.

    Negative control: without that charge the canonical bucket stays empty, which
    is exactly the assertion below.
    """
    from trueppm_api.core.throttling import LoginAccountRateThrottle

    canonical_key = LoginAccountRateThrottle.cache_key_for("skhoury")
    assert not cache.get(canonical_key)

    resp = _login(APIClient(), "sarah.khoury@example.com")
    assert resp.status_code == 200

    assert len(cache.get(canonical_key) or []) == 1, (
        "an email-form login left the canonical account's throttle bucket empty — "
        "the per-account limit has split in two"
    )


@pytest.mark.django_db
def test_a_failed_email_login_also_charges_the_canonical_bucket(invited_user) -> None:
    """The guessing case is the one that matters, not the success case."""
    from trueppm_api.core.throttling import LoginAccountRateThrottle

    canonical_key = LoginAccountRateThrottle.cache_key_for("skhoury")
    assert _login(APIClient(), "sarah.khoury@example.com", "wrong").status_code == 401
    assert len(cache.get(canonical_key) or []) == 1


@pytest.mark.django_db
def test_spending_the_username_budget_also_closes_the_email_form(invited_user) -> None:
    """The order that a recording-only fix leaves open (#3468, `rbac-check`).

    Charging the canonical bucket is not enough on its own. The username bucket
    already accumulates every attempt in either form, but if nothing *checks* it on
    the email path, an attacker who spends the username budget first arrives at an
    untouched email bucket and collects a second full allowance — so only the
    email-first order would be capped, and the protection would look complete while
    being half-broken. This drives the username form to its limit and then asserts
    the *email* form is refused rather than starting a fresh budget.

    Negative control: with the enforcing branch removed and only the recording left,
    the final assertion returns 401 instead of 429.

    Runs against the shipped rates rather than overriding them — DRF captures
    ``DEFAULT_THROTTLE_RATES`` onto ``SimpleRateThrottle.THROTTLE_RATES`` at import,
    so a ``settings`` fixture override reloads ``api_settings`` and leaves that class
    attribute pointing at the original dict. Seven requests fit inside the 10/min
    IP-keyed ``login`` cap, so the per-account scope is the only limiter here.
    """
    account_limit = 5  # login_account, settings/base.py

    client = APIClient()
    for _ in range(account_limit):
        assert _login(client, "skhoury", "wrong").status_code == 401
    # The username form is now refused by DRF's own per-account throttle.
    assert _login(client, "skhoury", "wrong").status_code == 429

    # ...and switching to the account's OTHER identifier must not reset the budget.
    assert _login(client, "sarah.khoury@example.com", "wrong").status_code == 429
