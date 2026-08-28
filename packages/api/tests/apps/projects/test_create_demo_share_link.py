"""Tests for the create_demo_share_link management command (issues #1487, #2440)."""

from __future__ import annotations

from datetime import date
from io import StringIO
from typing import Any

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APIClient

from trueppm_api.apps.projects.authentication import sha256_hex
from trueppm_api.apps.projects.management.commands.create_demo_share_link import (
    DEFAULT_BASE_URL,
    DEMO_LABEL,
    DEMO_LABEL_BOARD,
)
from trueppm_api.apps.projects.models import Project, ShareContentKind, ShareLink
from trueppm_api.apps.projects.sharing_settings import resolve_effective_sharing
from trueppm_api.apps.workspace.models import Workspace


def _seed() -> Project:
    call_command("load_sample_project")
    return Project.objects.get(name="Platform Core", is_sample=True)


@pytest.mark.django_db
def test_missing_project_raises() -> None:
    with pytest.raises(CommandError, match="not found"):
        call_command("create_demo_share_link")


@pytest.mark.django_db
def test_publishes_the_sample_project_not_a_real_name_collision() -> None:
    """A real project may now share the demo name, so the lookup must be scoped (#2476).

    Before #2476 the seeder deleted any same-named real project, which made an
    unscoped ``.get()`` accidentally safe. Now that the real project survives,
    an unscoped lookup would raise MultipleObjectsReturned — or worse, publish a
    public share link for the operator's real schedule.
    """
    real = Project.objects.create(name="Platform Core", start_date=date(2026, 1, 1))
    sample = _seed()

    call_command("create_demo_share_link", token="fixed-demo-token")

    links = ShareLink.objects.filter(revoked_at__isnull=True)
    assert links.exists()
    assert {link.project_id for link in links} == {sample.pk}
    assert real.pk not in {link.project_id for link in links}


@pytest.mark.django_db
def test_pinned_token_is_idempotent_and_reprintable() -> None:
    project = _seed()
    out1 = StringIO()
    call_command("create_demo_share_link", token="fixed-demo-token", stdout=out1)
    out2 = StringIO()
    call_command("create_demo_share_link", token="fixed-demo-token", stdout=out2)

    # Exactly one link for the pinned token, matched by hash.
    links = ShareLink.objects.filter(token_hash=sha256_hex("fixed-demo-token"))
    assert links.count() == 1
    link = links.get()
    assert link.project_id == project.id
    assert link.content_kind == ShareContentKind.SCHEDULE
    assert link.label == DEMO_LABEL
    assert link.show_assignees is False
    assert link.created_by_id is None

    # The stable URL is reprinted on every run.
    assert "/share/schedule/fixed-demo-token" in out1.getvalue()
    assert "/share/schedule/fixed-demo-token" in out2.getvalue()


@pytest.mark.django_db
def test_base_url_override() -> None:
    _seed()
    out = StringIO()
    call_command(
        "create_demo_share_link",
        token="tok123",
        base_url="https://demo.example.org/",
        stdout=out,
    )
    assert "https://demo.example.org/share/schedule/tok123" in out.getvalue()


