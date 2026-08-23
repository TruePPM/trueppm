"""The {scope} x {surface} x {method} matrix the token guards were never tested on (#2877).

The defect this file pins was invisible to a large, green test suite because every
existing test held one axis fixed:

  * ``test_pat_general_endpoint_auth.py`` proved a ``legacy:full`` PAT can write — using
    only **non**-MCP-wrapped endpoints (``/calendars/``, ``/auth/me/profile/``);
  * ``test_api_token_scopes.py`` exercised ``TokenReadOnlyMethods`` — using only
    **``mcp:read``** tokens.

No test crossed ``{legacy:full, mcp:read}`` x ``{MCP-wrapped, plain}`` x ``{safe,
unsafe}``, so the cell where a ``legacy:full`` PAT writes to an MCP-wrapped viewset —
which is most of the core CRUD API: Task, Project, Risk, Sprint, Label, Program,
Backlog — was never visited, and 103 tests passed over a surface that 403'd every write
a self-hoster's CI script made. Parametrizing the matrix is the point: a future guard
that becomes scope-blind again fails a *cell*, not a hand-written case somebody
remembered to add.

The second half covers the two MCP consent controls, which had the same shape of bug
with a worse failure mode — the team opt-out withholds *rows*, so a blanked read is a
``200`` with ``count: 0``, indistinguishable from "no tasks" to the nightly export that
then writes an empty file.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_LEGACY_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Project,
    Task,
    is_agent_token,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="matrix_owner", password="pw")


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    proj = Project.objects.create(name="Matrix", start_date=date(2026, 4, 1), calendar=calendar)
    # OWNER satisfies every RBAC gate, so any refusal below comes from a scope guard
    # rather than from a missing role — which is the whole point of the matrix.
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint_personal(owner: Any, scopes: list[str]) -> str:
    """Mint an owner-scoped token with a known raw value; returns the bearer value."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name=f"pat-{scopes[0]}",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=scopes,
        # An mcp:read token must carry a bounded expiry (#1713/#2764); legacy:full
        # tolerates one, so setting it unconditionally keeps the two arms comparable.
        expires_at=timezone.now() + timedelta(days=30),
    )
    return raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


# ---------------------------------------------------------------------------
# Axis definitions
#
# "wrapped" = the view carries McpReadableViewMixin; "plain" = it does not. The
# distinction is invisible in the URL, which is exactly why an integrator could not
# have predicted which of their calls would 403.
# ---------------------------------------------------------------------------

_WRAPPED_READS = [
    "/api/v1/tasks/?project={project}",
    "/api/v1/projects/",
]

_UNSAFE_CASES = [
    ("wrapped", "/api/v1/tasks/"),
    ("plain", "/api/v1/calendars/"),
]


def _write_payload(path: str, project: Project) -> dict[str, Any]:
    if "tasks" in path:
        return {"name": "From CI", "duration": 2, "project": str(project.pk)}
    return {"name": "CI calendar"}


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("scope", [SCOPE_LEGACY_FULL, SCOPE_MCP_READ])
@pytest.mark.parametrize("path", _WRAPPED_READS)
def test_both_scopes_read_the_wrapped_surface(
    project: Project, owner: Any, scope: str, path: str
) -> None:
    """Reads on the MCP surface were never the broken axis — pin them anyway.

    ``legacy:full`` satisfies ``TokenHasScope("mcp:read")`` as a read superset, and an
    ``mcp:read`` token is what the wrapped surface exists for. Both must read it, and a
    scope-aware refactor of the guards is exactly the kind of change that could break
    one arm while fixing the other.
    """
    raw = _mint_personal(owner, [scope])
    resp = _bearer(raw).get(path.format(project=project.pk))
    assert resp.status_code == 200, f"{scope} on {path}: {resp.data}"


@pytest.mark.django_db
def test_legacy_full_reads_the_plain_surface(owner: Any) -> None:
    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    assert _bearer(raw).get("/api/v1/calendars/").status_code == 200


