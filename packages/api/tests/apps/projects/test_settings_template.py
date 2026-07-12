"""Tests for project settings copy-at-create (``copy_settings_from``, #157, ADR-0242).

A new project can be seeded from a source project the caller can read. The copy is
of the source's **stored** settings (allowlist in ``services.SETTINGS_TEMPLATE_FIELDS``),
never the resolved effective values, and only fills fields the caller did not pass
explicitly. The field doubles as its own IDOR gate: an unreadable source fails as
``does_not_exist`` (400), indistinguishable from a nonexistent id.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BoardCadence,
    Calendar,
    DefaultView,
    DurationChangePercentPolicy,
    Methodology,
    Program,
    Project,
    Visibility,
)
from trueppm_api.apps.projects.services import SETTINGS_TEMPLATE_FIELDS

User = get_user_model()

CREATE_URL = "/api/v1/projects/"


def _user(username: str) -> Any:
    return User.objects.create_user(username=username, password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std", working_days=31)


@pytest.fixture
def source(calendar: Calendar) -> Project:
    """A source project with deliberately non-default settings on every class of
    field, so a passing copy proves real value transfer (not both-at-default)."""
    program = Program.objects.create(name="Apollo")
    return Project.objects.create(
        name="Template Source",
        description="src desc",
        code="SRC",
        start_date=date(2026, 1, 5),
        calendar=calendar,
        program=program,
        # Plain stored settings — all off their defaults.
        visibility=Visibility.PRIVATE,
        default_view=DefaultView.BOARD,
        board_cadence=BoardCadence.CONTINUOUS,
        timezone="Pacific/Auckland",
        stale_task_threshold_days=14,
        agile_features=True,
        methodology=Methodology.AGILE,
        # Default new-member role off its MEMBER default (ADR-0363) so the copy
        # assertion below proves real transfer, not both-at-default.
        default_member_role=Role.SCHEDULER,
        # Inheritable overrides — explicit (non-NULL) stored values.
        iteration_label="PI",
        task_duration_change_percent_policy=DurationChangePercentPolicy.PRORATE,
        public_sharing=True,
        show_reporting=False,
        mc_history_enabled=True,
    )


@pytest.fixture
def owner(source: Project) -> Any:
    """A user who owns the source project (can read it → can copy from it)."""
    u = _user("owner")
    ProjectMembership.objects.create(project=source, user=u, role=Role.OWNER)
    return u


def _created_project(resp: Any) -> Project:
    assert resp.status_code == 201, resp.data
    return Project.objects.get(pk=resp.data["id"])


@pytest.mark.django_db
def test_copy_seeds_all_allowlisted_settings_from_source(source: Project, owner: Any) -> None:
    resp = _client(owner).post(
        CREATE_URL,
        {
            "name": "New From Template",
            "start_date": "2026-06-01",
            "copy_settings_from": str(source.pk),
        },
        format="json",
    )
    new = _created_project(resp)

    # Every allowlisted setting equals the source's STORED value.
    for field in SETTINGS_TEMPLATE_FIELDS:
        if field == "calendar":
            assert new.calendar_id == source.calendar_id
        else:
            assert getattr(new, field) == getattr(source, field), field

    # Identity / lifecycle / relationship fields are NOT copied.
    assert new.name == "New From Template"
    assert new.start_date == date(2026, 6, 1)
    assert new.code == ""  # source.code "SRC" not copied
    assert new.program_id is None  # source.program (Apollo) not copied
    assert new.lead_id is None
    assert new.object_sequence == 0
    assert new.pk != source.pk


@pytest.mark.django_db
def test_explicit_value_wins_over_copied(source: Project, owner: Any) -> None:
    """Precedence: explicit request value > copied value > model default."""
    resp = _client(owner).post(
        CREATE_URL,
        {
            "name": "Override tz",
            "start_date": "2026-06-01",
            "copy_settings_from": str(source.pk),
            "timezone": "UTC",  # explicit — must win over source's Pacific/Auckland
        },
        format="json",
    )
    new = _created_project(resp)
    assert new.timezone == "UTC"  # explicit wins
    assert new.stale_task_threshold_days == 14  # still copied from source


@pytest.mark.django_db
def test_copies_stored_not_effective_value_for_inherited_field(
    calendar: Calendar, owner: Any, source: Project
) -> None:
    """A source whose override is NULL (inheriting) seeds NULL — never its resolved
    effective label. Copying the effective value would silently pin inheritance."""
    inheriting = Project.objects.create(
        name="Inheriting Source",
        start_date=date(2026, 1, 5),
        calendar=calendar,
        iteration_label=None,  # inherit program/workspace, do not pin
    )
    ProjectMembership.objects.create(project=inheriting, user=owner, role=Role.OWNER)

    resp = _client(owner).post(
        CREATE_URL,
        {
            "name": "From Inheriting",
            "start_date": "2026-06-01",
            "copy_settings_from": str(inheriting.pk),
        },
        format="json",
    )
    new = _created_project(resp)
    assert new.iteration_label is None  # stored NULL copied, not an effective label


@pytest.mark.django_db
def test_source_not_readable_is_indistinguishable_from_nonexistent(
    source: Project, owner: Any
) -> None:
    """IDOR hygiene: a non-member source and a nonexistent id both 400 with the
    same ``does_not_exist`` error code, leaking no existence information. (The
    message echoes the pk the caller itself supplied — same code, same shape — so
    a forbidden source is indistinguishable from a nonexistent one.)"""
    stranger = _user("stranger")  # NOT a member of `source`
    client = _client(stranger)

    not_member = client.post(
        CREATE_URL,
        {"name": "A", "start_date": "2026-06-01", "copy_settings_from": str(source.pk)},
        format="json",
    )
    nonexistent = client.post(
        CREATE_URL,
        {"name": "B", "start_date": "2026-06-01", "copy_settings_from": str(uuid.uuid4())},
        format="json",
    )
    assert not_member.status_code == 400
    assert nonexistent.status_code == 400
    # Identical error code for both — the no-existence-leak signal. The message
    # differs only by the caller's own echoed pk, which reveals nothing.
    assert not_member.data["copy_settings_from"][0].code == "does_not_exist"
    assert nonexistent.data["copy_settings_from"][0].code == "does_not_exist"


@pytest.mark.django_db
def test_archived_source_is_allowed(source: Project, owner: Any) -> None:
    source.is_archived = True
    source.save(update_fields=["is_archived"])
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "From Archived", "start_date": "2026-06-01", "copy_settings_from": str(source.pk)},
        format="json",
    )
    new = _created_project(resp)
    assert new.timezone == "Pacific/Auckland"  # copy succeeded


@pytest.mark.django_db
def test_trashed_source_is_excluded(source: Project, owner: Any) -> None:
    source.is_deleted = True
    source.save(update_fields=["is_deleted"])
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "From Trashed", "start_date": "2026-06-01", "copy_settings_from": str(source.pk)},
        format="json",
    )
    assert resp.status_code == 400
    assert "copy_settings_from" in resp.data


@pytest.mark.django_db
def test_cross_program_source_is_allowed(source: Project, owner: Any) -> None:
    """Copying settings out of a project in a different program is fine — it is not
    the ADR-0070 project-move check. The source's program is not copied."""
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "Cross Program", "start_date": "2026-06-01", "copy_settings_from": str(source.pk)},
        format="json",
    )
    new = _created_project(resp)
    assert new.program_id is None
    assert new.board_cadence == BoardCadence.CONTINUOUS  # setting still copied


