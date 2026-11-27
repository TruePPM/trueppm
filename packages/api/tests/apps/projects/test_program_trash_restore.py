"""Program Trash + restore (#2587).

Covers:
- DELETE /programs/:id/          — records deleted_at / deleted_by / detached_project_ids
- GET    /programs/trash/        — membership-scoped list, can_restore gate, no leak
- POST   /programs/:id/restore/  — Program-Admin-gated (on a trashed program), re-attaches
                                    only still-unparented projects, re-keys a keyless
                                    shell, 404 on a double-submit, broadcasts per project
- soft_delete_program_subtree    — the seed-replace path records its detached projects
"""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Calendar, Methodology, Program, Project

User = get_user_model()


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(
        username="powner", password="pw", first_name="Paula", last_name="Owner"
    )


@pytest.fixture
def viewer(db: object) -> Any:
    return User.objects.create_user(username="pviewer", password="pw")


@pytest.fixture
def stranger(db: object) -> Any:
    return User.objects.create_user(username="pstranger", password="pw")


@pytest.fixture
def program(owner: Any, viewer: Any) -> Program:
    p = create_program(
        name="Atlas Launch", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    ProgramMembership.objects.create(program=p, user=viewer, role=Role.VIEWER)
    return p


def _project(program: Program, owner: Any, name: str, code: str) -> Project:
    cal = Calendar.objects.create(name=f"cal-{code}")
    p = Project.objects.create(
        name=name, code=code, start_date=date(2026, 4, 1), calendar=cal, program=program
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _delete(owner: Any, program: Program) -> None:
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 204, resp.content


@pytest.mark.django_db
def test_delete_records_trash_bookkeeping(program: Program, owner: Any) -> None:
    a = _project(program, owner, "Alpha", "ALP")
    b = _project(program, owner, "Beta", "BET")
    _delete(owner, program)

    program.refresh_from_db()
    assert program.is_deleted is True
    assert program.deleted_at is not None
    assert program.deleted_by_id == owner.pk
    assert set(program.detached_project_ids or []) == {a.pk, b.pk}
    a.refresh_from_db()
    assert a.program_id is None


@pytest.mark.django_db
def test_trash_lists_for_members_and_gates_restore(
    program: Program, owner: Any, viewer: Any, stranger: Any
) -> None:
    _project(program, owner, "Alpha", "ALP")
    _delete(owner, program)

    rows = _client(owner).get("/api/v1/programs/trash/").json()
    assert [r["id"] for r in rows] == [str(program.pk)]
    row = rows[0]
    assert row["can_restore"] is True
    assert row["my_role"] == Role.OWNER
    assert row["deleted_by"] == str(owner.pk)
    assert row["deleted_by_name"] == "Paula Owner"
    assert row["detached_project_count"] == 1

    viewer_rows = _client(viewer).get("/api/v1/programs/trash/").json()
    assert viewer_rows[0]["can_restore"] is False

    # A non-member never sees another team's Trash.
    assert _client(stranger).get("/api/v1/programs/trash/").json() == []


@pytest.mark.django_db
def test_trash_omits_live_programs(program: Program, owner: Any) -> None:
    assert _client(owner).get("/api/v1/programs/trash/").json() == []


@pytest.mark.django_db
def test_restore_reattaches_only_unparented_projects(
    program: Program, owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    a = _project(program, owner, "Alpha", "ALP")
    moved = _project(program, owner, "Moved", "MOV")
    _delete(owner, program)

    # After the delete, one project is re-homed by its own Admin.
    other = create_program(
        name="Elsewhere", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    moved.refresh_from_db()
    moved.program = other
    moved.save(update_fields=["program"])

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(owner).post(f"/api/v1/programs/{program.pk}/restore/")
    assert resp.status_code == 200, resp.content
    assert resp.json()["id"] == str(program.pk)

    program.refresh_from_db()
    assert program.is_deleted is False
    assert program.deleted_at is None
    assert program.deleted_by_id is None
    assert program.detached_project_ids is None
    a.refresh_from_db()
    moved.refresh_from_db()
    assert a.program_id == program.pk
    assert moved.program_id == other.pk
    bcast.assert_called_once_with(str(a.pk), "project_updated", {"id": str(a.pk)})

    # The restored program is visible again and its role is back.
    assert _client(owner).get(f"/api/v1/programs/{program.pk}/").status_code == 200
    # Double-submit fails closed: it is no longer in Trash.
    assert _client(owner).post(f"/api/v1/programs/{program.pk}/restore/").status_code == 404


@pytest.mark.django_db
def test_restore_is_program_admin_only(
    program: Program, owner: Any, viewer: Any, stranger: Any
) -> None:
    _delete(owner, program)
    assert _client(viewer).post(f"/api/v1/programs/{program.pk}/restore/").status_code == 403
    # A non-member cannot even resolve the id (no existence oracle).
    assert _client(stranger).post(f"/api/v1/programs/{program.pk}/restore/").status_code == 404
    program.refresh_from_db()
    assert program.is_deleted is True


@pytest.mark.django_db
def test_restore_of_live_program_is_404(program: Program, owner: Any) -> None:
    assert _client(owner).post(f"/api/v1/programs/{program.pk}/restore/").status_code == 404


@pytest.mark.django_db
def test_trashed_program_owner_gate_refuses_live_program(program: Program, owner: Any) -> None:
    """IsTrashedProgramOwner must never become a second path to a live program's role."""
    from rest_framework.test import APIRequestFactory

    from trueppm_api.apps.access.permissions import IsTrashedProgramOwner

    request = APIRequestFactory().post("/")
    request.user = owner
    assert IsTrashedProgramOwner().has_object_permission(request, None, program) is False  # type: ignore[arg-type]


@pytest.mark.django_db
def test_restore_rekeys_a_keyless_shell(program: Program, owner: Any) -> None:
    """A seed replace hands the shell's key to its successor (ADR-1237)."""
    from trueppm_api.apps.projects.services import release_keys_for_replace

    release_keys_for_replace(program)
    _delete(owner, program)
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/restore/")
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.code != ""


@pytest.mark.django_db
def test_subtree_soft_delete_is_restorable(program: Program, owner: Any) -> None:
    """The ADR-0726 seed-replace path lands in Trash too; trashed children re-attach."""
    from trueppm_api.apps.projects.services import soft_delete_program_subtree

    a = _project(program, owner, "Alpha", "ALP")
    with transaction.atomic():
        deleted = soft_delete_program_subtree(program, actor=owner, reason="seed_replace")
    assert deleted == [str(a.pk)]
    program.refresh_from_db()
    assert program.detached_project_ids == [a.pk]
    assert program.deleted_by_id == owner.pk

    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/restore/")
    assert resp.status_code == 200, resp.content
    a.refresh_from_db()
    # Re-attached, but still in project Trash: restoring the program never revives
    # a project — that stays the project Owner's call.
    assert a.program_id == program.pk
    assert a.is_deleted is True


@pytest.mark.django_db
def test_restore_bumps_membership_sync_cursor(program: Program, owner: Any, viewer: Any) -> None:
    """A client that full-synced while the program was trashed never received the
    memberships (the roster filters ``program__is_deleted=False``); the restore must
    move their cursor past that client's checkpoint or they stay hidden for good."""
    _delete(owner, program)
    before = {
        m.pk: (m.sync_seq, m.server_version)
        for m in ProgramMembership.objects.filter(program=program)
    }
    assert len(before) == 2

    assert _client(owner).post(f"/api/v1/programs/{program.pk}/restore/").status_code == 200

    for m in ProgramMembership.objects.filter(program=program):
        old_seq, old_version = before[m.pk]
        assert m.sync_seq > old_seq
        assert m.server_version == old_version + 1
    # Every membership shares the one draw, and the program row's own cursor is not
    # behind it for a client that pulls programs before memberships.
    assert len({m.sync_seq for m in ProgramMembership.objects.filter(program=program)}) == 1


@pytest.mark.django_db
def test_trash_hides_opted_out_program_from_agent_token(program: Program, owner: Any) -> None:
    """ADR-0678: an agent (MCP) token must not see a trashed program that opted out."""
    import secrets
    from datetime import timedelta

    from django.utils import timezone

    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken

    _delete(owner, program)
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="agent",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
        expires_at=timezone.now() + timedelta(days=30),
    )
    agent = APIClient()
    agent.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")

    # Control: consenting program is visible to the agent.
    assert [r["id"] for r in agent.get("/api/v1/programs/trash/").json()] == [str(program.pk)]

    Program.objects.filter(pk=program.pk).update(mcp_enabled=False)
    assert agent.get("/api/v1/programs/trash/").json() == []
    # The same program is still listed for its human owner.
    assert [r["id"] for r in _client(owner).get("/api/v1/programs/trash/").json()] == [
        str(program.pk)
    ]


@pytest.mark.django_db
def test_concurrent_restore_losing_the_lock_is_404(program: Program, owner: Any) -> None:
    """A second restore that passes the view's unlocked lookup but loses the row lock
    raises ``Program.DoesNotExist`` in the service; that must be the 404 a
    double-submit gets, not a 500."""
    from trueppm_api.apps.projects import services

    _delete(owner, program)
    real = services.restore_program

    def lose_the_race(prog: Any, *, actor: Any) -> list[str]:
        # The winner commits between the view's lookup and this call's lock.
        Program.objects.filter(pk=prog.pk).update(is_deleted=False)
        return real(prog, actor=actor)

    with patch.object(services, "restore_program", lose_the_race):
        resp = _client(owner).post(f"/api/v1/programs/{program.pk}/restore/")
    assert resp.status_code == 404, resp.content


def _trash_project(owner: Any, project: Project) -> None:
    resp = _client(owner).delete(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 204, resp.content


def _restore_project(owner: Any, project: Project) -> None:
    resp = _client(owner).post(f"/api/v1/projects/{project.pk}/restore/")
    assert resp.status_code == 200, resp.content


@pytest.mark.django_db
@pytest.mark.parametrize("path", ["cascade", "subtree", "reap"])
def test_project_trashed_before_program_delete_restores_standalone(
    program: Program, owner: Any, path: str
) -> None:
    """#4835: no program-delete path may leave a trashed project on the deleted program."""
    from trueppm_api.apps.projects.models import ProgramImportJob
    from trueppm_api.apps.projects.services import soft_delete_program_subtree
    from trueppm_api.apps.projects.tasks import _reap_empty_import_shell

    early = _project(program, owner, "Early", "EAR")
    _trash_project(owner, early)
    early.refresh_from_db()
    trashed_at = early.deleted_at

    if path == "cascade":
        _delete(owner, program)
    else:
        with transaction.atomic():
            if path == "subtree":
                assert soft_delete_program_subtree(program, actor=owner) == []
            else:
                assert _reap_empty_import_shell(ProgramImportJob(program=program)) is True

    program.refresh_from_db()
    early.refresh_from_db()
    assert program.is_deleted is True
    assert program.detached_project_ids == [early.pk]
    assert early.program_id is None
    # Detaching must not re-trash it: the retention clock is the original one.
    assert early.deleted_at == trashed_at

    _restore_project(owner, early)
    early.refresh_from_db()
    assert early.is_deleted is False
    assert early.program_id is None


@pytest.mark.django_db
def test_restoring_a_project_already_stranded_on_a_deleted_program_detaches_it(
    program: Program, owner: Any
) -> None:
    """Rows stored before #4835 still point at the tombstone; restore repairs them."""
    stranded = _project(program, owner, "Stranded", "STR")
    _trash_project(owner, stranded)
    # The pre-fix stored state: program tombstoned, trashed child still attached.
    program.soft_delete()

    _restore_project(owner, stranded)
    stranded.refresh_from_db()
    assert stranded.program_id is None
    program.refresh_from_db()
    assert program.detached_project_ids == [stranded.pk]

    # And a program restore still brings it home.
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/restore/")
    assert resp.status_code == 200, resp.content
    stranded.refresh_from_db()
    assert stranded.program_id == program.pk


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("path", ["cascade", "reap"])
def test_project_restore_waits_for_an_uncommitted_program_delete(
    program: Program, owner: Any, path: str
) -> None:
    """#4835: a restore overlapping a program delete must not re-attach the project.

    The delete holds the program row but has not committed. A lock query that also
    filtered on ``is_deleted`` would match nothing, not wait, and then save the
    stale ``program_id`` over the delete's detach.

    The reap case pauses after the projects are detached and before the program
    is tombstoned, so a reap that did not lock the program first would deadlock
    with the restore.
    """
    from trueppm_api.apps.access.services import delete_program_cascade
    from trueppm_api.apps.projects.models import ProgramImportJob
    from trueppm_api.apps.projects.tasks import _reap_empty_import_shell

    racer = _project(program, owner, "Racer", "RAC")
    _trash_project(owner, racer)
    stale = Project.objects.get(pk=racer.pk)  # still points at the live program
    deleted_uncommitted = threading.Event()
    errors: list[BaseException] = []

    def hold_locks() -> None:
        deleted_uncommitted.set()
        time.sleep(0.5)  # hold the locks while the restore starts

    soft_delete = Program.soft_delete

    def paused_soft_delete(self: Program) -> None:
        hold_locks()
        soft_delete(self)

    def delete() -> None:
        try:
            with transaction.atomic():
                if path == "cascade":
                    delete_program_cascade(program_id=program.pk, actor=owner)
                    hold_locks()
                else:
                    with patch.object(Program, "soft_delete", paused_soft_delete):
                        assert _reap_empty_import_shell(ProgramImportJob(program=program))
        except BaseException as exc:  # surfaced by the assert below
            errors.append(exc)
        finally:
            connection.close()

    deleter = threading.Thread(target=delete)
    deleter.start()
    assert deleted_uncommitted.wait(10), errors
    stale.restore()
    deleter.join(30)

    assert errors == []
    racer.refresh_from_db()
    program.refresh_from_db()
    assert program.is_deleted is True
    assert racer.is_deleted is False
    assert racer.program_id is None
    assert program.detached_project_ids == [racer.pk]