@pytest.mark.django_db
def test_mcp_read_is_refused_on_the_plain_surface(owner: Any) -> None:
    """The other half of the ``mcp:read`` promise: it stays on the curated surface.

    Refused by ``OwnerScopedApiTokenAuthentication`` (401, not 403) — nothing on a
    non-MCP view checks token scope, so this authenticator is the only thing that keeps
    an ``mcp:read`` token off the general API.
    """
    raw = _mint_personal(owner, [SCOPE_MCP_READ])
    resp = _bearer(raw).get("/api/v1/calendars/")
    assert resp.status_code == 401, resp.data
    # #2878 finding 6: this was a bare {"detail": "Invalid token."} — the least
    # diagnosable answer to the most likely first-hour integration mistake.
    assert resp.data["refusal"] == {
        "verdict": "refused",
        "reason": "identity",
        "constraint": "token_identity",
    }, resp.data
    # The generic detail is unchanged, so "wrong scope" still cannot be told apart from
    # "revoked" / "expired" / "never existed" — the anti-enumeration posture holds.
    assert resp.data["detail"] == "Invalid token."


@pytest.mark.django_db
@pytest.mark.parametrize(("surface", "path"), _UNSAFE_CASES)
def test_legacy_full_writes_every_surface(
    project: Project, owner: Any, surface: str, path: str
) -> None:
    """The regression cell. A ``legacy:full`` PAT is the owner's own credential.

    Before #2877 the ``plain`` arm passed and the ``wrapped`` arm returned 403 — same
    token, same user, same project, difference invisible from the outside — while
    ``features/personal-access-tokens.md`` promised "reads and writes everything your
    account can" and the settings UI said the same.
    """
    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    resp = _bearer(raw).post(
        path.format(project=project.pk),
        _write_payload(path, project),
        format="json",
    )
    assert resp.status_code == 201, f"{surface} {path}: {resp.data}"


@pytest.mark.django_db
@pytest.mark.parametrize(("surface", "path"), _UNSAFE_CASES)
def test_mcp_read_writes_nothing(project: Project, owner: Any, surface: str, path: str) -> None:
    """The guarantee that must NOT be weakened while fixing the cell above.

    ``mcp:read`` is a published product promise ("rejected at every write path"), and
    the two surfaces refuse it by different mechanisms — ``TokenReadOnlyMethods`` on the
    wrapped one, ``OwnerScopedApiTokenAuthentication`` on the plain one — so both arms
    have to be asserted or half the promise is untested.
    """
    raw = _mint_personal(owner, [SCOPE_MCP_READ])
    resp = _bearer(raw).post(
        path.format(project=project.pk),
        _write_payload(path, project),
        format="json",
    )
    assert resp.status_code in (401, 403), f"{surface} {path}: {resp.status_code} {resp.data}"
    # Whichever mechanism refused, the caller is told what class of problem it is —
    # both paths were previously bare bodies (#2878 finding 6).
    assert "refusal" in resp.data, resp.data


@pytest.mark.django_db
def test_a_pat_never_exceeds_its_owners_rbac(calendar: Calendar, owner: Any) -> None:
    """The invariant that makes the write pass safe: a token is bounded by its owner.

    A Viewer's PAT writing to a project they can only read must still 403 — from the
    view's RBAC, not from a token guard. Without this the fix would read as "tokens can
    write" rather than "tokens are governed exactly as their owner's session is".
    """
    viewer_project = Project.objects.create(
        name="Viewer only", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=viewer_project, user=owner, role=Role.VIEWER)

    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    client = _bearer(raw)

    assert client.get(f"/api/v1/tasks/?project={viewer_project.pk}").status_code == 200
    resp = client.post(
        f"/api/v1/tasks/?project={viewer_project.pk}",
        {"name": "Nope", "duration": 1, "project": str(viewer_project.pk)},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert not Task.objects.filter(project=viewer_project).exists()


@pytest.mark.django_db
def test_a_pat_cannot_reach_a_project_its_owner_is_not_in(
    calendar: Calendar, owner: Any, project: Project
) -> None:
    """Removing the MCP row filter must not widen what a token can see.

    ``_mcp_filter_queryset`` only ever narrowed an already-membership-scoped queryset,
    so skipping it for a ``legacy:full`` token cannot widen anything — but that is an
    argument, and this is the check.
    """
    stranger_project = Project.objects.create(
        name="Not mine", start_date=date(2026, 4, 1), calendar=calendar
    )
    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    client = _bearer(raw)

    listed = client.get("/api/v1/projects/")
    assert listed.status_code == 200
    ids = {row["id"] for row in listed.data["results"]}
    assert str(project.pk) in ids
    assert str(stranger_project.pk) not in ids
    assert client.get(f"/api/v1/projects/{stranger_project.pk}/").status_code == 404


# ---------------------------------------------------------------------------
# The two MCP consent controls — agent-scoped, not token-scoped
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=False)
def test_instance_kill_switch_does_not_blank_a_full_access_pat(
    project: Project, owner: Any
) -> None:
    """``administration/mcp-server.md``: "People are never affected."

    Verified false before #2877: with the switch off, a ``legacy:full`` PAT's task list
    returned 403 while its calendar list returned 200 — the same credential, refused on
    one half of the API by a control documented as governing agents only.
    """
    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    resp = _bearer(raw).get(f"/api/v1/tasks/?project={project.pk}")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=False)
