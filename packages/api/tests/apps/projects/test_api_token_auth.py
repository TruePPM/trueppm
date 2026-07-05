"""Unit tests for ProjectApiTokenAuthentication (ADR-0068, #848 backfill).

The auth class is the trust boundary for inbound integration writes — every
structural-validation branch (wrong keyword, malformed header, bad length/prefix,
non-hex body, unknown/revoked hash) must fail closed with a generic 401, and the
success path must return ``(creator, token)`` and stamp ``last_used_at``. The
program-scoped happy path is exercised end-to-end by test_acceptance_result_ingest;
here we cover the authenticator in isolation, including project- and program-scoped
tokens and the deleted-creator → AnonymousUser fallback.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.utils import timezone
from rest_framework import exceptions
from rest_framework.test import APIRequestFactory

from trueppm_api.apps.projects.authentication import (
    TOKEN_PREFIX,
    ProjectApiTokenAuthentication,
    sha256_hex,
)
from trueppm_api.apps.projects.models import ApiToken, Calendar, Program, Project

User = get_user_model()

# A well-formed raw token: prefix + 64 hex chars.
_RAW_HEX = "0123456789abcdef" * 4
_RAW_TOKEN = TOKEN_PREFIX + _RAW_HEX


def _request(authorization: str | None = None):
    factory = APIRequestFactory()
    if authorization is None:
        return factory.get("/")
    return factory.get("/", HTTP_AUTHORIZATION=authorization)


@pytest.fixture
def creator(db: object) -> object:
    return User.objects.create_user(username="integrator", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    from datetime import date

    return Project.objects.create(name="P", start_date=date(2026, 1, 5), calendar=calendar)


def _mint(raw: str = _RAW_TOKEN, **kwargs: object) -> ApiToken:
    return ApiToken.objects.create(
        name="Jira Production",
        token_prefix=raw[len(TOKEN_PREFIX) :][:8],
        token_hash=sha256_hex(raw),
        **kwargs,
    )


@pytest.mark.django_db
class TestProjectApiTokenAuthenticationSuccess:
    def test_valid_project_token_returns_creator_and_token(
        self, project: Project, creator: object
    ) -> None:
        token = _mint(project=project, created_by=creator)
        result = ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        assert result is not None
        user, auth = result
        assert user == creator
        assert auth == token

    def test_program_scoped_token_authenticates(self, creator: object) -> None:
        program = Program.objects.create(name="Prog")
        token = _mint(program=program, project=None, created_by=creator)
        result = ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        assert result is not None
        _, auth = result
        assert auth == token
        assert auth.is_program_scoped is True

    def test_success_stamps_last_used_at(self, project: Project, creator: object) -> None:
        token = _mint(project=project, created_by=creator)
        assert token.last_used_at is None
        before = timezone.now()
        ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        token.refresh_from_db()
        assert token.last_used_at is not None
        assert token.last_used_at >= before

    def test_deleted_creator_falls_back_to_anonymous_user(self, project: Project) -> None:
        # created_by is SET_NULL: a token whose minter was deleted still works,
        # but request.user becomes AnonymousUser (history attribution is lost).
        _mint(project=project, created_by=None)
        result = ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        assert result is not None
        user, _ = result
        assert isinstance(user, AnonymousUser)


@pytest.mark.django_db
class TestProjectApiTokenAuthenticationFailures:
    def test_no_authorization_header_returns_none(self) -> None:
        # Returns None (not 401) so JWT/session authenticators get a turn.
        assert ProjectApiTokenAuthentication().authenticate(_request()) is None

    def test_non_bearer_scheme_returns_none(self) -> None:
        assert ProjectApiTokenAuthentication().authenticate(_request("Basic abc123")) is None

    def test_header_with_no_credentials_raises(self) -> None:
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request("Bearer"))

    def test_header_with_extra_parts_raises(self) -> None:
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN} extra"))

    def test_wrong_length_token_raises(self) -> None:
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request("Bearer tppm_tooshort"))

    def test_wrong_prefix_bearer_returns_none(self) -> None:
        # A ``Bearer`` value that is not one of our ``tppm_`` tokens is almost
        # certainly a JWT (simplejwt also uses ``Bearer``). Since the read-only
        # MCP viewsets additively list token auth *and* JWT (ADR-0186 §E), a
        # non-``tppm_`` bearer must DEFER to the next authenticator (return None),
        # not raise — otherwise every human JWT request on those views would 401.
        bad = "xxxx_" + _RAW_HEX  # right length, wrong prefix
        assert ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {bad}")) is None

    def test_non_hex_body_raises(self) -> None:
        bad = TOKEN_PREFIX + ("z" * 64)  # right length + prefix, body not hex
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {bad}"))

    def test_unknown_hash_raises(self, db: object) -> None:
        # Well-formed token that was never minted → no DB row → generic failure.
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))

    def test_revoked_token_raises(self, project: Project, creator: object) -> None:
        _mint(project=project, created_by=creator, revoked_at=timezone.now())
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))


@pytest.mark.django_db
class TestPersonalAccessTokenAuthentication:
    """Personal Access Tokens (ADR-0211): owner resolution + expiry filter.

    A PAT sets ``request.user`` to its ``owner`` (the acting user), so all
    downstream RBAC applies exactly as that user's session. A token past its
    ``expires_at`` fails closed with the same generic 401 as an unknown hash.
    """

    def test_personal_token_resolves_to_owner(self, creator: object) -> None:
        # created_by (minter) differs from owner to prove owner wins the resolution.
        owner = User.objects.create_user(username="pat_owner", password="pw")
        token = _mint(owner=owner, project=None, created_by=creator)
        result = ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        assert result is not None
        user, auth = result
        assert user == owner  # owner, not the minter
        assert auth == token
        assert auth.is_personal is True
        # A far-future expiry authenticates fine.
        token.expires_at = timezone.now() + timedelta(days=1)
        token.save(update_fields=["expires_at"])
        again = ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        assert again is not None

    def test_expired_personal_token_raises(self, creator: object) -> None:
        owner = User.objects.create_user(username="pat_owner", password="pw")
        _mint(
            owner=owner,
            project=None,
            created_by=creator,
            expires_at=timezone.now() - timedelta(minutes=1),
        )
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))

    def test_project_token_unaffected_by_expiry_filter(
        self, project: Project, creator: object
    ) -> None:
        # A project token has null expires_at and still authenticates (the expiry
        # branch must not regress the existing project/program path).
        _mint(project=project, created_by=creator)
        result = ProjectApiTokenAuthentication().authenticate(_request(f"Bearer {_RAW_TOKEN}"))
        assert result is not None
        user, _ = result
        assert user == creator
