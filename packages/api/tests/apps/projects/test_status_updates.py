"""Tests for project status updates (#4803).

Covers the role matrix (post: Project Manager and above, never an agent; read:
project members), immutability at every layer (no PATCH/PUT/DELETE route, model
``save``/``delete`` and queryset bulk writes refused), the snapshot frozen at
``posted_at``, the live diff, sequential ``seq``, atomic post, and the share-token
read: snapshot-only, bound to one update, every unavailable outcome the same 404,
no cross-kind resolution, and server-side projection of risks and decisions.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import share_services, status_update_services
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    RiskStatus,
    ShareContentKind,
    StatusUpdate,
    StatusUpdateImmutableError,
    Task,
)

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="Riverside",
        code="RIV",
        start_date=date(2026, 1, 5),
        calendar=Calendar.objects.create(name="Standard"),
        public_sharing=True,
    )


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def pm(project: Project) -> Any:
    return _member(project, "pm", Role.ADMIN)


@pytest.fixture
def pm_client(pm: Any) -> APIClient:
    return _client(pm)


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/status-updates/"


def _post(client: APIClient, project: Project, **body: Any) -> Any:
    payload = {"rag": "amber", "narrative": "Vendor slipped the API drop."}
    payload.update(body)
    return client.post(_url(project), payload, format="json")


def _milestone(project: Project, name: str, finish: date) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=0,
        is_milestone=True,
        early_start=finish,
        early_finish=finish,
    )


# ── role matrix ──────────────────────────────────────────────────────────────


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (Role.VIEWER, 403),
        (Role.MEMBER, 403),
        (Role.SCHEDULER, 403),
        (Role.ADMIN, 201),
        (Role.OWNER, 201),
    ],
)
def test_post_requires_project_manager(project: Project, role: int, expected: int) -> None:
    client = _client(_member(project, f"u{role}", role))
    assert _post(client, project).status_code == expected


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN])
def test_every_member_reads_history(project: Project, pm_client: APIClient, role: int) -> None:
    created = _post(pm_client, project).json()
    client = _client(_member(project, f"r{role}", role))
    listed = client.get(_url(project))
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()["results"]] == [created["id"]]
    assert client.get(f"{_url(project)}{created['id']}/").status_code == 200


@pytest.mark.django_db
def test_non_member_and_anonymous_are_refused(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project).json()
    stranger = _client(User.objects.create_user(username="stranger", password="pw"))
    assert stranger.get(_url(project)).status_code in (403, 404)
    assert stranger.get(f"{_url(project)}{created['id']}/").status_code in (403, 404)
    assert _post(stranger, project).status_code in (403, 404)
    anon = APIClient()
    assert anon.get(_url(project)).status_code == 401
    assert _post(anon, project).status_code == 401


def _token(owner: Any, scopes: list[str]) -> APIClient:
    """An APIClient carrying a fresh personal API token of ``owner`` with ``scopes``."""
    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import ApiToken

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=scopes,
        expires_at=timezone.now() + timedelta(days=30),
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


@pytest.mark.django_db
def test_agent_reads_the_history_and_cannot_post(
    project: Project, pm: Any, pm_client: APIClient, settings: Any
) -> None:
    """An ``mcp:read`` token reads list and detail as the PM it acts for; never posts."""
    from trueppm_api.apps.projects.models import SCOPE_MCP_READ

    settings.TRUEPPM_MCP_ENABLED = True
    created = _post(pm_client, project).json()
    agent = _token(pm, [SCOPE_MCP_READ])

    listed = agent.get(_url(project))
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()["results"]] == [created["id"]]
    detail = agent.get(f"{_url(project)}{created['id']}/")
    assert detail.status_code == 200
    assert detail.json()["snapshot"] == created["snapshot"]

    assert _post(agent, project).status_code == 403
    assert StatusUpdate.objects.filter(project=project).count() == 1


@pytest.mark.django_db
def test_agent_read_respects_the_project_opt_out(
    project: Project, pm: Any, pm_client: APIClient, settings: Any
) -> None:
    from trueppm_api.apps.projects.models import SCOPE_MCP_READ

    settings.TRUEPPM_MCP_ENABLED = True
    created = _post(pm_client, project).json()
    Project.objects.filter(pk=project.pk).update(mcp_enabled=False)
    agent = _token(pm, [SCOPE_MCP_READ])
    assert agent.get(_url(project)).status_code == 403
    assert agent.get(f"{_url(project)}{created['id']}/").status_code == 403


@pytest.mark.django_db
def test_full_access_token_cannot_post_even_for_the_pm(project: Project, pm: Any) -> None:
    """A full-scope personal token authenticates and passes the PM gate, then is refused.

    This is the case ``IsNotTokenAuthenticated`` alone decides: the token is the PM's
    own, holds every scope, and the method guards pass a full-scope token. Removing
    the refusal makes this a 201.
    """
    from trueppm_api.apps.projects.models import SCOPE_API_FULL

    client = _token(pm, [SCOPE_API_FULL])
    assert client.get(_url(project)).status_code == 200  # authenticated, a PM
    resp = _post(client, project)
    assert resp.status_code == 403
    assert "status update" in resp.json()["detail"]
    assert not StatusUpdate.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_archived_project_refuses_a_post(project: Project, pm_client: APIClient) -> None:
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    assert _post(pm_client, project).status_code == 403


@pytest.mark.django_db
def test_narrative_is_capped_and_rag_validated(project: Project, pm_client: APIClient) -> None:
    assert _post(pm_client, project, narrative="x" * 601).status_code == 400
    assert _post(pm_client, project, rag="purple").status_code == 400
    assert _post(pm_client, project, narrative="x" * 600).status_code == 201


# ── immutability ─────────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_no_update_or_delete_route(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project).json()
    detail = f"{_url(project)}{created['id']}/"
    assert pm_client.patch(detail, {"rag": "green"}, format="json").status_code == 405
    assert pm_client.put(detail, {"rag": "green"}, format="json").status_code == 405
    assert pm_client.delete(detail).status_code == 405
    assert pm_client.delete(_url(project)).status_code == 405
    assert StatusUpdate.objects.get(pk=created["id"]).rag == "amber"


@pytest.mark.django_db
def test_model_and_queryset_refuse_writes(project: Project, pm: Any) -> None:
    update = status_update_services.post_status_update(project, pm, rag="red", narrative="")
    update.rag = "green"
    with pytest.raises(StatusUpdateImmutableError):
        update.save()
    with pytest.raises(StatusUpdateImmutableError):
        update.delete()
    with pytest.raises(StatusUpdateImmutableError):
        StatusUpdate.objects.filter(pk=update.pk).update(rag="green")
    with pytest.raises(StatusUpdateImmutableError):
        StatusUpdate.objects.filter(pk=update.pk).delete()


@pytest.mark.django_db
def test_project_hard_delete_still_cascades(project: Project, pm: Any) -> None:
    status_update_services.post_status_update(project, pm, rag="red", narrative="")
    ProjectMembership.objects.filter(project=project).delete()
    project.delete()
    assert StatusUpdate.objects.count() == 0


# ── seq, atomicity, snapshot ─────────────────────────────────────────────────


@pytest.mark.django_db
def test_posts_take_sequential_numbers(project: Project, pm_client: APIClient) -> None:
    seqs = [_post(pm_client, project).json()["seq"] for _ in range(3)]
    assert seqs == [1, 2, 3]
    assert _post(pm_client, project).json()["snapshot"]["previous_seq"] == 3


@pytest.mark.django_db
def test_failed_snapshot_leaves_nothing_behind(project: Project, pm: Any) -> None:
    with (
        patch.object(status_update_services, "build_snapshot", side_effect=RuntimeError("boom")),
        pytest.raises(RuntimeError),
    ):
        status_update_services.post_status_update(project, pm, rag="red", narrative="")
    assert not StatusUpdate.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_snapshot_carries_provenance_and_reasons(project: Project, pm_client: APIClient) -> None:
    _milestone(project, "Gate A", date(2026, 3, 2))
    body = _post(pm_client, project).json()
    snap = body["snapshot"]
    assert snap["schema_version"] == 1
    for key in ("p50", "p80", "cpm_finish", "baseline_finish_variance_days"):
        assert set(snap["forecast"][key]) >= {"value", "as_of", "definition"}
    # No Monte Carlo run and no baseline: null with a machine-readable reason.
    assert snap["forecast"]["p80"]["value"] is None
    assert snap["forecast"]["p80"]["reason"] == "no_forecast"
    assert snap["forecast"]["baseline_finish_variance_days"]["reason"] == "no_baseline"
    assert snap["forecast"]["cpm_finish"]["value"] == "2026-03-02"
    assert snap["counts"]["completed_since_previous"]["reason"] == "no_previous_update"
    assert [m["name"] for m in snap["milestones"]] == ["Gate A"]
    assert body["computed_health"] in ("on_track", "at_risk", "critical")
    assert body["snapshot_verified"] is True
    stored = StatusUpdate.objects.get(pk=body["id"])
    assert body["snapshot_sha256"] == status_update_services.record_sha256(
        project_id=project.pk,
        seq=stored.seq,
        rag=stored.rag,
        narrative=stored.narrative,
        posted_at=stored.posted_at,
        computed_health=stored.computed_health,
        snapshot=snap,
    )


@pytest.mark.django_db
def test_top_three_risks_by_probability_times_impact(
    project: Project, pm_client: APIClient
) -> None:
    for title, p, i in [("low", 1, 1), ("high", 5, 5), ("mid", 3, 3), ("mid2", 4, 2), ("x", 2, 2)]:
        Risk.objects.create(project=project, title=title, probability=p, impact=i)
    Risk.objects.create(
        project=project, title="closed", probability=5, impact=5, status=RiskStatus.CLOSED
    )
    snap = _post(pm_client, project).json()["snapshot"]
    assert [r["title"] for r in snap["risks"]] == ["high", "mid", "mid2"]


@pytest.mark.django_db
def test_snapshot_is_frozen_and_live_diff_reports_the_move(
    project: Project, pm_client: APIClient
) -> None:
    gate = _milestone(project, "Gate A", date(2026, 3, 2))
    created = _post(pm_client, project).json()
    Task.objects.filter(pk=gate.pk).update(
        early_start=date(2026, 3, 9), early_finish=date(2026, 3, 9)
    )

    body = pm_client.get(f"{_url(project)}{created['id']}/").json()
    assert body["snapshot"] == created["snapshot"]
    assert body["snapshot"]["forecast"]["cpm_finish"]["value"] == "2026-03-02"
    assert body["live_diff"]["forecast.cpm_finish"]["value"] == "2026-03-09"
    assert body["live_diff"][f"milestones.{gate.pk}.cpm_finish"] == {"value": "2026-03-09"}
    # Keys that did not move are absent, not echoed.
    assert "forecast.p80" not in body["live_diff"]

    second = _post(pm_client, project).json()
    assert second["snapshot"]["counts"]["slipped_since_previous"]["value"] == 1


@pytest.mark.django_db
def test_live_diff_is_empty_when_nothing_moved(project: Project, pm_client: APIClient) -> None:
    _milestone(project, "Gate A", date(2026, 3, 2))
    created = _post(pm_client, project).json()
    assert created["live_diff"] == {}
    assert pm_client.get(f"{_url(project)}{created['id']}/").json()["live_diff"] == {}


@pytest.mark.django_db
def test_tampered_snapshot_is_reported(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project).json()
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE projects_statusupdate SET snapshot = '{}'::jsonb WHERE id = %s",
            [created["id"]],
        )
    body = pm_client.get(f"{_url(project)}{created['id']}/").json()
    assert body["snapshot_verified"] is False


@pytest.mark.django_db
@pytest.mark.parametrize(
    "change",
    [
        {"narrative": "Rewritten after the fact."},
        {"rag": "green"},
        {"computed_health": "critical"},
        {"seq": 99},
    ],
)
def test_a_served_field_changed_alone_is_reported_and_not_shared(
    project: Project, pm: Any, pm_client: APIClient, change: dict[str, Any]
) -> None:
    """The digest covers every served field, not the snapshot alone.

    ``_base_manager`` is a plain manager, so this write gets past the queryset's
    immutability guard: it stands in for a row rewritten outside the application.
    """
    update = status_update_services.post_status_update(
        project, pm, rag="red", narrative="Original."
    )
    _link, raw = share_services.mint_share_link(
        project, pm, content_kind=ShareContentKind.STATUS_UPDATE, status_update=update
    )
    assert _share(raw).status_code == 200
    cache.clear()
    StatusUpdate._base_manager.filter(pk=update.pk).update(**change)

    body = pm_client.get(f"{_url(project)}{update.pk}/").json()
    assert body["snapshot_verified"] is False
    assert _share(raw).status_code == 404


# ── share token ──────────────────────────────────────────────────────────────


def _mint(client: APIClient, project: Project, update_id: Any, **extra: Any) -> Any:
    body = {"content_kind": "status_update", "status_update": str(update_id)}
    body.update(extra)
    return client.post(f"/api/v1/projects/{project.pk}/share-links/", body, format="json")


def _share(token: str) -> Any:
    return APIClient().get(f"/api/v1/share/status-update/{token}/")


@pytest.mark.django_db
def test_share_serves_the_frozen_snapshot_only(project: Project, pm_client: APIClient) -> None:
    gate = _milestone(project, "Gate A", date(2026, 3, 2))
    Risk.objects.create(project=project, title="Vendor", probability=5, impact=5)
    created = _post(pm_client, project).json()
    minted = _mint(pm_client, project, created["id"])
    assert minted.status_code == 201
    assert minted.json()["share_path"].startswith("/share/status-update/")
    token = minted.json()["token"]

    # The plan moves and a newer update is posted; the link stays on update 1.
    Task.objects.filter(pk=gate.pk).update(early_finish=date(2026, 4, 1))
    _post(pm_client, project, rag="red")

    resp = _share(token)
    assert resp.status_code == 200
    body = resp.json()
    assert body["seq"] == 1
    assert body["rag"] == "amber"
    assert body["forecast"]["cpm_finish"]["value"] == "2026-03-02"
    assert body["milestones"] == [
        {
            "name": "Gate A",
            "cpm_finish": "2026-03-02",
            "baseline_finish": None,
            "variance_days": None,
        }
    ]
    # No live diff, no ids, no people, risks and decisions withheld by default.
    flat = str(body)
    assert "live_diff" not in body
    assert str(gate.pk) not in flat
    assert created["id"] not in flat
    assert body["author"] is None
    assert body["risks"] is None
    assert body["decisions"] is None
    assert resp["Referrer-Policy"] == "no-referrer"
    assert "noindex" in resp["X-Robots-Tag"]
    assert resp["Cache-Control"].startswith("private")


@pytest.mark.django_db
def test_share_reveals_are_opt_in_and_enforced(project: Project, pm_client: APIClient) -> None:
    owner = User.objects.create_user(username="ro", first_name="Rita", last_name="Owner")
    Risk.objects.create(project=project, title="Vendor", probability=5, impact=5, owner=owner)
    _milestone(project, "Gate A", date(2026, 3, 2))
    created = _post(pm_client, project).json()

    t1 = _mint(pm_client, project, created["id"], show_risks=True).json()["token"]
    risks = _share(t1).json()["risks"]
    assert risks == [
        {"title": "Vendor", "probability": 5, "impact": 5, "severity": 25, "owner": None}
    ]

    t2 = _mint(pm_client, project, created["id"], show_risks=True, show_assignees=True).json()[
        "token"
    ]
    assert _share(t2).json()["risks"][0]["owner"] == "Rita Owner"
    assert _share(t2).json()["author"] is not None

    t3 = _mint(pm_client, project, created["id"], show_milestone_dates=False).json()["token"]
    assert _share(t3).json()["milestones"] is None


def _comparable(resp: Any) -> tuple[int, Any, dict[str, str]]:
    # X-Request-ID is a per-request correlation id, unique on every response.
    headers = {k: v for k, v in resp.headers.items() if k != "X-Request-ID"}
    return resp.status_code, resp.json(), headers


@pytest.mark.django_db
def test_unavailable_outcomes_are_one_identical_404(
    project: Project, pm: Any, settings: Any
) -> None:
    """Every unavailable outcome is byte-identical to an unknown token: status, body, headers."""
    update = status_update_services.post_status_update(project, pm, rag="red", narrative="")

    def mint(on: Project = project, by: Any = pm) -> tuple[Any, str]:
        return share_services.mint_share_link(
            on, by, content_kind=ShareContentKind.STATUS_UPDATE, status_update=update
        )

    revoked, revoked_raw = mint()
    share_services.revoke_share_link(revoked, pm)
    expired, expired_raw = mint()
    type(expired).objects.filter(pk=expired.pk).update(
        expires_at=timezone.now() - timedelta(minutes=1)
    )
    _board, board_raw = share_services.mint_share_link(project, pm)
    _sched, sched_raw = share_services.mint_share_link(
        project, pm, content_kind=ShareContentKind.SCHEDULE
    )
    # A second PM's link, then the account is deactivated.
    pm2 = _member(project, "pm2", Role.ADMIN)
    _l2, deactivated_raw = mint(by=pm2)
    User.objects.filter(pk=pm2.pk).update(is_active=False)
    _live, live_raw = mint()

    unknown = _share(secrets.token_urlsafe(32))
    assert unknown.status_code == 404
    expected = _comparable(unknown)
    assert expected[2]["Cache-Control"].startswith("private")
    assert expected[2]["Referrer-Policy"] == "no-referrer"
    assert "noindex" in expected[2]["X-Robots-Tag"]
    for raw in (revoked_raw, expired_raw, board_raw, sched_raw, deactivated_raw):
        assert _comparable(_share(raw)) == expected, raw

    # Sharing policy turned off for the project after the mint.
    Project.objects.filter(pk=project.pk).update(public_sharing=False)
    cache.clear()
    assert _comparable(_share(live_raw)) == expected
    Project.objects.filter(pk=project.pk).update(public_sharing=True)

    # Project moved to Trash.
    Project.objects.filter(pk=project.pk).update(is_deleted=True)
    cache.clear()
    assert _comparable(_share(live_raw)) == expected
    Project.objects.filter(pk=project.pk).update(is_deleted=False)

    # Instance kill switch.
    settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = False
    cache.clear()
    assert _comparable(_share(live_raw)) == expected
    settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = True

    # And the same link serves again once every condition is cleared.
    cache.clear()
    assert _share(live_raw).status_code == 200


@pytest.mark.django_db
def test_status_token_does_not_resolve_board_or_schedule(project: Project, pm: Any) -> None:
    update = status_update_services.post_status_update(project, pm, rag="red", narrative="")
    _link, raw = share_services.mint_share_link(
        project, pm, content_kind=ShareContentKind.STATUS_UPDATE, status_update=update
    )
    client = APIClient()
    assert client.get(f"/api/v1/share/board/{raw}/").status_code == 404
    assert client.get(f"/api/v1/share/schedule/{raw}/").status_code == 404
    assert _share(raw).status_code == 200


@pytest.mark.django_db
def test_share_of_a_tampered_snapshot_is_refused(project: Project, pm: Any) -> None:
    update = status_update_services.post_status_update(project, pm, rag="red", narrative="")
    _link, raw = share_services.mint_share_link(
        project, pm, content_kind=ShareContentKind.STATUS_UPDATE, status_update=update
    )
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE projects_statusupdate SET narrative = 'x', snapshot = '{}'::jsonb "
            "WHERE id = %s",
            [str(update.pk)],
        )
    assert _share(raw).status_code == 404


@pytest.mark.django_db
def test_mint_requires_an_update_of_this_project(project: Project, pm_client: APIClient) -> None:
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 5), public_sharing=True)
    other_pm = _member(other, "other-pm", Role.ADMIN)
    foreign = status_update_services.post_status_update(other, other_pm, rag="red", narrative="")
    assert _mint(pm_client, project, foreign.pk).status_code == 400
    missing = pm_client.post(
        f"/api/v1/projects/{project.pk}/share-links/",
        {"content_kind": "status_update"},
        format="json",
    )
    assert missing.status_code == 400


@pytest.mark.django_db
def test_mint_is_pm_only(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project).json()
    scheduler = _client(_member(project, "sched", Role.SCHEDULER))
    assert _mint(scheduler, project, created["id"]).status_code == 403


@pytest.mark.django_db
def test_board_link_never_carries_the_status_binding(
    project: Project, pm_client: APIClient
) -> None:
    created = _post(pm_client, project).json()
    resp = pm_client.post(
        f"/api/v1/projects/{project.pk}/share-links/",
        {"content_kind": "board", "status_update": created["id"], "show_risks": True},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["status_update"] is None
    assert resp.json()["show_risks"] is False


# ── throttles and concurrency ────────────────────────────────────────────────


@pytest.mark.django_db
def test_post_rate_limit_is_per_project_across_posters(project: Project, pm: Any) -> None:
    """Two PMs share one project bucket; another project's bucket is untouched."""
    from trueppm_api.apps.projects.status_update_views import StatusUpdateProjectPostThrottle

    other = Project.objects.create(name="Other", start_date=date(2026, 1, 5))
    pm2 = _member(project, "pm2", Role.ADMIN)
    ProjectMembership.objects.create(project=other, user=pm2, role=Role.ADMIN)
    first, second = _client(pm), _client(pm2)
    with patch.object(StatusUpdateProjectPostThrottle, "rate", "2/min", create=True):
        assert _post(first, project).status_code == 201
        assert _post(second, project).status_code == 201
        assert _post(second, project).status_code == 429
        assert _post(first, project).status_code == 429
        assert _post(second, other).status_code == 201
    assert StatusUpdate.objects.filter(project=project).count() == 2


@pytest.mark.django_db(transaction=True)
def test_concurrent_posts_take_distinct_sequential_numbers(project: Project, pm: Any) -> None:
    """Four posts racing on separate connections serialize on the project lock."""
    import threading

    from django.db import connections

    barrier = threading.Barrier(4)
    errors: list[BaseException] = []

    def post() -> None:
        try:
            barrier.wait(timeout=10)
            status_update_services.post_status_update(project, pm, rag="amber", narrative="")
        except BaseException as exc:  # surfaced by the assertion below
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=post) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    seqs = sorted(StatusUpdate.objects.filter(project=project).values_list("seq", flat=True))
    assert seqs == [1, 2, 3, 4]