def test_instance_kill_switch_still_stops_an_agent_token(project: Project, owner: Any) -> None:
    """The operator's lever must keep working for what it is aimed at."""
    raw = _mint_personal(owner, [SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/tasks/?project={project.pk}")
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_project_opt_out_does_not_silently_empty_a_full_access_pats_list(
    project: Project, owner: Any
) -> None:
    """The silent variant, which is the dangerous one.

    A row-filtered collection returns ``200`` with ``count: 0``. A nightly export cannot
    tell that from "no tasks this week", so the failure surfaces as an empty report
    rather than an error — the worst possible shape for a data-integrity bug.
    """
    Task.objects.create(project=project, name="Real work", duration=1)
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])

    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    client = _bearer(raw)

    listed = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert listed.status_code == 200, listed.data
    assert listed.data["count"] == 1, listed.data
    assert client.get(f"/api/v1/projects/{project.pk}/").status_code == 200


@pytest.mark.django_db
def test_project_opt_out_still_withholds_from_an_agent_token(project: Project, owner: Any) -> None:
    """The team's consent lever must keep working for what it is aimed at."""
    Task.objects.create(project=project, name="Real work", duration=1)
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])

    raw = _mint_personal(owner, [SCOPE_MCP_READ])
    client = _bearer(raw)

    listed = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert listed.status_code == 200, listed.data
    assert listed.data["count"] == 0, listed.data
    assert client.get(f"/api/v1/projects/{project.pk}/").status_code == 404


# ---------------------------------------------------------------------------
# The predicate itself, and the guards' agreement on it
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("scopes", "expected"),
    [
        ([SCOPE_MCP_READ], True),
        ([SCOPE_LEGACY_FULL], False),
        # Fail-closed: an empty or unrecognized scope set is an agent, so a future
        # narrower scope stays confined to the read-only surface until someone decides
        # otherwise on purpose.
        ([], True),
        ([SCOPE_LEGACY_FULL, SCOPE_MCP_READ], False),
    ],
)
def test_is_agent_token_predicate(owner: Any, scopes: list[str], expected: bool) -> None:
    token = ApiToken.objects.create(
        owner=owner,
        name="predicate",
        token_prefix="abcdefgh",
        token_hash=sha256_hex(f"raw-{scopes}"),
        created_by=owner,
        scopes=scopes,
    )
    assert is_agent_token(token) is expected


@pytest.mark.django_db
def test_a_refused_scoped_token_probe_is_blocked_and_audited(project: Project, owner: Any) -> None:
    """The #1712 confused-deputy probe is refused **and** leaves a row.

    This test used to be named ``…_but_not_audited`` and asserted the absence of the
    row, pinning honestly that no *permission-layer* refusal on this surface was ever
    audited: DRF's ``exception_handler`` calls ``set_rollback()``, so the write issued
    in ``finalize_response`` was discarded before it could commit. It carried an
    instruction to flip if that changed. #3017 changed it (ADR-0902) — the refusal is
    queued and written after the request transaction closes — so the assertion now
    checks the row instead of its absence.

    The probe here is a one-project integration token walked against a collection tool
    to read its minter's whole membership. That is precisely the event most worth
    keeping, and it is why ``_record_mcp_agent_action``'s scope predicate deliberately
    does **not** filter refusals the way it filters allowed reads.
    """
    from trueppm_api.apps.agents.models import AgentAction, AgentActionVerdict

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        project=project,
        name="scoped-ci",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
    )  # default scopes = [legacy:full], as every project token gets

    resp = _bearer(raw).get("/api/v1/projects/")
    assert resp.status_code == 401, resp.data
    assert resp.data["refusal"]["reason"] == "identity", resp.data
    row = AgentAction.objects.get()
    assert row.verdict == AgentActionVerdict.REFUSED
    assert row.refusal_reason == "identity"


