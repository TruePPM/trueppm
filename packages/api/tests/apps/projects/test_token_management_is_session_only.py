"""A token cannot manage tokens, and revoking one is now recorded (#2878).

Six defects that together made the containment story in
``features/personal-access-tokens.md#revoking-a-token`` untrue. The story is: your token
leaked, you revoke it, you are contained. Each defect broke a different link:

  1. a leaked token could mint siblings and revoke the owner's live tokens, so revoking
     "the" token contained nothing;
  2. the operator runbook's breach lever (rotate ``JWT_SIGNING_KEY``) does not touch a
     token at all — a token is a hash lookup, not a signature;
  3. the two security-relevant revocations (password reset, off-boarding) wrote no audit
     row, so the trail was *inverted*: routine rotation logged, incident response not;
  4. personal audit rows had no reader anywhere;
  5. list/retrieve/destroy on the credential surface resolved to an **empty** throttle
     list, because an overriding ``get_throttles`` replaces the defaults rather than
     adding to them;
  6. two refusal paths answered with a bare body.

**The trap this file exists to avoid.** An identity refusal is raised by the
*authenticator*, so on that path ``request.auth`` is ``None`` and no permission class
runs. A suite that only exercises *live* tokens proves the 403 and says nothing about
the 401 — every test would stay green while the refusal path silently regressed. Every
"refused" assertion below therefore comes in a pair: a live token (403 from
``IsNotTokenAuthenticated``) and a dead or wrong-scope one (401 from the authenticator).
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_LEGACY_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    ApiTokenAuditAction,
    ApiTokenAuditEntry,
    Calendar,
    Program,
    Project,
)

User = get_user_model()

_MY_TOKENS = "/api/v1/me/api-tokens/"
_MY_AUDIT = "/api/v1/me/api-token-audit/"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(
        username="pat_holder", email="pat_holder@example.com", password="pw"
    )


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint(owner: Any, **kwargs: Any) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    kwargs.setdefault("expires_at", timezone.now() + timedelta(days=30))
    token = ApiToken.objects.create(
        owner=owner,
        name=kwargs.pop("name", "pat"),
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        **kwargs,
    )
    return token, raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _session(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# ---------------------------------------------------------------------------
# 1 — a token cannot mint, list, or revoke tokens
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_token_cannot_mint_a_sibling(owner: Any) -> None:
    """The persistence primitive: one leak became up to ten credentials."""
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).post(_MY_TOKENS, {"name": "attacker"}, format="json")
    assert resp.status_code == 403, resp.data
    assert ApiToken.objects.filter(owner=owner).count() == 1


@pytest.mark.django_db
def test_a_token_cannot_enumerate_its_siblings(owner: Any) -> None:
    """The reconnaissance step. ``GET`` is refused too, not only the writes."""
    _mint(owner, name="power-bi", scopes=[SCOPE_LEGACY_FULL])
    _, raw = _mint(owner, name="leaked", scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).get(_MY_TOKENS)
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_a_token_cannot_revoke_the_owners_other_token(owner: Any) -> None:
    """Denial of the owner's own automations, from a credential they never issued."""
    victim, _ = _mint(owner, name="nightly-export", scopes=[SCOPE_LEGACY_FULL])
    _, raw = _mint(owner, name="leaked", scopes=[SCOPE_LEGACY_FULL])

    resp = _bearer(raw).delete(f"{_MY_TOKENS}{victim.pk}/")
    assert resp.status_code == 403, resp.data
    victim.refresh_from_db()
    assert victim.revoked_at is None


@pytest.mark.django_db
def test_the_refusal_says_why(owner: Any) -> None:
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).get(_MY_TOKENS)
    assert resp.data["refusal"] == {
        "verdict": "refused",
        "reason": "policy",
        "constraint": "capability_scope",
    }, resp.data


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path_suffix",
    ["", "audit"],
)
def test_a_revoked_token_is_refused_at_the_authenticator_not_the_permission(
    owner: Any, path_suffix: str
) -> None:
    """**The 401 path.** This is the assertion the obvious test suite omits.

    A revoked token never reaches ``IsNotTokenAuthenticated`` — the authenticator raises
    first and ``request.auth`` stays ``None``. A guard keyed on ``request.auth`` is
    therefore *correct* only because it is a permission class rather than a check inside
    the view, and only this pair of tests demonstrates that: without the 401 arm, a
    regression that moved the check somewhere ``request.auth`` is not yet populated
    would leave every 403 test green.
    """
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL], revoked_at=timezone.now())
    url = _MY_AUDIT if path_suffix == "audit" else _MY_TOKENS
    resp = _bearer(raw).get(url)
    assert resp.status_code == 401, resp.data
    assert resp.data["refusal"]["reason"] == "identity", resp.data


