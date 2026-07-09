"""Tests for the create_demo_share_link management command (issue #1487)."""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.projects.authentication import sha256_hex
from trueppm_api.apps.projects.management.commands.create_demo_share_link import (
    DEMO_LABEL,
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
