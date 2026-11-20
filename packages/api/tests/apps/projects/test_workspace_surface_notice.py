"""A workspace methodology/policy write tells every project whose preset moved (#3292).

The workspace default wins for every project under INHERIT, resolved on read, so no
project row changes. The notice must ride the #3009 outbox, never the request.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects import config_notice, tasks
from trueppm_api.apps.projects.models import (
    Calendar,
    ConfigNoticeRequest,
    Methodology,
    Program,
    Project,
)
from trueppm_api.apps.workspace.models import (
    TermOverridePolicy,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)

from .test_config_notice_outbox import client_for, inbox, with_work

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def admin(db: object) -> Any:
    user = User.objects.create_user(username="wsadmin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.ADMIN
    )
    return user


def make(calendar: Calendar, name: str, methodology: str, **kw: Any) -> Project:
    return Project.objects.create(
        name=name, start_date=date(2026, 1, 1), calendar=calendar, methodology=methodology, **kw
    )


def patch_workspace(admin: Any, capture: Any, body: dict[str, Any]) -> None:
    with (
        patch.object(
            tasks.emit_config_notice, "delay", return_value=SimpleNamespace(id="celery-ws")
        ),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        capture(execute=True),
    ):
        resp = client_for(admin).patch("/api/v1/workspace/", data=body, format="json")
    assert resp.status_code == 200, resp.content


def run_all() -> None:
    for row in ConfigNoticeRequest.objects.all():
        config_notice.run_config_notice_request(str(row.pk))


@pytest.mark.django_db
def test_policy_flip_to_inherit_notifies_only_projects_whose_effective_preset_moved(
    calendar: Calendar, admin: Any, django_capture_on_commit_callbacks: Any
) -> None:
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.SUGGEST
    ws.save()
    moved = make(calendar, "Moves", Methodology.AGILE)
    stays = make(calendar, "Stays", Methodology.WATERFALL)
    a = with_work(moved, "alice")
    b = with_work(stays, "bob")

    patch_workspace(
        admin,
        django_capture_on_commit_callbacks,
        {"methodology_override_policy": TermOverridePolicy.INHERIT},
    )

    row = ConfigNoticeRequest.objects.get()
    assert row.kind == config_notice.KIND_SURFACE
    assert [c["project_id"] for c in row.payload["changes"]] == [str(moved.pk)]
    assert row.payload["changes"][0]["before"]["methodology"] == Methodology.AGILE
    assert row.payload["changes"][0]["after"]["methodology"] == Methodology.WATERFALL
    run_all()
    assert len(inbox(a)) == 1
    assert inbox(b) == []


@pytest.mark.django_db
def test_workspace_methodology_change_while_locked_notifies(
    calendar: Calendar, admin: Any, django_capture_on_commit_callbacks: Any
) -> None:
    ws = Workspace.load()
    ws.methodology = Methodology.AGILE
    ws.methodology_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    p = make(calendar, "P", Methodology.HYBRID)
    person = with_work(p, "carol")

    patch_workspace(
        admin, django_capture_on_commit_callbacks, {"methodology": Methodology.WATERFALL}
    )

    run_all()
    assert len(inbox(person)) == 1


@pytest.mark.django_db
def test_workspace_methodology_change_under_suggest_is_silent(
    calendar: Calendar, admin: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """Under SUGGEST every project's own value wins, so nothing moved."""
    p = make(calendar, "P", Methodology.AGILE)
    with_work(p, "dave")

    patch_workspace(
        admin, django_capture_on_commit_callbacks, {"methodology": Methodology.WATERFALL}
    )

    assert not ConfigNoticeRequest.objects.exists()


@pytest.mark.django_db
def test_unrelated_workspace_patch_queues_nothing(
    calendar: Calendar, admin: Any, django_capture_on_commit_callbacks: Any
) -> None:
    make(calendar, "P", Methodology.AGILE)
    patch_workspace(admin, django_capture_on_commit_callbacks, {"name": "Renamed"})
    assert not ConfigNoticeRequest.objects.exists()


@pytest.mark.django_db
def test_dispatch_goes_through_the_outbox_not_the_request(
    calendar: Calendar, admin: Any, django_capture_on_commit_callbacks: Any
) -> None:
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    p = make(calendar, "P", Methodology.AGILE)
    person = with_work(p, "erin")

    with (
        patch.object(
            tasks.emit_config_notice, "delay", return_value=SimpleNamespace(id="celery-ws")
        ) as delay,
        patch.object(config_notice, "_emit_surface_notifications") as emit,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client_for(admin).patch(
            "/api/v1/workspace/",
            data={"methodology_override_policy": TermOverridePolicy.INHERIT},
            format="json",
        )

    assert resp.status_code == 200
    emit.assert_not_called()
    row = ConfigNoticeRequest.objects.get()
    delay.assert_called_once_with(str(row.pk))
    assert inbox(person) == []


@pytest.mark.django_db
def test_large_fanout_is_chunked_across_outbox_rows(
    calendar: Calendar, admin: Any, django_capture_on_commit_callbacks: Any, monkeypatch: Any
) -> None:
    monkeypatch.setattr(config_notice, "WORKSPACE_FANOUT_CHUNK", 2)
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    for i in range(5):
        make(calendar, f"P{i}", Methodology.AGILE)

    patch_workspace(
        admin,
        django_capture_on_commit_callbacks,
        {"methodology_override_policy": TermOverridePolicy.INHERIT},
    )

    sizes = sorted(len(r.payload["changes"]) for r in ConfigNoticeRequest.objects.all())
    assert sizes == [1, 2, 2]


@pytest.mark.django_db
def test_program_methodology_change_stays_silent(calendar: Calendar) -> None:
    """Program scope is silent by design: under SUGGEST the project's own value wins."""
    from trueppm_api.apps.projects.methodology import resolve_effective_methodology

    program = Program.objects.create(name="Prog", methodology=Methodology.AGILE)
    p = make(calendar, "P", Methodology.HYBRID, program=program)
    before = config_notice.capture_project_surface(p)
    program.methodology = Methodology.WATERFALL
    program.save()
    p.refresh_from_db()
    assert resolve_effective_methodology(p) == Methodology.HYBRID
    assert config_notice.collect_project_surface_change(p, before=before) is None


@pytest.mark.django_db
def test_workspace_write_enumeration_query_count_is_flat(
    calendar: Calendar, django_assert_max_num_queries: Any
) -> None:
    for i in range(30):
        make(calendar, f"Q{i}", Methodology.AGILE)
    ws = Workspace.load()
    with django_assert_max_num_queries(6):
        before = config_notice.capture_workspace_surfaces(ws)
    assert len(before) == 30
