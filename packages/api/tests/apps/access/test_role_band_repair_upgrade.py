"""The out-of-band role repair runs before the CHECK constraints land (#4583).

``AddConstraint`` validates every existing row, so a stray ordinal would
crash-loop the upgrade (CLAUDE.md migration rule 7). The constraints are dropped
inside the test transaction (PostgreSQL DDL is transactional, so the rollback
restores them), out-of-band rows are planted, then each band migration's own
``RunPython`` repair is run and the constraints re-added to prove the repaired
data satisfies them. The migrations are located through Django's loader by
their operations, never imported by name (migration rule 3), and the
migration-level executor is deliberately avoided: a ``transaction=True`` flush
of this schema costs minutes.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.operations import AddConstraint, RunPython

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.workspace.models import Group, GroupProject, Workspace

User = get_user_model()

_CONSTRAINT_NAMES = {
    "project_membership_role_in_band",
    "program_membership_role_in_band",
    "group_project_role_in_band",
    "project_default_member_role_in_band",
}


def _band_migrations() -> list:
    """Every migration that adds one of the role-band constraints, found by content."""
    loader = MigrationExecutor(connection).loader
    found = []
    for migration in loader.disk_migrations.values():
        names = {op.constraint.name for op in migration.operations if isinstance(op, AddConstraint)}
        if names & _CONSTRAINT_NAMES:
            found.append(migration)
    return found


def _drop_band_constraints() -> None:
    with connection.cursor() as cur:
        # Deferred FK triggers from the inserts above block ALTER TABLE in the same
        # transaction ("pending trigger events"); flush them first.
        cur.execute("SET CONSTRAINTS ALL IMMEDIATE")
        for table, name in [
            ("access_project_membership", "project_membership_role_in_band"),
            ("access_program_membership", "program_membership_role_in_band"),
            ("workspace_group_project", "group_project_role_in_band"),
            ("projects_project", "project_default_member_role_in_band"),
        ]:
            cur.execute(f'ALTER TABLE "{table}" DROP CONSTRAINT "{name}"')


@pytest.mark.django_db
def test_repair_clamps_out_of_band_roles_so_the_constraints_can_be_added() -> None:
    migrations = _band_migrations()
    assert len(migrations) == 3, "expected one band migration each in access/projects/workspace"

    project = Project.objects.create(name="Repair", start_date=date(2026, 1, 1))
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 1))
    program = Program.objects.create(name="Repair Prog")
    workspace = Workspace.load()
    group = Group.objects.create(workspace=workspace, name="g")
    group2 = Group.objects.create(workspace=workspace, name="g2")
    users = [User.objects.create_user(username=f"r{i}", password="pw") for i in range(6)]
    pm = {
        v: ProjectMembership.objects.create(project=project, user=users[i], role=Role.MEMBER)
        for i, v in enumerate([-5, 0, 250, 500])
    }
    gm = {
        v: ProgramMembership.objects.create(program=program, user=users[4 + i], role=Role.MEMBER)
        for i, v in enumerate([0, 500])
    }
    gp_hi = GroupProject.objects.create(group=group, project=project, role=Role.MEMBER)
    gp_lo = GroupProject.objects.create(group=group2, project=other, role=Role.MEMBER)

    _drop_band_constraints()
    for value, row in pm.items():
        ProjectMembership.objects.filter(pk=row.pk).update(role=value)
    for value, row in gm.items():
        ProgramMembership.objects.filter(pk=row.pk).update(role=value)
    GroupProject.objects.filter(pk=gp_hi.pk).update(role=900)
    GroupProject.objects.filter(pk=gp_lo.pk).update(role=-3)
    Project.objects.filter(pk=project.pk).update(default_member_role=777)
    Project.objects.filter(pk=other.pk).update(default_member_role=0)

    for migration in migrations:
        repairs = [op for op in migration.operations if isinstance(op, RunPython)]
        assert len(repairs) == 1
        with connection.schema_editor() as editor:
            repairs[0].code(global_apps, editor)

    assert {v: ProjectMembership.objects.get(pk=r.pk).role for v, r in pm.items()} == {
        -5: Role.VIEWER,
        0: Role.VIEWER,
        250: 250,
        500: Role.OWNER,
    }
    assert {v: ProgramMembership.objects.get(pk=r.pk).role for v, r in gm.items()} == {
        0: Role.VIEWER,
        500: Role.OWNER,
    }
    assert GroupProject.objects.get(pk=gp_hi.pk).role == Role.ADMIN
    assert GroupProject.objects.get(pk=gp_lo.pk).role == Role.VIEWER
    assert Project.objects.get(pk=project.pk).default_member_role == Role.ADMIN
    assert Project.objects.get(pk=other.pk).default_member_role == Role.VIEWER

    # The repaired data must satisfy the real constraints: re-adding them is what the
    # migration's AddConstraint does on upgrade.
    with connection.cursor() as cur:
        cur.execute("SET CONSTRAINTS ALL IMMEDIATE")
    with connection.schema_editor() as editor:
        for model in (ProjectMembership, ProgramMembership, GroupProject, Project):
            for constraint in model._meta.constraints:
                if constraint.name in _CONSTRAINT_NAMES:
                    editor.add_constraint(model, constraint)
