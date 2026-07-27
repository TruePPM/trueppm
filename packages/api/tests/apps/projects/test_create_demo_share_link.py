"""Tests for the create_demo_share_link management command (issues #1487, #2440)."""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.projects.authentication import sha256_hex
from trueppm_api.apps.projects.management.commands.create_demo_share_link import (
    DEMO_LABEL,
    DEMO_LABEL_BOARD,
)
from trueppm_api.apps.projects.models import Project, ShareContentKind, ShareLink


def _seed() -> Project:
    call_command("seed_demo_project")
    return Project.objects.get(name="Platform Migration")


@pytest.mark.django_db
def test_missing_project_raises() -> None:
    with pytest.raises(CommandError, match="not found"):
        call_command("create_demo_share_link")


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
    # seed_demo_project without personas creates no persona usernames.
    assert not User.objects.filter(username__in=["maya", "raj", "tom"]).exists()


# ── Board share link (#2440) ────────────────────────────────────────────────────


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

    seed_demo_project deletes the prior demo project and ShareLink.project is
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