@pytest.mark.django_db
def test_unsupported_format_suffix_does_not_crash_finalize_response(
    project: Project, owner: Any
) -> None:
    """A pre-authentication exception must not 500 in ``_record_mcp_agent_action`` (#2989).

    An unsupported URL format suffix (``/projects/{id}.xyz/``) fails DRF's content
    negotiation inside ``initial()`` — *before* ``perform_authentication()`` ever runs.
    DRF's ``exception_handler`` still calls ``set_rollback()`` for that ``NotAcceptable``
    (ATOMIC_REQUESTS), and ``finalize_response`` still runs afterward (it sits outside
    ``dispatch()``'s try/except). Reading ``request.successful_authenticator`` there
    lazily runs authentication for the first time against an already-poisoned
    transaction, and previously raised ``TransactionManagementError`` instead of letting
    the 406 response through — reproduced by nightly ``api:fuzz`` on
    ``/projects/{id}/``, ``/programs/{id}/``, and ``/tasks/{id}/`` alike.
    """
    raw = _mint_personal(owner, [SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}.xyz/")
    assert resp.status_code != 500, resp.content


@pytest.mark.django_db
def test_a_full_access_pats_successful_read_is_not_audited_as_agent_activity(
    project: Project, owner: Any
) -> None:
    """The other half of the asymmetry: a person's own credential is not an agent.

    A row here would claim ``actor_kind=MCP_TOKEN`` and ``capability_used=mcp:read``
    about a CI script, and would half-close #2749 on eight viewsets while ~260 other
    token-writable routes stay unrecorded. A partial ledger reads as a complete one.
    """
    from trueppm_api.apps.agents.models import AgentAction

    raw = _mint_personal(owner, [SCOPE_LEGACY_FULL])
    assert _bearer(raw).get(f"/api/v1/tasks/?project={project.pk}").status_code == 200
    assert not AgentAction.objects.exists()


@pytest.mark.django_db
def test_an_agent_tokens_read_is_audited(project: Project, owner: Any) -> None:
    """Guard the guard — the exclusion above must not have silenced the real agent path."""
    from trueppm_api.apps.agents.models import AgentAction

    raw = _mint_personal(owner, [SCOPE_MCP_READ])
    assert _bearer(raw).get(f"/api/v1/tasks/?project={project.pk}").status_code == 200
    assert AgentAction.objects.latest("sequence").verdict == "allowed"


def test_is_agent_token_is_false_for_non_tokens() -> None:
    """Human JWT/Session auth is ``None``; nothing else may be mistaken for a token."""
    assert is_agent_token(None) is False
    assert is_agent_token("tppm_deadbeef") is False
    assert is_agent_token(object()) is False


def test_every_agent_control_routes_through_the_one_predicate() -> None:
    """The claim ``is_agent_token``'s docstring makes, checked rather than asserted.

    The bug was five controls independently answering "is this a token?" and all five
    being wrong the same way. Centralizing the predicate only helps if the controls
    actually use it — and the two that deliberately do **not** (``TokenIsOwnerScoped``
    asks about the credential's *identity*; ``TokenHasScope`` is a scope check by
    construction) are pinned as exceptions here, so relaxing either is a visible edit
    rather than a quiet drift.
    """
    import inspect

    from trueppm_api.apps.access import permissions as perms
    from trueppm_api.apps.access import throttles as access_throttles
    from trueppm_api.apps.projects import mcp_settings

    must_use = [
        perms.McpInstanceEnabled.has_permission,
        perms.McpProjectEnabled.has_permission,
        perms.TokenReadOnlyMethods.has_permission,
        perms.McpReadableViewMixin._record_mcp_agent_action,
        mcp_settings.mcp_visible_project_ids,
        mcp_settings.mcp_excluded_project_ids,
        access_throttles._McpTokenThrottle.get_cache_key,
    ]
    for func in must_use:
        assert "is_agent_token" in inspect.getsource(func), (
            f"{func.__qualname__} does not consult is_agent_token — an MCP control that "
            "asks 'is this an ApiToken?' instead applies to the owner's own CI script "
            "(#2877)."
        )

    must_not_use = [
        perms.TokenIsOwnerScoped.has_permission,
        perms.IsNotTokenAuthenticated.has_permission,
    ]
    for func in must_not_use:
        assert "is_agent_token" not in inspect.getsource(func), (
            f"{func.__qualname__} must stay scope-blind: it asks what the credential IS, "
            "not what it may do. Project/program tokens carry legacy:full by default, so "
            "a scope-aware version fails open (#1712)."
        )
