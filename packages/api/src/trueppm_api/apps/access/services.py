"""Service-layer helpers for the access app.

The service layer wraps multi-row transactions that must remain atomic — most
importantly the Program create flow, which inserts a ``Program`` row and an
OWNER ``ProgramMembership`` row in the same transaction so a Program can never
exist in the database without at least one Owner.

ADR-0070: see §Durable Execution §4 for the atomic-create rationale.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Methodology, Program, Project


@transaction.atomic
def create_program(
    *,
    name: str,
    description: str,
    methodology: str | Methodology,
    created_by: Any,
) -> Program:
    """Create a ``Program`` and the creator's OWNER membership in one transaction.

    Atomicity is the whole point of this helper — if the OWNER ``ProgramMembership``
    INSERT were a second request (or a non-atomic follow-up), a crash between the
    two writes would leave a Program with no Owner, which permission classes treat
    as "nobody can manage this program." The ``@transaction.atomic`` wrapper makes
    that orphan window impossible.

    Args:
        name: Display name (max 255). No uniqueness enforcement — two PMs can
            both have a program called "Phase 2".
        description: Optional rich text; empty string allowed.
        methodology: One of ``Methodology`` values; default ``HYBRID``.
        created_by: The user creating the program — recorded on the Program row
            and inserted as the OWNER ``ProgramMembership``.

    Returns:
        The persisted ``Program``. The OWNER membership exists by the time the
        function returns.
    """
    program = Program.objects.create(
        name=name,
        description=description,
        methodology=methodology,
        created_by=created_by,
    )
    ProgramMembership.objects.create(
        program=program,
        user=created_by,
        role=Role.OWNER,
    )
    return program


@transaction.atomic
def delete_program_cascade(program_id: uuid.UUID | str) -> None:
    """Soft-delete all memberships, detach all projects, soft-delete the program.

    Three things must happen atomically:

    1. **Memberships are soft-deleted.** ``ProgramMembership.program`` is ``PROTECT``,
       so a naive ``program.delete()`` raises ``ProtectedError`` while any member
       rows exist. The UX brief surfaces this as a combined "Remove all members
       and delete" action; the cascade implements that intent server-side.
    2. **Projects are detached.** Django's ``SET_NULL`` only fires on a hard DELETE,
       not on our soft-delete (``is_deleted=True``). Without an explicit detach
       step, ``Project.program_id`` would continue to reference a soft-deleted
       Program — the UI would display "Phase 2 (deleted)" for those projects
       and the program shell would still try to retrieve a 404'd parent. Setting
       ``program=NULL`` here matches the dialog's promise that projects become
       standalone after deletion.
    3. **The program itself is soft-deleted.** This bumps ``server_version`` so
       sync consumers can drop the row from their caches.

    Args:
        program_id: The program to delete.

    Raises:
        Program.DoesNotExist: if the program is missing or already soft-deleted.
    """
    # Local import: Project is in the projects app; importing at module top
    # would create a circular dependency through the projects → access path.
    from trueppm_api.apps.projects.models import Project

    # Lock the program row so concurrent member-add / project-assign requests
    # cannot land between the cascade steps and re-create a reference to the
    # program we're about to mark deleted.
    program = Program.objects.select_for_update().get(pk=program_id, is_deleted=False)

    for membership in ProgramMembership.objects.select_for_update().filter(
        program=program, is_deleted=False
    ):
        membership.soft_delete()

    # Detach projects — they hold a SET_NULL FK, but SET_NULL only fires on
    # hard delete. soft_delete() on the program would otherwise leave dangling
    # references. We must go through ``Project.save()`` (not ``update()``) so
    # ``server_version`` increments and mobile sync clients pick up the change.
    for project in Project.objects.select_for_update().filter(program=program):
        project.program = None
        project.save(update_fields=["program"])

    program.soft_delete()


@transaction.atomic
def transfer_project_ownership(
    *,
    project: Project,
    new_owner: Any,
    actor: Any,
) -> ProjectMembership:
    """Atomically promote a project member to OWNER, demote the actor to ADMIN.

    Why the target must already be a member: requiring an existing membership
    forces an explicit invite step and gives the audit trail a clean
    "joined → promoted" sequence. Auto-creating membership on transfer would
    surprise the target with admin authority on a project they were never
    knowingly added to.

    Args:
        project: The project whose ownership is being transferred.
        new_owner: The user who will become OWNER.
        actor: The current OWNER initiating the transfer; will be downgraded
            to ADMIN. May be the same user as ``new_owner`` — in that case
            both upserts are no-ops and the function returns the actor's row.

    Returns:
        The new OWNER's ``ProjectMembership`` row.

    Raises:
        ValidationError: if ``new_owner`` has no existing active membership
            on the project.
    """
    # Defense in depth — the view layer gates with ``IsProjectOwner``, but the
    # service is reusable (management commands, signals, future endpoints). If
    # the actor is not actually the OWNER, a naive ``.update()`` is a silent
    # no-op that would promote the target without removing anyone — creating
    # an unauthorized OWNER. Assert and fail loudly before any state changes.
    try:
        actor_row = ProjectMembership.objects.select_for_update().get(
            project=project,
            user=actor,
            is_deleted=False,
        )
    except ProjectMembership.DoesNotExist as exc:
        raise ValidationError("Only an existing project Owner can transfer ownership.") from exc
    if actor_row.role != Role.OWNER:
        raise ValidationError("Only an existing project Owner can transfer ownership.")

    try:
        target = ProjectMembership.objects.select_for_update().get(
            project=project,
            user=new_owner,
            is_deleted=False,
        )
    except ProjectMembership.DoesNotExist as exc:
        raise ValidationError(
            "The new owner must already be a member of this project. "
            "Invite them first, then retry the transfer."
        ) from exc

    if new_owner == actor:
        return target

    # Demote the actor first so the OWNER count never exceeds the previous
    # state mid-transaction — defensive against future single-owner constraints.
    actor_row.role = Role.ADMIN
    actor_row.save(update_fields=["role"])

    target.role = Role.OWNER
    target.save(update_fields=["role"])
    return target


@transaction.atomic
def transfer_program_sponsorship(
    *,
    program: Program,
    new_owner: Any,
    actor: Any,
    new_lead: Any | None = None,
) -> ProgramMembership:
    """Atomically promote a program member to OWNER and optionally rotate the lead.

    Programs carry both an OWNER membership (RBAC) and a ``lead`` FK (the
    "Program Manager" displayed in the header). Both can move together in a
    sponsorship transfer so the header chip and the access matrix stay in sync.

    Args:
        program: The program whose sponsorship is being transferred.
        new_owner: The user who will become OWNER.
        actor: The current OWNER initiating the transfer; will be downgraded
            to ADMIN.
        new_lead: Optional user to set as ``program.lead``. ``None`` leaves
            the existing lead unchanged; pass ``new_owner`` explicitly to keep
            owner+lead in lockstep.

    Returns:
        The new OWNER's ``ProgramMembership`` row.

    Raises:
        ValidationError: if ``new_owner`` has no existing active program
            membership.
    """
    # Defense in depth (see ``transfer_project_ownership`` for full rationale)
    # — the actor must currently hold the OWNER row, otherwise the demote
    # ``.update()`` is a no-op and the target gets promoted without anyone
    # being removed.
    try:
        actor_row = ProgramMembership.objects.select_for_update().get(
            program=program,
            user=actor,
            is_deleted=False,
        )
    except ProgramMembership.DoesNotExist as exc:
        raise ValidationError("Only an existing program Owner can transfer sponsorship.") from exc
    if actor_row.role != Role.OWNER:
        raise ValidationError("Only an existing program Owner can transfer sponsorship.")

    try:
        target = ProgramMembership.objects.select_for_update().get(
            program=program,
            user=new_owner,
            is_deleted=False,
        )
    except ProgramMembership.DoesNotExist as exc:
        raise ValidationError(
            "The new sponsor must already be a member of this program. "
            "Invite them first, then retry the transfer."
        ) from exc

    if new_owner != actor:
        actor_row.role = Role.ADMIN
        actor_row.save(update_fields=["role"])

        target.role = Role.OWNER
        target.save(update_fields=["role"])

    if new_lead is not None:
        program.lead = new_lead
        program.save(update_fields=["lead"])

    return target