@pytest.mark.django_db
def test_calendar_reference_is_shared_and_null_passes_through(
    calendar: Calendar, owner: Any
) -> None:
    with_cal = Project.objects.create(
        name="Has Cal", start_date=date(2026, 1, 5), calendar=calendar
    )
    no_cal = Project.objects.create(name="No Cal", start_date=date(2026, 1, 5), calendar=None)
    for p in (with_cal, no_cal):
        ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)

    shared = _created_project(
        _client(owner).post(
            CREATE_URL,
            {
                "name": "Shared Cal",
                "start_date": "2026-06-01",
                "copy_settings_from": str(with_cal.pk),
            },
            format="json",
        )
    )
    assert shared.calendar_id == calendar.pk  # same row, not cloned

    nulled = _created_project(
        _client(owner).post(
            CREATE_URL,
            {"name": "Null Cal", "start_date": "2026-06-01", "copy_settings_from": str(no_cal.pk)},
            format="json",
        )
    )
    assert nulled.calendar_id is None


@pytest.mark.django_db
def test_create_without_template_is_unchanged(owner: Any) -> None:
    """Regression guard: omitting copy_settings_from behaves exactly as before."""
    resp = _client(owner).post(
        CREATE_URL, {"name": "Plain", "start_date": "2026-06-01"}, format="json"
    )
    new = _created_project(resp)
    assert new.timezone == ""  # model default, not seeded
    assert new.stale_task_threshold_days == 7  # model default


@pytest.mark.django_db
def test_viewer_role_on_source_suffices(source: Project) -> None:
    """Reading settings is a read op — a Viewer on the source may copy from it."""
    viewer = _user("viewer")
    ProjectMembership.objects.create(project=source, user=viewer, role=Role.VIEWER)
    resp = _client(viewer).post(
        CREATE_URL,
        {"name": "Viewer Copy", "start_date": "2026-06-01", "copy_settings_from": str(source.pk)},
        format="json",
    )
    new = _created_project(resp)
    assert new.default_view == DefaultView.BOARD


