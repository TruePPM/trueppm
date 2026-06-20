"""Workspace → Program → Project attachment-policy resolution (ADR-0153, #976).

Two inheritable settings govern task file attachments:

* ``attachments_enabled`` — whether file uploads are permitted at all (external
  *links* are a separate capability and are unaffected).
* ``allowed_attachment_types`` — the per-scope MIME allow-list, tri-state on a
  program/project: ``None`` = inherit, ``[]`` = explicit empty (the key footgun —
  NOT inherit), ``[...]`` = explicit set.

Both resolve computed-on-read (ADR-0108) via ``apps.projects.attachment_policy``.
:data:`SYSTEM_ATTACHMENT_DENYLIST` is a non-overridable security floor subtracted
from every resolved list. ``ENFORCE`` (a workspace lock) is an Enterprise seam —
no-op in OSS until a provider is registered.

Coverage:
  * resolver precedence for ``attachments_enabled`` (tri-state inherit)
  * resolver precedence for ``allowed_attachment_types`` (None/[]/[...] tri-state)
  * the denylist floor at every scope and under "widen"
  * ``is_attachment_mime_allowed`` normalization + rejection
  * the ENFORCE enterprise lock seam (no-op in OSS, locks with a provider)
  * Project/Program serializer ``effective_*`` / ``inherited_*`` output
  * Workspace settings PATCH (normalize/dedupe; denied MIME → 400)
  * per-project allow-list enforcement on upload (narrow → 400, widen → 201)
  * uploads-disabled gate (file 403, external link 201, GET still 200)
  * django-simple-history capture of an override change
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.attachment_policy import (
    SYSTEM_ATTACHMENT_DENYLIST,
    SYSTEM_DEFAULT_ATTACHMENT_TYPES,
    attachment_policy_enforcement_active,
    is_attachment_mime_allowed,
    register_attachment_policy_enforcement_provider,
    resolve_attachments_enabled,
    resolve_effective_attachment_types,
    resolve_inherited_attachment_types,
    resolve_inherited_attachments_enabled,
)
from trueppm_api.apps.projects.models import Calendar, Program, Project, Task, TaskAttachment
from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def _project(calendar: Calendar, **kw: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 3, 1), calendar=calendar, **kw)


def _client_for_project(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _client_for_program(program: Program, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def enterprise_lock() -> Iterator[None]:
    """Register an active enforcement provider, clearing it on teardown.

    OSS registers no provider, so a test exercising the ENFORCE lock must register
    one — and MUST clear it afterwards (module-global state) or it leaks into every
    later test in the process. The finally clause guarantees teardown even on a
    mid-test assertion failure.
    """
    register_attachment_policy_enforcement_provider(lambda: True)
    try:
        yield
    finally:
        register_attachment_policy_enforcement_provider(None)


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> Iterator[None]:
    """The attachment create path schedules an on_commit broadcast; mute it."""
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


# ===========================================================================
# 1. Resolver — attachments_enabled tri-state inheritance
# ===========================================================================


@pytest.mark.django_db
def test_enabled_inherits_workspace_when_no_overrides(calendar: Calendar) -> None:
    """Program & project overrides NULL → both resolve to the workspace value."""
    ws = Workspace.load()
    ws.attachments_enabled = True
    ws.save()
    prog = Program.objects.create(name="Prog")  # NULL override
    p = _project(calendar, program=prog)  # NULL override

    assert resolve_attachments_enabled(prog) is True
    assert resolve_attachments_enabled(p) is True


@pytest.mark.django_db
def test_enabled_workspace_false_inherited(calendar: Calendar) -> None:
    """Workspace False with NULL overrides → both inherit False."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.save()
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)

    assert resolve_attachments_enabled(prog) is False
    assert resolve_attachments_enabled(p) is False


@pytest.mark.django_db
def test_enabled_program_override_wins_for_its_projects(calendar: Calendar) -> None:
    """A program override beats the workspace value for the program AND its projects."""
    ws = Workspace.load()
    ws.attachments_enabled = True
    ws.save()
    prog = Program.objects.create(name="Prog", attachments_enabled=False)
    p = _project(calendar, program=prog)  # NULL → inherits program

    assert resolve_attachments_enabled(prog) is False
    assert resolve_attachments_enabled(p) is False
    # inherited_* skips the object's own override → the parent's effective value.
    assert resolve_inherited_attachments_enabled(p) is False


