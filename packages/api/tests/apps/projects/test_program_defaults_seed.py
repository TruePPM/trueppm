"""Tests for "Use program defaults" copy-at-create (``inherit_program_defaults``, #1909).

A project created under a program can opt in to seed a conservative set of settings
from its parent program (``services.PROGRAM_DEFAULT_FIELDS`` = methodology, visibility).
This is a one-time manual copy at create time — NOT locked/governed inheritance:

- only fields the caller did not pass explicitly are filled (explicit > copied > default);
- the caller must be ADMIN on the parent program (the existing ``validate_program``
  gate doubles as the RBAC/IDOR guard) — a non-member cannot seed from a program;
- the flag is create-only and mutually exclusive with ``copy_settings_from``.

Live-inherited overrides (iteration_label, sharing, mc_history, attachments, …) are
deliberately NOT copied — a new project leaves them NULL and already inherits the
program's value computed-on-read (copying would pin and break inheritance).
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Methodology, Program, Project, Visibility
from trueppm_api.apps.projects.services import PROGRAM_DEFAULT_FIELDS

User = get_user_model()

CREATE_URL = "/api/v1/projects/"


def _user(username: str) -> Any:
    return User.objects.create_user(username=username, password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def program(db: object) -> Program:
    """A program with settings deliberately off their defaults, so a passing copy
    proves real value transfer (not both-at-default)."""
    return Program.objects.create(
        name="Apollo",
        methodology=Methodology.WATERFALL,  # off the HYBRID default
        visibility=Visibility.PRIVATE,  # off the WORKSPACE default
    )


@pytest.fixture
def program_admin(program: Program) -> Any:
    """A user who is ADMIN on the program → may assign to it and seed from it."""
    u = _user("prog_admin")
    ProgramMembership.objects.create(program=program, user=u, role=Role.ADMIN)
    return u


def _created_project(resp: Any) -> Project:
    assert resp.status_code == 201, resp.data
    return Project.objects.get(pk=resp.data["id"])


@pytest.mark.django_db
def test_flag_seeds_program_defaults(program: Program, program_admin: Any) -> None:
    """With the flag on, the new project's methodology and visibility come from
    the program; agile/blank defaults do not."""
    resp = _client(program_admin).post(
        CREATE_URL,
        {
            "name": "New Under Apollo",
            "start_date": "2026-06-01",
            "program": str(program.pk),
            "inherit_program_defaults": True,
        },
        format="json",
    )
    new = _created_project(resp)

    for field in PROGRAM_DEFAULT_FIELDS:
        assert getattr(new, field) == getattr(program, field), field
    # Concretely: the program's non-default values were copied.
    assert new.methodology == Methodology.WATERFALL
    assert new.visibility == Visibility.PRIVATE
    assert new.program_id == program.pk


@pytest.mark.django_db
def test_explicit_value_wins_over_program_default(program: Program, program_admin: Any) -> None:
    """An explicit field in the create body beats the copied program value
    (explicit > copied > default)."""
    resp = _client(program_admin).post(
        CREATE_URL,
        {
            "name": "Explicit Methodology",
            "start_date": "2026-06-01",
            "program": str(program.pk),
            "inherit_program_defaults": True,
            "methodology": Methodology.AGILE,  # explicit override
        },
        format="json",
    )
    new = _created_project(resp)
    assert new.methodology == Methodology.AGILE  # explicit wins
    assert new.visibility == Visibility.PRIVATE  # still copied (not sent explicitly)


@pytest.mark.django_db
def test_without_flag_nothing_is_copied(program: Program, program_admin: Any) -> None:
    """Assigning a program WITHOUT the flag leaves settings at their model defaults —
    the copy is strictly opt-in."""
    resp = _client(program_admin).post(
        CREATE_URL,
        {
            "name": "No Seed",
            "start_date": "2026-06-01",
            "program": str(program.pk),
        },
        format="json",
    )
    new = _created_project(resp)
    # Model defaults, NOT the program's WATERFALL/PRIVATE values.
    assert new.methodology == Methodology.HYBRID
    assert new.visibility == Visibility.WORKSPACE


@pytest.mark.django_db
def test_non_member_cannot_seed_from_program(program: Program) -> None:
    """A user who is not an ADMIN member of the program is rejected by the existing
    ``validate_program`` gate — the RBAC/IDOR guard also protects the seed path."""
    outsider = _user("outsider")
    resp = _client(outsider).post(
        CREATE_URL,
        {
            "name": "Sneaky",
            "start_date": "2026-06-01",
            "program": str(program.pk),
            "inherit_program_defaults": True,
        },
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "program" in resp.data
    # And no project leaked through.
    assert not Project.objects.filter(name="Sneaky").exists()


@pytest.mark.django_db
def test_below_admin_member_cannot_seed_from_program(program: Program) -> None:
    """A program MEMBER (below ADMIN) cannot assign to — nor seed from — the program."""
    member = _user("member")
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(member).post(
        CREATE_URL,
        {
            "name": "Under-privileged",
            "start_date": "2026-06-01",
            "program": str(program.pk),
            "inherit_program_defaults": True,
        },
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "program" in resp.data


@pytest.mark.django_db
def test_flag_requires_a_program(program_admin: Any) -> None:
    """``inherit_program_defaults`` without a ``program`` is a 400 — there is nothing
    to seed from."""
    resp = _client(program_admin).post(
        CREATE_URL,
        {
            "name": "No Program",
            "start_date": "2026-06-01",
            "inherit_program_defaults": True,
        },
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "inherit_program_defaults" in resp.data


@pytest.mark.django_db
def test_flag_mutually_exclusive_with_copy_settings_from(
    program: Program, program_admin: Any
) -> None:
    """Supplying both settings sources is rejected — the caller must choose one."""
    # A readable source project for copy_settings_from.
    src = Project.objects.create(name="Src", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=src, user=program_admin, role=Role.OWNER)
    resp = _client(program_admin).post(
        CREATE_URL,
        {
            "name": "Two Sources",
            "start_date": "2026-06-01",
            "program": str(program.pk),
            "inherit_program_defaults": True,
            "copy_settings_from": str(src.pk),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "inherit_program_defaults" in resp.data


@pytest.mark.django_db
def test_flag_rejected_on_update(program: Program, program_admin: Any) -> None:
    """The flag is create-only — a PATCH carrying it is rejected, not silently applied."""
    project = Project.objects.create(name="Existing", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=program_admin, role=Role.OWNER)
    resp = _client(program_admin).patch(
        f"{CREATE_URL}{project.pk}/",
        {"inherit_program_defaults": True},
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "inherit_program_defaults" in resp.data


@pytest.mark.django_db
def test_program_default_fields_have_a_program_analog() -> None:
    """Guard: every field in the seed allowlist must exist on BOTH Program and Project,
    so a rename on either model can't silently break the copy."""
    program_fields = {f.name for f in Program._meta.get_fields()}
    project_fields = {f.name for f in Project._meta.get_fields()}
    for field in PROGRAM_DEFAULT_FIELDS:
        assert field in program_fields, f"{field} missing on Program"
        assert field in project_fields, f"{field} missing on Project"