@pytest.mark.django_db
def test_program_id_is_rejected(source: Project, owner: Any) -> None:
    """A Program uuid does not resolve in the project-scoped queryset → 400."""
    program = Program.objects.create(name="Not A Project")
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "Bad Source", "start_date": "2026-06-01", "copy_settings_from": str(program.pk)},
        format="json",
    )
    assert resp.status_code == 400
    assert "copy_settings_from" in resp.data


@pytest.mark.django_db
def test_copy_settings_from_rejected_on_update(source: Project, owner: Any) -> None:
    """copy_settings_from is a create-only template source (ADR-0242)."""
    target = Project.objects.create(name="Existing", start_date=date(2026, 1, 5))
    ProjectMembership.objects.create(project=target, user=owner, role=Role.OWNER)
    resp = _client(owner).patch(
        f"/api/v1/projects/{target.pk}/",
        {"copy_settings_from": str(source.pk)},
        format="json",
    )
    assert resp.status_code == 400
    assert "copy_settings_from" in resp.data


@pytest.mark.django_db
def test_default_member_role_copies_from_source(source: Project, owner: Any) -> None:
    """default_member_role rides the settings-copy allowlist (ADR-0363)."""
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "Copy Role", "start_date": "2026-06-01", "copy_settings_from": str(source.pk)},
        format="json",
    )
    new = _created_project(resp)
    assert new.default_member_role == Role.SCHEDULER  # source's non-default value


@pytest.mark.django_db
def test_default_member_role_defaults_to_member(owner: Any) -> None:
    """Without a template or explicit value, the field is MEMBER (ADR-0363 §2)."""
    resp = _client(owner).post(
        CREATE_URL, {"name": "Plain Role", "start_date": "2026-06-01"}, format="json"
    )
    new = _created_project(resp)
    assert new.default_member_role == Role.MEMBER
    # The read serializer exposes the human label for the settings UI.
    assert resp.data["default_member_role"] == Role.MEMBER
    assert resp.data["default_member_role_label"] == "Team Member"


@pytest.mark.django_db
def test_default_member_role_explicit_on_create(owner: Any) -> None:
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "Explicit Role", "start_date": "2026-06-01", "default_member_role": Role.ADMIN},
        format="json",
    )
    new = _created_project(resp)
    assert new.default_member_role == Role.ADMIN


@pytest.mark.django_db
def test_default_member_role_editable_after_create(owner: Any) -> None:
    """Acceptance: all settings independently editable after create (no lock)."""
    project = Project.objects.create(name="Editable", start_date=date(2026, 1, 5))
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    resp = _client(owner).patch(
        f"/api/v1/projects/{project.pk}/",
        {"default_member_role": Role.VIEWER},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    project.refresh_from_db()
    assert project.default_member_role == Role.VIEWER


@pytest.mark.django_db
@pytest.mark.parametrize("verb", ["create", "patch"])
def test_default_member_role_owner_is_rejected(owner: Any, verb: str) -> None:
    """A default of OWNER is rejected (ADR-0363 §4) — an unusable, unsafe default."""
    client = _client(owner)
    if verb == "create":
        resp = client.post(
            CREATE_URL,
            {"name": "Bad", "start_date": "2026-06-01", "default_member_role": Role.OWNER},
            format="json",
        )
    else:
        project = Project.objects.create(name="Bad Patch", start_date=date(2026, 1, 5))
        ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
        resp = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"default_member_role": Role.OWNER},
            format="json",
        )
    assert resp.status_code == 400
    assert "default_member_role" in resp.data


@pytest.mark.django_db
def test_default_member_role_rejects_non_role_ordinal(owner: Any) -> None:
    """Values outside the five OSS roles fail the field's choice validation."""
    resp = _client(owner).post(
        CREATE_URL,
        {"name": "Junk", "start_date": "2026-06-01", "default_member_role": 137},
        format="json",
    )
    assert resp.status_code == 400
    assert "default_member_role" in resp.data


def test_allowlist_is_subset_of_model_fields_and_excludes_identity() -> None:
    """The template allowlist must name only real Project fields, and must never
    include identity/lifecycle/sync fields (guards against a future settings field
    being added to the model but silently escaping — or a dangerous field entering)."""
    model_fields = {f.name for f in Project._meta.get_fields()}
    assert set(SETTINGS_TEMPLATE_FIELDS) <= model_fields

    forbidden = {
        "id",
        "name",
        "description",
        "start_date",
        "status_date",
        "code",
        "health",
        "lead",
        "program",
        "object_sequence",
        "risk_sequence",
        "is_archived",
        "archived_at",
        "archived_by",
        "is_sample",
        "server_version",
        "is_deleted",
        "deleted_at",
        "deleted_by",
        "recalculated_at",
        "last_sync_version",
    }
    assert set(SETTINGS_TEMPLATE_FIELDS).isdisjoint(forbidden)
