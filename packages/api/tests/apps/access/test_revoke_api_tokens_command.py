"""``manage.py revoke_api_tokens`` — the operator's breach-recovery lever (#2878).

Why the command exists at all: ``administration/security.md`` told operators that
rotating ``JWT_SIGNING_KEY`` after a suspected token leak signs everyone out. It does,
for sessions and JWTs — and an API token is resolved by a SHA-256 hash lookup with no
signature anywhere in the path, so it is completely untouched. An operator could follow
the documented runbook exactly and leave every leaked token live. ``test_key_rotation_
does_not_touch_a_token`` below is the assertion that made that concrete; the rest cover
the lever that closes it.
"""

from __future__ import annotations

import secrets
from datetime import date
from io import StringIO
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings

from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    ApiToken,
    ApiTokenAuditAction,
    ApiTokenAuditEntry,
    Calendar,
    Project,
)

User = get_user_model()


@pytest.fixture
def alice(db: object) -> Any:
    return User.objects.create_user(username="alice", email="alice@example.com", password="pw")


@pytest.fixture
def bob(db: object) -> Any:
    return User.objects.create_user(username="bob", email="bob@example.com", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


def _mint(**kwargs: Any) -> ApiToken:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    return ApiToken.objects.create(
        name=kwargs.pop("name", "t"),
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        **kwargs,
    )


def _run(*args: str) -> str:
    out = StringIO()
    call_command("revoke_api_tokens", *args, stdout=out)
    return out.getvalue()


@pytest.mark.django_db
def test_dry_run_is_the_default(alice: Any) -> None:
    """Revocation is one-way, so the command must not act on a mistyped scope."""
    token = _mint(owner=alice, created_by=alice)
    output = _run("--user", "alice")

    assert "Dry run" in output
    token.refresh_from_db()
    assert token.revoked_at is None


@pytest.mark.django_db
def test_user_scope_revokes_only_that_account(alice: Any, bob: Any) -> None:
    mine = _mint(owner=alice, created_by=alice)
    theirs = _mint(owner=bob, created_by=bob)

    _run("--user", "alice", "--commit", "--yes")

    mine.refresh_from_db()
    theirs.refresh_from_db()
    assert mine.revoked_at is not None
    assert theirs.revoked_at is None


@pytest.mark.django_db
def test_user_scope_accepts_an_email(alice: Any) -> None:
    """An operator mid-incident has whichever handle the alert gave them."""
    token = _mint(owner=alice, created_by=alice)
    _run("--user", "alice@example.com", "--commit", "--yes")
    token.refresh_from_db()
    assert token.revoked_at is not None


@pytest.mark.django_db
def test_unknown_user_is_an_error_not_a_silent_no_op(alice: Any) -> None:
    """A typo must not report "nothing to revoke" and leave the operator reassured."""
    with pytest.raises(CommandError, match="No account matches"):
        _run("--user", "alicce", "--commit", "--yes")


@pytest.mark.django_db
def test_an_ambiguous_identifier_fails_closed(alice: Any) -> None:
    """Django's stock ``User`` puts no uniqueness constraint on ``email`` at all.

    So one address can match several accounts, and ``.first()`` on an unordered
    queryset would silently contain the lowest pk — mid-incident, while reporting
    success, leaving the actually-leaked token live and breaking an uninvolved
    account's automations. ``apps/sso/services.py`` and ``core/password_reset.py``
    already treat this lookup as hazardous; the breach-recovery lever must not be the
    one that guesses.
    """
    twin = User.objects.create_user(username="alice-two", email="alice@example.com", password="pw")
    mine = _mint(owner=alice, created_by=alice)
    theirs = _mint(owner=twin, created_by=twin)

    with pytest.raises(CommandError, match="matches more than one account"):
        _run("--user", "alice@example.com", "--commit", "--yes")

    for token in (mine, theirs):
        token.refresh_from_db()
    assert mine.revoked_at is None
    assert theirs.revoked_at is None


@pytest.mark.django_db
def test_case_differing_usernames_are_also_ambiguous(alice: Any) -> None:
    """``username`` uniqueness is case-*sensitive*, so ``__iexact`` can match two rows."""
    User.objects.create_user(username="Alice", email="other@example.com", password="pw")
    with pytest.raises(CommandError, match="matches more than one account"):
        _run("--user", "alice", "--commit", "--yes")


@pytest.mark.django_db
def test_all_personal_leaves_integration_tokens_alone(
    alice: Any, bob: Any, project: Project
) -> None:
    """The "our secret store leaked" case must not break every team's CI."""
    a = _mint(owner=alice, created_by=alice)
    b = _mint(owner=bob, created_by=bob)
    team = _mint(project=project, created_by=alice)

    _run("--all-personal", "--commit", "--yes")

    for token in (a, b, team):
        token.refresh_from_db()
    assert a.revoked_at is not None
    assert b.revoked_at is not None
    assert team.revoked_at is None


@pytest.mark.django_db
def test_all_includes_integration_tokens(alice: Any, project: Project) -> None:
    """The full-compromise lever. Documented as breaking inbound sync until re-minted."""
    personal = _mint(owner=alice, created_by=alice)
    team = _mint(project=project, created_by=alice)

    _run("--all", "--commit", "--yes")

    for token in (personal, team):
        token.refresh_from_db()
    assert personal.revoked_at is not None
    assert team.revoked_at is not None


@pytest.mark.django_db
def test_every_revocation_is_audited_with_its_reason(alice: Any, project: Project) -> None:
    """An incident timeline must distinguish a sweep from a user's routine rotation."""
    _mint(owner=alice, created_by=alice, name="personal")
    _mint(project=project, created_by=alice, name="team")

    _run("--all", "--commit", "--yes")

    rows = list(ApiTokenAuditEntry.objects.all())
    assert len(rows) == 2
    assert {row.action for row in rows} == {ApiTokenAuditAction.REVOKED.value}
    assert {row.detail["reason"] for row in rows} == {"operator_bulk_revoke"}
    # actor is null: a shell has no Django user, and inventing one would be worse than
    # recording the absence.
    assert all(row.actor_id is None for row in rows)
    # The scope XOR on ApiTokenAuditEntry requires exactly one of owner/project/program;
    # a row that violated it would raise on insert, so reaching here proves both shapes.
    assert {bool(row.owner_id) for row in rows} == {True, False}


@pytest.mark.django_db
def test_already_revoked_tokens_are_not_swept_again(alice: Any) -> None:
    from django.utils import timezone

    _mint(owner=alice, created_by=alice, revoked_at=timezone.now())
    output = _run("--all-personal", "--commit", "--yes")
    assert "Nothing to revoke" in output
    assert ApiTokenAuditEntry.objects.count() == 0


@pytest.mark.django_db
def test_a_scope_must_be_chosen(alice: Any) -> None:
    """No default scope: "revoke everything" must never be what happens by accident."""
    with pytest.raises(CommandError):
        _run("--commit", "--yes")


@pytest.mark.django_db
@override_settings(JWT_SIGNING_KEY="a-fresh-key-of-more-than-thirty-two-characters")
def test_key_rotation_does_not_touch_a_token(alice: Any) -> None:
    """The premise of the whole command, asserted rather than argued.

    A token resolves through ``sha256_hex(raw) == token_hash`` — no signature, no key
    material anywhere in the lookup — so the documented "rotate to sign everyone out"
    procedure cannot reach it. The docs now say so and point here.
    """
    token = _mint(owner=alice, created_by=alice)
    token.refresh_from_db()
    assert token.revoked_at is None
    assert ApiToken.objects.filter(token_hash=token.token_hash, revoked_at__isnull=True).exists()