@pytest.mark.django_db
def test_an_mcp_read_token_is_also_refused_at_the_authenticator(owner: Any) -> None:
    """Second 401 arm: a live token on the wrong surface, not a dead one.

    ``OwnerScopedApiTokenAuthentication`` rejects it before permissions run, so the two
    refusal mechanisms both have to be covered for the surface to be considered closed.
    """
    _, raw = _mint(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(_MY_TOKENS)
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_a_session_can_still_manage_tokens(owner: Any) -> None:
    """Guard the guard: the surface must stay usable by the human who owns it."""
    client = _session(owner)
    created = client.post(_MY_TOKENS, {"name": "Power BI"}, format="json")
    assert created.status_code == 201, created.data
    assert created.data["token"].startswith(TOKEN_PREFIX)

    assert client.get(_MY_TOKENS).status_code == 200
    assert client.delete(f"{_MY_TOKENS}{created.data['id']}/").status_code == 204


@pytest.mark.django_db
def test_a_token_cannot_mint_a_project_token(project: Project, owner: Any) -> None:
    """The worse variant of the same hole.

    A project token is a *strictly better* persistence primitive than a sibling PAT:
    password reset and off-boarding both scope their revocation to ``owner=user`` and
    deliberately leave project tokens alone, so one minted from a leaked PAT survives
    every containment step the owner has.
    """
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {"name": "backdoor"},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert not ApiToken.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_a_token_cannot_read_the_project_token_audit_log(project: Project, owner: Any) -> None:
    """Same reconnaissance argument: the rows carry prefixes, actors, IPs and scopes."""
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/api-token-audit/")
    assert resp.status_code == 403, resp.data
    assert _session(owner).get(f"/api/v1/projects/{project.pk}/api-token-audit/").status_code == 200


@pytest.mark.django_db
def test_a_token_cannot_mint_a_program_token(owner: Any) -> None:
    from trueppm_api.apps.access.models import ProgramMembership

    program = Program.objects.create(name="Apollo")
    ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).post(
        f"/api/v1/programs/{program.pk}/api-tokens/", {"name": "backdoor"}, format="json"
    )
    assert resp.status_code == 403, resp.data


# ---------------------------------------------------------------------------
# 3 — the two security-relevant revocations write audit rows
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_password_reset_revocation_is_audited(owner: Any) -> None:
    """Verified before the fix: ``revoked=2, audit_rows before=0 after=0``."""
    from trueppm_api.apps.access.services import revoke_all_personal_access_tokens

    _mint(owner, name="a")
    _mint(owner, name="b")
    assert ApiTokenAuditEntry.objects.filter(owner=owner).count() == 0

    revoked = revoke_all_personal_access_tokens(owner, actor=owner, reason="password_reset")

    assert revoked == 2
    rows = ApiTokenAuditEntry.objects.filter(owner=owner)
    assert rows.count() == 2
    assert {row.action for row in rows} == {ApiTokenAuditAction.REVOKED.value}
    assert {row.detail["reason"] for row in rows} == {"password_reset"}
    assert all(row.actor_id == owner.pk for row in rows)


@pytest.mark.django_db
def test_bulk_revocation_is_idempotent_and_does_not_double_audit(owner: Any) -> None:
    """Re-running must not manufacture a second revocation event for the same token.

    The bug shape a naive fix produces: re-read the tokens *after* the update (or
    without the ``revoked_at__isnull`` filter) and every already-revoked token gets a
    fresh row, so the trail claims a containment that never happened.
    """
    from trueppm_api.apps.access.services import revoke_all_personal_access_tokens

    _mint(owner, name="a")
    assert revoke_all_personal_access_tokens(owner, reason="password_reset") == 1
    assert revoke_all_personal_access_tokens(owner, reason="password_reset") == 0
    assert ApiTokenAuditEntry.objects.filter(owner=owner).count() == 1


@pytest.mark.django_db
def test_offboarding_revocation_is_audited_and_names_the_admin(owner: Any) -> None:
    from trueppm_api.apps.access.services import revoke_all_personal_access_tokens

    admin = User.objects.create_user(username="admin", password="pw", is_staff=True)
    _mint(owner, name="departing")

    revoke_all_personal_access_tokens(owner, actor=admin, reason="offboarding")

    row = ApiTokenAuditEntry.objects.get(owner=owner)
    assert row.detail["reason"] == "offboarding"
    assert row.actor_id == admin.pk