@pytest.mark.django_db
def test_default_base_url_is_the_local_stack_not_the_hosted_demo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With nothing configured the printed URL must point at the local stack (#2801).

    The share link is the demo's only entry point, so a fallback naming the
    hosted demo's domain hands a local evaluator a URL on a host they do not
    control — and once that domain is live it resolves to a different instance
    where their locally minted token does not exist. Every hosted path supplies
    the origin explicitly (the Helm chart fails its render without it), so the
    fallback exists solely for the zero-config local run.
    """
    monkeypatch.delenv("TRUEPPM_DEMO_BASE_URL", raising=False)
    _seed()
    out = StringIO()
    call_command("create_demo_share_link", token="tok-default", stdout=out)

    assert DEFAULT_BASE_URL == "http://localhost"
    assert "http://localhost/share/schedule/tok-default" in out.getvalue()
    assert "try.trueppm.com" not in out.getvalue()


@pytest.mark.django_db
def test_base_url_env_var_wins_over_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hosted deployment overrides the local default via the env var (#2801)."""
    monkeypatch.setenv("TRUEPPM_DEMO_BASE_URL", "https://demo.example.com/")
    _seed()
    out = StringIO()
    call_command("create_demo_share_link", token="tok-env", stdout=out)
    assert "https://demo.example.com/share/schedule/tok-env" in out.getvalue()


@pytest.mark.django_db
def test_generated_token_minted_once_then_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRUEPPM_DEMO_SHARE_TOKEN", raising=False)
    _seed()
    call_command("create_demo_share_link")
    assert (
        ShareLink.objects.filter(content_kind=ShareContentKind.SCHEDULE, label=DEMO_LABEL).count()
        == 1
    )

    # Re-running without a pinned token does not sprawl a second link.
    out = StringIO()
    call_command("create_demo_share_link", stdout=out)
    assert (
        ShareLink.objects.filter(content_kind=ShareContentKind.SCHEDULE, label=DEMO_LABEL).count()
        == 1
    )
    assert "cannot be recovered" in out.getvalue()


@pytest.mark.django_db
def test_never_creates_persona_logins() -> None:
    """Read-only posture: the demo link path must not create any loginable account."""
    from django.contrib.auth import get_user_model

    _seed()  # no --with-personas
    call_command("create_demo_share_link", token="tok")
    User = get_user_model()
    # load_sample_project without personas creates no persona usernames.
    assert not User.objects.filter(username__in=["maya", "raj", "tom"]).exists()


# ── Board share link (#2440) ────────────────────────────────────────────────────


def test_schedule_label_is_frozen() -> None:
    """The SCHEDULE label is a compatibility surface, not an implementation detail.

    Generated-mode idempotency filters on this exact string, and deployed instances
    already hold rows carrying it. Renaming it would orphan those rows and mint a
    duplicate on the next run — silently, since every other assertion in this file
    compares against the imported constant and would follow the rename.
    """
    assert DEMO_LABEL == "Public read-only demo (#1487)"


@pytest.mark.django_db
def test_token_bound_to_other_kind_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A token already bound to one kind cannot be reused for the other.

    Without the guard the lookup (which keys on token_hash alone) resolves the
    existing row, reports "Reused", exits 0 — and never mints the link the caller
    asked for.
    """
    monkeypatch.delenv("TRUEPPM_DEMO_SHARE_TOKEN_BOARD", raising=False)
    _seed()
    call_command("create_demo_share_link", token="shared-tok")
    assert ShareLink.objects.filter(content_kind=ShareContentKind.SCHEDULE).count() == 1

    with pytest.raises(CommandError, match="already bound to a schedule share link"):
        call_command("create_demo_share_link", token="other", token_board="shared-tok")

    assert not ShareLink.objects.filter(content_kind=ShareContentKind.BOARD).exists()


@pytest.mark.django_db
def test_board_token_mints_both_links(monkeypatch: pytest.MonkeyPatch) -> None:
    """A board token yields a second link alongside the schedule one."""
    monkeypatch.delenv("TRUEPPM_DEMO_SHARE_TOKEN_BOARD", raising=False)
    project = _seed()
    out = StringIO()
    call_command(
        "create_demo_share_link",
        token="sched-tok",
        token_board="board-tok",
        base_url="https://demo.example.org",
        stdout=out,
    )

    schedule = ShareLink.objects.get(token_hash=sha256_hex("sched-tok"))
    board = ShareLink.objects.get(token_hash=sha256_hex("board-tok"))
    assert schedule.content_kind == ShareContentKind.SCHEDULE
    assert board.content_kind == ShareContentKind.BOARD
    assert schedule.project_id == project.id
    assert board.project_id == project.id
    # Distinct labels — a shared label would make the generated-mode lookup collide.
    assert schedule.label == DEMO_LABEL
    assert board.label == DEMO_LABEL_BOARD
    # Read-only posture carries to the board link too.
    assert board.show_assignees is False
    assert board.created_by_id is None

    rendered = out.getvalue()
    assert "https://demo.example.org/share/schedule/sched-tok" in rendered
    assert "https://demo.example.org/share/board/board-tok" in rendered


@pytest.mark.django_db
def test_board_link_not_minted_without_board_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Back-compat: docker-compose.demo.yml supplies only the schedule token."""
    monkeypatch.delenv("TRUEPPM_DEMO_SHARE_TOKEN_BOARD", raising=False)
    _seed()
    out = StringIO()
    call_command("create_demo_share_link", token="sched-only", stdout=out)

    assert ShareLink.objects.filter(content_kind=ShareContentKind.SCHEDULE).count() == 1
    assert not ShareLink.objects.filter(content_kind=ShareContentKind.BOARD).exists()
    assert "/share/board/" not in out.getvalue()


@pytest.mark.django_db
def test_identical_tokens_rejected() -> None:
    """token_hash is globally unique, so one token cannot back both kinds."""
    _seed()
    with pytest.raises(CommandError, match="globally unique"):
        call_command("create_demo_share_link", token="same", token_board="same")

    # Nothing was minted — the guard fires before any write.
    assert not ShareLink.objects.exists()


@pytest.mark.django_db
def test_board_token_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Helm demo-seed hook supplies both tokens via the environment."""
    monkeypatch.setenv("TRUEPPM_DEMO_SHARE_TOKEN", "env-sched")
    monkeypatch.setenv("TRUEPPM_DEMO_SHARE_TOKEN_BOARD", "env-board")
    _seed()
    out = StringIO()
    call_command("create_demo_share_link", base_url="https://demo.example.org", stdout=out)

    assert ShareLink.objects.filter(token_hash=sha256_hex("env-sched")).exists()
    assert ShareLink.objects.filter(token_hash=sha256_hex("env-board")).exists()
    assert "https://demo.example.org/share/board/env-board" in out.getvalue()


@pytest.mark.django_db
def test_pinned_board_link_survives_reseed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The upgrade path: a destructive re-seed drops both links; pinning restores them.

    load_sample_project replaces the prior sample program and ShareLink.project is
    on_delete=CASCADE, so an unpinned link would change its public URL on every
    `helm upgrade`. This is the behaviour ADR-0658 D5 depends on.
    """
    monkeypatch.delenv("TRUEPPM_DEMO_SHARE_TOKEN_BOARD", raising=False)
    _seed()
    call_command("create_demo_share_link", token="pin-s", token_board="pin-b")
    assert ShareLink.objects.count() == 2

    # Re-seed exactly as the post-upgrade hook does.
    _seed()
    assert not ShareLink.objects.exists(), "cascade should have dropped both links"

    out = StringIO()
    call_command(
        "create_demo_share_link",
        token="pin-s",
        token_board="pin-b",
        base_url="https://demo.example.org",
        stdout=out,
    )
    assert ShareLink.objects.count() == 2
    rendered = out.getvalue()
    # Same URLs as before the upgrade — the whole point of pinning.
    assert "https://demo.example.org/share/schedule/pin-s" in rendered
    assert "https://demo.example.org/share/board/pin-b" in rendered


# --- #2781: the minted link must actually resolve ---------------------------
#
# Minting and serving are separate gates. Every test above this point asserts on
# the *mint* — that a ShareLink row exists with the right hash, label and kind —
# and all of them passed while the demo's own published URL answered 410 to every
# recipient, because Workspace.public_sharing defaults to False and nothing on the
# demo path turned it on. These tests assert the property the demo actually
# promises: seed → mint → GET returns 200, from default workspace state, with no
# fixture pre-setting the policy.


@pytest.mark.django_db
def test_minted_schedule_link_resolves_from_default_workspace_state() -> None:
    _seed()
    call_command("create_demo_share_link", token="probe-token")

    resp = APIClient().get("/api/v1/share/schedule/probe-token/")

    assert resp.status_code == 200, getattr(resp, "data", None)


@pytest.mark.django_db
def test_minted_board_link_resolves_from_default_workspace_state() -> None:
    """The board link rides the same ADR-0135 gate as the schedule one."""
    _seed()
    call_command("create_demo_share_link", token="probe-sched", token_board="probe-board")

    resp = APIClient().get("/api/v1/share/board/probe-board/")

    assert resp.status_code == 200, getattr(resp, "data", None)


@pytest.mark.django_db
def test_sharing_is_enabled_on_the_project_not_the_workspace() -> None:
    """The blast radius of the fix is one demo project, not the whole instance.

    A self-hoster who seeds the sample onto a real install must not find the
    workspace-wide "Public sharing" default flipped on underneath them — every
    other project on the instance still inherits ``False``.
    """
    project = _seed()
    other = Project.objects.create(name="Real work", start_date=date(2026, 1, 1))

    call_command("create_demo_share_link", token="probe-token")

    project.refresh_from_db()
    assert project.public_sharing is True
    assert Workspace.load().public_sharing is False
    assert resolve_effective_sharing(other, "public_sharing") is False


@pytest.mark.django_db
def test_enabling_sharing_is_idempotent_across_restarts() -> None:
    """A second run writes nothing — the demo container restarts, often.

    Each save advances ``server_version`` and writes a HistoricalRecords row, so
    an unconditional write would accrue one of each per restart forever.
    """
    project = _seed()
    call_command("create_demo_share_link", token="probe-token")
    project.refresh_from_db()
    version_after_first = project.server_version

    call_command("create_demo_share_link", token="probe-token")

    project.refresh_from_db()
    assert project.server_version == version_after_first


@pytest.mark.django_db
def test_reports_the_instance_kill_switch_instead_of_printing_a_dead_url(
    settings: Any,
) -> None:
    """The operator kill switch outranks every policy — say so, don't print a URL.

    This is the failure mode the whole issue is about, generalized: the command
    must not report a confident link it knows the instance will not serve.
    """
    settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = False
    _seed()
    out = StringIO()

    call_command("create_demo_share_link", token="probe-token", stdout=out)

    assert "TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED is false" in out.getvalue()
    assert APIClient().get("/api/v1/share/schedule/probe-token/").status_code == 404