@pytest.mark.django_db
def test_enabled_project_override_wins_over_program_and_workspace(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.attachments_enabled = True
    ws.save()
    prog = Program.objects.create(name="Prog", attachments_enabled=True)
    p = _project(calendar, program=prog, attachments_enabled=False)

    assert resolve_attachments_enabled(p) is False  # own override
    # With its own override cleared it would inherit the program (True).
    assert resolve_inherited_attachments_enabled(p) is True


@pytest.mark.django_db
def test_enabled_standalone_project_inherits_workspace(calendar: Calendar) -> None:
    """A project with no program inherits the workspace value directly."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.save()
    p = _project(calendar)  # no program, NULL override

    assert p.program_id is None
    assert resolve_attachments_enabled(p) is False
    assert resolve_inherited_attachments_enabled(p) is False


@pytest.mark.django_db
def test_enabled_explicit_true_overrides_false_chain(calendar: Calendar) -> None:
    """Explicit True at each level wins even when everything above is False."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.save()
    prog = Program.objects.create(name="Prog", attachments_enabled=True)
    p = _project(calendar, program=prog, attachments_enabled=True)

    assert resolve_attachments_enabled(prog) is True
    assert resolve_attachments_enabled(p) is True


# ===========================================================================
# 2. Resolver — allowed_attachment_types tri-state (None / [] / [...])
# ===========================================================================


@pytest.mark.django_db
def test_types_inherit_workspace_when_all_null(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf", "text/csv"]
    ws.save()
    prog = Program.objects.create(name="Prog")  # NULL → inherit
    p = _project(calendar, program=prog)  # NULL → inherit

    assert resolve_effective_attachment_types(prog) == ["application/pdf", "text/csv"]
    assert resolve_effective_attachment_types(p) == ["application/pdf", "text/csv"]


@pytest.mark.django_db
def test_types_empty_list_is_explicit_not_inherit(calendar: Calendar) -> None:
    """THE FOOTGUN: [] is an explicit "no type allowed", never "inherit parent"."""
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf", "text/csv"]
    ws.save()
    prog = Program.objects.create(name="Prog", allowed_attachment_types=[])
    p = _project(calendar, program=prog)  # NULL → inherits program's explicit []

    # Program explicitly cleared → [] (NOT the workspace set).
    assert resolve_effective_attachment_types(prog) == []
    # Project inherits the program's explicit empty list.
    assert resolve_effective_attachment_types(p) == []


@pytest.mark.django_db
def test_types_project_empty_list_overrides_populated_program(calendar: Calendar) -> None:
    """A project [] beats a populated program — empty is a deliberate value."""
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    prog = Program.objects.create(name="Prog", allowed_attachment_types=["text/csv"])
    p = _project(calendar, program=prog, allowed_attachment_types=[])

    assert resolve_effective_attachment_types(p) == []
    # Cleared, it would inherit the program's explicit ["text/csv"].
    assert resolve_inherited_attachment_types(p) == ["text/csv"]


@pytest.mark.django_db
def test_types_program_override_wins_over_workspace(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    prog = Program.objects.create(name="Prog", allowed_attachment_types=["text/csv", "image/png"])
    p = _project(calendar, program=prog)  # NULL → inherits program

    assert resolve_effective_attachment_types(prog) == ["image/png", "text/csv"]
    assert resolve_effective_attachment_types(p) == ["image/png", "text/csv"]
    assert resolve_inherited_attachment_types(p) == ["image/png", "text/csv"]


@pytest.mark.django_db
def test_types_project_override_wins_over_program_and_workspace(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    prog = Program.objects.create(name="Prog", allowed_attachment_types=["text/csv"])
    p = _project(calendar, program=prog, allowed_attachment_types=["image/png"])

    assert resolve_effective_attachment_types(p) == ["image/png"]
    # Cleared, it would inherit the program's ["text/csv"].
    assert resolve_inherited_attachment_types(p) == ["text/csv"]


@pytest.mark.django_db
def test_types_standalone_project_inherits_workspace(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf", "image/png"]
    ws.save()
    p = _project(calendar)  # no program, NULL override

    assert resolve_effective_attachment_types(p) == ["application/pdf", "image/png"]


@pytest.mark.django_db
def test_types_result_is_sorted_and_deduped(calendar: Calendar) -> None:
    """The resolver always returns a sorted, de-duplicated list."""
    ws = Workspace.load()
    ws.allowed_attachment_types = ["text/csv", "application/pdf", "text/csv"]
    ws.save()
    p = _project(calendar)

    assert resolve_effective_attachment_types(p) == ["application/pdf", "text/csv"]


@pytest.mark.django_db
def test_types_default_seed_matches_system_default(calendar: Calendar) -> None:
    """A fresh workspace seeds the column from SYSTEM_DEFAULT_ATTACHMENT_TYPES."""
    Workspace.load()  # lazily create with the column default
    p = _project(calendar)

    assert resolve_effective_attachment_types(p) == sorted(SYSTEM_DEFAULT_ATTACHMENT_TYPES)


# ===========================================================================
# 3. Denylist floor — non-overridable at every scope, even under "widen"
# ===========================================================================


@pytest.mark.django_db
def test_denylist_subtracted_from_workspace_list(calendar: Calendar) -> None:
    """An admin who stores a denied type directly never gets it back."""
    ws = Workspace.load()
    # Bypass the serializer and inject a denied type straight into the column.
    ws.allowed_attachment_types = ["application/pdf", "text/html", "image/svg+xml"]
    ws.save()
    p = _project(calendar)

    effective = resolve_effective_attachment_types(p)
    assert "text/html" not in effective
    assert "image/svg+xml" not in effective
    assert effective == ["application/pdf"]


@pytest.mark.django_db
def test_denylist_subtracted_at_program_scope(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.save()
    prog = Program.objects.create(
        name="Prog", allowed_attachment_types=["application/pdf", "text/html"]
    )

    assert resolve_effective_attachment_types(prog) == ["application/pdf"]


@pytest.mark.django_db
def test_denylist_subtracted_at_project_scope(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.save()
    p = _project(calendar, allowed_attachment_types=["application/xhtml+xml", "text/csv"])

    assert resolve_effective_attachment_types(p) == ["text/csv"]


@pytest.mark.django_db
def test_denylist_floor_survives_widen_at_every_scope(calendar: Calendar) -> None:
    """A "widen" that re-admits a denied type at every level still never returns it."""
    ws = Workspace.load()
    ws.allowed_attachment_types = ["text/html"]
    ws.save()
    prog = Program.objects.create(name="Prog", allowed_attachment_types=["image/svg+xml"])
    p = _project(calendar, program=prog, allowed_attachment_types=["application/xhtml+xml"])

    assert resolve_effective_attachment_types(prog) == []  # only denied → empty
    assert resolve_effective_attachment_types(p) == []
    # inherited is also denylist-floored.
    assert resolve_inherited_attachment_types(p) == []


@pytest.mark.django_db
def test_denylist_blocks_is_allowed_at_every_scope(calendar: Calendar) -> None:
    """is_attachment_mime_allowed rejects a denied type even if stored in the list."""
    ws = Workspace.load()
    ws.allowed_attachment_types = ["text/html", "application/pdf"]
    ws.save()
    prog = Program.objects.create(name="Prog", allowed_attachment_types=["image/svg+xml"])
    p = _project(calendar, program=prog, allowed_attachment_types=["text/html", "text/csv"])

    # Project: denied type stored locally is never allowed; csv is.
    assert is_attachment_mime_allowed(p, "text/html") is False
    assert is_attachment_mime_allowed(p, "text/csv") is True
    # Program: only-denied list → nothing allowed.
    assert is_attachment_mime_allowed(prog, "image/svg+xml") is False


@pytest.mark.django_db
def test_denylist_constants_are_the_documented_set() -> None:
    """Guard the security floor's contents so a refactor can't silently shrink it."""
    assert set(SYSTEM_ATTACHMENT_DENYLIST) == {
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
    }


# ===========================================================================
# 4. is_attachment_mime_allowed — normalization + rejection
# ===========================================================================


@pytest.mark.django_db
def test_is_allowed_normalizes_charset_trailer(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["text/csv"]
    ws.save()
    p = _project(calendar)

    assert is_attachment_mime_allowed(p, "text/csv; charset=utf-8") is True


@pytest.mark.django_db
def test_is_allowed_normalizes_case(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    p = _project(calendar)

    assert is_attachment_mime_allowed(p, "APPLICATION/PDF") is True
    assert is_attachment_mime_allowed(p, "Application/Pdf ; charset=binary") is True


@pytest.mark.django_db
def test_is_allowed_rejects_not_in_list(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    p = _project(calendar)

    assert is_attachment_mime_allowed(p, "image/png") is False


@pytest.mark.django_db
def test_is_allowed_rejects_empty_or_blank(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.save()
    p = _project(calendar)

    assert is_attachment_mime_allowed(p, "") is False
    assert is_attachment_mime_allowed(p, "   ") is False


# ===========================================================================
# 5. ENFORCE enterprise seam
# ===========================================================================


@pytest.mark.django_db
def test_enforce_is_noop_in_oss(calendar: Calendar) -> None:
    """ENFORCE with no provider (OSS default) degrades to SUGGEST: override wins."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.allowed_attachment_types = ["application/pdf"]
    ws.attachments_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    prog = Program.objects.create(
        name="Prog", attachments_enabled=True, allowed_attachment_types=["text/csv"]
    )
    p = _project(calendar, program=prog)

    assert attachment_policy_enforcement_active() is False
    # The downstream override still wins because no provider is registered.
    assert resolve_attachments_enabled(prog) is True
    assert resolve_attachments_enabled(p) is True
    assert resolve_effective_attachment_types(p) == ["text/csv"]


@pytest.mark.django_db
def test_enforce_locks_to_workspace_when_provider_active(
    calendar: Calendar, enterprise_lock: None
) -> None:
    """ENFORCE + active provider: the workspace value is a ceiling, overrides ignored."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.allowed_attachment_types = ["application/pdf"]
    ws.attachments_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    prog = Program.objects.create(
        name="Prog", attachments_enabled=True, allowed_attachment_types=["text/csv"]
    )
    p = _project(calendar, program=prog, attachments_enabled=True)

    assert attachment_policy_enforcement_active() is True
    # Both overrides are overridden by the workspace ceiling.
    assert resolve_attachments_enabled(prog) is False
    assert resolve_attachments_enabled(p) is False
    assert resolve_effective_attachment_types(p) == ["application/pdf"]
    assert resolve_inherited_attachment_types(p) == ["application/pdf"]


@pytest.mark.django_db
def test_enforce_lock_still_applies_denylist(calendar: Calendar, enterprise_lock: None) -> None:
    """Even under an active enterprise lock the denylist floor still applies."""
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf", "text/html"]
    ws.attachments_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    p = _project(calendar, allowed_attachment_types=["image/png"])  # ignored under lock

    assert resolve_effective_attachment_types(p) == ["application/pdf"]
    assert is_attachment_mime_allowed(p, "text/html") is False


@pytest.mark.django_db
def test_suggest_policy_never_locks_even_with_provider(
    calendar: Calendar, enterprise_lock: None
) -> None:
    """SUGGEST (the default policy) never locks, even when a provider is active."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.attachments_override_policy = TermOverridePolicy.SUGGEST
    ws.save()
    p = _project(calendar, attachments_enabled=True)

    assert attachment_policy_enforcement_active() is True
    assert resolve_attachments_enabled(p) is True


@pytest.mark.django_db
def test_provider_cleared_after_lock_test() -> None:
    """Sanity: a plain test (no enterprise_lock fixture) sees no active provider.

    Guards against the module-global leaking out of the ENFORCE tests above — if
    the fixture teardown regressed, this would flip to True.
    """
    assert attachment_policy_enforcement_active() is False


# ===========================================================================
# 6. Serializer output — effective_* / inherited_*
# ===========================================================================


@pytest.mark.django_db
def test_project_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.attachments_enabled = True
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    prog = Program.objects.create(
        name="Prog", attachments_enabled=False, allowed_attachment_types=["text/csv"]
    )
    p = _project(calendar, program=prog)  # NULL overrides → inherits program/ws
    client = _client_for_project(p, Role.MEMBER, "u_proj_read")

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200, resp.content
    assert resp.data["attachments_enabled"] is None
    assert resp.data["allowed_attachment_types"] is None
    # Effective reflects the program override (the nearest non-null ancestor).
    assert resp.data["effective_attachments_enabled"] is False
    assert resp.data["effective_allowed_attachment_types"] == ["text/csv"]
    # inherited = value with this object's override cleared → also the program's.
    assert resp.data["inherited_attachments_enabled"] is False
    assert resp.data["inherited_allowed_attachment_types"] == ["text/csv"]


@pytest.mark.django_db
def test_project_serializer_inherited_skips_own_override(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.attachments_enabled = True
    ws.allowed_attachment_types = ["application/pdf"]
    ws.save()
    p = _project(calendar, attachments_enabled=False, allowed_attachment_types=["text/csv"])
    client = _client_for_project(p, Role.MEMBER, "u_proj_skip")

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200, resp.content
    assert resp.data["effective_attachments_enabled"] is False  # own override
    assert resp.data["effective_allowed_attachment_types"] == ["text/csv"]  # own override
    # With the project's own overrides cleared it would inherit the workspace.
    assert resp.data["inherited_attachments_enabled"] is True
    assert resp.data["inherited_allowed_attachment_types"] == ["application/pdf"]


@pytest.mark.django_db
def test_program_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.attachments_enabled = True
    ws.allowed_attachment_types = ["application/pdf", "text/csv"]
    ws.save()
    prog = Program.objects.create(name="Prog")  # NULL override → inherits ws
    client = _client_for_program(prog, Role.MEMBER, "u_prog_read")

    resp = client.get(f"/api/v1/programs/{prog.pk}/")
    assert resp.status_code == 200, resp.content
    assert resp.data["attachments_enabled"] is None
    assert resp.data["effective_attachments_enabled"] is True  # workspace value
    assert resp.data["effective_allowed_attachment_types"] == ["application/pdf", "text/csv"]
    assert resp.data["inherited_attachments_enabled"] is True
    assert resp.data["inherited_allowed_attachment_types"] == ["application/pdf", "text/csv"]


@pytest.mark.django_db
def test_project_patch_explicit_empty_override(calendar: Calendar) -> None:
    """A project may PATCH allowed_attachment_types to [] — an explicit "no types
    allowed" override, distinct from null (inherit). ADR-0153 tri-state relies on
    the serializer's allow_empty=True; null then clears back to inheriting.
    """
    ws = Workspace.load()
    ws.allowed_attachment_types = ["application/pdf", "text/csv"]
    ws.save()
    p = _project(calendar)  # NULL → inherits workspace
    client = _client_for_project(p, Role.ADMIN, "u_proj_patch")

    # [] = explicit empty override (not inherit) → effective resolves to [].
    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"allowed_attachment_types": []}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["allowed_attachment_types"] == []
    assert resp.data["effective_allowed_attachment_types"] == []

    # null clears the override → inherits the workspace set again.
    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"allowed_attachment_types": None}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["allowed_attachment_types"] is None
    assert resp.data["effective_allowed_attachment_types"] == ["application/pdf", "text/csv"]


# ===========================================================================
# 7. Workspace settings PATCH — normalize / dedupe / reject denied MIME
# ===========================================================================

WS_URL = "/api/v1/workspace/"


@pytest.fixture
def ws_admin(db: object) -> object:
    return User.objects.create_user(username="ws_admin", password="pw", is_superuser=True)


@pytest.mark.django_db
def test_workspace_patch_normalizes_and_dedupes(ws_admin: object) -> None:
    client = APIClient()
    client.force_authenticate(user=ws_admin)
    resp = client.patch(
        WS_URL,
        {"allowed_attachment_types": ["Text/CSV", "text/csv", "APPLICATION/PDF"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    # Lowercased, de-duplicated, sorted.
    assert resp.data["allowed_attachment_types"] == ["application/pdf", "text/csv"]
    assert Workspace.load().allowed_attachment_types == ["application/pdf", "text/csv"]


@pytest.mark.django_db
def test_workspace_patch_strips_charset_trailer(ws_admin: object) -> None:
    client = APIClient()
    client.force_authenticate(user=ws_admin)
    resp = client.patch(
        WS_URL,
        {"allowed_attachment_types": ["text/csv; charset=utf-8"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["allowed_attachment_types"] == ["text/csv"]


@pytest.mark.django_db
def test_workspace_patch_rejects_denied_mime(ws_admin: object) -> None:
    client = APIClient()
    client.force_authenticate(user=ws_admin)
    resp = client.patch(
        WS_URL,
        {"allowed_attachment_types": ["application/pdf", "text/html"]},
        format="json",
    )
    assert resp.status_code == 400
    assert "allowed_attachment_types" in resp.data
    # The stored value is unchanged (the seed default).
    assert "text/html" not in Workspace.load().allowed_attachment_types


@pytest.mark.django_db
def test_workspace_patch_empty_list_accepted(ws_admin: object) -> None:
    """An empty workspace allow-list is a deliberate "no types allowed" policy.

    The serializer declares ``allow_empty=True`` on ``allowed_attachment_types``
    (ADR-0153) to opt back out of DRF's default ArrayField ``allow_empty=False``,
    so an admin can set the workspace root to empty — consistent with the resolver
    treating a stored empty list as explicit-empty, not inherit.
    """
    client = APIClient()
    client.force_authenticate(user=ws_admin)
    resp = client.patch(WS_URL, {"allowed_attachment_types": []}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["allowed_attachment_types"] == []
    assert Workspace.load().allowed_attachment_types == []


@pytest.mark.django_db
def test_workspace_patch_enabled_toggle(ws_admin: object) -> None:
    client = APIClient()
    client.force_authenticate(user=ws_admin)
    resp = client.patch(WS_URL, {"attachments_enabled": False}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["attachments_enabled"] is False
    assert Workspace.load().attachments_enabled is False


@pytest.mark.django_db
def test_workspace_non_admin_cannot_patch_attachments() -> None:
    member = User.objects.create_user(username="ws_member", password="pw")
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(WS_URL, {"attachments_enabled": False}, format="json")
    assert resp.status_code == 403
    assert Workspace.load().attachments_enabled is True


# ===========================================================================
# 8. Per-project allow-list enforcement on upload (narrow / widen)
# ===========================================================================


def _att_list_url(project: Project, task: Task) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/attachments/"


@pytest.fixture
def task_on(calendar: Calendar) -> tuple[Project, Task]:
    """A standalone project + task; the caller sets the project's policy."""
    p = _project(calendar)
    t = Task.objects.create(project=p, name="Foundation", duration=1)
    return p, t


@pytest.mark.django_db
def test_upload_blocked_when_project_narrows_allowlist(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """Project allow-list = PDF only → a PNG upload is rejected 400."""
    Workspace.load()  # seed default (includes png)
    project, task = task_on
    project.allowed_attachment_types = ["application/pdf"]
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_narrow_png")

    png = SimpleUploadedFile(
        "real.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16, content_type="image/png"
    )
    resp = client.post(_att_list_url(project, task), {"file": png}, format="multipart")
    assert resp.status_code == 400
    assert "image/png" in str(resp.data)


@pytest.mark.django_db
def test_upload_allowed_when_type_in_narrowed_allowlist(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """Same narrowed PDF-only project → a PDF upload still succeeds."""
    Workspace.load()
    project, task = task_on
    project.allowed_attachment_types = ["application/pdf"]
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_narrow_pdf")

    pdf = SimpleUploadedFile("report.pdf", b"%PDF-1.4 small", content_type="application/pdf")
    resp = client.post(_att_list_url(project, task), {"file": pdf}, format="multipart")
    assert resp.status_code == 201, resp.content
    assert resp.data["file_mime"] == "application/pdf"


@pytest.mark.django_db
def test_upload_allowed_when_project_widens_allowlist(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """Project adds a type the workspace seed lacked (text/plain) → it now uploads.

    text/plain is not in SYSTEM_DEFAULT_ATTACHMENT_TYPES and is not on the
    denylist, so a project that explicitly widens to it can accept it.
    """
    ws = Workspace.load()
    assert "text/plain" not in ws.allowed_attachment_types  # not in the seed
    project, task = task_on
    project.allowed_attachment_types = ["text/plain"]
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_widen_txt")

    txt = SimpleUploadedFile("notes.txt", b"hello world\n", content_type="text/plain")
    resp = client.post(_att_list_url(project, task), {"file": txt}, format="multipart")
    assert resp.status_code == 201, resp.content
    assert resp.data["file_mime"] == "text/plain"


@pytest.mark.django_db
def test_upload_denied_type_blocked_even_if_project_widened(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """A project that injects a denied type into its list can't accept that upload."""
    Workspace.load()
    project, task = task_on
    project.allowed_attachment_types = ["text/html"]  # denied — never resolves in
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_widen_html")

    html = SimpleUploadedFile("page.html", b"<html></html>", content_type="text/html")
    resp = client.post(_att_list_url(project, task), {"file": html}, format="multipart")
    assert resp.status_code == 400


# ===========================================================================
# 9. Uploads-disabled gate (file 403, external link 201, GET still 200)
# ===========================================================================


@pytest.mark.django_db
def test_file_upload_403_when_disabled_explicit(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """Explicit project attachments_enabled=False → file upload is 403 (policy refusal)."""
    Workspace.load()
    project, task = task_on
    project.attachments_enabled = False
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_disabled_file")

    pdf = SimpleUploadedFile("report.pdf", b"%PDF-1.4 small", content_type="application/pdf")
    resp = client.post(_att_list_url(project, task), {"file": pdf}, format="multipart")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_file_upload_403_when_disabled_inherited(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """Inherited disable (workspace False, project NULL) also blocks the file upload."""
    ws = Workspace.load()
    ws.attachments_enabled = False
    ws.save()
    project, task = task_on  # project override NULL → inherits workspace False
    client = _client_for_project(project, Role.MEMBER, "u_disabled_inh")

    pdf = SimpleUploadedFile("report.pdf", b"%PDF-1.4 small", content_type="application/pdf")
    resp = client.post(_att_list_url(project, task), {"file": pdf}, format="multipart")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_external_link_still_succeeds_when_disabled(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """attachments_enabled gates file uploads only — external *links* are unaffected."""
    Workspace.load()
    project, task = task_on
    project.attachments_enabled = False
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_disabled_link")

    resp = client.post(
        _att_list_url(project, task),
        {"external_url": "https://example.com/doc", "external_title": "Doc"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["external_url"] == "https://example.com/doc"


@pytest.mark.django_db
def test_get_existing_attachments_still_works_when_disabled(
    calendar: Calendar, task_on: tuple[Project, Task]
) -> None:
    """Disabling uploads never hides attachments already on the task."""
    Workspace.load()
    project, task = task_on
    TaskAttachment.objects.create(task=task, external_url="https://example.com/old")
    project.attachments_enabled = False
    project.save()
    client = _client_for_project(project, Role.MEMBER, "u_disabled_get")

    resp = client.get(_att_list_url(project, task))
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 1


# ===========================================================================
# 10. django-simple-history captures the override change
# ===========================================================================


@pytest.mark.django_db
def test_project_override_change_recorded_in_history(calendar: Calendar) -> None:
    """attachments_enabled is NOT in _HISTORY_EXCLUDED_BASE → the change is audited."""
    Workspace.load()
    p = _project(calendar)
    before = p.history.count()  # type: ignore[attr-defined]

    p.attachments_enabled = False
    p.save()

    after = p.history.count()  # type: ignore[attr-defined]
    assert after == before + 1
    latest = p.history.first()  # type: ignore[attr-defined]
    assert latest.attachments_enabled is False


@pytest.mark.django_db
def test_project_allowlist_change_recorded_in_history(calendar: Calendar) -> None:
    Workspace.load()
    p = _project(calendar)
    before = p.history.count()  # type: ignore[attr-defined]

    p.allowed_attachment_types = ["application/pdf"]
    p.save()

    assert p.history.count() == before + 1  # type: ignore[attr-defined]
    assert p.history.first().allowed_attachment_types == ["application/pdf"]  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_program_override_change_recorded_in_history() -> None:
    Workspace.load()
    prog = Program.objects.create(name="Prog")
    before = prog.history.count()  # type: ignore[attr-defined]

    prog.attachments_enabled = False
    prog.save()

    assert prog.history.count() == before + 1  # type: ignore[attr-defined]
    assert prog.history.first().attachments_enabled is False  # type: ignore[attr-defined]