@pytest.mark.django_db
def test_bulk_revocation_leaves_integration_tokens_alone(project: Project, owner: Any) -> None:
    """Scope discipline is load-bearing and must not regress while adding the audit."""
    from trueppm_api.apps.access.services import revoke_all_personal_access_tokens

    team_token = ApiToken.objects.create(
        project=project,
        name="team-ci",
        token_prefix="deadbeef",
        token_hash=sha256_hex("team-ci"),
        created_by=owner,
    )
    _mint(owner, name="personal")

    assert revoke_all_personal_access_tokens(owner, reason="password_reset") == 1
    team_token.refresh_from_db()
    assert team_token.revoked_at is None


# ---------------------------------------------------------------------------
# 4 — the personal audit rows have a reader
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_user_can_read_their_own_token_history(owner: Any) -> None:
    """Before this route existed the rows matched no queryset anywhere on the instance."""
    client = _session(owner)
    created = client.post(_MY_TOKENS, {"name": "Power BI"}, format="json")
    client.delete(f"{_MY_TOKENS}{created.data['id']}/")

    resp = client.get(_MY_AUDIT)
    assert resp.status_code == 200, resp.data
    actions = [row["action"] for row in resp.data["results"]]
    assert set(actions) == {
        ApiTokenAuditAction.MINTED.value,
        ApiTokenAuditAction.REVOKED.value,
    }


@pytest.mark.django_db
def test_the_audit_reader_shows_only_your_own_rows(owner: Any) -> None:
    stranger = User.objects.create_user(username="stranger", password="pw")
    _session(stranger).post(_MY_TOKENS, {"name": "Not yours"}, format="json")
    _session(owner).post(_MY_TOKENS, {"name": "Mine"}, format="json")

    resp = _session(owner).get(_MY_AUDIT)
    assert resp.status_code == 200
    assert resp.data["count"] == 1
    assert resp.data["results"][0]["detail"]["name"] == "Mine"


@pytest.mark.django_db
def test_the_audit_reader_refuses_a_token_caller(owner: Any) -> None:
    _, raw = _mint(owner, scopes=[SCOPE_LEGACY_FULL])
    assert _bearer(raw).get(_MY_AUDIT).status_code == 403


# ---------------------------------------------------------------------------
# 5 — no action on the credential surface resolves to an empty throttle list
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["list", "retrieve", "create", "destroy"])
def test_every_token_action_is_throttled(action: str) -> None:
    """An overriding ``get_throttles`` **replaces** ``DEFAULT_THROTTLE_CLASSES``.

    Verified before the fix: ``list: [], retrieve: [], create: ['TokenIssuanceThrottle'],
    destroy: []`` — an unthrottled enumerate/delete pair on a credential-management
    surface, published as "Every endpoint is rate limited."
    """
    from trueppm_api.apps.projects.views import MyApiTokenViewSet, ProjectApiTokenViewSet

    for viewset_cls in (MyApiTokenViewSet, ProjectApiTokenViewSet):
        view = viewset_cls()
        view.action = action
        throttles = view.get_throttles()
        assert throttles, f"{viewset_cls.__name__}.{action} resolves to no throttle at all"


@pytest.mark.django_db
def test_revocation_carries_its_own_throttle_bucket() -> None:
    """Sized above issuance on purpose: revocation is the containment action.

    A shared bucket would cap a user cutting off a leak at the 5/min mint rate — a
    control working against the incident it exists for.
    """
    from trueppm_api.apps.projects.throttles import TokenIssuanceThrottle, TokenRevocationThrottle
    from trueppm_api.apps.projects.views import MyApiTokenViewSet

    view = MyApiTokenViewSet()
    view.action = "destroy"
    assert any(isinstance(t, TokenRevocationThrottle) for t in view.get_throttles())
    assert TokenRevocationThrottle.USER_LIMIT > TokenIssuanceThrottle.USER_LIMIT


# ---------------------------------------------------------------------------
# Scope coherence — the mint paths agree, and stored state is unambiguous
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_pat_cannot_be_minted_with_both_scopes(owner: Any) -> None:
    """The two scopes select mutually exclusive enforcement postures since #2877."""
    resp = _session(owner).post(
        _MY_TOKENS,
        {
            "name": "both",
            "scopes": [SCOPE_LEGACY_FULL, SCOPE_MCP_READ],
            "expires_at": (timezone.now() + timedelta(days=30)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "scopes" in resp.data


@pytest.mark.django_db
def test_a_project_token_cannot_be_minted_with_both_scopes(project: Project, owner: Any) -> None:
    """Both mint paths write the same column, so both must reject the same input.

    The rule lived in two copies before, which is how they drifted: the PAT path was
    fixed and the project path was not, leaving one route able to produce a row whose
    resolved posture contradicts its own label.
    """
    resp = _session(owner).post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {
            "name": "both",
            "scopes": [SCOPE_LEGACY_FULL, SCOPE_MCP_READ],
            "expires_at": (timezone.now() + timedelta(days=30)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.data
